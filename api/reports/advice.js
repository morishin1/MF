// POST /api/reports/advice  { clientId, period }
// 月次試算表（当アプリ内の承認済み仕訳集計）にAIアドバイスを付けて返す（MF不要）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { computeTrialBalance } from "../../lib/reports.js";
import { adviseTrialBalance } from "../../lib/ai.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { clientId, period } = await readJson(req);
  if (!clientId) return json(res, 400, { error: "invalid_body", required: ["clientId"] });
  const ym = /^\d{4}-\d{2}$/.test(period || "") ? period : new Date().toISOString().slice(0, 7);

  const sb = admin();
  const { data: client, error } = await sb.from("clients").select("id, tenant_id, name").eq("id", clientId).single();
  if (error || !client) return json(res, 404, { error: "client_not_found" });

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, client.id, client.tenant_id)) return json(res, 403, { error: "forbidden" });

  try {
    const tb = await computeTrialBalance(sb, clientId, ym);
    if (!tb.journalCount) {
      return json(res, 200, { trialBalance: tb, advice: null, note: "対象月に承認済み仕訳がありません。仕訳を承認すると試算表とアドバイスを作成できます。" });
    }
    const advice = await adviseTrialBalance({ ...tb, companyName: client.name });
    return json(res, 200, { trialBalance: tb, advice });
  } catch (e) {
    return json(res, 500, { error: "advice_failed", detail: String(e?.message || e) });
  }
}
