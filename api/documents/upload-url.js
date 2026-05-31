// POST /api/documents/upload-url
// 顧問先（or 事務所スタッフ）が書類PDFをアップロードするための「署名URL」を発行。
// 公開バケットは使わず、書き込み専用の短期署名URLだけを返す。
//
// 入力: { clientId, filename, mimeType, sizeBytes }
// 出力: { documentId, uploadUrl, storagePath, expiresInSec }

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { audit } from "../../lib/audit.js";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const SIGNED_TTL = 60 * 5;          // 5分

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const body = await readJson(req);
  const { clientId, filename, mimeType, sizeBytes } = body;
  if (!clientId || !filename || !mimeType || !sizeBytes) {
    return json(res, 400, { error: "invalid_body", required: ["clientId","filename","mimeType","sizeBytes"] });
  }
  if (!ALLOWED_MIME.has(mimeType)) return json(res, 400, { error: "unsupported_mime", mimeType });
  if (sizeBytes > MAX_BYTES)        return json(res, 400, { error: "file_too_large", max: MAX_BYTES });

  const sb = admin();
  const { data: client, error: e1 } = await sb
    .from("clients").select("id, tenant_id").eq("id", clientId).single();
  if (e1 || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, client.id, client.tenant_id)) {
    return json(res, 403, { error: "forbidden" });
  }

  // パス規約: <tenant_id>/<client_id>/<YYYY-MM>/<docId>.<ext>
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "bin";
  const docId = crypto.randomUUID();
  const ym = new Date().toISOString().slice(0, 7);
  const storagePath = `${client.tenant_id}/${client.id}/${ym}/${docId}.${ext}`;

  // documents 行を先に作る（status=uploaded ではなく "pending"扱いとして uploaded で作成）
  const { error: e2 } = await sb.from("documents").insert({
    id: docId,
    tenant_id: client.tenant_id,
    client_id: client.id,
    uploaded_by: user.id,
    filename,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    storage_path: storagePath,
    status: "uploaded",
  });
  if (e2) return json(res, 500, { error: "db_insert_failed", detail: e2.message });

  // 署名URLの発行（書き込み用）
  const { data: signed, error: e3 } = await sb.storage
    .from("documents")
    .createSignedUploadUrl(storagePath);
  if (e3) return json(res, 500, { error: "sign_failed", detail: e3.message });

  await audit({
    tenantId: client.tenant_id, clientId: client.id, actorId: user.id,
    action: "document.upload_url_issued", target: `document:${docId}`,
    detail: { filename, mimeType, sizeBytes },
  });

  return json(res, 200, {
    documentId: docId,
    storagePath,
    uploadUrl: signed.signedUrl,
    token: signed.token,
    expiresInSec: SIGNED_TTL,
  });
}
