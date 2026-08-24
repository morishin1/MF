// GET /api/documents/preview?documentId=...
// 非公開バケットの書類を安全に閲覧するための「短期署名URL」を返す。
// アクセス権（テナント/クライアント）を確認したうえで発行する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";

const TTL = 300; // 5分

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { documentId } = req.query || {};
  if (!documentId) return json(res, 400, { error: "invalid_query", required: ["documentId"] });

  const sb = admin();
  const { data: doc, error } = await sb
    .from("documents")
    .select("id, tenant_id, client_id, filename, mime_type, storage_path, status")
    .eq("id", documentId).single();
  if (error || !doc) return json(res, 404, { error: "document_not_found" });

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, doc.client_id, doc.tenant_id)) {
    return json(res, 403, { error: "forbidden" });
  }

  const { data: signed, error: e2 } = await sb.storage
    .from("documents").createSignedUrl(doc.storage_path, TTL);
  if (e2) return json(res, 500, { error: "sign_failed", detail: e2.message });

  return json(res, 200, { url: signed.signedUrl, mimeType: doc.mime_type, filename: doc.filename, status: doc.status, expiresInSec: TTL });
}
