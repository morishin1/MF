// 毎朝: 次回評価の7日前に「キャリア評価の時期です」を、評価する側へ届ける（§31）。
//
// 届け先は、その社員の上長（manager_id）と、人事・経営者（gw_role_grants の hr / owner）。
// 本人には送らない（評価の中身を本人に見せるのは、確定したあと）。
// 同じ社員・同じ評価日には1回だけ（dedupeKey）。
import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";

export const REMIND_DAYS = 7;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const target = new Date(Date.now() + 9 * 3600000 + REMIND_DAYS * 86400000).toISOString().slice(0, 10);
  const { data: careers, error } = await sb.from("gw_employee_careers")
    .select("id, tenant_id, employee_id, next_review_on")
    .eq("is_active", true).eq("next_review_on", target).limit(1000);
  if (error) return json(res, 200, { target, sent: 0, note: "gw_employee_careers を読めません（db/092 未適用？）" });
  if (!careers?.length) return json(res, 200, { target, sent: 0 });

  const empIds = careers.map((c) => c.employee_id);
  const tenantIds = [...new Set(careers.map((c) => c.tenant_id))];
  const [{ data: emps }, { data: grants }] = await Promise.all([
    sb.from("gw_employees").select("id, tenant_id, display_name, manager_id").in("id", empIds),
    sb.from("gw_role_grants").select("tenant_id, employee_id, role").in("tenant_id", tenantIds).in("role", ["hr", "owner"]),
  ]);
  const empById = new Map((emps || []).map((e) => [e.id, e]));
  const rows = [];
  for (const c of careers) {
    const e = empById.get(c.employee_id);
    if (!e) continue;
    const to = new Set((grants || []).filter((g) => g.tenant_id === c.tenant_id).map((g) => g.employee_id));
    if (e.manager_id) to.add(e.manager_id);
    to.delete(e.id);
    for (const employeeId of to) {
      rows.push({
        tenantId: c.tenant_id, employeeId, kind: "general",
        title: "キャリア評価の時期です",
        body: `${e.display_name}さんの次回評価日は ${c.next_review_on} です`,
        link: `admin-career.html?employeeId=${encodeURIComponent(e.id)}`,
        dedupeKey: `career-remind:${c.id}:${c.next_review_on}`,
      });
    }
  }
  const r = rows.length ? await notify(rows) : { created: 0 };
  return json(res, 200, { target, careers: careers.length, sent: r.created ?? rows.length });
}
