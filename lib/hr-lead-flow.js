// リード（lead_category）ごとの、表示名・次のアクション・遷移。値の定義だけ（DB・外部に触らない）。
// lib/hr.js（shapeApplicant・nextActionOf）と api/hr/applicants/detail.js（leadNextAction）から使う。
//
// ■ 別のシステムを作らず、表示名と遷移だけを変える（db/118）
//   無限道場リードも採用候補者と同じ stage / status の列を使う。カジュアル面談までは同じ値・同じ動き
//   （日程調整中 → 面談予定 → 面談済）。その先は無限道場だけの stage（md_*）へ進む。
//   画面に出す名前は lead_category で引き分ける（同じ status でも採用と無限道場で言い方が違う）。

export const LEAD_CATEGORY_LABEL = {
  recruitment: "採用", mugendojo: "無限道場", internship: "インターン", other: "その他",
};

/** 無限道場の段階（いまどこにいるか） */
export const MUGENDOJO_STAGES = [
  { key: "applied", label: "新規リード" },
  { key: "casual_interview", label: "カジュアル面談" },
  { key: "md_trial", label: "体験案内" },
  { key: "md_considering", label: "参加検討" },
  { key: "md_applied", label: "申込" },
  { key: "md_joined", label: "参加" },
];
export const MUGENDOJO_STAGE_KEYS = MUGENDOJO_STAGES.map((s) => s.key);
const MUGENDOJO_STAGE_LABEL = Object.fromEntries(MUGENDOJO_STAGES.map((s) => [s.key, s.label]));

/** 無限道場での status の言い方（ここに無いものは採用と同じ名前） */
export const MUGENDOJO_STATUS_LABEL = {
  todo: "対応中", scheduling: "日程調整中", interview_scheduled: "カジュアル面談予定",
  eval_pending: "カジュアル面談済", next_scheduling_pending: "保留",
  done: "完了", passed: "対象外", declined: "辞退",
};

/**
 * 面談後の次のアクション。押すと stage / status / decision がこの値になる（書いていないものは変えない）。
 * decision は「保留」「対象外」だけが持つ。それ以外を選んだら外す（保留から再開したとき残さない）。
 */
export const LEAD_NEXT_ACTIONS = [
  { key: "trial", label: "体験案内", stage: "md_trial", status: "todo", todo: "体験の案内を進めてください" },
  { key: "explain", label: "説明", status: "todo", todo: "無限道場の説明を進めてください" },
  { key: "considering", label: "参加検討", stage: "md_considering", status: "todo", todo: "参加の意思を確認してください" },
  { key: "apply", label: "申込", stage: "md_applied", status: "todo", todo: "参加の手続きを進めてください" },
  { key: "join", label: "参加", stage: "md_joined", status: "done" },
  { key: "enger_referral", label: "ENGER紹介", status: "done" },
  { key: "other_service", label: "別サービス紹介", status: "done" },
  { key: "hold", label: "保留", status: "next_scheduling_pending", decision: "hold" },
  { key: "not_target", label: "対象外", status: "passed", decision: "rejected" },
];
export const LEAD_NEXT_ACTION_KEYS = LEAD_NEXT_ACTIONS.map((x) => x.key);
export const leadNextActionLabel = (k) => LEAD_NEXT_ACTIONS.find((x) => x.key === k)?.label || null;

const categoryOf = (a) => a?.lead_category ?? a?.leadCategory ?? "recruitment";
export const isMugendojo = (a) => categoryOf(a) === "mugendojo";

/** 選択した次のアクションで書き換える列 */
export function leadNextActionPatch(key) {
  const x = LEAD_NEXT_ACTIONS.find((n) => n.key === key);
  if (!x) return null;
  const patch = { lead_next_action: x.key, status: x.status, decision: x.decision || null };
  if (x.stage) patch.stage = x.stage;
  return patch;
}

/** stage / status の表示名（無限道場なら無限道場の言い方。無ければ null → 呼び出し側の既定を使う） */
export function leadStageLabel(a) {
  return isMugendojo(a) ? MUGENDOJO_STAGE_LABEL[a.stage] || null : null;
}
export function leadStatusLabel(a) {
  return isMugendojo(a) ? MUGENDOJO_STATUS_LABEL[a.status] || null : null;
}

/**
 * 無限道場の NEXT ACTION。採用と同じでよいもの（面談予定 → 実施済みにする）は null を返し、
 * 呼び出し側（lib/hr.js nextActionOf）の採用の判定へ任せる。
 * @returns {{label:string,cta:string|null,action:string|null,kind?:string}|null}
 */
export function leadNextActionOf(a) {
  if (!isMugendojo(a)) return null;
  const choose = { cta: "次のアクションを選ぶ", action: "leadNextAction" };
  const nextKey = a.lead_next_action ?? a.leadNextAction;
  const chosen = LEAD_NEXT_ACTIONS.find((x) => x.key === nextKey);

  if (a.status === "scheduling") {
    return { label: "本人のカジュアル面談の予約を待っています", cta: "予約URLを送る", action: "sendSchedulingLink", kind: "casual" };
  }
  if (a.status === "todo" && !chosen) {
    return { label: "カジュアル面談の予約URLを送ってください", cta: "予約URLを送る", action: "sendSchedulingLink", kind: "casual" };
  }
  if (a.status === "interview_scheduled") return null;   // 採用と同じ（面談を実施済みにする）
  if (a.status === "eval_pending") return { label: "面談後の次のアクションを選んでください", ...choose };
  if (a.status === "next_scheduling_pending") {
    const step = a.hold_next_step ?? a.holdNextStep;
    return { label: step ? `保留中：${step}` : "保留中です", ...choose };
  }
  if (["done", "passed", "declined"].includes(a.status)) {
    return { label: "対応は不要です", cta: "次のアクションを変更", action: "leadNextAction" };
  }
  if (chosen?.todo) return { label: chosen.todo, ...choose };
  return { label: "次のアクションを選んでください", ...choose };
}
