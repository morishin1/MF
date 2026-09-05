// GET    /api/library                … 社内文書の一覧（社員は公開分のみ。RLSが決める）
// POST   /api/library                … 登録（管理部）
// PATCH  /api/library {id, ...}      … 更新（管理部）
// DELETE /api/library?id=…           … 削除（管理部。実体のファイルも消す）
//
// GET    /api/library?path=…         … 閲覧用の署名URLを返す
// POST   /api/library?sign=1         … アップロード用の署名URLを返す（管理部）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";

const BUCKET = "library";
const CATEGORIES = ["rule", "manual", "form", "other"];
const MAX_BYTES = 25 * 1024 * 1024;   // 規程やマニュアルは領収書より大きい
const VIEW_TTL = 60 * 10;

const FIELDS =
  "id, tenant_id, title, category, description, file_path, file_name, mime_type, size_bytes, " +
  "link_url, published, sort_order, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET") {
    // ファイルを開く。見てよいかは Storage のポリシーではなく、
    // 署名を service_role で作る以上ここで判断する必要がある
    const path = url.searchParams.get("path");
    if (path) return viewUrl(res, ctx, path);

    const { data, error } = await userClient(req)
      .from("gw_library")
      .select(FIELDS)
      .eq("tenant_id", ctx.tenantId)
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("title", { ascending: true })
      .limit(500);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    return json(res, 200, { documents: data || [], canManage: canManageHr(ctx) });
  }

  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = userClient(req);

  if (req.method === "POST") {
    if (url.searchParams.get("sign") === "1") return signUpload(req, res, ctx);

    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.file_path && !row.value.link_url) {
      return json(res, 400, { error: "no_target", hint: "ファイルを選ぶか、リンクを入れてください" });
    }

    const { data, error } = await sb
      .from("gw_library")
      .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
      .select(FIELDS)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    return json(res, 200, { document: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_library")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(FIELDS)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "document_not_found" });
    return json(res, 200, { document: data });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data: doc } = await sb
      .from("gw_library").select("file_path").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!doc) return json(res, 404, { error: "document_not_found" });

    const { error } = await sb.from("gw_library").delete().eq("id", id).eq("tenant_id", ctx.tenantId);
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });

    // 行を消したあとに実体を消す。逆だと、消えたファイルを指す行が残りうる
    if (doc.file_path) {
      await admin().storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
    }
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

async function viewUrl(res, ctx, path) {
  if (String(path).split("/")[0] !== ctx.tenantId) return json(res, 403, { error: "forbidden" });
  if (!ctx.employee && !ctx.isAdmin) return json(res, 403, { error: "forbidden" });

  const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, VIEW_TTL);
  if (error) return json(res, 404, { error: "file_not_found", detail: error.message });
  return json(res, 200, { url: data.signedUrl });
}

async function signUpload(req, res, ctx) {
  const { filename, sizeBytes } = (await readJson(req)) || {};
  if (!filename) return json(res, 400, { error: "invalid_body", required: ["filename"] });
  if (sizeBytes && sizeBytes > MAX_BYTES) {
    return json(res, 400, { error: "file_too_large", hint: "25MBまでにしてください" });
  }
  const ext = String(filename).includes(".")
    ? String(filename).split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
    : "bin";
  const path = `${ctx.tenantId}/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await admin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
  return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("title")) {
    const t = String(body.title ?? "").trim();
    if (!t) return { error: "invalid_body", hint: "タイトルを入力してください" };
    v.title = t.slice(0, 200);
  }
  if (has("category")) {
    if (!CATEGORIES.includes(body.category)) return { error: "invalid_category", detail: CATEGORIES.join(", ") };
    v.category = body.category;
  }
  if (has("description")) v.description = body.description ? String(body.description).slice(0, 1000) : null;
  if (has("published")) v.published = !!body.published;
  if (has("sortOrder")) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n)) return { error: "invalid_sort_order" };
    v.sort_order = n;
  }
  if (has("filePath")) v.file_path = body.filePath || null;
  if (has("fileName")) v.file_name = body.fileName ? String(body.fileName).slice(0, 200) : null;
  if (has("mimeType")) v.mime_type = body.mimeType || null;
  if (has("sizeBytes")) v.size_bytes = Number(body.sizeBytes) || null;

  if (has("linkUrl")) {
    const raw = String(body.linkUrl || "").trim();
    if (!raw) v.link_url = null;
    else {
      // http(s) 以外を弾く。javascript: を入れられると、開いた人の画面で動く
      let u;
      try { u = new URL(raw); } catch { return { error: "invalid_link", hint: "リンクの形式が正しくありません" }; }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { error: "invalid_link", hint: "http:// または https:// のリンクを入れてください" };
      }
      v.link_url = u.toString();
    }
  }
  return { value: v };
}
