import assert from "node:assert/strict";
import { buildDailyProposalAnalysis } from "../lib/sales-proposal-daily-analysis.js";

const date = "2026-10-29";
const proposals = [
  { id: "a", sent_at: "2026-10-28T15:00:00.000Z", status: "meeting_done" },
  { id: "b", sent_at: "2026-10-29T14:59:59.999Z", status: "reply_wait" },
  { id: "c", sent_at: "2026-10-29T15:00:00.000Z", status: "reply_wait" },
  { id: "archived", sent_at: "2026-10-29T05:00:00.000Z", status: "reply_wait", archived_at: "2026-10-29T06:00:00Z" },
  { id: "deleted", sent_at: "2026-10-29T05:00:00.000Z", status: "reply_wait" },
];
const closedProposals = [
  { id: "loss", status: "closed_no_reply", closed_at: "2026-10-28T15:00:00Z", close_reason: "no_reply" },
  { id: "won", status: "won", closed_at: "2026-10-28T15:00:00Z" },
];
const activities = [
  { proposal_id: "a", kind: "call", occurred_at: "2026-10-28T15:10:00Z" },
  { proposal_id: "a", kind: "meeting", result: "scheduled", occurred_at: "2026-10-28T15:11:00Z" },
  { proposal_id: "b", kind: "meeting", result: "done", occurred_at: "2026-10-29T14:59:00Z" },
  { proposal_id: "b", kind: "mail", occurred_at: "2026-10-29T14:58:00Z" },
  { proposal_id: "c", kind: "reply", occurred_at: "2026-10-29T15:00:00Z" },
  { proposal_id: "archived", kind: "call", occurred_at: "2026-10-29T05:00:00Z" },
  { proposal_id: "deleted", kind: "reply", occurred_at: "2026-10-29T05:00:00Z" },
];
const summary = buildDailyProposalAnalysis({
  date, proposals, closedProposals, activities,
  meetingProposalIds: new Set(["b"]),
  deletedProposalIds: new Set(["deleted"]),
  activeProposalIds: new Set(["a", "b", "c", "loss"]),
});
assert.equal(summary.proposalSentCount, 2, "JSTの当日境界だけを提案送信として数える");
assert.equal(summary.meetingEventCount, 1, "当日実施した面談だけを数える");
assert.equal(summary.meetingCohortCount, 2, "当日送信した提案のうち面談実施記録のある件数");
assert.equal(summary.conversionRate, 100);
assert.equal(summary.callCount, 1);
assert.equal(summary.mailCount, 1);
assert.equal(summary.replyCount, 0, "翌日JSTの返信は含めない");
assert.equal(summary.actionCount, 3);
assert.equal(summary.closedCount, 1, "選択日に見送り・クローズした記録だけを数える");
assert.deepEqual(summary.lossReasons, [{ key: "no_reply", label: "無回答", count: 1 }]);

const empty = buildDailyProposalAnalysis({ date, proposals: [], closedProposals: [], activities: [] });
assert.equal(empty.proposalSentCount, 0);
assert.equal(empty.conversionRate, null, "分母が0なら0%ではなく比較なし");
console.log("Sales proposal daily analysis: JST boundaries, activity counts, and empty denominator OK");
