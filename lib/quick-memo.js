// とりあえずメモ。純粋関数だけ。
//
// ■ ここが正
//
//   状態と「次に何をするか」の判定は、この1ファイルだけが持つ。
//   画面・API・cron の3か所で同じことを書くと、必ずどこかが食い違う。
//
// ■ AIは提案するだけ
//
//   決めるのは人。DECISION_CHOICES の4つから選ぶ。
//   AIの案（ai_decision）は「最初に選ばれている案」でしかなく、
//   押さなければ何も起きない。

/** 1本のメモに書ける長さ。長い説明はここに書かせない */
export const BODY_MAX = 200;

/** メモをどうするか。人が選ぶ4つ */
export const DECISION_CHOICES = [
  { key: "task", label: "正式タスク化",   hint: "期日・担当・完了条件を決めて、タスクにする" },
  { key: "self", label: "自分で対応",     hint: "もう片付けた。タスク化は要らない" },
  { key: "hand", label: "他の人へ依頼",   hint: "担当を決めて、その人のタスクにする" },
  { key: "drop", label: "不要だった",     hint: "取りやめる" },
];
export const DECISION_KEYS = DECISION_CHOICES.map((c) => c.key);
export const decisionLabel = (key) => DECISION_CHOICES.find((c) => c.key === key)?.label || key;

/** 正式なタスクの行を作るのは、この2つを選んだときだけ */
export const PROMOTES_TASK = new Set(["task", "hand"]);

/** 本文の整形。前後の空白を削り、長さを切る。空なら null（保存させない） */
export function cleanBody(raw) {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  return s.slice(0, BODY_MAX);
}

/** 決定の値が正しいか */
export const isDecision = (v) => DECISION_KEYS.includes(v);

/**
 * メモ1件の行を、画面が使う形にそろえる。
 * @param row DBの行
 */
export function rowOf(row) {
  return {
    id: row.id,
    body: row.body,
    status: row.status,
    decision: row.decision || null,
    decisionLabel: row.decision ? decisionLabel(row.decision) : null,
    decisionNote: row.decision_note || null,
    aiDecision: row.ai_decision || null,
    aiReason: row.ai_reason || null,
    promotedTaskId: row.promoted_task_id || null,
    createdAt: row.created_at,
  };
}

/**
 * 決定に応じて、gw_tasks へ書く最小限の下書きを作る（純粋関数。DBには触れない）。
 * task/hand 以外は null（作らない）。
 *
 * @param memo  gw_quick_memos の行
 * @param opts  { assigneeId, dueOn, priority } … hand のときは人が担当を選ぶ。
 *              期日・優先度を指定しなければ、ひとまず「ふつう」のタスクとして作る
 *              （「明日の3つ」には入れない。入れるかどうかは本人が別途決める）
 */
export function taskDraftFor(memo, decision, opts = {}) {
  if (!PROMOTES_TASK.has(decision)) return null;
  return {
    title: memo.body,
    category: "とりあえずメモから",
    assignee_id: decision === "hand" ? (opts.assigneeId || null) : memo.employee_id,
    due_on: opts.dueOn || null,
    priority: opts.priority || "normal",
    status: "todo",
    created_by: opts.createdBy || null,
  };
}
