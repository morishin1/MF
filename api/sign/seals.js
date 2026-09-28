// GET  /api/sign/seals                  … 印鑑の一覧（画像は数分だけ有効な signed URL）
// POST /api/sign/seals {action:"upload", mimeType, sizeBytes} … 画像の置き場所（signed upload URL）
// POST /api/sign/seals {action:"create", name, sealType, isActive, path} … 登録
// POST /api/sign/seals {action:"update", id, name?, sealType?, isActive?, sortOrder?, path?} … 変更・無効化
//
// ■ 誰が何をできるか
//   登録・変更・無効化 … owner / admin だけ（canManageSeals）
//   一覧を見る         … 署名依頼を出せる人（canManageHr）。ただし有効な印鑑だけ。
//                        owner / admin には無効にしたものも返す（管理のため）
//
// ■ 画像は非公開のまま
//   既存の private バケット hr に置き、表示には短時間の signed URL を使う。
//   公開URLは作らない。一覧の signed URL も、操作ログには残さない。
//
// ■ 差し替えても、送付済みの契約書は変わらない
//   送るときに印影を依頼ごとに複製している（api/sign/index.js）。
//   だからここでマスタの画像を差し替えても、古い画像を消しても、
//   送付済み・締結済みの契約書の印影には影響しない。
//
// ■ 削除は無い
//   押した実績のある印鑑を消すと「どの印鑑で送ったか」を追いにくくなる。
//   使わなくなったものは無効にする。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, canManageSeals } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import {
  SEAL_TYPES, SEAL_TYPE_KEYS, SEAL_MAX_BYTES, SEAL_ACCEPT,
  checkSealImage, checkDeclared, sealLog,
} from "../../lib/seal.js";

const BUCKET = "hr";
// PDF の道具（フォント6MB）を読み込まないよう、ハッシュはここで取る
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const TTL = 60 * 5;
const FIELDS =
  "id, tenant_id, name, seal_type, image_path, image_mime, image_sha256, image_size, "
  + "is_active, sort_order, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 署名依頼を出せない人には、印影を見せもしない
  if (!canManageHr(ctx) && !canManageSeals(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return list(res, ctx);
  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  if (!canManageSeals(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "印鑑の登録・変更は、管理者・経営者だけができます" });
  }
  const body = await readJson(req);
  if (body?.action === "upload") return uploadUrl(res, ctx, body);
  if (body?.action === "create") return create(res, ctx, user, body);
  if (body?.action === "update") return update(res, ctx, user, body);
  return json(res, 400, { error: "invalid_action", detail: "upload, create, update" });
}

// ---- 一覧 ---------------------------------------------------------------------
async function list(res, ctx) {
  const manage = canManageSeals(ctx);
  const sb = admin();
  let q = sb.from("gw_seals").select(FIELDS).eq("tenant_id", ctx.tenantId);
  if (!manage) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    const hint = dbSetupHint(error, "db/091_seals.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const rows = [...(data || [])].sort((a, b) =>
    (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)));
  const seals = await Promise.all(rows.map(async (s) => ({
    id: s.id,
    name: s.name,
    sealType: s.seal_type,
    isActive: s.is_active,
    sortOrder: s.sort_order,
    mime: s.image_mime,
    size: s.image_size,
    updatedAt: s.updated_at,
    imageUrl: await signedUrl(sb, s.image_path),
  })));

  return json(res, 200, {
    seals,
    types: SEAL_TYPES,
    canManage: manage,
    limits: { maxBytes: SEAL_MAX_BYTES, accept: SEAL_ACCEPT },
  });
}

async function signedUrl(sb, path) {
  if (!path) return null;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, TTL);
  return error ? null : data?.signedUrl || null;
}

// ---- 画像の置き場所 -----------------------------------------------------------
async function uploadUrl(res, ctx, body) {
  const d = checkDeclared(body || {});
  if (!d.ok) return json(res, 400, d);
  // 差し替えのたびに別のパスにする（上書きしない）
  const path = `${ctx.tenantId}/seals/${crypto.randomUUID()}.${d.ext}`;
  const { data, error } = await admin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
  return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
}

/**
 * 置かれた画像を読んで確かめる。だめなら消す（置きっぱなしにしない）。
 * @returns {Promise<{ok:true, bytes:Buffer, mime:string}|{ok:false, status:number, body:object}>}
 */
async function takeImage(sb, ctx, path) {
  // 置き場所を自分で指定できてしまうと、他社のファイルや契約書を掴める
  if (!/^[\w-]+\/seals\/[\w-]+\.(png|jpg)$/.test(path) || !path.startsWith(`${ctx.tenantId}/seals/`)) {
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }
  const dl = await sb.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) {
    return { ok: false, status: 400, body: { error: "no_file", hint: "置いた画像を読めませんでした" } };
  }
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const c = checkSealImage(bytes);
  if (!c.ok) {
    await sb.storage.from(BUCKET).remove([path]);
    return { ok: false, status: 400, body: c };
  }
  return { ok: true, bytes, mime: c.mime };
}

const cleanName = (v) => String(v ?? "").trim().slice(0, 40);

// ---- 登録 ---------------------------------------------------------------------
async function create(res, ctx, user, body) {
  const name = cleanName(body.name);
  if (!name) return json(res, 400, { error: "no_name", hint: "印鑑名を入れてください" });
  const sealType = SEAL_TYPE_KEYS.includes(body.sealType) ? body.sealType : "other";
  const path = String(body.path || "");
  if (!path) return json(res, 400, { error: "no_file", hint: "印鑑画像を選んでください" });

  const sb = admin();
  const img = await takeImage(sb, ctx, path);
  if (!img.ok) return json(res, img.status, img.body);

  // 新しいものは末尾へ
  const { data: last } = await sb.from("gw_seals").select("sort_order")
    .eq("tenant_id", ctx.tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_seals").insert({
    tenant_id: ctx.tenantId,
    name,
    seal_type: sealType,
    image_path: path,
    image_mime: img.mime,
    image_sha256: sha256(img.bytes),
    image_size: img.bytes.length,
    is_active: body.isActive !== false,
    sort_order: (last?.sort_order ?? -1) + 1,
    created_by: user.id,
    updated_by: user.id,
    created_at: now,
    updated_at: now,
  }).select(FIELDS).single();
  if (error) {
    await sb.storage.from(BUCKET).remove([path]);
    const hint = dbSetupHint(error, "db/091_seals.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  await sealLog(ctx, user.id, "seal.create", data, { active: data.is_active });
  return json(res, 200, { seal: { id: data.id, name: data.name, sealType: data.seal_type, isActive: data.is_active } });
}

// ---- 変更・無効化 -------------------------------------------------------------
async function update(res, ctx, user, body) {
  if (!body.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const sb = admin();
  const { data: cur } = await sb.from("gw_seals").select(FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!cur) return json(res, 404, { error: "not_found" });

  const patch = {};
  const changed = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return json(res, 400, { error: "no_name", hint: "印鑑名を入れてください" });
    if (name !== cur.name) { patch.name = name; changed.push("name"); }
  }
  if (body.sealType !== undefined && SEAL_TYPE_KEYS.includes(body.sealType) && body.sealType !== cur.seal_type) {
    patch.seal_type = body.sealType; changed.push("seal_type");
  }
  if (body.sortOrder !== undefined && Number.isInteger(body.sortOrder) && body.sortOrder !== cur.sort_order) {
    patch.sort_order = body.sortOrder; changed.push("sort_order");
  }
  let newImage = null;
  if (body.path && body.path !== cur.image_path) {
    const img = await takeImage(sb, ctx, String(body.path));
    if (!img.ok) return json(res, img.status, img.body);
    newImage = body.path;
    Object.assign(patch, {
      image_path: body.path, image_mime: img.mime,
      image_sha256: sha256(img.bytes), image_size: img.bytes.length,
    });
    changed.push("image");
  }
  const toggled = typeof body.isActive === "boolean" && body.isActive !== cur.is_active;
  if (toggled) patch.is_active = body.isActive;

  if (!changed.length && !toggled) return json(res, 200, { ok: true, unchanged: true });

  patch.updated_by = user.id;
  patch.updated_at = new Date().toISOString();
  const { data, error } = await sb.from("gw_seals").update(patch)
    .eq("id", cur.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error || !data) {
    if (newImage) await sb.storage.from(BUCKET).remove([newImage]);
    return json(res, 500, { error: "db_update_failed", detail: error?.message || "not_updated" });
  }

  // 古い画像は消してよい。送付済みの依頼は、送った時点の複製を持っている
  if (newImage) await sb.storage.from(BUCKET).remove([cur.image_path]);

  if (changed.length) {
    await sealLog(ctx, user.id, "seal.update", data, {
      changed, ...(patch.name ? { previousName: cur.name } : {}),
    });
  }
  if (toggled) await sealLog(ctx, user.id, body.isActive ? "seal.enable" : "seal.disable", data);

  return json(res, 200, { seal: { id: data.id, name: data.name, sealType: data.seal_type, isActive: data.is_active } });
}
