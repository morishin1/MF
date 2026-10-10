// 採用HR（/hr）。値の定義・正規化・状態の判定。
// db/081_hr_recruiting.sql と1対1。api/hr/*.js から使う。
//
// ■ 選考ステージと対応ステータスは別軸（README・db/081と同じ注意）
//   stage＝いまどこにいるか。status＝いま誰が何をすべきか。混ぜない。

import crypto from "node:crypto";
import { when as jstWhen, ymd as jstYmd } from "./jst.js";
import {
  leadStageLabel, leadStatusLabel, leadNextActionOf, leadNextActionLabel, LEAD_CATEGORY_LABEL,
} from "./hr-lead-flow.js";
import {
  OFFER_TYPE_KEYS, offerTypeOf, publicOfferView, offerTypeLabel, offerStatusLabel, offerNextAction, recruitStepsOf,
  normalizeOfferTerms, columnKeysOf,
} from "./hr-offer-types.js";

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
  "offer_send_pending", "offer_sent", "offer_viewed", "offer_resend_pending",
  "offer_response_pending", "accepted", "declined", "done", "passed",
];
export const STATUS_LABEL = {
  todo: "未対応", scheduling: "日程調整中", interview_scheduled: "面談予定",
  eval_pending: "評価入力待ち", ceo_recommend_pending: "社長推薦待ち",
  ceo_interview_pending: "社長面談設定待ち", ceo_decision_pending: "社長判断待ち",
  next_scheduling_pending: "次回調整待ち", offer_draft_pending: "合格通知作成待ち",
  offer_review_pending: "社内確認待ち", offer_send_pending: "本人送付待ち",
  offer_sent: "本人送付済み", offer_viewed: "本人が閲覧済み", offer_resend_pending: "URL再送待ち",
  offer_response_pending: "承諾待ち", accepted: "承諾済み", declined: "辞退",
  done: "完了", passed: "見送り",
};
// 終わっている（もう対応の要らない）状態。期限超過の判定から除く
export const CLOSED_STATUSES = ["accepted", "declined", "done", "passed"];

// NEXT ACTION。「いま誰が何をすべきか」を1行で言う（README §31の考え方）
export const NEXT_ACTION_LABEL = {
  todo: "対応を進めてください", scheduling: "日程調整を進めてください",
  interview_scheduled: "面談を実施してください", eval_pending: "面談結果を入力してください",
  ceo_recommend_pending: "社長推薦してください", ceo_interview_pending: "社長面談を設定してください",
  ceo_decision_pending: "社長判断をしてください", next_scheduling_pending: "次回の日程調整をしてください",
  offer_draft_pending: "合格通知を作成してください", offer_review_pending: "内容を確認してください",
  offer_send_pending: "合格通知を本人へ送ってください", offer_sent: "本人の確認を待っています",
  offer_viewed: "本人が合格通知を確認しました", offer_resend_pending: "URLを再発行しました。本人へ再送してください",
  offer_response_pending: "本人の回答を待っています",
  accepted: "本採用へ進めてください", declined: "対応は不要です", done: "対応は不要です", passed: "対応は不要です",
};

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
export function isOverdue(applicant, today = jstYmd()) {
  if (!applicant?.decision_due_on) return false;
  if (CLOSED_STATUSES.includes(applicant.status)) return false;
  return applicant.decision_due_on < today;
}

// ---- 面談・評価（Stage 3） -----------------------------------------------------

/** 面談の種別 */
export const INTERVIEW_KINDS = [
  { key: "casual", label: "カジュアル面談" },
  { key: "ceo", label: "社長面談" },
];
export const interviewKindLabel = (k) => INTERVIEW_KINDS.find((x) => x.key === k)?.label || k;

/** 面談方法（db/109）。未設定はnull（既存の面談は推測で埋めない） */
export const INTERVIEW_METHODS = [
  { key: "online", label: "オンライン" },
  { key: "onsite", label: "対面" },
  { key: "phone", label: "電話" },
];
export const interviewMethodLabel = (k) => INTERVIEW_METHODS.find((x) => x.key === k)?.label || null;

/** 面談メモの上限（db/109 の gw_hr_interviews_memo_len_check と同じ） */
export const INTERVIEW_MEMO_MAX = 4000;

/**
 * TimeRex同期済みの面談か（db/089 の timerex_event_id が入っている）。
 * 日時・面談URLはTimeRex側が正（lib/hr-timerex.js がWebhookのたびに上書きする）ので、
 * アプリからは編集させない（api/hr/interviews/index.js の update）
 */
export const isTimerexInterview = (i) => Boolean(i?.timerex_event_id);
/** TimeRex同期済みの面談で、アプリから直せない項目（normalizeInterview() 後の列名） */
export const TIMEREX_MANAGED_COLUMNS = ["scheduled_at", "meeting_url"];

/**
 * 5項目評価。◎○△×の4段階。長いフォームにしない（README §4の方針）。
 * scores は {key: "great"|"good"|"fair"|"bad"} の jsonb で持つ（固定の列にしない）
 */
export const EVAL_ITEMS = [
  { key: "communication", label: "コミュニケーション" },
  { key: "experience", label: "経験・スキル" },
  { key: "orientation", label: "志向性" },
  { key: "culture_fit", label: "カルチャーフィット" },
  { key: "potential", label: "期待値／ポテンシャル" },
];
export const EVAL_SCALE = [
  { key: "great", label: "◎" }, { key: "good", label: "○" },
  { key: "fair", label: "△" }, { key: "bad", label: "×" },
];
export const EVAL_SCALE_KEYS = EVAL_SCALE.map((s) => s.key);

/**
 * いまの選考段階（stage）で実施する面談の種類。
 * 社長面談の段階なら ceo、それより前（新規応募・カジュアル面談・社長推薦）なら casual。
 * 内定より後は種類で絞らない（null）。
 */
export function interviewKindForStage(stage) {
  if (stage === "ceo_interview") return "ceo";
  if (["applied", "casual_interview", "ceo_recommend"].includes(stage)) return "casual";
  return null;
}

/**
 * NEXT ACTION が指す面談（gw_hr_interviews の行）。実施前・キャンセルでない、いまの段階の種類のうち、
 * いちばん近い予定のもの。画面は「未完了の先頭」を推測で探さず、ここで決めた ID（nextInterviewId）で操作する
 * （古いカジュアル面談が残っていても、社長面談の段階なら社長面談だけを指す）。
 */
export function pickNextInterview(applicant, interviews) {
  const kind = interviewKindForStage(applicant?.stage);
  const open = (interviews || []).filter((i) => !i.conducted_at && !i.canceled_at && (!kind || i.kind === kind));
  open.sort((x, y) => (x.scheduled_at ? 0 : 1) - (y.scheduled_at ? 0 : 1)
    || String(x.scheduled_at || "").localeCompare(String(y.scheduled_at || "")));
  return open[0] || null;
}

/** 状態プルダウンの選択肢。STATUSES / STATUS_LABEL が正（画面側に別の定義を持たない） */
export const STATUS_OPTIONS = STATUSES.map((key) => ({ key, label: STATUS_LABEL[key] }));

const OFFER_STAGES = ["offer", "joining_scheduled"];
const OFFER_STATUSES = [
  "offer_draft_pending", "offer_review_pending", "offer_send_pending", "offer_sent", "offer_viewed",
  "offer_resend_pending", "offer_response_pending", "accepted",
];

/**
 * 状態（status）を手動で変えるときの注意。データの食い違いが大きくなるものを文で返す（空なら注意なし）。
 * 状態の変更は面談そのもの（日時・取消・Meet URL）を変えない。TimeRex 連携の面談は TimeRex が正。
 * @param {{stage:string,status:string}} a  gw_hr_applicants の行
 * @param {object[]} interviews gw_hr_interviews の行（kind・conducted_at・canceled_at・timerex_event_id）
 * @param {string} to 変更先の status
 */
export function statusChangeWarnings(a, interviews, to) {
  const list = interviews || [];
  const active = list.filter((i) => !i.conducted_at && !i.canceled_at);
  const conducted = (kind) => list.some((i) => i.kind === kind && i.conducted_at && !i.canceled_at);
  const stageKind = interviewKindForStage(a?.stage);
  const out = [];
  if (to === "interview_scheduled") {
    if (!active.length) {
      out.push("有効な（実施前・キャンセルされていない）面談が1件もありません。「面談予定」にしても実施済みにできません。先に面談を予定してください。");
    } else if (stageKind && !active.some((i) => i.kind === stageKind)) {
      out.push(`いまの選考段階（${STAGE_LABEL[a.stage] || a.stage}）の${interviewKindLabel(stageKind)}が予定されていません。`);
    }
  }
  if (to === "eval_pending" && !conducted("casual")) {
    out.push("実施済みのカジュアル面談がありません。評価を入力する面談がない状態になります。");
  }
  if (to === "ceo_decision_pending" && !conducted("ceo")) {
    out.push("実施済みの社長面談がありません。社長面談をせずに社長判断待ちになります。");
  }
  if (["todo", "scheduling", "ceo_interview_pending", ...CLOSED_STATUSES].includes(to) && active.length) {
    const tr = active.some((i) => i.timerex_event_id);
    out.push(`予定中の面談が${active.length}件あります。状態を変えても面談の予定は取り消されません`
      + `${tr ? "（TimeRex連携の面談は TimeRex から取り消してください）" : "（不要なら面談タブからキャンセルしてください）"}。`);
  }
  if (OFFER_STATUSES.includes(to) && !OFFER_STAGES.includes(a?.stage)) {
    out.push(`選考段階が「${STAGE_LABEL[a?.stage] || a?.stage || "—"}」のままです。合格通知は採用判断（内定）から進めるのが通常です。`);
  }
  return out;
}

/** 面談の予定・実施状態。1つの列（status）で表す。gw_hr_interviews.conducted_at の有無から出す */
export const interviewDone = (i) => Boolean(i?.conducted_at);

/**
 * NEXT ACTION。「いま何をすべきか」を1つに絞って返す。
 *
 * ■ ランクだけで採用判断を確定しない（README §5・§7）
 *   評価を保存すると status は機械的に進む（nextStatusFromRank）。
 *   ただしそこから先の「社長推薦」「見送り」の最終確定は、
 *   このNEXT ACTIONのボタンを人が押してはじめて動く。
 *
 * @param {object} a shapeApplicant() 済みの応募者（status/rank/decision を見る）
 * @param {object|null} [nextInterview] NEXT ACTION が指す面談（{id, scheduledAt, kind}）。
 *   null は「調べたが有効な面談が無い」、省略（undefined）は「調べていない」
 * @param {object} [currentOffer] いま有効な合格通知（{sentAt, viewedAt}。README Stage 6）
 * @returns {{label:string, cta:string|null, action:string|null, kind?:string}}
 */
export function nextActionOf(a, nextInterview = undefined, currentOffer = null) {
  // 無限道場リードは、面談の前後だけ次にすることが違う（lib/hr-lead-flow.js。同じものは下の採用の判定へ）
  const lead = leadNextActionOf(a);
  if (lead) return lead;
  // TimeRexへ日程調整を任せるのが通常導線（README「TimeRex連携」指示書）。
  // 手入力（openScheduleForm）は、TimeRexが使えないときの例外導線として残す
  if (a.status === "todo") {
    return { label: "カジュアル面談の日程を調整してください", cta: "日程調整を送る", action: "sendSchedulingLink", kind: "casual" };
  }
  // 候補者がTimeRexで予約するのを待っている状態。面談キャンセル後もここへ戻る
  // （応募者一覧・ドロワーUI改善指示書 §3）。手入力はここでも例外として使える
  if (a.status === "scheduling") {
    return { label: "カジュアル面談の日程を再調整してください", cta: "手動で面談を設定", action: "schedule", kind: "casual" };
  }
  if (a.status === "interview_scheduled") {
    // 面談を調べた結果、いまの選考段階の有効な面談が無い（null）。「実施済みにする」は出さない
    // （押しても実施する面談が無い）。undefined は「調べていない」なので従来どおり
    if (nextInterview === null) {
      return { label: "面談予定の記録を確認してください", cta: "面談タブを確認", action: "checkInterviews" };
    }
    return {
      label: nextInterview?.scheduledAt
        ? `${fmtWhen(nextInterview.scheduledAt)} ${interviewKindLabel(nextInterview.kind)}`
        : NEXT_ACTION_LABEL.interview_scheduled,
      cta: "面談を実施済みにする", action: "conduct",
    };
  }
  if (a.status === "eval_pending") {
    return { label: NEXT_ACTION_LABEL.eval_pending, cta: "評価を入力", action: "evaluate" };
  }
  if (a.status === "ceo_recommend_pending") {
    // A・Bはどちらも同じstatus（社長推薦の要否そのものを判定中）だが、
    // 次にすべきことはランクで変わる：Aは推薦へ、Bはもう1回確認する面談へ
    return a.rank === "B"
      ? { label: "追加確認が必要です", cta: "次回面談を設定", action: "schedule", kind: "casual" }
      : { label: "社長に会ってほしい候補です", cta: "社長推薦する", action: "recommend" };
  }
  if (a.status === "next_scheduling_pending") {
    return { label: "保留中です", cta: "判断を更新", action: "evaluate" };
  }
  if (a.status === "passed") {
    if (a.decision === "rejected") return { label: NEXT_ACTION_LABEL.passed, cta: null, action: null };
    return { label: "見送り候補です", cta: "見送りを確定", action: "reject" };
  }
  if (a.status === "ceo_interview_pending") {
    return { label: NEXT_ACTION_LABEL.ceo_interview_pending, cta: "社長面談を設定", action: "schedule", kind: "ceo" };
  }
  if (a.status === "ceo_decision_pending") {
    if (a.decision === "hold") {
      const nextStep = a.hold_next_step ?? a.holdNextStep;
      const dueOn = a.decision_due_on ?? a.decisionDueOn;
      return {
        label: [nextStep, dueOn ? `（${dueOn}までに再判断）` : null].filter(Boolean).join("　") || "保留中です",
        cta: "採用判断を更新", action: "decide",
      };
    }
    return { label: NEXT_ACTION_LABEL.ceo_decision_pending, cta: "採用判断", action: "decide" };
  }
  // 合格通知（Stage 5：README §17・db/081の3ステータス）
  // 合格後は、まず採用区分（正社員・育成・業務委託・パート・スポット）を選び、その区分のオファーを作る
  // （lib/hr-offer-types.js。区分が無いまま作られた、これまでの合格通知は従来どおり）
  const offerType = a.offer_type ?? a.offerType ?? null;
  if (a.status === "offer_draft_pending") return offerNextAction(a.status, offerType);
  if (a.status === "offer_review_pending") {
    const typed = offerNextAction(a.status, offerType);
    if (typed) return typed;
    return { label: NEXT_ACTION_LABEL.offer_review_pending, cta: "内容を確認する", action: "reviewOffer" };
  }
  // 回答期限切れ（Stage 7）。候補者は公開APIで既にアクセスできなくなっているが
  // （README Stage 6 §7）、HR側にも「時間切れで止まっている」ことを知らせる。
  // 専用の対応ステータスは持たない（表示のみの判定。isOverdueと同じ考え方）
  const AWAITING_RESPONSE = [
    "offer_send_pending", "offer_resend_pending", "offer_sent", "offer_viewed", "offer_response_pending",
  ];
  if (AWAITING_RESPONSE.includes(a.status) && currentOffer?.expiresAt
      && new Date(currentOffer.expiresAt).getTime() < Date.now()) {
    return { label: "回答期限を過ぎました。再発行するか、本人へ確認してください", cta: "URLを再発行", action: "reissueOffer" };
  }
  // 本人専用URL発行・送付・閲覧確認（Stage 6）
  if (a.status === "offer_send_pending") {
    const typed = offerNextAction(a.status, offerType);
    if (typed) return typed;
    return { label: NEXT_ACTION_LABEL.offer_send_pending, cta: "本人へ送る", action: "sendOffer" };
  }
  if (a.status === "offer_resend_pending") {
    return { label: NEXT_ACTION_LABEL.offer_resend_pending, cta: "本人へ再送", action: "sendOffer" };
  }
  if (a.status === "offer_sent") {
    const meta = currentOffer?.sentAt ? `送付：${fmtWhen(currentOffer.sentAt)}　閲覧：未確認` : null;
    return {
      label: [NEXT_ACTION_LABEL.offer_sent, meta].filter(Boolean).join("　"),
      cta: "URLを再発行", action: "reissueOffer",
    };
  }
  // 閲覧済み・承諾待ち（Stage 7）。閲覧できた時点で「本人の回答を待っています」へ
  // 進める（README「閲覧済み→承諾待ち」の実体は同じ1つの状態として扱う。
  // offer_viewedは古い行のための後方互換として残す）
  if (a.status === "offer_viewed" || a.status === "offer_response_pending") {
    const meta = currentOffer?.sentAt && currentOffer?.viewedAt
      ? `送付：${fmtWhen(currentOffer.sentAt)}　閲覧：${fmtWhen(currentOffer.viewedAt)}` : null;
    return {
      label: [NEXT_ACTION_LABEL.offer_response_pending, meta].filter(Boolean).join("　"),
      cta: "URLを再発行", action: "reissueOffer",
    };
  }
  // 本採用へ進める（Stage 8）。承諾済みから、既存のadmin-onboard.htmlへつなぐ
  if (a.status === "accepted") {
    const claimedAt = a.advance_claimed_at ?? a.advanceClaimedAt;
    if (claimedAt && !isAdvanceClaimStale(claimedAt)) {
      return { label: "本採用の手続き中です（admin-onboardで入力中）", cta: "続きを開く", action: "advance" };
    }
    const typed = offerNextAction(a.status, offerType);
    if (typed) return typed;
    return { label: NEXT_ACTION_LABEL.accepted, cta: "本採用へ進める", action: "advance" };
  }
  return { label: NEXT_ACTION_LABEL[a.status] || "", cta: null, action: null };
}

// 日本時間で「本日 16:15」/「2026/10/1 16:15」（サーバは UTC なので lib/jst.js を通す）
const fmtWhen = (iso) => jstWhen(iso);

/**
 * 面談（作成・編集）の入力チェック。
 * @param {{partial?: boolean}} [opts] partial=true は「実施済みにする」「評価を入れる」など、渡された項目だけ検証する
 */
export function normalizeInterview(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;
  const str = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };

  if (!partial || has("kind")) {
    if (!INTERVIEW_KINDS.some((k) => k.key === body.kind)) {
      return { error: "invalid_body", detail: "面談種別は casual か ceo です" };
    }
    v.kind = body.kind;
  }
  if (has("scheduledAt")) {
    // 日時として読めない文字列は保存しない（一覧・詳細・今日の面談の並びが壊れるため）
    if (body.scheduledAt && Number.isNaN(Date.parse(body.scheduledAt))) {
      return { error: "invalid_body", detail: "面談日時の形式が正しくありません" };
    }
    v.scheduled_at = body.scheduledAt || null;
  }
  if (has("conductedAt")) v.conducted_at = body.conductedAt || null;
  if (has("interviewerId")) v.interviewer_id = body.interviewerId || null;
  if (has("meetingUrl")) {
    const meetingUrl = str(body.meetingUrl, 500);
    // 録画URLと同じく、空欄（=削除）は許可し、値がある場合だけ http(s) を強制する
    if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) {
      return { error: "invalid_body", detail: "面談URLは http:// か https:// で始まるURLにしてください" };
    }
    v.meeting_url = meetingUrl;
  }
  if (has("method")) {
    if (body.method && !INTERVIEW_METHODS.some((m) => m.key === body.method)) {
      return { error: "invalid_body", detail: "面談方法は online / onsite / phone のいずれかです" };
    }
    v.method = body.method || null;
  }
  if (has("recordingUrl")) {
    const recordingUrl = str(body.recordingUrl, 500);
    // 空欄（=削除）は許可する。値がある場合だけ http(s) を強制する
    // （Google Driveに限定しすぎず、将来ほかの許可ストレージへ差し替えられる余地を残す。
    // 採用HR録画URL手動登録UI 追加指示 §5・§6）
    if (recordingUrl && !/^https?:\/\//i.test(recordingUrl)) {
      return { error: "invalid_body", detail: "録画URLは http:// か https:// で始まるURLにしてください" };
    }
    v.recording_url = recordingUrl;
  }
  if (has("notes")) v.notes = str(body.notes, 1000);
  if (has("recommendReason")) v.recommend_reason = str(body.recommendReason, 500);
  if (has("nextDueOn")) v.next_due_on = body.nextDueOn || null;

  if (has("rank")) {
    if (body.rank !== null && !RANKS.includes(body.rank)) {
      return { error: "invalid_body", detail: "rank は A/B/C/D のいずれかです" };
    }
    v.rank = body.rank || null;
  }
  if (has("scores")) {
    if (body.scores && typeof body.scores === "object") {
      const bad = Object.entries(body.scores).find(([k, val]) =>
        !EVAL_ITEMS.some((e) => e.key === k) || !EVAL_SCALE_KEYS.includes(val));
      if (bad) return { error: "invalid_body", detail: "評価の項目・値が不正です" };
      v.scores = body.scores;
    } else {
      v.scores = {};
    }
  }

  return { value: v };
}

export const shapeInterview = (i) => ({
  id: i.id, applicantId: i.applicant_id, kind: i.kind, kindLabel: interviewKindLabel(i.kind),
  scheduledAt: i.scheduled_at, conductedAt: i.conducted_at, done: interviewDone(i),
  canceledAt: i.canceled_at, canceled: Boolean(i.canceled_at),
  interviewerId: i.interviewer_id, meetingUrl: i.meeting_url, recordingUrl: i.recording_url,
  scores: i.scores || {}, rank: i.rank, recommendReason: i.recommend_reason, notes: i.notes,
  nextDueOn: i.next_due_on, createdAt: i.created_at,
  // db/109：面談方法・面談メモ（未適用の環境では undefined → null）
  method: i.method || null, methodLabel: interviewMethodLabel(i.method),
  memo: i.memo ?? null, memoUpdatedAt: i.memo_updated_at || null,
  // TimeRex同期済みなら、日時・面談URLはTimeRex側で変える（画面は入力欄を読み取り専用にする）
  fromTimerex: isTimerexInterview(i), timerexSyncedAt: i.timerex_synced_at || null,
  // TimeRex 連携の面談（timerex_event_id がある）は TimeRex を正とする。
  // 日程変更・取消は TimeRex の導線から（採用HRの画面だけに出す。ログには残さない）
  timerex: i.timerex_event_id ? {
    linked: true, syncedAt: i.timerex_synced_at || null,
    rescheduleUrl: i.timerex_reschedule_url || null,
    cancelUrl: i.timerex_host_cancel_url || i.timerex_guest_cancel_url || null,
  } : null,
});

// ---- TimeRex連携（カジュアル面談の日程調整） -----------------------------------
//
// ■ 応募者の一意識別（README「TimeRex連携」指示書 §11）
//   候補者名・メールだけで照合しない。TimeRex公式が対応しているURLパラメータで
//   gw_hr_applicants.id をそのまま引き回す（TimeRex側の予約ごとに発行される
//   event_idとは別物。event_idは重複防止キー、applicant_idは応募者の特定に使う）
//
// env読み取りは呼び出し側（api/hr/applicants/detail.js）で行い、ここは
// 素のURL組み立てだけにする（テストしやすくするため。他のlib/hr.jsの関数と揃える）
export function schedulingUrlFor(baseUrl, applicantId) {
  const base = String(baseUrl || "").trim();
  if (!base || !applicantId) return null;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}applicant_id=${encodeURIComponent(applicantId)}`;
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
  if (offer.viewed_at) return "viewed";
  if (offer.sent_at) return "sent";
  return "draft";
}

/** 応募者の合格通知一覧から、いま有効な（無効化されていない）最新の1件を選ぶ（README Stage 6 §5・§20） */
export const activeOffer = (offers) => (offers || [])
  .filter((o) => !o.revoked_at)
  .sort((a, b) => b.version - a.version)[0] || null;

/** 回答期限（date）から、公開URLの有効期限（timestamptz）を出す。期限と揃える（README Stage 6 §7） */
export const offerExpiresAt = (respondBy) => new Date(`${respondBy}T23:59:59+09:00`).toISOString();

export const shapeOffer = (o) => ({
  id: o.id, applicantId: o.applicant_id, version: o.version, status: offerStatus(o),
  jobTitle: o.job_title, employmentType: o.employment_type, contractType: o.contract_type,
  contractEndDate: o.contract_end_date, joinDate: o.join_date, probationMonths: o.probation_months,
  wageType: o.wage_type, wageAmount: o.wage_amount, weeklyHours: o.weekly_hours,
  workLocation: o.work_location, messageToCandidate: o.message_to_candidate, respondBy: o.respond_by,
  sentAt: o.sent_at, viewedAt: o.viewed_at, acceptedAt: o.accepted_at,
  declinedAt: o.declined_at, declineReason: o.decline_reason, expiresAt: o.expires_at,
  createdAt: o.created_at,
  // 採用区分と、区分ごとの条件（db/128。給与にあたる incentive・commuteCost は lib/salary.js が出口で外す）
  offerType: o.offer_type ?? null, offerTypeLabel: offerTypeLabel(o.offer_type),
  offerName: offerTypeOf(o.offer_type)?.offerName || "合格通知",
  offerTerms: o.offer_terms ?? {},
});

/**
 * 合格通知の入力チェック。作成時（partial=false）は、応募者の現在の採用条件
 * （snapshotOfferFields）を土台にして、渡された項目だけ上書きする
 * （項目を全部書き直させない。README Stage 6 §10と同じ「スナップショット」の考え方）。
 * 回答期限（respondBy）は必須（公開URLの有効期限に使う。README Stage 6 §7）。
 * @param {{partial?: boolean}} [opts] partial=true は編集用（社内確認待ちの間だけ。README Stage 6 §6）
 */
export function normalizeOffer(body, applicant, { partial = false, offerType = null, salary = true, previousTerms = {} } = {}) {
  const v = partial ? {} : { ...snapshotOfferFields(applicant) };
  const type = offerTypeOf(offerType);
  const has = (k) => body[k] !== undefined;
  const s = (x, max) => { const t = String(x ?? "").trim(); return t ? t.slice(0, max) : null; };
  const n = (x) => (x === "" || x == null ? null : Number(x));

  if (has("jobTitle")) v.job_title = s(body.jobTitle, 100);
  if (has("employmentType")) v.employment_type = s(body.employmentType, 100);
  if (has("contractType")) v.contract_type = s(body.contractType, 20);
  if (has("contractEndDate")) v.contract_end_date = body.contractEndDate || null;
  if (has("joinDate")) v.join_date = body.joinDate || null;
  if (has("probationMonths")) v.probation_months = n(body.probationMonths);
  if (has("wageType")) v.wage_type = s(body.wageType, 20);
  if (has("wageAmount")) v.wage_amount = n(body.wageAmount);
  if (has("weeklyHours")) v.weekly_hours = n(body.weeklyHours);
  if (has("workLocation")) v.work_location = s(body.workLocation, 200);
  if (has("messageToCandidate")) v.message_to_candidate = s(body.messageToCandidate, 1000);

  // 採用区分つき（db/128）。区分で決めた項目だけを受け付ける
  if (type) {
    const allowed = new Set([...columnKeysOf(type.key), "messageToCandidate", "respondBy"]);
    const wageField = type.fields.find((f) => f.key === "wageType");
    if (v.wage_type && wageField && !wageField.options.includes(v.wage_type) && has("wageType")) {
      return { error: "invalid_body", detail: `${wageField.label}は ${wageField.options.join("／")} から選んでください` };
    }
    const empField = type.fields.find((f) => f.key === "employmentType");
    if (has("employmentType") && empField && v.employment_type && !empField.options.includes(v.employment_type)) {
      return { error: "invalid_body", detail: `${empField.label}は ${empField.options.join("／")} から選んでください` };
    }
    // 区分に無い既存の列（例：業務委託の試用期間）は受け付けない。作成時は応募者の値も持ち込まない
    // （職種・雇用形態は区分の項目に無くても、社内の記録として応募者の値・区分の値を残す）
    for (const [col, key] of [["probation_months", "probationMonths"], ["weekly_hours", "weeklyHours"],
      ["contract_end_date", "contractEndDate"], ["contract_type", "contractType"], ["join_date", "joinDate"],
      ["work_location", "workLocation"]]) {
      if (allowed.has(key)) continue;
      if (partial) delete v[col]; else v[col] = null;
    }
    if (!partial) {
      v.offer_type = type.key;
      if (type.employmentType) v.employment_type = type.employmentType;
      // 応募者に入っていた値が、この区分の選択肢に無ければ持ち込まない（業務委託に「月給」、パートに「正社員」など）
      if (empField && v.employment_type && !empField.options.includes(v.employment_type)) v.employment_type = null;
      if (wageField && v.wage_type && !wageField.options.includes(v.wage_type)) v.wage_type = null;
    }
    if (!partial || has("offerTerms")) {
      const terms = normalizeOfferTerms(type.key, body.offerTerms, { salary, previous: previousTerms });
      if (terms.error) return terms;
      v.offer_terms = terms.value;
    }
  }

  if (!partial || has("respondBy")) {
    if (!body.respondBy) return { error: "invalid_body", detail: "回答期限は必須です" };
    v.respond_by = body.respondBy;
    v.expires_at = offerExpiresAt(body.respondBy);
  }

  return { value: v };
}

// ---- admin-onboard.html（api/employees/onboard.js）へ渡す項目 -----------------
// gw_hr_applicants の列名を、そのままフォームの項目名として渡せるようにしておく
// （名前を変換する層を作らない。二重に定義を持たない）
export const ONBOARD_PREFILL_FIELDS = [
  "name", "email", "join_date", "contract_type", "contract_end_date",
  "probation_months", "wage_type", "wage_amount", "weekly_hours",
];

// admin-onboard.html（readForm()）が実際に使っているキー名はcamelCase。
// 列名をそのまま、のはずが揃っていないので、ここだけ変換する（Stage 8）
const ONBOARD_FIELD_KEY = {
  name: "name", email: "email", join_date: "joinDate", contract_type: "contractType",
  contract_end_date: "contractEndDate", probation_months: "probationMonths",
  wage_type: "wageType", wage_amount: "wageAmount", weekly_hours: "weeklyHours",
};

/**
 * 本採用へ進める（Stage 8）。応募者の採用条件を、admin-onboard.htmlの
 * フォームへそのまま事前入力できる形にする。空の項目は入れない（初期値を壊さない）
 */
export function advancePrefill(applicant) {
  const out = {};
  for (const col of ONBOARD_PREFILL_FIELDS) {
    const v = applicant[col];
    if (v !== null && v !== undefined && v !== "") out[ONBOARD_FIELD_KEY[col]] = v;
  }
  return out;
}

// 「本採用へ進める」のクレーム（advance_claimed_at）が、放置されて
// 有効なままになっていないか。これを過ぎたら、やり直しとして扱ってよい
export const ADVANCE_CLAIM_TTL_MS = 60 * 60 * 1000; // 1時間
export const isAdvanceClaimStale = (claimedAt) =>
  !claimedAt || (Date.now() - new Date(claimedAt).getTime()) > ADVANCE_CLAIM_TTL_MS;

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
  if (has("decision")) {
    if (body.decision !== null && !["hired", "hold", "rejected"].includes(body.decision)) {
      return { error: "invalid_body", detail: "decision は hired/hold/rejected のいずれかです" };
    }
    v.decision = body.decision || null;
  }
  // CEO REVIEW（README §16・db/084）
  if (has("recommendNote")) v.recommend_note = str(body.recommendNote, 500);
  if (has("decisionNote")) v.decision_note = str(body.decisionNote, 500);
  if (has("holdReason")) v.hold_reason = str(body.holdReason, 500);
  if (has("holdNextStep")) v.hold_next_step = str(body.holdNextStep, 500);

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

  // 合格後の採用区分（db/128。lib/hr-offer-types.js）。null で外せる
  if (has("offerType")) {
    if (body.offerType !== null && !OFFER_TYPE_KEYS.includes(body.offerType)) {
      return { error: "invalid_body", detail: `offerType は ${OFFER_TYPE_KEYS.join("/")} のいずれかです` };
    }
    v.offer_type = body.offerType || null;
  }

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

/** 採用の応募者か（無限道場などのリードは、採用区分・ステップバーを持たない） */
const isRecruitLead = (a) => !a?.lead_category || a.lead_category === "recruitment";

/**
 * @param {object} a  gw_hr_applicants の行
 * @param {object} [nextInterview] NEXT ACTION が指す面談（pickNextInterview。{id, scheduledAt, kind}）
 * @param {object} [currentOffer] いま有効な合格通知（{sentAt, viewedAt}。README Stage 6）
 */
export const shapeApplicant = (a, nextInterview = undefined, currentOffer = null) => {
  const next = nextActionOf(a, nextInterview, currentOffer);
  return {
    id: a.id, name: a.name, email: a.email, phone: a.phone, profileUrl: a.profile_url,
    source: a.source, jobTitle: a.job_title,
    stage: a.stage, stageLabel: leadStageLabel(a) || STAGE_LABEL[a.stage] || a.stage,
    status: a.status,
    statusLabel: leadStatusLabel(a) || (isRecruitLead(a) && offerStatusLabel(a.status, a.offer_type)) || STATUS_LABEL[a.status] || a.status,
    // 合格後の採用区分（db/128。未適用・未選択は null）と、採用フロー上の現在地（ステップバー）
    offerType: a.offer_type ?? null, offerTypeLabel: offerTypeLabel(a.offer_type),
    steps: isRecruitLead(a) ? recruitStepsOf(a) : null,
    nextAction: next.label, nextActionCta: next.cta, nextActionKey: next.action, nextActionKind: next.kind || null,
    // NEXT ACTION の「面談を実施済みにする」が操作する面談。画面側で推測して探さない
    nextInterviewId: nextInterview?.id || null, nextInterviewKind: nextInterview?.kind || null,
    rank: a.rank, decision: a.decision, decisionDueOn: a.decision_due_on,
    recommendNote: a.recommend_note, decisionNote: a.decision_note,
    holdReason: a.hold_reason, holdNextStep: a.hold_next_step,
    overdue: isOverdue(a),
    recruiterId: a.recruiter_id,
    employmentType: a.employment_type, contractType: a.contract_type,
    contractEndDate: a.contract_end_date, joinDate: a.join_date,
    probationMonths: a.probation_months, wageType: a.wage_type, wageAmount: a.wage_amount,
    weeklyHours: a.weekly_hours, workLocation: a.work_location,
    employeeId: a.employee_id, advanceClaimedAt: a.advance_claimed_at,
    note: a.note, createdAt: a.created_at, updatedAt: a.updated_at,
    // リードの区分と、LP から来た情報（db/118。未適用の環境では採用として扱う）
    leadCategory: a.lead_category || "recruitment",
    leadCategoryLabel: LEAD_CATEGORY_LABEL[a.lead_category || "recruitment"] || a.lead_category,
    utmSource: a.utm_source ?? null, utmMedium: a.utm_medium ?? null, utmCampaign: a.utm_campaign ?? null,
    attribution: a.attribution ?? null, leadProfile: a.lead_profile ?? null,
    lastContactedAt: a.last_contacted_at ?? null,
    leadNextAction: a.lead_next_action ?? null, leadNextActionLabel: leadNextActionLabel(a.lead_next_action),
  };
};

/**
 * 応募者の採用区分（db/128）。列がまだ無い環境では null（一覧・詳細はこれまでどおり動かす）。
 * @returns {Promise<{ready: boolean, byId: Map<string, string|null>}>}
 */
export async function readOfferTypes(sb, tenantId, ids) {
  const byId = new Map();
  // 100 件ずつ（条件が URL に入るので、長すぎると断られる。lib/hr-pay.js と同じ）
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("gw_hr_applicants").select("id, offer_type")
      .eq("tenant_id", tenantId).in("id", ids.slice(i, i + 100));
    if (error) return { ready: false, byId: new Map() };
    for (const r of data || []) byId.set(r.id, r.offer_type ?? null);
  }
  return { ready: true, byId };
}

/**
 * 採用判断（内定・保留・見送り）ができる人の社員ID一覧。canDecideHire と同じ基準
 * （経営者・管理者）。通知の宛先探しに使う。呼び出し側は admin() で渡すこと
 * （lib/messages-admin.js の adminSideEmployeeIds は hr も含むため、ここでは分ける）
 */
export async function decisionMakerEmployeeIds(sb, tenantId) {
  const [{ data: adminM }, { data: employees }] = await Promise.all([
    sb.from("memberships").select("user_id").eq("tenant_id", tenantId).eq("role", "admin"),
    sb.from("gw_employees").select("id, user_id").eq("tenant_id", tenantId).neq("status", "left"),
  ]);
  const adminUserIds = new Set((adminM || []).map((m) => m.user_id));
  const ids = new Set();
  const empIds = [];
  for (const e of employees || []) {
    empIds.push(e.id);
    if (e.user_id && adminUserIds.has(e.user_id)) ids.add(e.id);
  }
  if (empIds.length) {
    const { data: grants } = await sb.from("gw_role_grants")
      .select("employee_id").in("employee_id", empIds).eq("role", "owner");
    for (const g of grants || []) ids.add(g.employee_id);
  }
  return [...ids];
}

// ---- 候補者向け公開ページ（Stage 6・7） -----------------------------------------
//
// ■ 本人に見せてよいのは、確定したoffer versionのスナップショットだけ
//   ランク・5項目評価・社内メモ・推薦理由・CEO REVIEWコメント・employee_id・
//   tenant内部IDは絶対に返さない（README Stage 6 §17・§21）
//
// ■ 採用担当の連絡先だけは例外（README Stage 7）
//   「質問がある本人が連絡できる」ことがこの項目の目的そのものなので、
//   氏名・メールアドレスだけを返す（社員IDや他の社員情報は返さない）
export function offerResponseStatus(offer) {
  if (offer.accepted_at) return "accepted";
  if (offer.declined_at) return "declined";
  return "pending";
}
export const shapePublicOffer = (offer, applicant, tenant, recruiter) => ({
  // 採用区分つきのオファー（db/128）だけ：本人向けの書類名・条件の行・承諾後の案内（社内用語・社内用の項目は含めない）
  ...(publicOfferView(offer) || {}),
  tenantName: tenant?.name || null,
  candidateName: applicant.name,
  jobTitle: offer.job_title, employmentType: offer.employment_type, contractType: offer.contract_type,
  contractEndDate: offer.contract_end_date, joinDate: offer.join_date, probationMonths: offer.probation_months,
  wageType: offer.wage_type, wageAmount: offer.wage_amount, weeklyHours: offer.weekly_hours,
  workLocation: offer.work_location, messageToCandidate: offer.message_to_candidate, respondBy: offer.respond_by,
  responseStatus: offerResponseStatus(offer),
  recruiterName: recruiter?.display_name || null, recruiterEmail: recruiter?.email || null,
});
