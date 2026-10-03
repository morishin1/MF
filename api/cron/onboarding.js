// GET /api/cron/onboarding
// 毎朝1回。入社日が近い（7日以内・過ぎた）のに終わっていない入社手続きを、
// 本人・管理者・社労士に知らせる。
//
// ■ 何を知らせるか
//   段階の判定（lib/onboard-stage.js）そのまま。「本人：書類の提出が2件残っています」。
//   ここで別の文を作らない。画面と通知で言葉が違うと、どちらを信じればよいか分からなくなる。
//
// ■ 積み上がらない
//   dedupe_key を手続き×宛先で固定（lib/onboard-due.js）。毎日走っても1件が更新されるだけ。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { gatherFactsBulk } from "../../lib/onboard-advance.js";
import { computeStage } from "../../lib/onboard-stage.js";
import { dueNotices, DUE_WINDOW_DAYS } from "../../lib/onboard-due.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const until = new Date(Date.now() + 9 * 3600000 + DUE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const out = { today, procedures: 0, notices: 0, skipped: 0 };

  // 終わっていない入社手続きで、入社日が 7日以内か過ぎているもの
  const { data: procs, error } = await sb.from("gw_procedures")
    .select("id, tenant_id, employee_id, kind, status, target_on, stage")
    .eq("kind", "onboarding").eq("status", "in_progress")
    .not("target_on", "is", null).lte("target_on", until)
    .limit(500);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!procs?.length) return json(res, 200, { ...out, note: "対象なし" });

  const procIds = procs.map((p) => p.id);
  const empIds = [...new Set(procs.map((p) => p.employee_id))];
  const tenantIds = [...new Set(procs.map((p) => p.tenant_id))];

  const [{ data: items }, { data: emps }, { data: grants }] = await Promise.all([
    sb.from("gw_procedure_items").select("id, procedure_id, item_key, owner, required, status, title")
      .in("procedure_id", procIds).limit(5000),
    sb.from("gw_employees").select("id, display_name").in("id", empIds),
    sb.from("gw_role_grants").select("tenant_id, employee_id, role")
      .in("tenant_id", tenantIds).in("role", ["hr", "owner", "labor_advisor"]),
  ]);
  const itemsBy = new Map();
  for (const i of items || []) {
    if (!itemsBy.has(i.procedure_id)) itemsBy.set(i.procedure_id, []);
    itemsBy.get(i.procedure_id).push(i);
  }
  const nameOf = new Map((emps || []).map((e) => [e.id, e.display_name]));
  const rolesOf = (tenantId, roles) => [...new Set((grants || [])
    .filter((g) => g.tenant_id === tenantId && roles.includes(g.role))
    .map((g) => g.employee_id).filter(Boolean))];

  const rows = [];
  for (const tenantId of tenantIds) {
    const mine = procs.filter((p) => p.tenant_id === tenantId);
    const facts = await gatherFactsBulk(sb, tenantId, mine, itemsBy);
    for (const p of mine) {
      const f = facts.get(p.id);
      if (!f) { out.skipped++; continue; }
      const stage = computeStage(f);
      out.procedures++;
      rows.push(...dueNotices({
        proc: p, name: nameOf.get(p.employee_id), stage, today,
        adminIds: rolesOf(tenantId, ["hr", "owner"]),
        advisorIds: rolesOf(tenantId, ["labor_advisor"]),
      }));
    }
  }

  if (rows.length) {
    const r = await notify(rows);
    out.notices = r.created || 0;
  }
  return json(res, 200, out);
}
