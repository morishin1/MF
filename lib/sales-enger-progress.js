import { CLOSE_REASON_LABEL, STATUS_LABEL, isClosed } from "./sales-proposals.js";

export const PROGRESS_FIELDS = "next_action,next_due_on,meeting_held_on,joined_on";
export const PROGRESS_INPUTS = {
  nextAction: "next_action", nextDueOn: "next_due_on", meetingHeldOn: "meeting_held_on", joinedOn: "joined_on",
};
export const MILESTONES = [
  ["sentOn", "提案送信"], ["meetingOn", "面談実施"], ["offerOn", "オファー"],
  ["wonOn", "受注"], ["joinedOn", "参画"],
];
const OFFER_STATUS = { new: "未対応", contacting: "連絡中", meeting: "面談調整", negotiating: "条件交渉", won: "成約確認待ち", lost: "見送り" };

export function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(value + "T00:00:00Z");
  return Number.isFinite(+day) && day.toISOString().slice(0, 10) === value;
}

export function jstDay(value) {
  if (!value) return null;
  if (validDay(value)) return value;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at + 9 * 3600000).toISOString().slice(0, 10) : null;
}

export function shapeEngerProgress({ kind, source, companyId, deal, meetingAt, offerAt, task, people, today, sourceStage, progress }) {
  const proposal = kind === "proposal";
  const sentOn = proposal ? jstDay(source.sent_at) : null;
  const meetingOn = deal?.meeting_held_on || jstDay(meetingAt);
  const offerOn = jstDay(proposal ? offerAt : source.created_at);
  const wonInProposal = proposal && source.status === "won";
  const wonOn = (wonInProposal ? jstDay(source.closed_at) : null) || deal?.won_on || null;
  const joinedOn = (wonInProposal && progress?.stage === "active" ? progress.startOn : null) || deal?.joined_on || null;
  const milestones = { sentOn, meetingOn, offerOn, wonOn, joinedOn };
  const closed = wonInProposal || (deal ? deal.stage === "lost" || Boolean(deal.joined_on) : proposal ? isClosed(source.status) : source.status === "lost");
  const ownerId = (deal ? deal.owner_id : proposal && source.sales_owner_id) || null;
  const nextAction = deal ? deal.next_action : task?.title;
  const nextDueOn = deal ? deal.next_due_on : jstDay(task?.due_at);
  const sourceStageConflict = proposal && sourceStage === "失注" && !isClosed(source.status);
  const lastRecorded = Object.values(milestones).filter(day => day && day <= today).sort().at(-1);
  const stalledDays = !closed && lastRecorded ? Math.round((Date.parse(today) - Date.parse(lastRecorded)) / 86400000) : null;
  return {
    id: source.id, kind, companyId, companyName: source.company_name || null,
    engerCompanyId: proposal ? source.source_company_id : source.company_id,
    title: source.job_title || source.title || "企業からのオファー",
    ownerId, ownerName: people.get(ownerId) || null, milestones,
    dealId: deal?.id || null, dealStage: deal?.stage || null, amount: deal?.amount ?? null, updatedAt: deal?.updated_at || null,
    expectedCloseOn: deal?.expected_close_on || null,
    closed, nextAction: nextAction || null, nextDueOn: nextDueOn || null, stalledDays,
    sourceStatus: (proposal ? STATUS_LABEL : OFFER_STATUS)[source.status] || null,
    recordedMeetingOn: deal?.meeting_held_on || null,
    sourceStageConflict,
    issue: sourceStageConflict ? "source_conflict" : closed ? null : nextDueOn && nextDueOn < today ? "overdue" : !ownerId || !nextAction || !nextDueOn ? "missing" : null,
    lossReason: deal?.stage === "lost" ? deal.lost_reason : proposal && isClosed(source.status)
      ? CLOSE_REASON_LABEL[source.close_reason] || source.close_reason : null,
    lost: !wonInProposal && (deal ? deal.stage === "lost" : proposal ? ["lost", "closed_no_reply", "stopped"].includes(source.status) : source.status === "lost"),
  };
}

export function progressMetrics(rows, since, until, current) {
  const cohort = rows.filter(row => row.kind === "proposal" && row.milestones.sentOn >= since && row.milestones.sentOn <= until);
  const known = (row, key) => row.milestones[key] && row.milestones[key] >= row.milestones.sentOn && row.milestones[key] <= current;
  return MILESTONES.map(([key, label], index) => {
    const ids = cohort.filter(row => known(row, key)).map(row => row.id);
    const previous = index && MILESTONES[index - 1][0];
    const eligible = previous ? cohort.filter(row => known(row, previous)) : [];
    const pendingIds = eligible.filter(row => !known(row, key) || row.milestones[key] < row.milestones[previous]).map(row => row.id);
    return { key, label, ids, pendingIds, rate: eligible.length
      ? Math.round((eligible.length - pendingIds.length) * 1000 / eligible.length) / 10 : null };
  });
}
