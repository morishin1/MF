// タスク一覧の見え方。印（バッジ）・絞り込み・上に出す数。
//
// ■ 一覧は「探す場所」
//
//   1件ずつ短い行にして、たくさん並べる。文章は出さない。
//   出すのは タスク名／担当／期限／優先度／分類／状態／KPI まで。
//   中身は、行を押して右から出る引き出しで読む（処理する場所）。
//
// ■ 印は6つだけ
//
//   緊急・今日・期限超過・AI提案・確認待ち・完了。
//   これ以上増やすと、どれも目に入らなくなる。
//
// ■ 判定はここ1か所
//
//   画面と API の両方で「期限超過かどうか」を書くと、必ず食い違う。
//   サーバがこの関数で行を作り、画面はその通りに描くだけにする。

/** 期間の絞り込み */
export const RANGES = [
  { key: "today",  label: "今日" },
  { key: "tomorrow", label: "明日" },
  { key: "week",   label: "今週" },
  { key: "month",  label: "今月" },
  { key: "all",    label: "すべて" },
];
export const RANGE_KEYS = RANGES.map((r) => r.key);

export const PRIORITIES = [
  { key: "high",   label: "高", short: "高" },
  { key: "normal", label: "ふつう", short: "中" },
  { key: "low",    label: "低", short: "低" },
];
export const priorityLabel = (k) => PRIORITIES.find((p) => p.key === k)?.label || k;

export const STATUSES = [
  { key: "todo",      label: "未着手" },
  { key: "doing",     label: "着手中" },
  { key: "done",      label: "完了" },
  { key: "cancelled", label: "取りやめ" },
];
export const statusLabel = (k) => STATUSES.find((s) => s.key === k)?.label || k;

/** 印。出す順に並べる。左から目に入る */
export const BADGES = [
  { key: "overdue", label: "期限超過", tone: "bad" },
  { key: "urgent",  label: "緊急",     tone: "bad" },
  { key: "today",   label: "今日",     tone: "now" },
  { key: "ai",      label: "AI提案",   tone: "ai" },
  { key: "waiting", label: "確認待ち", tone: "warn" },
  { key: "done",    label: "完了",     tone: "ok" },
];
export const BADGE_KEYS = BADGES.map((b) => b.key);

const isOpen = (t) => t.status === "todo" || t.status === "doing";

/**
 * その行に付く印。
 *
 * @param {object} t gw_tasks の行（focus_date / ai_review / accepted_at を含む）
 * @param {string} today YYYY-MM-DD
 */
export function badgesOf(t, today) {
  const out = [];
  if (t.status === "done") return ["done"];
  if (t.status === "cancelled") return [];
  if (t.due_on && t.due_on < today) out.push("overdue");
  if (t.priority === "high") out.push("urgent");
  // 今日やると決めた重要タスク。期限が今日なだけのものとは分けない
  // （どちらも「今日のうちに終える」ことに変わりはない）
  if (t.focus_date === today || t.due_on === today) out.push("today");
  if (t.ai_review || t.ai_assignee) out.push("ai");
  // 頼まれたのに、まだ受けていない
  if (t.created_by && t.assignee_id && t.accepted_at === null && t.requested_by_other) out.push("waiting");
  return out;
}

/**
 * 一覧の1行。ここに無いものは画面に出さない。
 *
 * @param {object} t      gw_tasks の行
 * @param {object} ctx    { today, names: Map<employeeId, {name, department}> }
 */
export function rowOf(t, { today, names = new Map() } = {}) {
  const who = names.get(t.assignee_id) || null;
  return {
    id: t.id,
    title: t.title,
    assigneeId: t.assignee_id || null,
    assignee: who?.name || null,
    department: who?.department || null,
    dueOn: t.due_on || null,
    priority: t.priority || "normal",
    priorityLabel: priorityLabel(t.priority || "normal"),
    category: t.category || null,
    service: t.service || null,
    kpi: t.kpi_link || null,
    status: t.status,
    statusLabel: statusLabel(t.status),
    focusDate: t.focus_date || null,
    focusRank: t.focus_rank ?? null,
    carryCount: t.carry_count || 0,
    // AIの指摘があるか。中身は引き出しで読む
    hasAi: Boolean(t.ai_review || t.ai_assignee),
    aiVerdict: t.ai_review?.verdict || null,
    badges: badgesOf(t, today),
    overdue: Boolean(t.due_on && t.due_on < today && isOpen(t)),
  };
}

/** 期間の範囲。from/to は YYYY-MM-DD（両端を含む） */
export function rangeOf(key, today, tomorrow) {
  if (key === "today") return { from: today, to: today };
  if (key === "tomorrow") return { from: tomorrow, to: tomorrow };
  if (key === "week") {
    const d = new Date(`${today}T00:00:00Z`);
    const dow = d.getUTCDay();
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
  }
  if (key === "month") return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-31` };
  return null;
}

/**
 * 絞り込み。行（rowOf の結果）に対してかける。
 *
 * ■ 期限が無いものを、期間で消さない
 *   「今日」で絞ったときに期限なしのタスクまで消えると、
 *   期限を入れていないものが永久に見つからなくなる。
 *   期間で絞るのは、期限が入っているものだけ。
 *   ただし「今日」のときは、今日やると決めた重要タスクを必ず入れる
 */
export function applyFilters(rows, f = {}, { today, tomorrow } = {}) {
  let out = rows;
  const range = f.range && f.range !== "all" ? rangeOf(f.range, today, tomorrow) : null;
  if (range) {
    out = out.filter((r) => {
      if (f.range === "today" && r.focusDate === today) return true;
      if (f.range === "tomorrow" && r.focusDate === tomorrow) return true;
      if (!r.dueOn) return false;
      return r.dueOn >= range.from && r.dueOn <= range.to;
    });
  }
  if (f.assigneeId) out = out.filter((r) => r.assigneeId === f.assigneeId);
  if (f.department) out = out.filter((r) => (r.department || "") === f.department);
  if (f.service) out = out.filter((r) => (r.service || "") === f.service);
  if (f.priority) out = out.filter((r) => r.priority === f.priority);
  if (f.status) {
    out = f.status === "open"
      ? out.filter((r) => r.status === "todo" || r.status === "doing")
      : out.filter((r) => r.status === f.status);
  }
  if (f.ai === true || f.ai === "1") out = out.filter((r) => r.hasAi);
  if (f.overdue === true || f.overdue === "1") out = out.filter((r) => r.overdue);
  const q = String(f.q || "").trim();
  if (q) {
    const hit = (v) => String(v || "").toLowerCase().includes(q.toLowerCase());
    out = out.filter((r) => hit(r.title) || hit(r.assignee) || hit(r.category)
      || hit(r.service) || hit(r.kpi));
  }
  return out;
}

/**
 * 上に出す6つの数。
 *
 *   今日のタスク／完了／未完了／期限超過／明日の3タスク未登録／AI確認待ち
 *
 * 前の4つはタスクから、後ろの2つは人ごとの状態（gw_focus_days）から数える。
 * 絞り込みの影響を受けない（一覧を絞っても、会社の状況は変わらないため）
 */
export function kpiOf(rows, { today, tomorrow, focusDays = [], people = [] } = {}) {
  const todays = rows.filter((r) => r.focusDate === today || r.dueOn === today);
  const open = (r) => r.status === "todo" || r.status === "doing";

  // 明日ぶんを決めていない人。確定していない人も「未登録」に含めない
  // （登録はしたが確定していない人は、AI確認待ち側で数える）
  const byEmp = new Map(focusDays.map((d) => [`${d.employee_id}|${d.focus_date}`, d]));
  const plannedTomorrow = new Set(
    rows.filter((r) => r.focusDate === tomorrow).map((r) => r.assigneeId).filter(Boolean));
  const noTomorrow = people.filter((p) => !plannedTomorrow.has(p.id)).length;
  const waiting = people.filter((p) => {
    const d = byEmp.get(`${p.id}|${tomorrow}`);
    return d && d.status !== "confirmed" && plannedTomorrow.has(p.id);
  }).length;

  return {
    today: todays.length,
    done: todays.filter((r) => r.status === "done").length,
    open: todays.filter(open).length,
    overdue: rows.filter((r) => r.overdue).length,
    noTomorrow,
    waiting,
  };
}

/** 一覧の並び。期限超過 → 今日 → 期限の近い順 → 優先度。完了は下 */
export function sortRows(rows, today) {
  const rank = (r) => {
    if (r.status === "done" || r.status === "cancelled") return 9;
    if (r.overdue) return 0;
    if (r.focusDate === today) return 1;
    if (r.dueOn === today) return 2;
    return 3;
  };
  const pri = { high: 0, normal: 1, low: 2 };
  return rows.slice().sort((a, b) =>
    rank(a) - rank(b)
    || String(a.dueOn || "9999-12-31").localeCompare(String(b.dueOn || "9999-12-31"))
    || (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1)
    || String(a.title).localeCompare(String(b.title), "ja"));
}

/** 履歴の1行を、人が読める文にする */
export const EVENT_LABEL = {
  created:  "作成",
  assigned: "担当変更",
  due:      "期限変更",
  priority: "優先度変更",
  status:   "状態変更",
  focus:    "重要タスク",
  ai:       "AI提案",
  carry:    "持ち越し",
  comment:  "コメント",
  edited:   "内容変更",
};

export function eventLine(e) {
  const d = e.detail || {};
  const arrow = (from, to) => `${from || "（なし）"} → ${to || "（なし）"}`;
  switch (e.kind) {
    case "created":  return "作成しました";
    case "assigned": return `担当を ${arrow(d.fromName, d.toName)}`;
    case "due":      return `期限を ${arrow(d.from, d.to)}`;
    case "priority": return `優先度を ${arrow(priorityLabel(d.from), priorityLabel(d.to))}`;
    case "status":   return `${statusLabel(d.to)} にしました${d.result ? `（${d.result}）` : ""}`;
    case "focus":    return d.date ? `${d.date} の重要タスクにしました` : "重要タスクから外しました";
    case "ai":       return d.adopted ? `AIの案を採りました（${d.what || ""}）` : `AIが確認しました（${d.verdict || ""}）`;
    case "carry":    return `${d.label || d.decision}${d.reason ? `：${d.reason}` : ""}`;
    case "comment":  return "コメントしました";
    case "edited":   return `${(d.fields || []).join("・") || "内容"}を直しました`;
    default:         return e.kind;
  }
}
