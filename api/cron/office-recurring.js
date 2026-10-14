// 毎日1回：Office 定例業務マスター（db/125）から、今日から先90日の予定のうち、まだ無いものだけ作る。
//
// 同じマスター・同じ日は1件だけ（uq_gw_office_events_recurring）。完了・今回なしにした回も「ある」とみなすので作り直さない。
// 画面（/api/office-tasks/calendar）も、見ている月の予定が無ければその場で作るので、cron が止まっても予定は消えない。
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する（ほかの cron と同じ）。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { jstDate } from "../../lib/timecard.js";
import { HORIZON_DAYS, addDays } from "../../lib/office-recurring.js";
import { generate, activeMasters } from "../../lib/office-recurring-db.js";

const SQL = "db/125_office_recurring.sql";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }
  const sb = admin();
  const today = jstDate();
  const to = addDays(today, HORIZON_DAYS);
  let masters;
  try { masters = await activeMasters(sb, null); }
  catch (e) {
    // 125 をまだ流していない環境。cron は落とさない
    return json(res, 200, { today, notReady: true, message: `${SQL} をまだ流していません` });
  }
  // テナントごとに作る（自社1社運用だが、分けない理由も無い）
  const byTenant = new Map();
  for (const m of masters) byTenant.set(m.tenant_id, [...(byTenant.get(m.tenant_id) || []), m]);
  let made = 0;
  for (const list of byTenant.values()) made += await generate(sb, list, { from: today, to });
  return json(res, 200, { today, to, masters: masters.length, made });
}
