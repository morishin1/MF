// Salesダッシュボード「件数=根拠の提案件数」。表示専用。編集権限は提案API/詳細側に委ねる。
// 作業期限のタスクは同じ提案に複数あり得るため、カテゴリ内では提案IDで重複排除する。
const ACTIVE = (p) => !p.archived && !p.closed;
const isOpen = (t) => t.status === "open" && !!t.proposal_id;
const dueMs = (value) => value ? Date.parse(value) : NaN;
const eligibleDue = (due, bound) => Number.isFinite(dueMs(due)) && dueMs(due) <= dueMs(bound);
export const WORK_CATEGORY = Object.freeze({
  overdue: "期限超過",
  today_all: "本日の対応（期限到来）",
  no_call: "電話未実施",
  call_today: "電話対応（期限到来）",
  reply_check: "回答確認（期限到来）",
  meeting_today: "面談対応（期限到来）",
  proposal_wait: "提案送信待ち",
  unassigned: "担当未割当",
});


// 売上までの工程：Salesが確実に把握している段階のみ実数にする。
// 所属承諾はENGERが別管理・売上は請求/原価データが必要なため、未連携はnullで表す。
export const PIPELINE_CATEGORY = Object.freeze({
  pipeline_matching:"マッチング済み",
  pipeline_affiliation:"所属確認",
  pipeline_proposal:"提案送信済み",
  pipeline_followup:"追客中",
  pipeline_meeting:"面談・調整",
  pipeline_closing:"クロージング",
  pipeline_revenue:"参画・売上",
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
    list.sort((a,b) => (dueMs(a.due_at) || Infinity) - (dueMs(b.due_at) || Infinity)
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
    overdue: Boolean(task?.due_at && Number.isFinite(dueMs(task.due_at)) && dueMs(task.due_at) < dueMs(now)),
    // 補助表示であって、タスク担当者ではない。推定した担当をタスク実行者にしない。
    matchingOwnerName: p.matchingOwnerName || null,
    salesOwnerName: p.salesOwnerName || null,
    closingOwnerName: p.closingOwnerName || null,
  });
  for (const p of active) {
    const all = taskMap.get(p.id) || [];
    const late = all.find(t => t.due_at && Number.isFinite(dueMs(t.due_at)) && dueMs(t.due_at) < dueMs(now));
    const due = all.find(t => eligibleDue(t.due_at,todayEnd));
    if (due) groups.today_all.push(make(p,"today_all",due,"期限到来のタスクを処理"));
    if (late) groups.overdue.push(make(p,"overdue",late,"期限超過の作業を確認"));
    if (p.sentAt && !p.call) {
      const firstCall = taskFor(p,t => t.kind === "call");
      groups.no_call.push(make(p,"no_call",firstCall,"初回電話の結果を記録"));
    }
    const today = (kind) => taskFor(p,t => kind.includes(t.kind) && eligibleDue(t.due_at,todayEnd));
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

  // ステージは「現在どこで止まっているか」。同一提案を複数の工程に二重計上しない。
  // 過去の面談実施数・成約率とは別の進行中スナップショット。
  const pipelineGroups = Object.fromEntries(
    Object.keys(PIPELINE_CATEGORY).map(k => [k, k==="pipeline_affiliation" || k==="pipeline_revenue" ? null : []])
  );
  for (const p of active) {
    let category=null;
    if (!p.sentAt || p.status==="proposal_wait") category="pipeline_matching";
    else if (p.handoffStage==="closing") category="pipeline_closing";
    else if (["meeting_adjust","meeting_done"].includes(p.status) || p.meetingCompleted) category="pipeline_meeting";
    else if (["reply_wait","considering","reproposal"].includes(p.status)) category="pipeline_followup";
    else category="pipeline_proposal";
    const task=(taskMap.get(p.id)||[])[0]||null;
    const action=category==="pipeline_matching"?"所属・提案可能性を確認する":
      category==="pipeline_proposal"?"提案後の初動・電話を確認する":
      category==="pipeline_followup"?"企業返信・見送り理由を回収する":
      category==="pipeline_meeting"?"面談日程・結果を確認する":"条件交渉・成約手続きを進める";
    pipelineGroups[category].push(make(p,category,task,action));
  }

  const sortRows = (a,b) => (dueMs(a.dueAt) || Infinity) - (dueMs(b.dueAt) || Infinity)
    || String(a.companyName).localeCompare(String(b.companyName),"ja")
    || String(a.proposalId).localeCompare(String(b.proposalId));
  for (const rows of Object.values(groups)) rows.sort(sortRows);
  return {
    pipeline: {
      categories: PIPELINE_CATEGORY,
      counts: Object.fromEntries(Object.entries(pipelineGroups).map(([k,rows])=>[k,rows===null?null:rows.length])),
      groups: Object.fromEntries(Object.entries(pipelineGroups).map(([k,rows])=>[k,rows===null?null:rows.sort(sortRows)])),
      notes: {pipeline_affiliation:"ENGERから所属確認結果が未連携です。0件とは表示しません。",
        pipeline_revenue:"契約・稼働・請求・粗利の確定データは未連携です。0件とは表示しません。"},
    },
    categories: WORK_CATEGORY,
    counts: Object.fromEntries(Object.entries(groups).map(([k,rows]) => [k,rows.length])),
    groups,
    generatedAt: now,
  };
}
