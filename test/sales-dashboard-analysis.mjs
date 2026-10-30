import assert from "node:assert/strict";
import { buildSalesDashboardAnalysis, previousSalesPeriod } from "../lib/sales-dashboard-analysis.js";

const period = {
  key: "custom", label: "期間指定", from: "2026-10-28", to: "2026-10-29", days: 2,
  sinceIso: "2026-10-27T15:00:00.000Z", untilIso: "2026-10-29T15:00:00.000Z",
};
const previous = previousSalesPeriod(period);
assert.equal(previous.from, "2026-10-26");
assert.equal(previous.to, "2026-10-27");
assert.equal(previous.sinceIso, "2026-10-25T15:00:00.000Z");
assert.equal(previous.untilIso, "2026-10-27T15:00:00.000Z");

const proposals = [
  { id: "matched", source_system: "enger", source_proposal_id: "e1", company_id: "co-1", company_name: "候補社", sales_owner_id: "owner-1", matched_at: "2026-10-27T15:00:00.000Z", sent_at: null, status: "proposal_wait" },
  { id: "sent-met", source_system: "enger", source_proposal_id: "e2", company_id: "co-1", company_name: "候補社", sales_owner_id: "owner-1", matched_at: "2026-10-26T15:00:00Z", sent_at: "2026-10-28T14:59:59Z", status: "reply_wait" },
  { id: "sent-met-after", source_system: "manual", company_id: "co-2", company_name: "面談社", sales_owner_id: "owner-2", sent_at: "2026-10-29T14:59:59+00:00", status: "lost", close_reason: "client_declined", closed_at: "2026-10-29T14:59:59+00:00" },
  { id: "sent-unmet", source_system: "enger", source_proposal_id: "e3", company_id: "co-2", company_name: "面談社", sales_owner_id: "owner-2", sent_at: "2026-10-29T14:59:59.999Z", status: "closed_no_reply", close_reason: null, closed_at: "2026-10-29T14:59:59.999Z" },
  ...Array.from({ length: 15 }, (_, i) => ({
    id: `blast-${i}`, source_system: "manual", company_id: "co-blast", company_name: "候補社なし面談", sales_owner_id: "owner-1",
    sent_at: `2026-10-${String(i < 5 ? 28 : 29).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`, status: "reply_wait",
  })),
  { id: "old", source_system: "enger", source_proposal_id: "old", company_id: "co-old", company_name: "対象外", sales_owner_id: "owner-1", sent_at: "2026-10-26T14:59:59Z", status: "reply_wait" },
  { id: "archived", source_system: "manual", company_id: "co-archived", company_name: "アーカイブ", sent_at: "2026-10-28T12:00:00Z", status: "reply_wait", archived_at: "2026-10-29T00:00:00Z" },
  { id: "deleted", source_system: "enger", source_proposal_id: "gone", company_id: "co-deleted", company_name: "削除済み", sent_at: "2026-10-28T12:00:00Z", status: "reply_wait" },
];
const meetingEvents = [
  { proposal_id: "sent-met", kind: "meeting", result: "done", occurred_at: "2026-10-28T14:59:00.000Z" },
  { proposal_id: "sent-met-after", kind: "meeting", result: "done", occurred_at: "2026-10-29T14:59:00.000Z" },
  { proposal_id: "sent-met-after", kind: "meeting", result: "done", occurred_at: "2026-10-29T14:59:30.000Z" },
  { proposal_id: "old", kind: "meeting", result: "done", occurred_at: "2026-10-28T12:00:00Z" },
  { proposal_id: "deleted", kind: "meeting", result: "done", occurred_at: "2026-10-28T12:00:00Z" },
];
const meetingHistory = [
  { proposal_id: "sent-met", kind: "meeting", result: "done" },
  { proposal_id: "sent-met-after", kind: "meeting", result: "done" },
  { proposal_id: "old", kind: "meeting", result: "done" },
  { proposal_id: "deleted", kind: "meeting", result: "done" },
];
const result = buildSalesDashboardAnalysis({
  period, previous, proposals, meetingEvents, meetingHistory,
  employees: [{ id: "owner-1", display_name: "担当A" }, { id: "owner-2", display_name: "担当B" }],
  deletedProposalIds: new Set(["deleted"]),
});
assert.equal(result.metrics.matchingCount, 1, "マッチング確定はJSTの確定日時で集計");
assert.equal(result.metrics.unsubmittedMatchedCount, 1, "当期マッチングの未送信は現状の送信日時で確認");
assert.equal(result.metrics.proposalSentCount, 18, "JST期間内の提案だけ。アーカイブ・削除・期間外を除外");
assert.equal(result.metrics.meetingEventCount, 4, "面談実施は実施日でイベント数を数える");
assert.equal(result.metrics.meetingCohortCount, 2, "送信コホートの面談到達は提案単位で重複させない");
assert.equal(result.metrics.conversionRate, 11.1);
assert.equal(result.metrics.closedCount, 2);
assert.deepEqual(result.metrics.lossReasons, [
  { key: "client_declined", label: "企業側の見送り", count: 1 },
  { key: "unknown", label: "理由未取得", count: 1 },
]);
assert.equal(result.metrics.blastCompanies.length, 1);
assert.equal(result.metrics.blastCompanies[0].companyName, "候補社なし面談");
assert.equal(result.metrics.byOwner.find((row) => row.ownerId === "owner-1").meetingCohortCount, 1);
assert.equal(result.metrics.byOwner.find((row) => row.ownerId === "owner-2").meetingEventCount, 2);
assert.equal(result.metrics.byOwner.find((row) => row.ownerId === "owner-1").ownerName, "担当A");

const noProposalPeriod = { ...period, from: "2026-10-01", to: "2026-10-01", days: 1,
  sinceIso: "2026-09-30T15:00:00.000Z", untilIso: "2026-10-01T15:00:00.000Z" };
const empty = buildSalesDashboardAnalysis({ period: noProposalPeriod, previous: previousSalesPeriod(noProposalPeriod) });
assert.equal(empty.metrics.conversionRate, null, "分母0を0%として扱わない");
assert.equal(empty.metrics.meetingEventCount, 0);
console.log("Sales dashboard analysis: JST periods, event/cohort distinction, reasons, owners, blast rule, and zero denominator OK");

assert.equal(result.metrics.byCompany.reduce((sum, row) => sum + row.sentCount, 0), result.metrics.proposalSentCount);
assert.equal(result.metrics.byCompany.find(row => row.key === result.metrics.blastCompanies[0].key).rate, 0);
assert.ok(result.metrics.byCompany.some(row => row.meetingCount > 0), "成功した企業も一覧に含める");
const roles = buildSalesDashboardAnalysis({
 period, previous, proposals:[
 {id:"role-a",company_id:"a",company_name:"同名企業A",sent_at:"2026-10-28T01:00:00Z",matched_at:"2026-10-27T01:00:00Z",proposal_owner_id:"registered",cs_owner_id:"cs-a",status:"won"},
 {id:"role-b",company_id:"b",company_name:"同名企業B",sent_at:"2026-10-28T02:00:00Z",proposal_owner_id:"registered",cs_owner_id:"cs-b",status:"reply_wait"}
 ], meetingHistory:[
 {proposal_id:"role-a",kind:"sent",employee_id:"actor",occurred_at:"2026-10-28T01:00:00Z"},
 {proposal_id:"role-a",kind:"meeting",result:"done",occurred_at:"2026-10-29T01:00:00Z"}
 ],employees:[{id:"actor",display_name:"同名"},{id:"registered",display_name:"同名"},{id:"cs-a",display_name:"CS"},{id:"cs-b",display_name:"CS"}]
});
assert.equal(roles.metrics.roleRows.proposal.length,2,"同名でもIDで別集計");
assert.equal(roles.metrics.roleRows.cs.length,2,"同名CSを混同しない");
assert.equal(roles.metrics.roleRows.proposal.find(row=>row.ownerId==="actor").recordedActorCount,1);
assert.equal(roles.metrics.roleRows.closing[0].ownerId,"unassigned","成約からCL担当を推定しない");
assert.equal(roles.metrics.sentRecords.find(row=>row.proposalId==="role-a").elapsedHours,24,"経過時間であり実作業時間ではない");
assert.equal(roles.metrics.sentRecords.find(row=>row.proposalId==="role-b").elapsedHours,null);
assert.equal(roles.metrics.sentRecords.find(row=>row.proposalId==="role-b").actorBasis,"登録提案担当（実行者未確認）");
const resent = buildSalesDashboardAnalysis({
 period, previous,
 proposals:[{id:"resend",sent_at:"2026-10-28T01:00:00Z",proposal_owner_id:"registered"}],
 meetingHistory:[
 {proposal_id:"resend",kind:"sent",occurred_at:"2026-10-28T01:00:00Z",employee_id:null},
 {proposal_id:"resend",kind:"sent",occurred_at:"2026-10-29T01:00:00Z",employee_id:"later"}],
 employees:[{id:"registered",display_name:"登録担当"},{id:"later",display_name:"再送者"}]
});
assert.equal(resent.metrics.sentRecords[0].ownerName,"登録担当","再送者を最初の送信者としない");
assert.equal(resent.metrics.sentRecords[0].actorBasis,"登録提案担当（実行者未確認）");
assert.equal(resent.metrics.roleRows.proposal[0].recordedActorCount,0);
const scheduledOnly = buildSalesDashboardAnalysis({
 period,previous,proposals:[{id:"scheduled",company_id:"co",sent_at:"2026-10-28T01:00:00Z",meeting_at:"2026-10-29T01:00:00Z",status:"meeting_adjust",proposal_owner_id:"owner"}],
 meetingHistory:[{proposal_id:"scheduled",kind:"meeting",result:"scheduled",occurred_at:"2026-10-29T01:00:00Z"}]
});
assert.equal(scheduledOnly.metrics.meetingCohortCount,0,"予定だけを実施と数えない");
assert.equal(scheduledOnly.metrics.byCompany[0].rate,0);
assert.equal(scheduledOnly.metrics.roleRows.proposal[0].rate,0);
const companyWithLoss = result.metrics.byCompany.find(row=>row.companyName==="面談社");
assert.equal(companyWithLoss.lossReasons.reduce((total,row)=>total+row.count,0),2,"送信コホートの企業別終了理由");
assert.ok(companyWithLoss.lossReasons.some(row=>row.label==="理由未取得" && row.count===1));
assert.ok(result.metrics.byCompany.find(row=>row.companyName==="候補社").lossReasons.length===0,"別企業の失注を混ぜない");
const lateClose = buildSalesDashboardAnalysis({period,previous,proposals:[
 {id:"late-close",company_id:"late",company_name:"架空社",sent_at:"2026-10-28T01:00:00Z",status:"lost",close_reason:"client_declined",closed_at:"2026-10-30T01:00:00Z"}
]});
assert.equal(lateClose.metrics.closedCount,0,"終了日時が期間外なら期間内終了には含めない");
assert.equal(lateClose.metrics.byCompany[0].lossReasons[0].count,1,"送信コホートの現在理由は後日の終了も含む");
