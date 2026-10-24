// 採用HR：応募者詳細の「ステップを直接移動する」（電話で面談・合格を確認した、など実際の進み方に合わせる）。
//
// ■ 何をして、何をしないか
//   する   … 選考段階（stage）と状態（status）を、選んだステップの値にする。合格（内定）へ進めるときは decision=hired も記録する。
//            理由は必須。選考タイムラインと監査ログに「誰が・いつ・変更前 → 変更後・理由」を残す。
//   しない … メール送信・合格通知（オファー）の作成や発行・契約・署名・Office への引き渡し・面談の取消。
//            送付済みの書類・承諾・署名の記録は、戻しても消さない・取り消した扱いにしない。
//
// ■ 動かせないステップ（事実を作ってしまうもの）
//   入社予定（契約・入社手続き）… 本人の承諾と契約の記録からだけ進む。ステップ移動では進めない。
//   承諾・契約・引き渡し・社員登録の記録がある人 … どのステップへも動かさない（記録を守る）。
//   社長判断待ちの人・内定（合格）へ進める操作 … 社長・管理者だけ（採用判断と同じ重さ）。
//
// 画面（hr/applicants.html）と API（api/hr/applicants/detail.js の moveStep）は、どちらもここだけを見る。
import { STAGE_LABEL, STATUS_LABEL, statusChangeWarnings } from "./hr.js";

export const MOVE_STEPS = [
  { key: "applied", label: "新規応募" },
  { key: "casual_interview", label: "カジュアル面談" },
  { key: "ceo_recommend", label: "社長推薦" },
  { key: "ceo_interview", label: "社長面談" },
  { key: "offer", label: "内定" },
  { key: "joining_scheduled", label: "入社予定" },
];
export const MOVE_STEP_KEYS = MOVE_STEPS.map((s) => s.key);
const LABEL = Object.fromEntries(MOVE_STEPS.map((s) => [s.key, s.label]));
export const REASON_MAX = 500;

const CLOSED = ["passed", "declined", "position_closed"];
// 合格通知を作っている・送って本人の回答を待っている状態（内定の中の進み具合。ステップ移動では作らない）
const OFFER_IN_PROGRESS = ["offer_review_pending", "offer_send_pending", "offer_resend_pending", "offer_sent", "offer_viewed", "offer_response_pending"];

const isLeadRow = (a) => a?.lead_category === "mugendojo" || String(a?.stage || "").startsWith("md_");
const conducted = (interviews, kind) => (interviews || []).some((i) => i.kind === kind && i.conducted_at && !i.canceled_at);
const liveOffers = (offers) => (offers || []).filter((o) => !o.revoked_at);

/** 記録を守るために、どこへも動かさない理由（無ければ null） */
function lockReason(a, offers) {
  if (isLeadRow(a)) return "無限道場リードは「次のアクション」で進めます（ステップ移動の対象外です）";
  if (a?.employee_id || a?.status === "done") return "本採用（社員登録）まで進んでいるため、ステップは動かせません";
  const facts = (offers || []).some((o) => o.accepted_at || o.formal_sent_at || o.formal_signed_at || o.handoff_at);
  if (a?.status === "accepted" || facts) {
    return "本人の承諾・契約・引き渡しの記録があるため、ステップは動かせません（記録を守るため。辞退・取消は別の操作で行います）";
  }
  return null;
}

/** ステップごとの、移動したあとの値 */
function targetOf(key, a, interviews) {
  switch (key) {
    case "applied": return { stage: "applied", status: "todo" };
    // 実施済みのカジュアル面談があれば評価待ち、無ければ日程調整から
    case "casual_interview": return { stage: "casual_interview", status: conducted(interviews, "casual") ? "eval_pending" : "scheduling" };
    case "ceo_recommend": return { stage: "ceo_recommend", status: "ceo_recommend_pending" };
    case "ceo_interview": return { stage: "ceo_interview", status: "ceo_interview_pending" };
    // 合格（内定）。採用区分の選択・合格通知の作成はここから既存の流れで進める（作らない・送らない）
    case "offer": return { stage: "offer", status: "offer_draft_pending", decision: "hired" };
    default: return null;
  }
}

/**
 * いまの応募者が、どのステップへ動かせるか。
 * @param {object} a  gw_hr_applicants の行（stage・status・decision・employee_id・lead_category）
 * @param {{offers?:object[], interviews?:object[], canDecide?:boolean}} facts
 * @returns {{current:string|null, locked:string|null, options:{key,label,state:"current"|"allowed"|"blocked",reason:string|null,target:object|null}[]}}
 */
export function stepMoveOptions(a, { offers = [], interviews = [], canDecide = false } = {}) {
  const current = MOVE_STEP_KEYS.includes(a?.stage) ? a.stage : null;
  const locked = lockReason(a, offers);
  const decisionLock = a?.status === "ceo_decision_pending" && !canDecide
    ? "社長判断待ちのため、動かせるのは社長・管理者だけです" : null;
  const options = MOVE_STEPS.map(({ key, label }) => {
    if (key === current) return { key, label, state: "current", reason: null, target: null };
    let reason = locked || decisionLock;
    if (!reason && key === "joining_scheduled") reason = "入社予定は、本人の承諾と契約の記録から進みます（ステップ移動では進めません）";
    if (!reason && key === "offer" && !canDecide && a?.decision !== "hired") reason = "内定（合格）にできるのは社長・管理者だけです";
    const target = reason ? null : targetOf(key, a, interviews);
    if (!reason && !target) reason = "このステップへは移動できません";
    return { key, label, state: reason ? "blocked" : "allowed", reason, target };
  });
  return { current, locked, options };
}

/**
 * 移動する前に確かめてもらう注意（warnings：確認が要る）と、知らせるだけの案内（notes）
 * @param {object} a 応募者の行
 * @param {{key:string,target:object}} opt stepMoveOptions の allowed の1つ
 */
export function stepMoveNotices(a, opt, { offers = [], interviews = [] } = {}) {
  const warnings = [], notes = [];
  const from = MOVE_STEP_KEYS.indexOf(a?.stage);
  const to = MOVE_STEP_KEYS.indexOf(opt.key);
  const back = from >= 0 && to < from;
  // 状態の注意は「移動したあとの選考段階」で見る（内定へ進めるのに「選考段階が新規応募のまま」と出さない）
  for (const w of statusChangeWarnings({ ...a, stage: opt.target.stage }, interviews, opt.target.status)) warnings.push(w);
  if (CLOSED.includes(a?.status)) {
    warnings.push(`選考を再開します（${STATUS_LABEL[a.status] || a.status}の記録は履歴に残ります）。${a.status === "declined" ? "本人が辞退した方です。本人の意思を確認済みか確かめてください。" : ""}`);
  }
  if (from >= 0 && to > from + 1) {
    const skipped = MOVE_STEPS.slice(from + 1, to).map((s) => s.label);
    warnings.push(`途中のステップ（${skipped.join("・")}）を飛ばします。面談・推薦の記録は作られません。`);
  }
  if (back && a?.decision && to < MOVE_STEP_KEYS.indexOf("offer")) {
    const d = a.decision === "hired" ? "合格" : a.decision === "hold" ? "保留" : "見送り";
    warnings.push(`これまでの判断（${d}）は記録に残ります。進めるときは、あらためて判断してください。`);
  }
  if (back) {
    for (const o of liveOffers(offers)) {
      if (o.sent_at && !o.accepted_at && !o.declined_at) {
        warnings.push(`送付済みの合格通知（第${o.version}版）は取り消されません。本人のURLは期限まで有効なままです（本人が承諾すると「承諾済み」になります）。`);
      } else if (!o.sent_at) {
        notes.push(`作成済み・未送付の合格通知（第${o.version}版）は残ります（削除しません）。`);
      }
    }
    if (OFFER_IN_PROGRESS.includes(a?.status)) notes.push(`合格通知の進み具合（${STATUS_LABEL[a.status] || a.status}）から外れます。`);
  }
  if (opt.key === "offer") {
    notes.push("合格（採用判断）として記録します。次に採用区分を選び、合格通知を作成してください（送付はそこから行います）。");
  }
  notes.push("この操作でメールは送られません。合格通知・契約・署名・書類の送付も行いません。");
  return { warnings, notes };
}

/** タイムライン・確認画面に出す「変更前 → 変更後」 */
export function stepMoveLabel(stage, status) {
  return `${LABEL[stage] || STAGE_LABEL[stage] || stage || "—"}（${STATUS_LABEL[status] || status || "—"}）`;
}

/** 理由の入力チェック。空・長すぎは null */
export function normalizeMoveReason(v) {
  const s = String(v ?? "").replace(/\r\n/g, "\n").trim();
  if (!s || s.length > REASON_MAX) return null;
  return s;
}
