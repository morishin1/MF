// GET /api/mf/oauth/start?clientId=...
// 管理者(admin/staff)が MF 連携を開始する。認可URLを返す（フロントが window.location で遷移）。
// state は署名して改ざんを防ぐ（callback は公開エンドポイントのため）。

import { json, methodNotAllowed } from "../../../lib/http.js";
import { requireUser, getMemberships } from "../../../lib/auth.js";
import { admin } from "../../../lib/supabase.js";
import { isConfigured, signState, buildAuthorizeUrl } from "../../../lib/mf-oauth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { clientId } = req.query || {};
  if (!clientId) return json(res, 400, { error: "invalid_query", required: ["clientId"] });

  if (!isConfigured()) {
    return json(res, 503, { error: "mf_not_configured", hint: "Vercel に MF_CLIENT_SECRET / MF_APP_SECRET を設定してください" });
  }

  const sb = admin();
  const { data: client, error } = await sb.from("clients").select("id, tenant_id").eq("id", clientId).single();
  if (error || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  const isAdmin = memberships.some((m) => m.tenant_id === client.tenant_id && (m.role === "admin" || m.role === "staff"));
  if (!isAdmin) return json(res, 403, { error: "forbidden_not_admin" });

  const state = signState({ clientId: client.id, tenantId: client.tenant_id, exp: Date.now() + 10 * 60 * 1000 });
  return json(res, 200, { authorizeUrl: buildAuthorizeUrl(state) });
}
