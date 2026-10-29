// 毎日、税理士の定期マスターから今日以降90日のタスクを作る。source_key の一意制約で重複しない。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { jstDate } from "../../lib/timecard.js";
import { generateTaxTasks } from "../../lib/professional-tasks.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  const sb = admin();
  const today = jstDate();
  const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 90);
  const to = d.toISOString().slice(0, 10);
  const { data: masters, error } = await sb.from("gw_professional_task_templates").select("tenant_id")
    .eq("is_active", true).limit(2000);
  if (error) {
    if (/schema cache|does not exist/i.test(error.message || "")) return json(res, 200, { today, notReady: true });
    return json(res, 500, { error: "db_query_failed" });
  }
  const tenants = [...new Set((masters || []).map((r) => r.tenant_id).filter(Boolean))];
  let made = 0;
  for (const tenantId of tenants) {
    const rows = await generateTaxTasks(sb, tenantId, { from: today, to });
    made += rows.length;
    for (const task of rows) if (task.assignee_employee_id) {
      await notify([{ tenantId, employeeId: task.assignee_employee_id, kind: "task_assigned",
        title: "税理士の定期タスクが追加されました", body: task.title,
        link: "/office/professionals.html?tab=tax", dedupeKey: `professional-task:${task.id}` }]);
    }
  }
  return json(res, 200, { today, to, templates: tenants.length, made });
}
