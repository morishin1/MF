// GET /api/cron/retention
// 週1回。保存期限を過ぎた個人情報を数え、
//   auto_delete の種別 … 消して記録する
//   それ以外           … 管理者に「期限切れがあります」を1通
//
// ■ 既定では消さない
//   取り消しがきかない。会社が種別ごとに auto_delete を付けたものだけ。
//   付けていない種別は、一覧（admin-hr.html の「保存期限」）から人が消す。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { rulesWith, scheduleOf, collectPeople, deleteFor } from "../../lib/retention.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const out = { today, tenants: 0, expired: 0, deleted: 0, notified: 0, errors: [] };

  // 入社手続きを持つ会社だけ見る（他は消すものが無い）
  const { data: tenants, error } = await sb.from("gw_procedures").select("tenant_id")
    .eq("kind", "onboarding").limit(5000);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  const tenantIds = [...new Set((tenants || []).map((t) => t.tenant_id))];

  for (const tenantId of tenantIds) {
    out.tenants++;
    const { data: rows } = await sb.from("gw_retention_rules")
      .select("kind, months, auto_delete, updated_at").eq("tenant_id", tenantId);
    const rules = rulesWith(rows || []);
    const people = await collectPeople(sb, tenantId);
    const expired = scheduleOf(rules, people, today).filter((s) => s.expired);
    out.expired += expired.length;
    if (!expired.length) continue;

    const left = [];
    for (const s of expired) {
      if (!s.autoDelete) { left.push(s); continue; }
      const r = await deleteFor(sb, {
        tenantId, employeeId: s.employeeId, kind: s.kind, actor: null, reason: "expired", dueOn: s.dueOn,
      });
      out.deleted += r.deleted;
      for (const e of r.errors) out.errors.push(`${s.name}/${s.kind}: ${e}`);
    }

    if (left.length) {
      const { data: grants } = await sb.from("gw_role_grants").select("employee_id")
        .eq("tenant_id", tenantId).in("role", ["hr", "owner"]);
      const ids = [...new Set((grants || []).map((g) => g.employee_id).filter(Boolean))];
      const r = await notify(ids.map((eid) => ({
        tenantId, employeeId: eid, kind: "general",
        title: `保存期限を過ぎた個人情報が ${left.length} 件あります`,
        body: `${left.slice(0, 3).map((s) => `${s.name}：${s.label}`).join("、")}${left.length > 3 ? " ほか" : ""}。入退社の「保存期限」から確認して削除してください`,
        link: "admin-hr.html#retention",
        dedupeKey: `retention:${tenantId}`,
      })));
      out.notified += r.created || 0;
    }
  }
  return json(res, 200, out);
}
