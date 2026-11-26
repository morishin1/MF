import { requireUser } from "../../lib/auth.js";
import { gwContext, canOfficeHr, isLaborAdvisor, isTaxAdvisor } from "../../lib/gw.js";
import { gwLog } from "../../lib/gw-audit.js";
import { json, methodNotAllowed, readJson } from "../../lib/http.js";
import { requireMfa } from "../../lib/mfa.js";
import { logSensitiveMany } from "../../lib/sensitive-log.js";
import { isPreJoin } from "../../lib/stages.js";
import { admin } from "../../lib/supabase.js";
import { claimValid, commuteCsv, commuteDbError, validId, validMonth } from "../../lib/timecard-commute.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!["GET", "PATCH"].includes(req.method)) return methodNotAllowed(res, ["GET", "PATCH"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  const query = new URL(req.url, "http://localhost").searchParams;
  const scope = query.get("scope") || "me";
  const exporting = query.get("format") === "csv";
  const external = isLaborAdvisor(ctx) || isTaxAdvisor(ctx);
  const office = scope === "office" && !external && canOfficeHr(ctx);
  const advisor = scope === "advisor" && isLaborAdvisor(ctx) && ctx.employee?.id && exporting && req.method === "GET";
  const self = scope === "me" && !external && ctx.employee?.id && !isPreJoin(ctx.employee) && !exporting;
  if (!ctx.tenantId || !(office || advisor || self)) return json(res, 403, { error: "forbidden" });
  if (!self && !await requireMfa(req, res, ctx, user)) return;
  const month = query.get("month");
  if (!validMonth(month)) return json(res, 400, { error: "invalid_month", hint: "対象月を選択してください。" });
  const args = { p_tenant: ctx.tenantId, p_month: month + "-01" };
  const sb = admin();

  if (exporting && req.method === "GET") {
    const { data, error } = await sb.rpc("gw_commute_export", { ...args, p_advisor: advisor ? ctx.employee.id : null });
    if (error) return commuteDbError(res, error);
    if (!data?.length) return json(res, 409, { error: "no_payroll", hint: "この月に共有できる締め済みの明細はありません。" });
    await logSensitiveMany({ tenantId: ctx.tenantId, actor: { id: user.id, name: ctx.employee?.display_name },
      selfId: ctx.employee?.id, kind: "export", action: "export", target: "timecard_monthly_csv", detail: { month }, req },
    data.map(r => r.employee_id));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="timecard-commute-' + month + '.csv"');
    return res.end(commuteCsv(month, data));
  }
  if (req.method === "GET") {
    const { data, error } = await sb.rpc("gw_commute_overview", { ...args, p_employee: self ? ctx.employee.id : null });
    return error ? commuteDbError(res, error) : json(res, 200, data);
  }
  const body = await readJson(req);
  const employeeId = self ? ctx.employee.id : body?.employeeId;
  if (self && body?.employeeId && body.employeeId !== employeeId) return json(res, 403, { error: "forbidden" });
  if (exporting || !validId(employeeId) || !claimValid(body, month) || (office && body.advisorId != null && !validId(body.advisorId))) {
    return json(res, 400, { error: "invalid_claim", hint: "支給方法・運賃・通勤日を確認してください。" });
  }
  const { error } = await sb.rpc("gw_commute_save", { ...args, p_employee: employeeId, p_actor: user.id,
    p_review: office, p_method: body.method, p_route: body.route.trim(), p_rate: body.rate,
    p_dates: body.dates, p_advisor: office ? body.advisorId ?? null : null, p_version: body.version });
  if (error) return commuteDbError(res, error);
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: office ? "timecard.commute_review" : "timecard.commute_submit",
    target: "employee:" + employeeId, detail: { month } });
  return json(res, 200, { ok: true });
}
