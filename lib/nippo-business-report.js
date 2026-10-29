// 日報の全体営業・マッチング集計。日報本文は読まず、Sales の記録だけを集計する。
import { companyQualifications } from "./sales-company-qualification.js";
import { CLOSE_REASON_LABEL } from "./sales-proposals.js";
import { isBizDay } from "./holidays.js";
import { nextDay, weekStart } from "./nippo.js";

export const MEETING_GOAL_RATE = 10;
export const BLAST_PROPOSAL_THRESHOLD = 15;
const CLOSED = new Set(["lost", "closed_no_reply", "stopped"]);
const DONE_MEETING = (a) => a?.kind === "meeting" && a?.result === "done";

function shiftDay(date, amount) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

export function jstDay(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at + 9 * 3600000).toISOString().slice(0, 10) : "";
}

const includesDate = (iso, window) => {
  const day = jstDay(iso);
  return Boolean(day && day >= window.from && day < window.to);
};

function dayLabel(date) {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function windowOf(from, to) {
  return { from, to, label: `${dayLabel(from)}〜${dayLabel(shiftDay(to, -1))}` };
}

/** day は前日、week は前週の同じ経過日数と比べる。end は翌日（含まない）。 */
export function businessReportWindows(period, date) {
  const kind = period === "week" ? "week" : "day";
  const currentFrom = kind === "week" ? weekStart(date) : date;
  const currentTo = nextDay(date);
  const previousFrom = shiftDay(currentFrom, kind === "week" ? -7 : -1);
  const previousTo = shiftDay(currentTo, kind === "week" ? -7 : -1);
  return {
    kind,
    current: windowOf(currentFrom, currentTo),
    previous: windowOf(previousFrom, previousTo),
    description: kind === "week" ? "今週（月曜〜今日）／前週の同じ曜日数" : "今日／昨日",
  };
}

function nextBusinessDate(date) {
  let next = nextDay(date);
  while (!isBizDay(new Date(`${next}T00:00:00Z`))) next = nextDay(next);
  return next;
}

const rate = (numerator, denominator) => denominator
  ? Math.round((numerator * 1000) / denominator) / 10
  : null;
const normEmail = (value) => String(value || "").trim().toLowerCase();
const reasonLabel = (key) => key === "unknown" ? "未入力" : CLOSE_REASON_LABEL[key] || key;

function summarizePeriod({ window, proposals, activities, proposalsAvailable, activitiesAvailable, sourceDeletedIds }) {
  if (!proposalsAvailable) {
    return {
      window, proposalCount: null, meetingEventCount: null, meetingCohortCount: null,
      conversionRate: null, closedCount: null, missingReasonCount: null, lossReasons: null,
      lossRows: null, lossRowsTotal: null, proposalRows: null, proposalRowsTotal: null,
      meetingRows: null, meetingRowsTotal: null,
    };
  }

  const active = proposals.filter((p) => !p.archived_at && !sourceDeletedIds?.has(p.id));
  const sent = active.filter((p) => p.sent_at && includesDate(p.sent_at, window));
  const closed = active.filter((p) => CLOSED.has(p.status) && p.closed_at && includesDate(p.closed_at, window));
  const doneProposalIds = new Set((activities || []).filter(DONE_MEETING).map((a) => a.proposal_id));
  const meetingCohort = activitiesAvailable
    ? sent.filter((p) => p.status === "meeting_done" || doneProposalIds.has(p.id))
    : null;
  const meetings = activitiesAvailable
    ? activities.filter((a) => DONE_MEETING(a) && includesDate(a.occurred_at, window))
    : null;
  const reasonCounts = new Map();
  for (const p of closed) {
    const key = p.close_reason || "unknown";
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }
  const employees = new Map();
  for (const p of sent) employees.set(p.id, p.proposal_owner_id || p.sales_owner_id || null);
  const byId = new Map(active.map((p) => [p.id, p]));
  const lossRows = closed.map((p) => ({
    id: p.id,
    companyName: p.company_name || "（企業名未取得）",
    title: p.title || p.job_title || "（案件名未取得）",
    ownerName: p.proposal_owner_name || p.sales_owner_name || p.matching_owner_name || "担当未割当",
    closedAt: p.closed_at,
    reason: p.close_reason || "unknown",
    reasonLabel: reasonLabel(p.close_reason || "unknown"),
  }));
  const meetingRows = meetings?.map((a) => {
    const p = byId.get(a.proposal_id);
    return {
      id: a.proposal_id,
      activityId: a.id,
      companyName: p?.company_name || "（企業名未取得）",
      title: p?.title || p?.job_title || "（案件名未取得）",
      ownerName: p?.proposal_owner_name || p?.sales_owner_name || p?.matching_owner_name || "担当未割当",
      occurredAt: a.occurred_at,
    };
  }) || null;
  const proposalRows = sent.map((p) => ({
    id: p.id,
    companyName: p.company_name || "（企業名未取得）",
    title: p.title || p.job_title || "（案件名未取得）",
    ownerId: employees.get(p.id),
    ownerName: p.proposal_owner_name || p.sales_owner_name || p.matching_owner_name || "担当未割当",
    sentAt: p.sent_at,
    meetingCompleted: activitiesAvailable ? Boolean(p.status === "meeting_done" || doneProposalIds.has(p.id)) : null,
    status: p.status,
  })).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));

  return {
    window,
    proposalCount: sent.length,
    meetingEventCount: meetings?.length ?? null,
    meetingCohortCount: meetingCohort?.length ?? null,
    conversionRate: meetingCohort ? rate(meetingCohort.length, sent.length) : null,
    closedCount: closed.length,
    missingReasonCount: closed.filter((p) => !p.close_reason || ["client_declined", "other"].includes(p.close_reason)).length,
    lossReasons: [...reasonCounts].map(([key, count]) => ({ key, label: reasonLabel(key), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja")),
    lossRows: lossRows.slice(0, 100),
    lossRowsTotal: lossRows.length,
    proposalRows: proposalRows.slice(0, 100),
    proposalRowsTotal: proposalRows.length,
    meetingRows: meetingRows?.slice(0, 100) ?? null,
    meetingRowsTotal: meetingRows?.length ?? null,
  };
}

function ownerIdentity(proposal, employeesById, employeesByEmail, matching = false) {
  const matchingEmail = normEmail(proposal.matching_owner_email);
  const matchingEmployee = matchingEmail ? employeesByEmail.get(matchingEmail) : null;
  const employeeId = matching && matchingEmployee?.id
    ? matchingEmployee.id
    : (proposal.proposal_owner_id || proposal.sales_owner_id || null);
  const employee = employeeId ? employeesById.get(employeeId) : null;
  const name = employee?.display_name
    || (matching ? proposal.matching_owner_name : null)
    || proposal.proposal_owner_name || proposal.sales_owner_name || "担当未割当";
  const key = matching && !matchingEmployee && matchingEmail
    ? `email:${matchingEmail}`
    : employeeId || (matchingEmail ? `email:${matchingEmail}` : `name:${name}`);
  return { key, employeeId, name };
}

function ownerPerformance({ proposals, activities, tasks, employees, windows, sourceDeletedIds, proposalsAvailable, activitiesAvailable, tasksAvailable, now }) {
  if (!proposalsAvailable || !activitiesAvailable) return { status: "unavailable", rows: [], bottlenecks: [] };
  const employeesById = new Map((employees || []).map((e) => [e.id, e]));
  const employeesByEmail = new Map((employees || []).map((e) => [normEmail(e.email), e]).filter(([email]) => email));
  const active = proposals.filter((p) => !p.archived_at && !sourceDeletedIds?.has(p.id));
  const activeById = new Map(active.map((p) => [p.id, p]));
  const meetingDone = new Set((activities || []).filter(DONE_MEETING).map((a) => a.proposal_id));
  const rows = new Map();
  const get = (identity) => {
    if (!rows.has(identity.key)) rows.set(identity.key, {
      employeeId: identity.employeeId, name: identity.name,
      proposalCount: 0, meetingCount: 0, conversionRate: null,
      matchCount: 0, proposalizedMatchCount: 0, matchConversionRate: null,
      overdueMatches: 0, proposalExampleId: null, matchingExampleId: null,
    });
    return rows.get(identity.key);
  };
  const currentSales = active.filter((p) => p.sent_at && includesDate(p.sent_at, windows.current));
  for (const p of currentSales) {
    const row = get(ownerIdentity(p, employeesById, employeesByEmail));
    row.proposalCount++;
    if (!row.proposalExampleId) row.proposalExampleId = p.id;
    if (p.status === "meeting_done" || meetingDone.has(p.id)) row.meetingCount++;
  }
  const currentMatches = active.filter((p) => p.source_system === "enger" && p.matched_at && includesDate(p.matched_at, windows.current));
  for (const p of currentMatches) {
    const row = get(ownerIdentity(p, employeesById, employeesByEmail, true));
    row.matchCount++;
    if (!row.matchingExampleId) row.matchingExampleId = p.id;
    if (p.sent_at) row.proposalizedMatchCount++;
  }
  if (tasksAvailable) {
    const pendingIds = new Set(active.filter((p) => p.source_system === "enger" && p.matched_at && !p.sent_at && p.status === "proposal_wait").map((p) => p.id));
    const countedOverdue = new Set();
    for (const task of tasks || []) {
      if (task.kind !== "prepare" || task.status !== "open" || !pendingIds.has(task.proposal_id)
        || Date.parse(task.due_at) >= Date.parse(now) || countedOverdue.has(task.proposal_id)) continue;
      countedOverdue.add(task.proposal_id);
      const p = activeById.get(task.proposal_id);
      if (p) get(ownerIdentity(p, employeesById, employeesByEmail, true)).overdueMatches++;
    }
  }
  const list = [...rows.values()].map((row) => {
    const conversionRate = row.proposalCount ? rate(row.meetingCount, row.proposalCount) : null;
    return {
      ...row,
      conversionRate,
      matchConversionRate: row.matchCount ? rate(row.proposalizedMatchCount, row.matchCount) : null,
      bottleneck: (row.proposalCount >= 10 && conversionRate < MEETING_GOAL_RATE) || row.overdueMatches > 0,
    };
  }).sort((a, b) => Number(b.bottleneck) - Number(a.bottleneck)
    || b.proposalCount - a.proposalCount || b.matchCount - a.matchCount || a.name.localeCompare(b.name, "ja"));
  return { status: tasksAvailable ? "available" : "partial", rows: list, bottlenecks: list.filter((row) => row.bottleneck) };
}

function matchingPeriod({ window, proposals, available, sourceDeletedIds }) {
  if (!available) return { window, matchedCount: null, proposalizedCount: null, conversionRate: null, rows: null, rowsTotal: null };
  const matched = proposals.filter((p) => p.source_system === "enger" && p.matched_at && !p.archived_at
    && !sourceDeletedIds?.has(p.id) && includesDate(p.matched_at, window));
  return {
    window,
    matchedCount: matched.length,
    proposalizedCount: matched.filter((p) => Boolean(p.sent_at)).length,
    conversionRate: rate(matched.filter((p) => p.sent_at).length, matched.length),
    rows: matched.sort((a, b) => String(b.matched_at).localeCompare(String(a.matched_at))).slice(0, 100).map((p) => ({
      id: p.id,
      companyName: p.company_name || "（企業名未取得）",
      title: p.title || p.job_title || "（案件名未取得）",
      ownerName: p.proposal_owner_name || p.sales_owner_name || p.matching_owner_name || "担当未割当",
      matchingOwnerName: p.matching_owner_name || "担当未取得",
      matchedAt: p.matched_at,
      sentAt: p.sent_at || null,
      status: p.status,
      sourceUrl: p.source_url || null,
    })),
    rowsTotal: matched.length,
  };
}

function buildInsights({ sales, matching, blastCompanies, bottlenecks, sync, date }) {
  const actions = [];
  const deadline = nextBusinessDate(date);
  if (sales.status !== "unavailable" && sales.current.proposalCount !== null) {
    const count = sales.current.proposalCount;
    const rateValue = sales.current.conversionRate;
    if (count === 0) {
      actions.push({
        type: "proposal_volume", severity: "attention", issue: "対象期間に提案実績がありません",
        cause: "Salesの送信済み提案が0件です。",
        action: "対象企業と提案対象を確認し、今週の提案先を決める",
        owner: "Sales責任者", dueDate: deadline,
      });
    } else if (rateValue !== null && rateValue < MEETING_GOAL_RATE) {
      const reason = sales.current.lossReasons[0];
      const cause = sales.current.missingReasonCount > 0
        ? `見送り・クローズ ${sales.current.closedCount}件のうち、具体的な理由が未入力または不足している記録が${sales.current.missingReasonCount}件あります。`
        : reason
          ? `対象期間の最多理由は「${reason.label}」${reason.count}件です。`
          : "記録上、面談実施まで進んだ提案が目標に届いていません。離脱点は記録だけでは特定できません。";
      const underTarget = bottlenecks.filter((row) => row.proposalCount >= 10 && row.conversionRate < MEETING_GOAL_RATE);
      actions.push({
        type: "conversion", severity: count >= 10 ? "urgent" : "attention",
        issue: `提案→面談率が目標10%未満（${rateValue.toFixed(1)}%）`, cause,
        action: "提案先・条件・初回フォローの記録を見直し、次の提案で1件以上の面談を目指す",
        owner: underTarget.length === 1 ? underTarget[0].name : "Sales責任者",
        dueDate: deadline,
      });
    }
    if (sales.current.missingReasonCount > 0) {
      actions.push({
        type: "loss_reason", severity: "attention",
        issue: `失注理由の具体性が不足（${sales.current.missingReasonCount}件）`,
        cause: "企業側見送り・その他・未入力の記録だけでは、企業条件や人材条件の改善点を絞れません。",
        action: "該当提案の企業へ見送り理由を確認し、理由をSalesに記録する",
        owner: sales.current.lossRows.find((row) => ["unknown", "client_declined", "other"].includes(row.reason))?.ownerName || "各提案担当",
        dueDate: deadline,
      });
    }
  }
  if (blastCompanies.status === "available" && blastCompanies.count > 0) {
    actions.push({
      type: "blast", severity: "urgent",
      issue: `ブラスト限定候補が${blastCompanies.count}社あります`,
      cause: `全履歴で${BLAST_PROPOSAL_THRESHOLD}件以上の送信済み提案があり、面談実施が0件です。`,
      action: "配信停止・連絡停止を確認したうえで、通常提案から外し、ブラスト配信対象として扱うか確認する",
      owner: "Sales責任者", dueDate: deadline,
    });
  }
  if (matching.status !== "unavailable" && matching.stalledCount > 0) {
    const overdue = matching.stalledRows[0];
    actions.push({
      type: "matching_stalled", severity: "urgent",
      issue: `提案準備の期限超過が${matching.stalledCount}件あります`,
      cause: "ENGERでマッチング確定後、Sales側の提案準備タスクが期限を過ぎても未完了です。",
      action: "提案準備を完了して企業へ送るか、再マッチングの要否を判断する",
      owner: overdue.ownerName || "Sales責任者", dueDate: deadline,
    });
  }
  if (sync.status === "available" && sync.unresolvedCount > 0) {
    actions.push({
      type: "sync", severity: "attention",
      issue: `ENGER連携の未解決エラーが${sync.unresolvedCount}件あります`,
      cause: "連携エラーが残っており、マッチング集計に未反映の記録がある可能性があります。",
      action: "Salesの連携エラーを確認し、ENGERからの再送状態を点検する",
      owner: "Sales・ENGER連携担当", dueDate: deadline,
    });
  }
  return actions;
}

/** DBから読んだ記録を、日報カード用の匿名性を保った業務集計に変換する。 */
export function buildBusinessReport({
  period = "day", date, now = new Date().toISOString(), proposals = null,
  activities = null, tasks = null, employees = null, sync = { available: false },
  deletedProposalIds = null, sourceStateStatus = "unavailable",
}) {
  const windows = businessReportWindows(period, date);
  const proposalsAvailable = Array.isArray(proposals);
  const activitiesAvailable = Array.isArray(activities);
  const tasksAvailable = Array.isArray(tasks);
  const history = proposals || [];
  const activityRows = activities || [];
  const taskRows = tasks || [];
  const deleted = deletedProposalIds instanceof Set ? deletedProposalIds : new Set(deletedProposalIds || []);
  const sourceIds = deletedProposalIds == null ? null : deleted;
  const sourceAvailable = Boolean(sync?.available && (sync?.latestReceivedAt || history.some((p) => p.source_system === "enger")));
  const engerHistory = history.filter((p) => p.source_system === "enger");
  const matchingAvailable = proposalsAvailable && (sourceAvailable || engerHistory.length > 0);
  const current = summarizePeriod({ window: windows.current, proposals: history, activities: activityRows,
    proposalsAvailable, activitiesAvailable, sourceDeletedIds: sourceIds });
  const previous = summarizePeriod({ window: windows.previous, proposals: history, activities: activityRows,
    proposalsAvailable, activitiesAvailable, sourceDeletedIds: sourceIds });
  const currentMatching = matchingPeriod({ window: windows.current, proposals: history, available: matchingAvailable, sourceDeletedIds: sourceIds });
  const previousMatching = matchingPeriod({ window: windows.previous, proposals: history, available: matchingAvailable, sourceDeletedIds: sourceIds });

  const qualificationResult = proposalsAvailable && activitiesAvailable
    ? companyQualifications(history.filter((p) => !sourceIds?.has(p.id)), activityRows)
    : null;
  const allQualifications = qualificationResult?.companies || null;
  const blasts = allQualifications?.filter((row) => row.grade === "blast") || null;
  const newestProposalByCompany = new Map();
  if (qualificationResult) {
    for (const proposal of history) {
      if (!proposal.sent_at || sourceIds?.has(proposal.id)) continue;
      const group = qualificationResult.byProposal.get(proposal.id);
      if (!group) continue;
      const prior = newestProposalByCompany.get(group.key);
      if (!prior || String(proposal.sent_at) > String(prior.sent_at)) newestProposalByCompany.set(group.key, proposal);
    }
  }
  const blastRows = blasts?.map((row) => ({
    key: row.key,
    id: newestProposalByCompany.get(row.key)?.id || null,
    companyName: row.companyName, companyId: row.companyId,
    sourceCompanyId: row.sourceCompanyId, proposalCount: row.sent,
    meetingCount: row.meetings, rate: row.rate, stopContact: row.stopContact,
    lastSentAt: row.lastSentAt,
  })).sort((a, b) => b.proposalCount - a.proposalCount || a.companyName.localeCompare(b.companyName, "ja")) || null;

  const owners = ownerPerformance({ proposals: history, activities: activityRows, tasks: taskRows,
    employees: employees || [], windows, sourceDeletedIds: sourceIds,
    proposalsAvailable, activitiesAvailable, tasksAvailable, now });

  const backlogged = matchingAvailable
    ? history.filter((p) => p.source_system === "enger" && p.matched_at && !p.sent_at && !p.archived_at
      && !sourceIds?.has(p.id) && p.status === "proposal_wait")
    : null;
  const backlogIds = new Set((backlogged || []).map((p) => p.id));
  const backlogById = new Map((backlogged || []).map((p) => [p.id, p]));
  const overdueTasks = tasksAvailable && backlogged
    ? [...taskRows.reduce((byProposal, task) => {
      if (task.kind !== "prepare" || task.status !== "open" || !backlogIds.has(task.proposal_id)
        || Date.parse(task.due_at) >= Date.parse(now)) return byProposal;
      const prior = byProposal.get(task.proposal_id);
      if (!prior || Date.parse(task.due_at) < Date.parse(prior.due_at)) byProposal.set(task.proposal_id, task);
      return byProposal;
    }, new Map()).values()]
    : null;
  const employeesById = new Map((employees || []).map((e) => [e.id, e]));
  const staleRows = overdueTasks?.map((t) => {
    const proposal = backlogById.get(t.proposal_id);
    return {
      id: t.proposal_id,
      companyName: proposal?.company_name || "（企業名未取得）",
      title: proposal?.title || proposal?.job_title || "（案件名未取得）",
      ownerName: employeesById.get(t.assignee_id)?.display_name || proposal?.matching_owner_name || "担当未割当",
      matchedAt: proposal?.matched_at || null,
      taskDueAt: t.due_at,
    };
  }).sort((a, b) => String(a.taskDueAt).localeCompare(String(b.taskDueAt))) || null;

  const syncStatus = sync?.available
    ? { status: sync.latestReceivedAt ? "available" : "no_history", latestReceivedAt: sync.latestReceivedAt || null,
        unresolvedCount: sync.unresolvedCount ?? null }
    : { status: "unavailable", latestReceivedAt: null, unresolvedCount: null };
  const salesStatus = !proposalsAvailable ? "unavailable" : !activitiesAvailable ? "partial" : "available";
  const matchingStatus = !matchingAvailable ? "unavailable"
    : (!tasksAvailable || !sync?.available || ["unavailable", "partial"].includes(sourceStateStatus) ? "partial" : "available");
  const matching = {
    status: matchingStatus,
    source: "ENGERからSalesへ同期されたマッチング・提案記録",
    current: currentMatching,
    previous: previousMatching,
    backlogCount: backlogged?.length ?? null,
    stalledCount: overdueTasks?.length ?? null,
    backlogRows: backlogged?.slice(0, 100).map((p) => ({
      id: p.id, companyName: p.company_name || "（企業名未取得）",
      title: p.title || p.job_title || "（案件名未取得）",
      ownerName: p.proposal_owner_name || p.sales_owner_name || p.matching_owner_name || "担当未割当",
      matchedAt: p.matched_at, sourceUrl: p.source_url || null,
    })).sort((a, b) => String(a.matchedAt).localeCompare(String(b.matchedAt))) || null,
    backlogRowsTotal: backlogged?.length ?? null,
    stalledRows: staleRows?.slice(0, 100) ?? null,
    stalledRowsTotal: staleRows?.length ?? null,
    sync: syncStatus,
  };
  const sales = {
    status: salesStatus,
    source: "Sales提案・活動記録（社員の日報本文は対象外）",
    current,
    previous,
    byOwner: owners.rows,
    bottlenecks: owners.bottlenecks,
    ownerStatus: owners.status,
    blasts: { status: allQualifications ? "available" : "unavailable", count: blastRows?.length ?? null, rows: blastRows?.slice(0, 100) ?? null, rowsTotal: blastRows?.length ?? null },
    sourceStateStatus,
  };
  const insights = buildInsights({ sales, matching, blastCompanies: sales.blasts, bottlenecks: sales.bottlenecks, sync: syncStatus, date });
  return { generatedAt: now, period: windows, sales, matching, insights };
}
