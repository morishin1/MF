// GET /api/hr/ceo-review … 社長が「今日見るべき候補者だけ」を見るブロック
//   今日会う人／社長に会ってほしい人／社長判断待ち／判断済み・本人へ未連絡（contactPending）
//
// ■ 判断済み・本人へ未連絡（lib/hr-messages.js contactStatusOf。DB の列は増やさずタイムラインで決める）
//   内定・見送りを決めたのに本人へ伝えていない人。内定は合格通知を送れば連絡済みになる。
//   保留は「社長判断待ち」に残るので、そちらのカードに連絡状況を付ける。
//
// 応募者全件は返さない。表示対象は社長推薦（stage: ceo_recommend / ceo_interview）
// まで進んだ人だけ。事務処理（合格通知・onboarding等）は一切含めない（README §11）。
//
// canDecideHire（社長・管理者）だけが見られる。recruiterは社長推薦はできるが、
// この画面自体は開けない（js/hr-layout.js のページ側ガードと同じ基準）

import { ymd as jstYmd } from "../../lib/jst.js";
import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canDecideHire, canSeeSalary } from "../../lib/gw.js";
import { guardSalaryOutput, withoutColumns } from "../../lib/salary.js";
import { paySplit, attachPay } from "../../lib/hr-pay.js";
import { userClient } from "../../lib/supabase.js";
import { shapeApplicant, shapeInterview, ceoReviewBucket, CEO_STAGES, CEO_REVIEW_STATUSES } from "../../lib/hr.js";
import { contactStatusOf, CONTACT_EVENT_KEYS } from "../../lib/hr-messages.js";

const SQL = "db/081_hr_recruiting.sql・084_hr_ceo_review.sql";
const FIELDS = "id, tenant_id, name, email, phone, profile_url, source, job_title, "
  + "stage, status, rank, recruiter_id, decision, decision_due_on, "
  + "recommend_note, decision_note, hold_reason, hold_next_step, "
  + "employment_type, contract_type, contract_end_date, join_date, probation_months, "
  + "wage_type, wage_amount, weekly_hours, work_location, employee_id, note, created_at, updated_at";
// 内定にした人は stage=offer へ進む。本人への連絡が済むまでは「判断済み・本人へ未連絡」に出す
const FETCH_STAGES = [...CEO_STAGES, "offer"];

const EMPTY = { todayMeetings: [], recommended: [], decisionPending: [], contactPending: [] };

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canDecideHire(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  // 給与は、見られる人（lib/gw.js canSeeSalary）にだけ返す
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));
  const cols = salary && !paySplit() ? FIELDS : withoutColumns(FIELDS);
  // 段階で拾う人と、段階が社長より前でも状態が社長面談待ち・社長判断待ちの人（手動で状態を変えた人を取りこぼさない）。
  // 新しく動いた人から読み、件数が多くても、いま判断が要る人が上限で切れないようにする
  const [byStage, byStatus] = await Promise.all([
    sb.from("gw_hr_applicants").select(cols).eq("tenant_id", ctx.tenantId).in("stage", FETCH_STAGES)
      .order("updated_at", { ascending: false }).limit(1000),
    sb.from("gw_hr_applicants").select(cols).eq("tenant_id", ctx.tenantId).in("status", CEO_REVIEW_STATUSES)
      .order("updated_at", { ascending: false }).limit(1000),
  ]);
  const error = byStage.error || byStatus.error;
  const seen = new Set();
  const data = [...(byStage.data || []), ...(byStatus.data || [])].filter((a) => !seen.has(a.id) && seen.add(a.id));
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { ...EMPTY, notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const applicants = data || [];
  // 給与を見られる人にだけ、給与を足す（分けていない設定なら何もしない）
  if (salary) await attachPay(ctx.tenantId, applicants, "applicant");
  if (!applicants.length) return json(res, 200, EMPTY);

  const ids = applicants.map((a) => a.id);
  const decidedIds = applicants.filter((a) => a.decision).map((a) => a.id);
  const [{ data: interviews, error: ivError }, { data: contactEvents }] = await Promise.all([
    sb.from("gw_hr_interviews").select("*").in("applicant_id", ids).order("created_at", { ascending: false }).limit(5000),
    decidedIds.length
      ? sb.from("gw_hr_timeline").select("applicant_id, event_key, occurred_at")
        .in("applicant_id", decidedIds).in("event_key", CONTACT_EVENT_KEYS).limit(5000)
      : Promise.resolve({ data: [] }),
  ]);
  // 面談が読めないと「今日会う人」が黙って空になる。読めなかったことを返す
  if (ivError) return json(res, 500, { error: "db_query_failed", detail: ivError.message });
  const eventsOf = new Map();
  for (const e of contactEvents || []) {
    if (!eventsOf.has(e.applicant_id)) eventsOf.set(e.applicant_id, []);
    eventsOf.get(e.applicant_id).push(e);
  }
  const byApplicant = new Map();
  for (const i of interviews || []) {
    if (!byApplicant.has(i.applicant_id)) byApplicant.set(i.applicant_id, []);
    byApplicant.get(i.applicant_id).push(i);
  }

  const jstToday = jstYmd();
  const todayMeetings = [], recommended = [], decisionPending = [], contactPending = [];

  for (const a of applicants) {
    const list = byApplicant.get(a.id) || [];
    // 良かった点・気になる点は、評価が付いた面談（カジュアル面談）のものをそのまま出す
    const evaluated = list.find((i) => i.rank) || null;
    // 社長面談は「いま有効なもの」（実施前・キャンセルでない）を優先。無ければ実施済みの直近。
    // キャンセル済みの古い行を拾わない
    const ceoList = list.filter((i) => i.kind === "ceo");
    const ceoInterview = ceoList.find((i) => !i.conducted_at && !i.canceled_at)
      || ceoList.find((i) => !i.canceled_at) || null;

    const card = {
      ...shapeApplicant(a),
      goodPoints: evaluated?.recommend_reason || null,
      concerns: evaluated?.notes || null,
      // カジュアル面談の録画（Google Drive等の外部リンク）があれば渡す。無ければnull
      // のまま（社長が応募書類を読み直さなくても判断材料に辿り着けるように。README §14）
      recordingUrl: evaluated?.recording_url || null,
      ceoInterview: ceoInterview ? shapeInterview(ceoInterview) : null,
      contact: contactStatusOf(a.decision, eventsOf.get(a.id)),
    };

    // どのブロックに出すかは lib/hr.js ceoReviewBucket（集計・NEXT ACTION と同じ判定）
    const bucket = ceoReviewBucket(a, { interviews: list, contactState: card.contact.state, today: jstToday });
    if (bucket === "todayMeetings") todayMeetings.push(card);
    else if (bucket === "decisionPending") decisionPending.push(card);
    else if (bucket === "recommended") recommended.push(card);
    else if (bucket === "contactPending") contactPending.push(card);
  }

  const byTime = (x, y) => String(x.ceoInterview?.scheduledAt || "").localeCompare(String(y.ceoInterview?.scheduledAt || ""));
  todayMeetings.sort(byTime);

  return json(res, 200, { todayMeetings, recommended, decisionPending, contactPending });
}
