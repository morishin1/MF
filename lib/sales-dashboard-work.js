// Salesダッシュボード「件数=根拠の提案件数」。表示専用。編集権限は提案API/詳細側に委ねる。
// 作業期限のタスクは同じ提案に複数あり得るため、カテゴリ内では提案IDで重複排除する。
const ACTIVE = (p) => !p.archived && !p.closed;
const isOpen = (t) => t.status === "open" && !!t.proposal_id;
export const WORK_CATEGORY = Object.freeze({
  overdue: "期限超過",
  no_call: "電話未実施",
  call_today: "電話対応（期限到来）",
  reply_check: "回答確認（期限到来）",
  meeting_today: "面談対応（期限到来）",
  proposal_wait: "提案送信待ち",
  unassigned: "担当未割当",
});

export function buildSalesDashboardWork(proposals = [], tasks = [], {
  now = new Date().toISOString(), todayEnd = now, nameOf = () => null,
} = {}) {
  const active = proposals.filter(ACTIVE);
  const map = new Map(active.map(p => [p.id, p]));
  const taskMap = new Map();
  for (const task of tasks) {
    if (!isOpen(task) || !map.has(task.proposal_id)) continue;
    if (!taskMap.has(task.proposal_id)) taskMap.set(task.proposal_id, []);
    taskMap.get(task.proposal_id).push(task);
  }
  for (const list of taskMap.values())
    list.sort((a,b) => String(a.due_at || "9999").localeCompare(String(b.due_at || "9999"))
      || String(a.id).localeCompare(String(b.id)));

  const groups = Object.fromEntries(Object.keys(WORK_CATEGORY).map(k => [k,[]]));
  const taskFor = (p,predicate) => (taskMap.get(p.id) || []).find(predicate) || null;
  const actor = (task) => !task?.assignee_id ? "担当未割当"
    : nameOf(task.assignee_id) || "担当者名未取得";
  const make = (p, category, task, action) => ({
    proposalId: p.id,
    category, companyName: p.companyName || "企業名未取得", title: p.title || "提案名未取得",
    statusLabel: p.statusLabel || p.status || "未登録",
    taskId: task?.id || null,
    action: task?.title || action,
    assigneeId: task?.assignee_id || null, assigneeName: actor(task),
    dueAt: task?.due_at || null,
    overdue: Boolean(task?.due_at && task.due_at < now),
    // 補助表示であって、タスク担当者ではない。推定した担当をタスク実行者にしない。
    matchingOwnerName: p.matchingOwnerName || null,
    salesOwnerName: p.salesOwnerName || null,
    closingOwnerName: p.closingOwnerName || null,
  });
  for (const p of active) {
    const all = taskMap.get(p.id) || [];
    const late = all.find(t => t.due_at && t.due_at < now);
    if (late) groups.overdue.push(make(p,"overdue",late,"期限超過の作業を確認"));
    if (p.sentAt && !p.call) {
      const firstCall = taskFor(p,t => t.kind === "call");
      groups.no_call.push(make(p,"no_call",firstCall,"初回電話の結果を記録"));
    }
    const today = (kind) => taskFor(p,t => kind.includes(t.kind) && t.due_at && t.due_at <= todayEnd);
    const call = today(["call","refollow"]);
    const reply = today(["reply_check"]);
    const meeting = today(["meeting_fix","meeting_result"]);
    if (call) groups.call_today.push(make(p,"call_today",call,"電話の対応記録"));
    if (reply) groups.reply_check.push(make(p,"reply_check",reply,"企業からの回答を確認"));
    if (meeting) groups.meeting_today.push(make(p,"meeting_today",meeting,"面談調整・結果登録"));
    if (p.status === "proposal_wait") {
      const prepare = taskFor(p,t => t.kind === "prepare");
      groups.proposal_wait.push(make(p,"proposal_wait",prepare,"ENGERでマッチングを確認し企業へ提案"));
    }
    if (!p.salesOwnerId) groups.unassigned.push(make(p,"unassigned",null,"営業担当を割り当てる"));
  }
  const sortRows = (a,b) => String(a.dueAt || "9999").localeCompare(String(b.dueAt || "9999"))
    || String(a.companyName).localeCompare(String(b.companyName),"ja")
    || String(a.proposalId).localeCompare(String(b.proposalId));
  for (const rows of Object.values(groups)) rows.sort(sortRows);
  return {
    categories: WORK_CATEGORY,
    counts: Object.fromEntries(Object.entries(groups).map(([k,rows]) => [k,rows.length])),
    groups,
    generatedAt: now,
  };
}
