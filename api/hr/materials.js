// 採用HR 共通資料（db/136）
// GET    /api/hr/materials                  一覧
// GET    /api/hr/materials?id=<id>&file=1  private PDF の署名付きURL
// POST   create_url / upload / attach
// PATCH  update / set_active
//
// PDF の候補者向け外部共有は今回対象外。shareExternal=true は URL 資料だけ。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  HR_MATERIAL_CATEGORIES, HR_MATERIAL_MAX_BYTES, HR_MATERIAL_BUCKET, HR_MATERIAL_FILE_MIME,
  cleanMaterialName, cleanMaterialDescription, isHttpsUrl, shapeHrMaterial,
} from "../../lib/hr-materials.js";

const SQL = "db/136_hr_materials_interview.sql";
const FIELDS = "id,tenant_id,name,category,kind,url,storage_path,filename,mime_type,size_bytes,description,sort_order,is_active,share_external,default_for_casual,created_by,updated_by,created_at,updated_at";
const CAT = new Set(HR_MATERIAL_CATEGORIES.map((x) => x.key));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL = 60 * 5;

const notReady = (e) => {
  const m = String(e?.message || "");
  return e?.code === "42P01" || e?.code === "PGRST205" || /gw_hr_materials|schema cache|relation .* does not exist/i.test(m);
};
const readyHint = () => "HR資料を使うには " + SQL + " を Supabase に流してください";

function cleanFilename(v) {
  const base = String(v || "material.pdf").split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, "").trim();
  return (base || "material.pdf").slice(0, 180);
}
function intOr(v, fallback = 100) {
  const n = Number(v);
  return Number.isInteger(n) && n >= -100000 && n <= 100000 ? n : fallback;
}
function validCategory(v) { return CAT.has(v); }
function isPdf(bytes) {
  return bytes?.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") return get(req, res, ctx, user);
    if (req.method === "POST") return post(req, res, ctx, user);
    if (req.method === "PATCH") return patch(req, res, ctx, user);
    return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
  } catch (e) {
    if (notReady(e)) return json(res, 503, { error: "not_ready", hint: readyHint() });
    console.error("[hr/materials]", e);
    return json(res, 500, { error: "server_error", detail: e?.message || String(e) });
  }
}

async function get(req, res, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  const id = q.get("id");

  if (id && q.get("file") === "1") {
    if (!UUID.test(id)) return json(res, 400, { error: "invalid_id" });
    const got = await sb.from("gw_hr_materials").select(FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (got.error) throw got.error;
    const r = got.data;
    if (!r || r.kind !== "file" || !r.storage_path) return json(res, 404, { error: "not_found" });
    const signed = await sb.storage.from(HR_MATERIAL_BUCKET).createSignedUrl(r.storage_path, TTL);
    if (signed.error) return json(res, 404, { error: "file_missing", detail: signed.error.message });
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.material.view",
      target: "hr_material:" + r.id, detail: { kind: "file" },
    });
    return json(res, 200, { url: signed.data.signedUrl, filename: r.filename, expiresIn: TTL });
  }

  const includeInactive = q.get("all") === "1";
  let query = sb.from("gw_hr_materials").select(FIELDS).eq("tenant_id", ctx.tenantId)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (!includeInactive) query = query.eq("is_active", true);
  const got = await query;
  if (got.error) throw got.error;
  return json(res, 200, {
    materials: (got.data || []).map(shapeHrMaterial),
    categories: HR_MATERIAL_CATEGORIES,
    limits: { maxBytes: HR_MATERIAL_MAX_BYTES, accept: "application/pdf,.pdf" },
  });
}

async function post(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  if (body?.action === "create_url") {
    const name = cleanMaterialName(body.name);
    if (!name) return json(res, 400, { error: "invalid_body", detail: "資料名を入力してください" });
    if (!validCategory(body.category)) return json(res, 400, { error: "invalid_body", detail: "カテゴリを選んでください" });
    if (!isHttpsUrl(body.url)) return json(res, 400, { error: "invalid_body", detail: "URLは https:// で始まるものを入力してください" });
    const now = new Date().toISOString();
    const row = {
      tenant_id: ctx.tenantId, name, category: body.category, kind: "url", url: String(body.url).trim(),
      description: cleanMaterialDescription(body.description), sort_order: intOr(body.sortOrder),
      is_active: true, share_external: body.shareExternal === true, default_for_casual: body.defaultForCasual === true,
      created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
    };
    const ins = await sb.from("gw_hr_materials").insert(row).select(FIELDS).single();
    if (ins.error) throw ins.error;
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.material.create",
      target: "hr_material:" + ins.data.id, detail: { kind: "url", category: ins.data.category, name: ins.data.name },
    });
    return json(res, 200, { material: shapeHrMaterial(ins.data) });
  }

  if (body?.action === "upload") {
    if (body.mimeType !== HR_MATERIAL_FILE_MIME) return json(res, 400, { error: "invalid_file", detail: "PDFだけアップロードできます" });
    const size = Number(body.sizeBytes);
    if (!Number.isFinite(size) || size <= 0 || size > HR_MATERIAL_MAX_BYTES) {
      return json(res, 400, { error: "invalid_file", detail: "PDFは10MB以下にしてください" });
    }
    const path = ctx.tenantId + "/materials/" + crypto.randomUUID() + ".pdf";
    const signed = await sb.storage.from(HR_MATERIAL_BUCKET).createSignedUploadUrl(path);
    if (signed.error) return json(res, 500, { error: "sign_failed", detail: signed.error.message });
    return json(res, 200, { path, uploadUrl: signed.data.signedUrl, token: signed.data.token });
  }

  if (body?.action === "attach") {
    const name = cleanMaterialName(body.name);
    if (!name) return json(res, 400, { error: "invalid_body", detail: "資料名を入力してください" });
    if (!validCategory(body.category)) return json(res, 400, { error: "invalid_body", detail: "カテゴリを選んでください" });
    if (body.shareExternal) return json(res, 400, { error: "invalid_body", detail: "PDFの候補者向け外部共有は今回対象外です" });
    const path = String(body.path || "");
    const prefix = ctx.tenantId + "/materials/";
    if (!path.startsWith(prefix) || !/^[\w-]+\.pdf$/.test(path.slice(prefix.length))) {
      return json(res, 403, { error: "forbidden" });
    }
    const dl = await sb.storage.from(HR_MATERIAL_BUCKET).download(path);
    if (dl.error || !dl.data) return json(res, 400, { error: "no_file", detail: "アップロードしたPDFを確認できませんでした" });
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    if (bytes.length > HR_MATERIAL_MAX_BYTES || !isPdf(bytes)) {
      await sb.storage.from(HR_MATERIAL_BUCKET).remove([path]);
      return json(res, 400, { error: "invalid_file", detail: "正しいPDF（10MB以下）をアップロードしてください" });
    }
    const now = new Date().toISOString();
    const row = {
      tenant_id: ctx.tenantId, name, category: body.category, kind: "file", storage_path: path,
      filename: cleanFilename(body.filename), mime_type: HR_MATERIAL_FILE_MIME, size_bytes: bytes.length,
      description: cleanMaterialDescription(body.description), sort_order: intOr(body.sortOrder),
      is_active: true, share_external: false, default_for_casual: body.defaultForCasual === true,
      created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
    };
    const ins = await sb.from("gw_hr_materials").insert(row).select(FIELDS).single();
    if (ins.error) {
      await sb.storage.from(HR_MATERIAL_BUCKET).remove([path]);
      throw ins.error;
    }
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.material.create",
      target: "hr_material:" + ins.data.id,
      detail: { kind: "file", category: ins.data.category, name: ins.data.name, size: bytes.length },
    });
    return json(res, 200, { material: shapeHrMaterial(ins.data) });
  }

  return json(res, 400, { error: "invalid_action" });
}

async function patch(req, res, ctx, user) {
  const body = await readJson(req);
  if (!UUID.test(String(body?.id || ""))) return json(res, 400, { error: "invalid_id" });
  const sb = admin();
  const got = await sb.from("gw_hr_materials").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
  if (got.error) throw got.error;
  const before = got.data;
  if (!before) return json(res, 404, { error: "not_found" });

  if (body.action === "set_active") {
    if (typeof body.active !== "boolean") return json(res, 400, { error: "invalid_body" });
    const upd = await sb.from("gw_hr_materials")
      .update({ is_active: body.active, updated_by: user.id, updated_at: new Date().toISOString() })
      .eq("tenant_id", ctx.tenantId).eq("id", body.id).select(FIELDS).single();
    if (upd.error) throw upd.error;
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.material.active",
      target: "hr_material:" + upd.data.id, detail: { active: upd.data.is_active },
    });
    return json(res, 200, { material: shapeHrMaterial(upd.data) });
  }

  if (body.action === "update") {
    const p = { updated_by: user.id, updated_at: new Date().toISOString() };
    if (body.name !== undefined) {
      p.name = cleanMaterialName(body.name);
      if (!p.name) return json(res, 400, { error: "invalid_body", detail: "資料名を入力してください" });
    }
    if (body.category !== undefined) {
      if (!validCategory(body.category)) return json(res, 400, { error: "invalid_body", detail: "カテゴリを選んでください" });
      p.category = body.category;
    }
    if (body.description !== undefined) p.description = cleanMaterialDescription(body.description);
    if (body.sortOrder !== undefined) p.sort_order = intOr(body.sortOrder, before.sort_order ?? 100);
    if (body.defaultForCasual !== undefined) p.default_for_casual = body.defaultForCasual === true;
    if (body.shareExternal !== undefined) {
      if (before.kind !== "url" && body.shareExternal) return json(res, 400, { error: "invalid_body", detail: "PDFは外部共有できません" });
      p.share_external = body.shareExternal === true;
    }
    if (body.url !== undefined) {
      if (before.kind !== "url") return json(res, 400, { error: "invalid_body", detail: "PDF資料のURLは変更できません" });
      if (!isHttpsUrl(body.url)) return json(res, 400, { error: "invalid_body", detail: "URLは https:// で始まるものを入力してください" });
      p.url = String(body.url).trim();
    }

    const upd = await sb.from("gw_hr_materials").update(p)
      .eq("tenant_id", ctx.tenantId).eq("id", body.id).select(FIELDS).single();
    if (upd.error) throw upd.error;
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.material.update",
      target: "hr_material:" + upd.data.id,
      detail: { fields: Object.keys(p).filter((x) => !["updated_at", "updated_by"].includes(x)) },
    });
    return json(res, 200, { material: shapeHrMaterial(upd.data) });
  }

  return json(res, 400, { error: "invalid_action" });
}
