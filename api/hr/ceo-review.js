// GET /api/hr/ceo-review … 社長が「今日見るべき候補者だけ」を見る3ブロック
//   今日会う人／社長に会ってほしい人／社長判断待ち
//
// 応募者全件は返さない。表示対象は社長推薦（stage: ceo_recommend / ceo_interview）
// まで進んだ人だけ。事務処理（合格通知・onboarding等）は一切含めない（README §11）。
//
// canDecideHire（社長・管理者）だけが見られる。recruiterは社長推薦はできるが、
// この画面自体は開けない（js/hr-layout.js のページ側ガードと同じ基準）

import { ymd as jstYmd } from "../../lib/jst.js";
import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canDecideHire } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { shapeApplicant, shapeInterview } from "../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql・084_hr_ceo_review.sql";
const FIELDS = "id, tenant_id, name, email, phone, profile_url, source, job_title, "
  + "stage, status, rank, recruiter_id, decision, decision_due_on, "
  + "recommend_note, decision_note, hold_reason, hold_next_step, "
  + "employment_type, contract_type, contract_end_date, join_date, probation_months, "
  + "wage_type, wage_amount, weekly_hours, work_location, employee_id, note, created_at, updated_at";
const RELEVANT_STAGES = ["ceo_recommend", "ceo_interview"];

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canDecideHire(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  const { data, error } = await sb.from("gw_hr_applicants").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).in("stage", RELEVANT_STAGES).limit(500);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { todayMeetings: [], recommended: [], decisionPending: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const applicants = data || [];
  if (!applicants.length) return json(res, 200, { todayMeetings: [], recommended: [], decisionPending: [] });

  const ids = applicants.map((a) => a.id);
  const { data: interviews } = await sb.from("gw_hr_interviews").select("*")
    .in("applicant_id", ids).order("created_at", { ascending: false });
  const byApplicant = new Map();
  for (const i of interviews || []) {
    if (!byApplicant.has(i.applicant_id)) byApplicant.set(i.applicant_id, []);
    byApplicant.get(i.applicant_id).push(i);
  }

  const jstToday = jstYmd();
  const todayMeetings = [], recommended = [], decisionPending = [];

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
    };

    const scheduledToday = ceoInterview && !ceoInterview.conducted_at && ceoInterview.scheduled_at
      && jstYmd(ceoInterview.scheduled_at) === jstToday;   // 日本の日付で比べる（UTC の日付で切らない）
    if (scheduledToday) todayMeetings.push(card);
    else if (a.status === "ceo_decision_pending") decisionPending.push(card);
    else recommended.push(card);
  }

  const byTime = (x, y) => String(x.ceoInterview?.scheduledAt || "").localeCompare(String(y.ceoInterview?.scheduledAt || ""));
  todayMeetings.sort(byTime);

  return json(res, 200, { todayMeetings, recommended, decisionPending });
}
