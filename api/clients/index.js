// GET /api/clients
// ログインユーザーがアクセスできるクライアント（顧問先）一覧。
// RLS（userClient）で自動的にテナント/クライアント分離される。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { userClient } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const sb = userClient(req); // ← RLS が auth.uid() を解決
  const { data, error } = await sb
    .from("clients")
    .select("id, name, industry, accounting_software")
    .order("name", { ascending: true });

  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  return json(res, 200, { clients: data || [] });
}
