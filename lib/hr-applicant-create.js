// 応募者を1人登録する（POST /api/hr/applicants と、採用メール新着受付の「応募者として登録」で共通）。
//
// ■ なぜ分けたか
//   受信メールから登録するときも、手入力で登録するときと同じ検査（入力・担当・給与・RLS）を通したい。
//   画面ごとに登録の処理を書き分けると、片方だけ検査が抜ける。
//
// ■ 返すもの
//   { status, body, row }           … そのまま json(res, status, body) で返せる
//   { payError, rollback }          … 給与だけ保存できなかった。呼び出し側で payFailed(res, payError, rollback)
import { checkRecruiter, notifyAssigned } from "./hr-recruiter.js";
import { notify } from "./notify.js";
import { dbSetupHint } from "./http.js";
import { dropSalaryInput, withoutColumns } from "./salary.js";
import { paySplit, splitWage, attachPay, savePay } from "./hr-pay.js";
import { gwLog } from "./gw-audit.js";
import { normalizeApplicant, shapeApplicant } from "./hr.js";

export const APPLICANT_SQL = "db/081_hr_recruiting.sql";
export const APPLICANT_FIELDS = "id, tenant_id, name, email, phone, profile_url, source, job_title, "
  + "stage, status, rank, recruiter_id, decision, decision_due_on, "
  + "recommend_note, decision_note, hold_reason, hold_next_step, "
  + "employment_type, contract_type, contract_end_date, join_date, probation_months, "
  + "wage_type, wage_amount, weekly_hours, work_location, employee_id, advance_claimed_at, note, created_at, updated_at";
// 給与を専用の表（gw_hr_pay）へ分けている設定（HR_PAY_SPLIT=1）では、元の列は読まない。
// 給与を見られない人には、どちらの設定でも、給与の列を選ばない
export const applicantColumns = (salary) => (salary && !paySplit() ? APPLICANT_FIELDS : withoutColumns(APPLICANT_FIELDS));

/**
 * @param {object} p
 * @param {object} p.sb       利用者の権限の Supabase クライアント（RLS を通す）
 * @param {object} p.ctx      gwContext の結果
 * @param {object} p.user     requireUser の結果
 * @param {object} p.body     画面から来た値（normalizeApplicant の形）
 * @param {boolean} p.salary  給与を見られる人か
 * @param {string|null} [p.appliedDetail] 「応募」タイムラインの補足（受信メールから登録したときの目印など）
 */
export async function createApplicant({ sb, ctx, user, body, salary, appliedDetail = null }) {
  // 給与を見られない人は、給与の欄を書き込めない
  const row = normalizeApplicant(salary ? body : dropSalaryInput(body));
  if (row.error) return { status: 400, body: row };
  // 担当：選ばれていなければ、登録した本人（lib/hr-recruiter.js）。選ばれていれば同じ会社の在籍者か確かめる
  if (row.value.recruiter_id === undefined) {
    row.value.recruiter_id = ctx.employee?.id || null;
  } else {
    const rc = await checkRecruiter(sb, ctx.tenantId, row.value.recruiter_id);
    if (!rc.ok) return { status: 400, body: rc };
    row.value.recruiter_id = rc.value;
  }

  // 給与は、分けている設定なら専用の表へ（元の行には入れない）
  const { base, wage } = splitWage(row.value);
  const { data, error } = await sb.from("gw_hr_applicants")
    .insert({ ...base, tenant_id: ctx.tenantId, created_by: user.id })
    .select(applicantColumns(salary)).single();
  if (error) {
    const hint = dbSetupHint(error, APPLICANT_SQL);
    if (hint) return { status: 503, body: { error: "not_ready", message: hint } };
    return { status: error.code === "42501" ? 403 : 500, body: { error: "db_insert_failed", detail: error.message } };
  }

  try {
    await savePay(ctx.tenantId, { applicantId: data.id, wage });
    if (salary) await attachPay(ctx.tenantId, data, "applicant");
  } catch (e) {
    // 給与だけが無い応募者を残さない（残すと、やり直しで二重に登録される）
    return { payError: e, rollback: () => sb.from("gw_hr_applicants").delete().eq("id", data.id).eq("tenant_id", ctx.tenantId) };
  }
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: data.id, event_key: "applied", label: "応募", created_by: user.id,
    ...(appliedDetail ? { detail: appliedDetail } : {}),
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_create",
    target: `hr_applicant:${data.id}`, detail: { name: data.name, jobTitle: data.job_title },
  });
  // ほかの人を担当にして登録したら、その人へ「担当になった」と知らせる
  await notifyAssigned(notify, { tenantId: ctx.tenantId, recruiterId: data.recruiter_id, actorEmployeeId: ctx.employee?.id || null,
    applicants: [{ id: data.id, name: data.name }] });

  return { status: 200, body: { applicant: shapeApplicant(data) }, row: data };
}
