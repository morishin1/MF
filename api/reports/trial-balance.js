// GET /api/reports/trial-balance?clientId=...&period=YYYY-MM
// 当アプリ内の承認済み仕訳から月次試算表を集計して返す（MF不要）。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { computeTrialBalance } from "../../lib/reports.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { clientId, period } = req.query || {};
  if (!clientId) return json(res, 400, { error: "invalid_query", required: ["clientId"] });
  const ym = /^\d{4}-\d{2}$/.test(period || "") ? period : new Date().toISOString().slice(0, 7);

  const sb = admin();
  const { data: client, error } = await sb.from("clients").select("id, tenant_id, name").eq("id", clientId).single();
  if (error || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, client.id, client.tenant_id)) return json(res, 403, { error: "forbidden" });

  try {
    const tb = await computeTrialBalance(sb, clientId, ym);
    return json(res, 200, { client: { id: client.id, name: client.name }, ...tb });
  } catch (e) {
    return json(res, 500, { error: "trial_balance_failed", detail: String(e?.message || e) });
  }
}
