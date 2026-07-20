// GET /api/mf/status?clientId=...
// 指定クライアントの MF 連携状態を返す（管理者のみ）。トークン本体は返さない。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { isConfigured, mfStatus } from "../../lib/mf-oauth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { clientId } = req.query || {};
  if (!clientId) return json(res, 400, { error: "invalid_query", required: ["clientId"] });

  const sb = admin();
  const { data: client, error } = await sb.from("clients").select("id, tenant_id").eq("id", clientId).single();
  if (error || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  const isAdmin = memberships.some((m) => m.tenant_id === client.tenant_id && (m.role === "admin" || m.role === "staff"));
  if (!isAdmin) return json(res, 403, { error: "forbidden_not_admin" });

  const status = await mfStatus(sb, clientId);
  return json(res, 200, { configured: isConfigured(), ...status });
}
