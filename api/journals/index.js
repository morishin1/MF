// GET /api/journals?clientId=...&status=draft|approved|sent
// テナント分離（RLS）に守られた仕訳一覧

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { userClient } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const sb = userClient(req); // ← RLS が auth.uid() を解決
  const { clientId, status } = req.query || {};
  let q = sb.from("journals")
    .select("id, tenant_id, client_id, document_id, partner_name, description, txn_date, total_amount, tax_category, confidence, lines, ai_note, status, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (clientId) q = q.eq("client_id", clientId);
  if (status)   q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  return json(res, 200, { journals: data || [] });
}
