// GET /api/hr/payroll?ids=<employeeId,…>   … MF給与の従業員取込用 CSV
//
// ■ 誰が出せるか
//   人事・管理者。社労士は、共有されている手続き（社労士に見せる項目がある入社手続き）の人だけ。
//   どちらも二段階認証（強制日以降）。
//
// ■ 何が入るか
//   lib/payroll-csv.js の COLUMNS だけ。電話・緊急連絡先・扶養家族の氏名・自己紹介は入れない。
//   マイナンバーはそもそも持っていない。
//
// ■ 出したことを残す
//   gw_activity_log（誰が・何人ぶん）と gw_sensitive_access_log（誰のぶんを・export）。
//   CSV は手元に残りやすい。出した記録が無いと、どこに何人ぶんが散ったか追えない。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { logSensitiveMany } from "../../lib/sensitive-log.js";
import { buildCsv, csvFileName, HEADERS } from "../../lib/payroll-csv.js";

const MAX = 200;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  const advisor = !canManageHr(ctx) && ctx.isAdvisor;
  if (!canManageHr(ctx) && !advisor) return json(res, 403, { error: "forbidden" });

  const q = new URL(req.url, "http://localhost").searchParams;
  if (q.get("columns")) return json(res, 200, { headers: HEADERS });

  const ids = [...new Set(String(q.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return json(res, 400, { error: "bad_request", hint: "誰のぶんを出すか（ids）を指定してください" });
  if (ids.length > MAX) return json(res, 400, { error: "too_many", hint: `一度に出せるのは${MAX}人までです` });

  const sb = admin();

  // 社労士は、共有されている手続きの人だけ
  if (advisor) {
    const { data: procs } = await sb.from("gw_procedures").select("id, employee_id")
      .eq("tenant_id", ctx.tenantId).eq("kind", "onboarding").in("employee_id", ids);
    const procIds = (procs || []).map((p) => p.id);
    const { data: shared } = procIds.length
      ? await sb.from("gw_procedure_items").select("procedure_id")
          .in("procedure_id", procIds).eq("share_with_advisor", true)
      : { data: [] };
    const okProc = new Set((shared || []).map((s) => s.procedure_id));
    const okEmp = new Set((procs || []).filter((p) => okProc.has(p.id)).map((p) => p.employee_id));
    const denied = ids.filter((id) => !okEmp.has(id));
    if (denied.length) {
      return json(res, 403, { error: "forbidden", hint: "共有されていない方が含まれています", denied });
    }
  }

  const [emps, profiles, contracts] = await Promise.all([
    sb.from("gw_employees")
      .select("id, employee_code, display_name, email, department, position, employment_type, joined_on")
      .eq("tenant_id", ctx.tenantId).in("id", ids),
    sb.from("gw_onboard_profiles")
      .select("employee_id, name_kana, birth_date, postal_code, address, commute_cost, "
            + "bank_name, bank_branch, bank_type, bank_number, bank_holder, "
            + "pension_number, employment_ins_number, has_dependents, dependents, status")
      .in("employee_id", ids),
    sb.from("gw_contracts").select("employee_id, wage_type, wage_amount, created_at")
      .eq("tenant_id", ctx.tenantId).in("employee_id", ids)
      .eq("status", "active").order("created_at", { ascending: false }),
  ]);
  if (emps.error) {
    const hint = dbSetupHint(emps.error, "db/008_onboarding.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: emps.error.message });
  }
  if (profiles.error) {
    const hint = dbSetupHint(profiles.error, "db/037_onboard_form.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
  }

  const profBy = new Map((profiles.data || []).map((p) => [p.employee_id, p]));
  const contractBy = new Map();
  for (const c of contracts.data || []) if (!contractBy.has(c.employee_id)) contractBy.set(c.employee_id, c);

  const rows = (emps.data || []).map((e) => ({
    employee: e, profile: profBy.get(e.id) || {}, contract: contractBy.get(e.id) || {},
  }));
  if (!rows.length) return json(res, 404, { error: "not_found", hint: "名簿に見つかりません" });

  const csv = buildCsv(rows);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const filename = csvFileName(today, rows.length);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.payroll_csv",
    target: "payroll", detail: { count: rows.length, advisor, ids: rows.map((r) => r.employee.id) },
  });
  await logSensitiveMany({
    tenantId: ctx.tenantId, actor: { id: user.id, name: ctx.employee?.display_name },
    selfId: ctx.employee?.id, kind: "export", action: "export", target: "payroll_csv",
    detail: { filename }, req,
  }, rows.map((r) => r.employee.id));

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(csv);
}
