// 採用HR（/hr）。値の定義・正規化・状態の判定。
// db/081_hr_recruiting.sql と1対1。api/hr/*.js から使う。
//
// ■ 選考ステージと対応ステータスは別軸（README・db/081と同じ注意）
//   stage＝いまどこにいるか。status＝いま誰が何をすべきか。混ぜない。

import crypto from "node:crypto";

export const STAGES = [
  { key: "applied", label: "新規応募" },
  { key: "casual_interview", label: "カジュアル面談" },
  { key: "ceo_recommend", label: "社長推薦" },
  { key: "ceo_interview", label: "社長面談" },
  { key: "offer", label: "内定" },
  { key: "joining_scheduled", label: "入社予定" },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);
export const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

export const STATUSES = [
  "todo", "scheduling", "interview_scheduled", "eval_pending",
  "ceo_recommend_pending", "ceo_interview_pending", "ceo_decision_pending",
  "next_scheduling_pending", "offer_draft_pending", "offer_review_pending",
  "offer_send_pending", "offer_response_pending", "accepted", "declined", "done", "passed",
];
export const STATUS_LABEL = {
  todo: "未対応", scheduling: "日程調整中", interview_scheduled: "面談予定",
  eval_pending: "評価入力待ち", ceo_recommend_pending: "社長推薦待ち",
  ceo_interview_pending: "社長面談設定待ち", ceo_decision_pending: "社長判断待ち",
  next_scheduling_pending: "次回調整待ち", offer_draft_pending: "合格通知作成待ち",
  offer_review_pending: "社内確認待ち", offer_send_pending: "本人送付待ち",
  offer_response_pending: "承諾待ち", accepted: "承諾済み", declined: "辞退",
  done: "完了", passed: "見送り",
};
// 終わっている（もう対応の要らない）状態。期限超過の判定から除く
export const CLOSED_STATUSES = ["accepted", "declined", "done", "passed"];

export const RANKS = ["A", "B", "C", "D"];
export const RANK_LABEL = {
  A: "ぜひ社長に会わせたい", B: "社長に会わせてもよい", C: "もう少し確認したい", D: "今回は見送り",
};

// 面談のランクから、そのあとの対応ステータスを機械的に決める
// （README「面談結果入力モーダル保存→…自動遷移」のとおり）
export const nextStatusFromRank = (rank) => (
  rank === "A" || rank === "B" ? "ceo_recommend_pending"
    : rank === "C" ? "next_scheduling_pending"
    : rank === "D" ? "passed"
    : "eval_pending"
);

/** 対応期限を過ぎていて、まだ終わっていないか */
export function isOverdue(applicant, today = new Date().toISOString().slice(0, 10)) {
  if (!applicant?.decision_due_on) return false;
  if (CLOSED_STATUSES.includes(applicant.status)) return false;
  return applicant.decision_due_on < today;
}

// ---- 合格通知トークン。外部メンバー招待（lib/guests.js）と同じ考え方 -----------
export const OFFER_TTL_DAYS = 30;
export const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
export const newOfferToken = () => crypto.randomBytes(32).toString("base64url");
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/** 合格通知（gw_hr_offers）1件の、いまの状態 */
export function offerStatus(offer) {
  if (!offer) return "none";
  if (offer.accepted_at) return "accepted";
  if (offer.declined_at) return "declined";
  if (offer.revoked_at) return "revoked";
  if (new Date(offer.expires_at).getTime() < Date.now()) return "expired";
  if (offer.sent_at) return "sent";
  return "draft";
}

// ---- admin-onboard.html（api/employees/onboard.js）へ渡す項目 -----------------
// gw_hr_applicants の列名を、そのままフォームの項目名として渡せるようにしておく
// （名前を変換する層を作らない。二重に定義を持たない）
export const ONBOARD_PREFILL_FIELDS = [
  "name", "email", "join_date", "contract_type", "contract_end_date",
  "probation_months", "wage_type", "wage_amount", "weekly_hours",
];

const str = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };
const num = (v) => (v === "" || v == null ? null : Number(v));

/**
 * 応募者の入力チェック。
 * @param {{partial?: boolean}} [opts] partial=true は更新用。渡された項目だけ検証する
 */
export function normalizeApplicant(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("name")) {
    const name = str(body.name, 100);
    if (!name) return { error: "invalid_body", detail: "氏名は必須です" };
    v.name = name;
  }
  if (!partial || has("jobTitle")) {
    const job = str(body.jobTitle, 100);
    if (!job) return { error: "invalid_body", detail: "応募職種は必須です" };
    v.job_title = job;
  }
  if (!partial || has("source")) {
    const source = str(body.source, 100);
    if (!source) return { error: "invalid_body", detail: "応募媒体は必須です" };
    v.source = source;
  }
  if (has("email")) v.email = str(body.email, 200);
  if (has("phone")) v.phone = str(body.phone, 40);
  if (has("profileUrl")) v.profile_url = str(body.profileUrl, 500);
  if (has("recruiterId")) v.recruiter_id = body.recruiterId || null;
  if (has("note")) v.note = str(body.note, 2000);
  if (has("decisionDueOn")) v.decision_due_on = body.decisionDueOn || null;

  if (has("stage")) {
    if (!STAGE_KEYS.includes(body.stage)) return { error: "invalid_body", detail: `stage は ${STAGE_KEYS.join("/")} のいずれかです` };
    v.stage = body.stage;
  }
  if (has("status")) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_body", detail: "status が不正です" };
    v.status = body.status;
  }
  if (has("rank")) {
    if (body.rank !== null && !RANKS.includes(body.rank)) return { error: "invalid_body", detail: "rank は A/B/C/D のいずれかです" };
    v.rank = body.rank || null;
  }

  // 採用条件（SSOT）。admin-onboard.html と同じ項目名で持つ
  if (has("employmentType")) v.employment_type = str(body.employmentType, 100);
  if (has("contractType")) v.contract_type = str(body.contractType, 20);
  if (has("contractEndDate")) v.contract_end_date = body.contractEndDate || null;
  if (has("joinDate")) v.join_date = body.joinDate || null;
  if (has("probationMonths")) v.probation_months = num(body.probationMonths);
  if (has("wageType")) v.wage_type = str(body.wageType, 20);
  if (has("wageAmount")) v.wage_amount = num(body.wageAmount);
  if (has("weeklyHours")) v.weekly_hours = num(body.weeklyHours);
  if (has("workLocation")) v.work_location = str(body.workLocation, 200);

  return { value: v };
}

/** 応募者の、既存の採用条件を合格通知へスナップショットする形にする */
export function snapshotOfferFields(applicant) {
  return {
    job_title: applicant.job_title, employment_type: applicant.employment_type,
    contract_type: applicant.contract_type, contract_end_date: applicant.contract_end_date,
    join_date: applicant.join_date, probation_months: applicant.probation_months,
    wage_type: applicant.wage_type, wage_amount: applicant.wage_amount,
    weekly_hours: applicant.weekly_hours, work_location: applicant.work_location,
  };
}

export const shapeApplicant = (a) => ({
  id: a.id, name: a.name, email: a.email, phone: a.phone, profileUrl: a.profile_url,
  source: a.source, jobTitle: a.job_title,
  stage: a.stage, stageLabel: STAGE_LABEL[a.stage] || a.stage,
  status: a.status, statusLabel: STATUS_LABEL[a.status] || a.status,
  rank: a.rank, decision: a.decision, decisionDueOn: a.decision_due_on,
  overdue: isOverdue(a),
  recruiterId: a.recruiter_id,
  employmentType: a.employment_type, contractType: a.contract_type,
  contractEndDate: a.contract_end_date, joinDate: a.join_date,
  probationMonths: a.probation_months, wageType: a.wage_type, wageAmount: a.wage_amount,
  weeklyHours: a.weekly_hours, workLocation: a.work_location,
  employeeId: a.employee_id, note: a.note, createdAt: a.created_at, updatedAt: a.updated_at,
});
