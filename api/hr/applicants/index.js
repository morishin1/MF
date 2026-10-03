// GET  /api/hr/applicants          … 応募者一覧（ダッシュボード・応募者一覧・CEO REVIEWで共通利用）
//      ?category=recruitment（既定）| mugendojo | internship | other | all
//      既定は採用（＝専用の流れを持つ区分〔無限道場〕以外。インターン等は採用と同じ選考段階を使う）。
//      無限道場リード（db/118）を採用のダッシュボード・ファネルに混ぜない。
//      応募者一覧の「すべて／採用／無限道場」は all で取り、画面で分ける
// POST /api/hr/applicants { name, jobTitle, source, ... } … 応募者を追加
//
// ダッシュボード・採用ファネル・通知の元ネタは、すべてこの一覧から
// 画面側で組み立てる（別に集計テーブルは作らない。README「State Management」の方針と同じ）。

import { checkRecruiter } from "../../../lib/hr-recruiter.js";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary } from "../../../lib/gw.js";
import { guardSalaryOutput, dropSalaryInput, withoutColumns } from "../../../lib/salary.js";
import { paySplit, splitWage, attachPay, savePay, payFailed } from "../../../lib/hr-pay.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { normalizeApplicant, shapeApplicant, pickNextInterview } from "../../../lib/hr.js";
import { docStatusOf } from "../../../lib/hr-docs.js";
import { selectWithLeadFields, LEAD_CATEGORIES } from "../../../lib/hr-leads.js";
import { DEDICATED_CATEGORIES } from "../../../lib/hr-timerex-calendars.js";

const SQL = "db/081_hr_recruiting.sql";
// 給与を専用の表（gw_hr_pay）へ分けている設定（HR_PAY_SPLIT=1）では、元の列は読まない。
// 給与を見られない人には、どちらの設定でも、給与の列を選ばない
const columns = (salary) => (salary && !paySplit() ? FIELDS : withoutColumns(FIELDS));
const FIELDS = "id, tenant_id, name, email, phone, profile_url, source, job_title, "
  + "stage, status, rank, recruiter_id, decision, decision_due_on, "
  + "recommend_note, decision_note, hold_reason, hold_next_step, "
  + "employment_type, contract_type, contract_end_date, join_date, probation_months, "
  + "wage_type, wage_amount, weekly_hours, work_location, employee_id, advance_claimed_at, note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  // 給与は、見られる人（lib/gw.js canSeeSalary）にだけ返す。採用担当・責任者には返さない
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") return list(req, res, sb, ctx, salary);
  if (req.method === "POST") return create(req, res, sb, ctx, user, salary);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function list(req, res, sb, ctx, salary) {
  const want = new URL(req.url || "/", "http://localhost").searchParams.get("category") || "recruitment";
  if (want !== "all" && !LEAD_CATEGORIES.includes(want)) {
    return json(res, 400, { error: "invalid_query", detail: `category は all / ${LEAD_CATEGORIES.join(" / ")} のいずれかです` });
  }
  // リードの列（db/118）が無い環境では、全員が採用。区分では絞れないので、採用・すべては全員、それ以外は0人
  const query = (fields, withCategory) => {
    let q = sb.from("gw_hr_applicants").select(fields).eq("tenant_id", ctx.tenantId);
    if (withCategory && want === "recruitment") for (const c of DEDICATED_CATEGORIES) q = q.neq("lead_category", c);
    else if (withCategory && want !== "all") q = q.eq("lead_category", want);
    return q.order("created_at", { ascending: false }).limit(1000);
  };
  const first = await selectWithLeadFields(query, columns(salary));
  const { error, leadReady } = first;
  let { data } = first;
  if (!error && !leadReady && !["all", "recruitment"].includes(want)) data = [];
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { applicants: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // 給与を見られる人にだけ、給与を足す（分けていない設定なら何もしない）。
  // 下の取得（担当・面談・書類）とは互いに待つ理由がないので、同時に出す（直列にしていたぶん、1往復待っていた）
  //   失敗はいままでどおり投げる（待つまでのあいだ「受け手の無い失敗」にしないよう、いったん値で受ける）
  const payAttached = salary
    ? attachPay(ctx.tenantId, data || [], "applicant").then(() => null, (e) => e) : Promise.resolve(null);

  const ids = (data || []).map((a) => a.id);
  const recruiterIds = [...new Set((data || []).map((a) => a.recruiter_id).filter(Boolean))];
  const [{ data: recruiters }, { data: interviewCounts }, { data: employees }, docs] = await Promise.all([
    recruiterIds.length
      ? sb.from("gw_employees").select("id, display_name").in("id", recruiterIds)
      : Promise.resolve({ data: [] }),
    ids.length
      ? sb.from("gw_hr_interviews").select("id, applicant_id, kind, scheduled_at, conducted_at, canceled_at")
        .in("applicant_id", ids).limit(5000)
      : Promise.resolve({ data: [] }),
    // 担当変更（一覧の複数選択操作）の選択肢。既存の面談担当ピッカーと同じ条件
    sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId)
      .in("status", ["active", "invited"]).order("display_name").limit(300),
    // 書類のそろい具合（履歴書・職務経歴書）。093 未適用なら出さないだけ
    ids.length
      ? Promise.resolve(sb.from("gw_hr_documents").select("id, applicant_id, doc_type, deleted_at, created_at")
        .eq("tenant_id", ctx.tenantId).in("applicant_id", ids).limit(5000))
        .then((r) => (r.error ? null : r.data || []), () => null)
      : Promise.resolve([]),
  ]);
  const payError = await payAttached;
  if (payError) throw payError;
  const recruiterName = new Map((recruiters || []).map((e) => [e.id, e.display_name]));
  const interviewCount = new Map();
  const interviewsOf = new Map();
  for (const i of interviewCounts || []) {
    interviewCount.set(i.applicant_id, (interviewCount.get(i.applicant_id) || 0) + 1);
    if (!interviewsOf.has(i.applicant_id)) interviewsOf.set(i.applicant_id, []);
    interviewsOf.get(i.applicant_id).push(i);
  }
  // NEXT ACTION が指す面談（詳細と同じ判定）。面談予定なのに有効な面談が無い応募者は、
  // 一覧でも「面談予定の記録を確認してください」になる（「実施済みにする」を出さない）
  const nextOf = (a) => {
    const n = pickNextInterview(a, interviewsOf.get(a.id) || []);
    return n ? { id: n.id, scheduledAt: n.scheduled_at, kind: n.kind } : null;
  };

  return json(res, 200, {
    applicants: (data || []).map((a) => ({
      ...shapeApplicant(a, nextOf(a)),
      // 直近の面談日時（#43：面談日時を変えたら一覧にも出る。NEXT ACTION と同じ面談）
      nextInterviewAt: nextOf(a)?.scheduledAt || null,
      recruiterName: recruiterName.get(a.recruiter_id) || null,
      interviewCount: interviewCount.get(a.id) || 0,
      docs: docs ? docStatusOf(docs.filter((d) => d.applicant_id === a.id)) : null,
    })),
    employees: employees || [],
    // 応募者を追加するとき、担当の初期値（登録する本人）
    meEmployeeId: ctx.employee?.id || null,
    // 給与の欄を出してよいか（画面の出し分け用。値そのものは、見られない人には返らない）
    salaryVisible: salary,
    // どの区分で取ったか・リードの列（db/118）があるか（無ければ画面は無限道場の欄を出さない）
    category: want, leadReady,
  });
}

async function create(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  // 給与を見られない人は、給与の欄を書き込めない
  const row = normalizeApplicant(salary ? body : dropSalaryInput(body));
  if (row.error) return json(res, 400, row);
  // 担当：選ばれていなければ、登録した本人（lib/hr-recruiter.js）。選ばれていれば同じ会社の在籍者か確かめる
  if (row.value.recruiter_id === undefined) {
    row.value.recruiter_id = ctx.employee?.id || null;
  } else {
    const rc = await checkRecruiter(sb, ctx.tenantId, row.value.recruiter_id);
    if (!rc.ok) return json(res, 400, rc);
    row.value.recruiter_id = rc.value;
  }

  // 給与は、分けている設定なら専用の表へ（元の行には入れない）
  const { base, wage } = splitWage(row.value);
  const { data, error } = await sb.from("gw_hr_applicants")
    .insert({ ...base, tenant_id: ctx.tenantId, created_by: user.id })
    .select(columns(salary)).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  try {
    await savePay(ctx.tenantId, { applicantId: data.id, wage });
    if (salary) await attachPay(ctx.tenantId, data, "applicant");
  } catch (e) {
    // 給与だけが無い応募者を残さない（残すと、やり直しで二重に登録される）
    return payFailed(res, e, () => sb.from("gw_hr_applicants").delete().eq("id", data.id).eq("tenant_id", ctx.tenantId));
  }
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: data.id, event_key: "applied", label: "応募", created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_create",
    target: `hr_applicant:${data.id}`, detail: { name: data.name, jobTitle: data.job_title },
  });

  return json(res, 200, { applicant: shapeApplicant(data) });
}
