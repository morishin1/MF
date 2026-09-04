// POST /api/messages/upload  { threadId, filename, mimeType, sizeBytes }
//        → 書き込み用の署名URLを発行する { fileId, uploadUrl }
// GET  /api/messages/upload?fileId=…
//        → 閲覧用の署名URLを返す（見てよいかは RLS が決める）
//
// 預けたファイルは、続けて /api/messages/thread に fileId を渡すことで
// メッセージに添付される。渡されないまま残った行は message_id が null のまま。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/heic", "image/webp", "image/gif",
  "text/csv", "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const VIEW_TTL = 60 * 5;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  if (req.method === "POST") return issueUploadUrl(req, res, ctx, user);
  if (req.method === "GET") return viewUrl(req, res);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function issueUploadUrl(req, res, ctx, user) {
  const body = await readJson(req);
  const { threadId, filename, mimeType, sizeBytes } = body || {};
  if (!threadId || !filename || !mimeType || !sizeBytes) {
    return json(res, 400, { error: "invalid_body", required: ["threadId", "filename", "mimeType", "sizeBytes"] });
  }
  if (!ALLOWED_MIME.has(mimeType)) return json(res, 400, { error: "unsupported_mime", mimeType });
  if (sizeBytes > MAX_BYTES) return json(res, 400, { error: "file_too_large", max: MAX_BYTES });

  // 参加していないスレッドへは預けさせない。RLS 越しに引いて 0 件なら弾く
  const { data: thread } = await userClient(req)
    .from("gw_threads")
    .select("id")
    .eq("id", threadId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (!thread) return json(res, 404, { error: "thread_not_found" });

  const sb = admin();
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase().slice(0, 8) : "bin";
  const fileId = crypto.randomUUID();
  const storagePath = `${ctx.tenantId}/${threadId}/${fileId}.${ext}`;

  const { error: ie } = await sb.from("gw_message_files").insert({
    id: fileId,
    tenant_id: ctx.tenantId,
    thread_id: threadId,
    filename, mime_type: mimeType, size_bytes: sizeBytes,
    storage_path: storagePath,
    uploaded_by: user.id,
  });
  if (ie) return json(res, 500, { error: "db_insert_failed", detail: ie.message });

  const { data: signed, error: se } = await sb.storage.from("messages").createSignedUploadUrl(storagePath);
  if (se) {
    await sb.from("gw_message_files").delete().eq("id", fileId);
    return json(res, 500, { error: "sign_failed", detail: se.message });
  }

  return json(res, 200, { fileId, storagePath, uploadUrl: signed.signedUrl, token: signed.token });
}

async function viewUrl(req, res) {
  const fileId = new URL(req.url, "http://localhost").searchParams.get("fileId");
  if (!fileId) return json(res, 400, { error: "invalid_query", required: ["fileId"] });

  // 参加者かどうかは RLS が決める。読めなければ 0 件になる
  const { data: file } = await userClient(req)
    .from("gw_message_files")
    .select("id, filename, storage_path")
    .eq("id", fileId)
    .maybeSingle();
  if (!file) return json(res, 404, { error: "file_not_found" });

  const { data: signed, error } = await admin()
    .storage.from("messages")
    .createSignedUrl(file.storage_path, VIEW_TTL);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  return json(res, 200, { url: signed.signedUrl, filename: file.filename, expiresInSec: VIEW_TTL });
}
