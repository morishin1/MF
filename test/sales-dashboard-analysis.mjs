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
