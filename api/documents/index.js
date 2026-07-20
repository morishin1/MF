// GET /api/documents?clientId=...&period=YYYY-MM&docType=...&status=...
// テナント分離（RLS）に守られた書類一覧。月次管理・承認画面の共通データ源。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { userClient } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const sb = userClient(req); // ← RLS が auth.uid() を解決
  const { clientId, period, docType, status } = req.query || {};

  let q = sb.from("documents")
    .select("id, tenant_id, client_id, uploaded_by, filename, mime_type, size_bytes, storage_path, doc_type, doc_date, period, ai_summary, is_accounting, status, uploaded_at")
    .order("uploaded_at", { ascending: false })
    .limit(500);
  if (clientId) q = q.eq("client_id", clientId);
  if (period)   q = q.eq("period", period);
  if (docType)  q = q.eq("doc_type", docType);
  if (status)   q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  return json(res, 200, { documents: data || [] });
}
