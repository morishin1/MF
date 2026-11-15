// Administrative classification only. Never use this field for authorization,
// employment type, payroll, or contract acceptance.
export const ENGAGEMENT_STAGES = Object.freeze({
  trial: "2週間トライアル", probation: "試用期間", regular: "通常",
});
export const validEngagementStage = value => value === null || Object.hasOwn(ENGAGEMENT_STAGES, value);

export function engagementStage(employee, { applicant, contract } = {}, today) {
  const explicit = employee.engagement_stage;
  if (explicit && Object.hasOwn(ENGAGEMENT_STAGES, explicit))
    return { key: explicit, label: ENGAGEMENT_STAGES[explicit], source: "メンバー管理" };
  if (applicant?.offer_type === "trial_2weeks" && ["accepted", "done"].includes(applicant.status))
    return { key: "trial", label: ENGAGEMENT_STAGES.trial, source: "HRの採用区分" };
  if (contract?.probation_end && contract.status === "active" && contract.period_from <= today)
    return { key: "probation", label: ENGAGEMENT_STAGES.probation,
      source: contract.probation_end < today ? "契約の試用期間が満了しています。移行判断を確認してください" : "契約条件", endOn: contract.probation_end };
  return { key: "regular", label: ENGAGEMENT_STAGES.regular, source: "在籍情報" };
}

export async function loadEngagementStages(sb, tenantId, employees, today) {
  const result = new Map();
  if (!employees.length) return result;
  const ids = employees.map(e => e.id);
  const [applicants, contracts] = await Promise.all([
    sb.from("gw_hr_applicants").select("employee_id,offer_type,status,updated_at")
      .eq("tenant_id", tenantId).in("employee_id", ids).in("status", ["accepted", "done"])
      .order("updated_at", { ascending: false }).limit(3000),
    sb.from("gw_contracts").select("employee_id,status,period_from,probation_end,created_at")
      .eq("tenant_id", tenantId).in("employee_id", ids).eq("status", "active")
      .order("created_at", { ascending: false }).limit(3000),
  ]);
  for (const employee of employees) {
    // A read failure must not silently classify someone as an ordinary member.
    if ((applicants.error || contracts.error) && !employee.engagement_stage) {
      result.set(employee.id, { key: "unknown", label: "区分要確認", source: "HR・契約情報を取得できませんでした" });
      continue;
    }
    result.set(employee.id, engagementStage(employee, {
      applicant: (applicants.data || []).find(a => a.employee_id === employee.id),
      contract: (contracts.data || []).find(c => c.employee_id === employee.id),
    }, today));
  }
  return result;
}
