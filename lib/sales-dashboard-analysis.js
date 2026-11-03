import { CLOSE_REASON_LABEL } from "./sales-proposals.js";
import { qualificationKey } from "./sales-company-qualification.js";

const LOST = new Set(["lost", "closed_no_reply", "stopped"]);
const jstBoundary = (day) => new Date(`${day}T00:00:00+09:00`).toISOString();
const nextDay = (day, delta) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};

export function previousSalesPeriod(period) {
  const to = nextDay(period.from, -1);
  const from = nextDay(period.from, -period.days);
  return {
    key: "previous", label: `直前${period.days}日間`, from, to, days: period.days,
    sinceIso: jstBoundary(from), untilIso: jstBoundary(nextDay(to, 1)),
  };
}

const inPeriod = (value, period) => {
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= Date.parse(period.sinceIso) && at < Date.parse(period.untilIso);
};

function newOwner(ownerId, employeeNames) {
  return {
    ownerId,
    ownerName: ownerId === "unassigned" ? "担当未割当" : employeeNames.get(ownerId) || "社員情報未取得",
    matchingCount: 0,
    proposalSentCount: 0,
    meetingEventCount: 0,
    meetingCohortCount: 0,
  };
}

function periodMetrics({ period, proposals, meetingEvents, meetingHistoryIds, deletedProposalIds, employeeNames, sentActors }) {
  const active = (proposal) => !proposal.archived_at && !deletedProposalIds.has(proposal.id);
  const rows = proposals.filter(active);
  const byProposal = new Map(rows.map((proposal) => [proposal.id, proposal]));
  const matched = rows.filter((proposal) => proposal.source_system === "enger" && inPeriod(proposal.matched_at, period));
  const sent = rows.filter((proposal) => inPeriod(proposal.sent_at, period));
  const doneMeetings = meetingEvents.filter((event) => inPeriod(event.occurred_at, period)
    && !deletedProposalIds.has(event.proposal_id));
  const closed = rows.filter((proposal) => LOST.has(proposal.status) && inPeriod(proposal.closed_at, period));
  const metIds = new Set([
    ...meetingHistoryIds,
    ...rows.filter((proposal) => proposal.status === "meeting_done").map((proposal) => proposal.id),
  ]);
  const cohortMet = sent.filter((proposal) => metIds.has(proposal.id));
  const reasons = new Map();
  for (const proposal of closed) {
    const key = proposal.close_reason || "unknown";
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }

  const ownerMap = new Map();
  const owner = (id) => {
    const key = id || "unassigned";
    if (!ownerMap.has(key)) ownerMap.set(key, newOwner(key, employeeNames));
    return ownerMap.get(key);
  };
  for (const proposal of matched) owner(proposal.sales_owner_id).matchingCount++;
  for (const proposal of sent) owner(proposal.sales_owner_id).proposalSentCount++;
  for (const proposal of cohortMet) owner(proposal.sales_owner_id).meetingCohortCount++;
  for (const event of doneMeetings) owner(byProposal.get(event.proposal_id)?.sales_owner_id).meetingEventCount++;

  const roleRows = {};
  for (const [role, field] of [["proposal", "proposal_owner_id"], ["cs", "cs_owner_id"], ["closing", "closing_owner_id"]]) {
    const grouped = new Map();
    for (const proposal of sent) {
      const actor = role === "proposal" ? sentActors.get(proposal.id) : null;
      const id = actor?.employee_id || proposal[field] || "unassigned";
      const row = grouped.get(id) || { ownerId:id, ownerName:id === "unassigned" ? "記録未確認" : employeeNames.get(id) || "社員情報未取得", sentCount:0, meetingCount:0, wonCount:0, recordedActorCount:0 };
      row.sentCount++;
      if (metIds.has(proposal.id)) row.meetingCount++;
      if (proposal.status === "won") row.wonCount++;
      if (actor?.employee_id) row.recordedActorCount++;
      grouped.set(id,row);
    }
    roleRows[role] = [...grouped.values()].map(row => ({...row, rate:row.sentCount ? Math.round(row.meetingCount * 1000 / row.sentCount) / 10 : null}))
      .sort((a,b) => b.sentCount-a.sentCount || a.ownerId.localeCompare(b.ownerId));
  }
  const sentRecords = [...sent].sort((a,b)=>String(b.sent_at).localeCompare(String(a.sent_at))).map(proposal => {
    const actor = sentActors.get(proposal.id);
    const id = actor?.employee_id || proposal.proposal_owner_id || null;
    const elapsed = Date.parse(proposal.sent_at) - Date.parse(proposal.matched_at);
    return { proposalId:proposal.id, sourceProposalId:proposal.source_system === "enger" ? proposal.source_proposal_id || null : null,
      companyKey: qualificationKey(proposal),companyName:proposal.company_name || "（社名なし）",
      title:proposal.job_title || "提案内容未登録", sentAt:proposal.sent_at,
      ownerName:id ? employeeNames.get(id) || "社員情報未取得" : "記録未確認",
      actorBasis:actor?.employee_id ? "送信活動の実行者" : id ? "登録提案担当（実行者未確認）" : "実行者未確認",
      status:proposal.status || "未確認", meetingReached:metIds.has(proposal.id),
      closeReason:LOST.has(proposal.status) ? (CLOSE_REASON_LABEL[proposal.close_reason] || "理由未取得") : null,
      elapsedHours:Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 360000) / 10 : null };
  });

  // Evidence uses the SAME proposal IDs and JST predicates as KPI totals. Keep missing
  // actor/meeting data explicit rather than deriving a successful outcome from status alone.
  const evidenceRow=(proposal,at,kind,extra={})=>{
    const actor=sentActors.get(proposal.id);
    const id=actor?.employee_id||proposal.proposal_owner_id||null;
    return {proposalId:proposal.id,companyKey:qualificationKey(proposal),
      companyName:proposal.company_name||"（社名なし）",title:proposal.job_title||"提案内容未登録",
      occurredAt:at,kind,status:proposal.status||"未確認",
      ownerName:id?employeeNames.get(id)||"社員情報未取得":"記録未確認",
      actorBasis:actor?.employee_id?"送信活動の実行者":id?"登録提案担当（実行者未確認）":"実行者未確認",
      meetingReached:metIds.has(proposal.id),...extra};
  };
  const byLatest=(a,b)=>String(b.occurredAt||"").localeCompare(String(a.occurredAt||""));
  // Reuse the report's source rows for proof without new RLS/tenant access paths.
  const evidence={
    matching:matched.map(p=>evidenceRow(p,p.matched_at,"matching",{sentAt:p.sent_at||null})).sort(byLatest),
    sent:sentRecords.map(r=>({proposalId:r.proposalId,companyKey:r.companyKey,companyName:r.companyName,
      title:r.title,occurredAt:r.sentAt,status:r.status,ownerName:r.ownerName,
      actorBasis:r.actorBasis,meetingReached:r.meetingReached,closeReason:r.closeReason,kind:"sent"})),
    meetings:doneMeetings.map(event=>{
      const p=byProposal.get(event.proposal_id);
      return p?evidenceRow(p,event.occurred_at,"meeting",{eventId:event.id||null}):{
        proposalId:event.proposal_id,companyKey:null,companyName:"提案原本未取得",
        title:"面談実施記録",occurredAt:event.occurred_at,status:"未確認",
        ownerName:"記録未確認",actorBasis:"対象提案未取得",meetingReached:true,kind:"meeting",eventId:event.id||null};
    }).sort(byLatest),
    cohort:sent.filter(p=>metIds.has(p.id)).map(p=>evidenceRow(p,p.sent_at,"cohort")).sort(byLatest),
    closed:closed.map(p=>evidenceRow(p,p.closed_at,"closed",{
      closeReason:CLOSE_REASON_LABEL[p.close_reason]||"理由未取得"
    })).sort(byLatest)
  };

  // Event-date trends from the rows already fetched for the selected period (JST).
  // The three series have distinct clocks: proposal.sent_at, meeting.occurred_at, won status.
  const jstDay = value => {
    const t=Date.parse(value);
    return Number.isFinite(t)?new Date(t+9*3600000).toISOString().slice(0,10):null;
  };
  const jstHour = value => {
    const t=Date.parse(value);
    return Number.isFinite(t)?new Date(t+9*3600000).getUTCHours():null;
  };
  const trends = new Map();
  const date=new Date(period.from+"T00:00:00Z");
  while (date.toISOString().slice(0,10)<=period.to && trends.size<400) {
    const day=date.toISOString().slice(0,10);
    trends.set(day,{date:day,sent:0,meetings:0});
    date.setUTCDate(date.getUTCDate()+1);
  }
  const hours=Array.from({length:24},(_,hour)=>({hour,label:String(hour).padStart(2,"0")+"時",count:0}));
  for(const proposal of sent){
    const day=jstDay(proposal.sent_at),hour=jstHour(proposal.sent_at);
    if(trends.has(day))trends.get(day).sent++;
    if(hour!==null)hours[hour].count++;
  }
  for(const event of doneMeetings){
    const day=jstDay(event.occurred_at);
    if(trends.has(day))trends.get(day).meetings++;
  }

  const companies = new Map();
  for (const proposal of sent) {
    const key = qualificationKey(proposal);
    let company = companies.get(key);
    if (!company) {
      company = { key, companyName: proposal.company_name || "（社名なし）", sentCount: 0, meetingCount: 0, lossReasonCounts: Object.create(null) };
      companies.set(key, company);
    }
    company.sentCount++;
    if (LOST.has(proposal.status)) {
      const reason = proposal.close_reason || "unknown";
      company.lossReasonCounts[reason] = (company.lossReasonCounts[reason] || 0) + 1;
    }
    if (metIds.has(proposal.id)) company.meetingCount++;
  }
  const byCompany = [...companies.values()]
    .map((company) => ({ ...company, lossReasons: Object.entries(company.lossReasonCounts).map(([key,count]) => ({label:key === "unknown" ? "理由未取得" : CLOSE_REASON_LABEL[key] || key,count})), rate: company.sentCount ? Math.round(company.meetingCount * 1000 / company.sentCount) / 10 : null }))
    .sort((a, b) => b.sentCount - a.sentCount || a.companyName.localeCompare(b.companyName, "ja"));

  // These are *follow-up candidates*, never proven profitable/ready-to-order jobs.
  // A completed-demand gate and a real gross-margin calculation are not held by Sales.
  // Keep the source proposal UUID so the action always opens the ENGER source of truth.
  const ACTIVE_STATUS_PRIORITY = {
    meeting_done: 0, meeting_adjust: 1, reply_wait: 2, considering: 3,
    call_wait: 4, mail_wait: 5, reproposal: 6, proposal_wait: 7,
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seenSource = new Set();
  const priorityCases = rows
    .filter((row) => row.source_system === "enger" && UUID.test(row.source_proposal_id || "")
      && Object.hasOwn(ACTIVE_STATUS_PRIORITY, row.status))
    .sort((a, b) => ACTIVE_STATUS_PRIORITY[a.status] - ACTIVE_STATUS_PRIORITY[b.status]
      || String(b.sent_at || b.matched_at || "").localeCompare(String(a.sent_at || a.matched_at || "")))
    .filter((row) => {
      if (seenSource.has(row.source_proposal_id)) return false;
      seenSource.add(row.source_proposal_id);
      return true;
    })
    .slice(0, 10)
    .map((row) => ({
      proposalId: row.source_proposal_id,
      title: row.job_title || "案件名未確認",
      companyName: row.company_name || "企業未確認",
      status: row.status,
      demandVerified: false, supplyVerified: false, profitVerified: false,
    }));

  return {
    matchingCount: matched.length,
    unsubmittedMatchedCount: matched.filter((proposal) => !proposal.sent_at).length,
    proposalSentCount: sent.length,
    meetingEventCount: doneMeetings.length,
    meetingCohortCount: cohortMet.length,
    wonCohortCount: sent.filter(p=>p.status==="won").length,
    evidence,
    dailyTrend:[...trends.values()],
    sentByHour:hours,
    conversionRate: sent.length ? Math.round(cohortMet.length * 1000 / sent.length) / 10 : null,
    closedCount: closed.length,
    lossReasons: [...reasons].map(([key, count]) => ({
      key, label: key === "unknown" ? "理由未取得" : CLOSE_REASON_LABEL[key] || key, count,
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja")),
    byOwner: [...ownerMap.values()].sort((a, b) =>
      (b.matchingCount + b.proposalSentCount + b.meetingEventCount) - (a.matchingCount + a.proposalSentCount + a.meetingEventCount)
      || a.ownerName.localeCompare(b.ownerName, "ja"))
      .map((row) => ({ ...row, conversionRate: row.proposalSentCount
        ? Math.round(row.meetingCohortCount * 1000 / row.proposalSentCount) / 10 : null })),
    byCompany, roleRows, sentRecords, priorityCases,
    blastCompanies: byCompany.filter((company) => company.sentCount >= 15 && company.meetingCount === 0),
  };
}

/**
 * Salesダッシュボード向けの集計。現在期間と直前の同日数はイベント日で分け、
 * 面談実施は実施日、提案→面談率は選択期間内の送信提案コホートで別々に数える。
 */
export function buildSalesDashboardAnalysis({
  period, previous, proposals = [], meetingEvents = [], meetingHistory = [], employees = [], deletedProposalIds = new Set(),
}) {
  const employeeNames = new Map(employees.map((employee) => [employee.id, employee.display_name]));
  const meetingHistoryIds = new Set(meetingHistory
    .filter((event) => event.kind === "meeting" && event.result === "done" && !deletedProposalIds.has(event.proposal_id))
    .map((event) => event.proposal_id));
  const sentActors = new Map();
  const byProposal = new Map(proposals.map(proposal => [proposal.id, proposal]));
  const sentEvidence = new Map();
  for (const event of meetingHistory) {
    const sentAt = Date.parse(byProposal.get(event.proposal_id)?.sent_at);
    if (event.kind !== "sent" || !Number.isFinite(sentAt) || Date.parse(event.occurred_at) !== sentAt) continue;
    if (!sentEvidence.has(event.proposal_id)) sentEvidence.set(event.proposal_id, []);
    sentEvidence.get(event.proposal_id).push(event);
  }
  for (const [id, events] of sentEvidence) {
    const actors = new Set(events.map(event => event.employee_id || null));
    if (actors.size === 1 && !actors.has(null)) sentActors.set(id, events[0]);
  }
  const metrics = periodMetrics({ period, proposals, meetingEvents, meetingHistoryIds, deletedProposalIds, employeeNames, sentActors });
  const previousMetrics = periodMetrics({ period: previous, proposals, meetingEvents, meetingHistoryIds, deletedProposalIds, employeeNames, sentActors });

  const issues = [];
  const improvements = [];
  const actions = [];
  if (!metrics.proposalSentCount && !metrics.matchingCount && !metrics.meetingEventCount) {
    issues.push("対象期間に該当する営業・マッチング記録はありません。入力状況を確認してください。");
  }
  if (metrics.unsubmittedMatchedCount) {
    issues.push(`対象期間のマッチング確定のうち、現時点で未送信の提案が${metrics.unsubmittedMatchedCount}件あります。`);
    actions.push("Salesの提案管理で未送信のマッチングを確認し、担当者と提案予定日を決める。");
  }
  if (metrics.proposalSentCount && metrics.conversionRate < 10) {
    issues.push(`提案送信コホートの面談移行率は${metrics.conversionRate}%で、目標10%に届いていません（${metrics.meetingCohortCount}/${metrics.proposalSentCount}件）。`);
    actions.push("面談に至らなかった提案の企業・案件条件と、記録済みの失注理由を見直す。");
  } else if (metrics.proposalSentCount && metrics.conversionRate >= 10) {
    improvements.push(`提案送信コホートの面談移行率は${metrics.conversionRate}%で、目標10%を達成しています。`);
    actions.push("面談につながった企業・提案条件を担当者間で共有し、次の提案に活かす。");
  }
  const unknownLosses = metrics.lossReasons.find((row) => row.key === "unknown")?.count || 0;
  if (unknownLosses) {
    issues.push(`失注・クローズ${unknownLosses}件は理由が未取得です。`);
    actions.push("Salesの提案管理で、理由未取得のクローズ記録に実際の理由を登録する。");
  }
  if (metrics.blastCompanies.length) {
    improvements.push(`期間内に15件以上提案し面談実施0件の「ブラスト限定候補」が${metrics.blastCompanies.length}社あります。`);
    actions.push("ブラスト限定候補の記録を確認し、新規提案を続けるか担当者が判断する。");
  }
  if (!issues.length && !improvements.length) improvements.push("対象期間の実績から、目標未達や要確認の条件は検出されていません。");

  return {
    period: { key: period.key, label: period.label, from: period.from, to: period.to, days: period.days },
    previousPeriod: { label: previous.label, from: previous.from, to: previous.to, days: previous.days },
    metrics, previousMetrics,
    insights: { issues, improvements, actions: [...new Set(actions)] },
  };
}
