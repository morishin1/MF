import { CLOSE_REASON_LABEL } from "./sales-proposals.js";

const CLOSED = new Set(["lost", "closed_no_reply", "stopped"]);
const jstDay = (value) => {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at + 9 * 3600000).toISOString().slice(0, 10) : "";
};

/** 指定日の送信・活動・クローズを、JSTの日付境界で集計する純粋関数。 */
export function buildDailyProposalAnalysis({
  date, proposals = [], closedProposals = [], activities = [], meetingProposalIds = new Set(),
  deletedProposalIds = new Set(), activeProposalIds = null,
}) {
  const active = (row) => !row.archived_at && !deletedProposalIds.has(row.id);
  const sent = proposals.filter((p) => active(p) && jstDay(p.sent_at) === date);
  const closed = closedProposals.filter((p) => active(p) && CLOSED.has(p.status) && jstDay(p.closed_at) === date);
  const daily = activities.filter((a) => (!activeProposalIds || activeProposalIds.has(a.proposal_id))
    && !deletedProposalIds.has(a.proposal_id) && jstDay(a.occurred_at) === date);
  const doneMeetings = daily.filter((a) => a.kind === "meeting" && a.result === "done");
  const callCount = daily.filter((a) => a.kind === "call").length;
  const mailCount = daily.filter((a) => a.kind === "mail").length;
  const replyCount = daily.filter((a) => a.kind === "reply").length;
  const reasons = new Map();
  for (const p of closed) {
    const key = p.close_reason || "unknown";
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  const met = sent.filter((p) => p.status === "meeting_done" || meetingProposalIds.has(p.id)).length;
  return {
    date,
    proposalSentCount: sent.length,
    meetingEventCount: doneMeetings.length,
    meetingCohortCount: met,
    conversionRate: sent.length ? Math.round((met * 1000) / sent.length) / 10 : null,
    callCount,
    mailCount,
    replyCount,
    actionCount: callCount + mailCount + replyCount + doneMeetings.length,
    closedCount: closed.length,
    lossReasons: [...reasons].map(([key, count]) => ({
      key,
      label: key === "unknown" ? "理由未取得" : CLOSE_REASON_LABEL[key] || key,
      count,
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja")),
  };
}
