/** A–D commercial review policy v1. Pure, side-effect free; never sends or stops proposals.
 * Keep the identical module in ENGER. Explicit evidence scores only: no invented ratios.
 */
export const COMPANY_EVALUATION_VERSION = '20261030-ad-v1';
export const EVALUATION_AXES = Object.freeze([
  { key: 'outcomes', label: '面談・参画実績', max: 30 },
  { key: 'response', label: '企業の返信速度', max: 20 },
  { key: 'reasons', label: '見送り理由の明確さ', max: 20 },
  { key: 'profitability', label: '収益性', max: 20 },
  { key: 'reliability', label: '案件の信頼性', max: 10 },
]);
export const EVALUATION_RANKS = Object.freeze(['A', 'B', 'C', 'D']);
export const EVALUATION_LABELS = Object.freeze({ A: '重点取引', B: '通常取引', C: '改善要求・要審査', D: '新規提案停止' });
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
/** Exactly 90 JST calendar days including today. Only observations <= now are valid. */
export function evaluationWindow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('valid now required');
  const day = new Date(now.getTime() + 32400000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+09:00`);
  start.setUTCDate(start.getUTCDate() - 89);
  return { days: 90, since: start.toISOString(), until: now.toISOString(), timezone: 'Asia/Tokyo' };
}
/** No partial-score extrapolation: missing evidence means unevaluated, not zero/D. */
export function evaluateScores(scores = {}, now = new Date()) {
  const window = evaluationWindow(now);
  const axes = EVALUATION_AXES.map(axis => {
    const supplied = scores?.[axis.key];
    const valid = supplied && typeof supplied.points === 'number' && Number.isFinite(supplied.points)
      && supplied.points >= 0 && supplied.points <= axis.max
      && typeof supplied.evidence === 'string' && supplied.evidence.trim().length > 0
      && validTime(supplied.observedAt) && Date.parse(supplied.observedAt) >= Date.parse(window.since)
      && Date.parse(supplied.observedAt) <= now.getTime();
    return { ...axis, points: valid ? supplied.points : null, observedAt: valid ? supplied.observedAt : null,
      evidence: valid ? supplied.evidence.trim() : null };
  });
  const missing = axes.filter(axis => axis.points == null).map(axis => axis.key);
  const score = missing.length ? null : Math.round(axes.reduce((sum, axis) => sum + axis.points, 0) * 1e10) / 1e10;
  const suggestedRank = score == null ? null : score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  return { version: COMPANY_EVALUATION_VERSION, window, axes, score, suggestedRank, missing,
    status: score == null ? 'unevaluated' : 'review_required' };
}
/**
 * A proposed review action is not an authorization or persistent task.
 * Counts must be complete, deduplicated, 90-day direct proposals for one verified company identity.
 * Pending/unknown response deadlines do not become evidence of failure by elapsed time alone.
 */
export function evaluateReviewCandidates(input = {}) {
  const { sentCount, meetingCount, qualifiedCount, unknownReasonCount = 0, complete = false,
    identityVerified = false, previousPolicy = null } = input;
  const usable = complete === true && identityVerified === true && nonnegativeInteger(sentCount)
    && nonnegativeInteger(meetingCount) && meetingCount <= sentCount
    && nonnegativeInteger(qualifiedCount) && qualifiedCount >= meetingCount && qualifiedCount <= sentCount
    && nonnegativeInteger(unknownReasonCount) && unknownReasonCount <= sentCount;
  if (!usable) return { status: 'unavailable', candidate: null, actions: [], enforceable: false };
  const actions = [];
  if (unknownReasonCount > 0) actions.push('confirm_loss_reasons');
  if (meetingCount > 0 && ['hold', 'stopped', 'blast_only'].includes(previousPolicy)) actions.push('review_improvement');
  let candidate = null;
  if (meetingCount === 0 && sentCount >= 5) {
    actions.push('alert_owner');
    candidate = 'C';
    if (sentCount >= 10) actions.push('review_proposal_hold');
    if (sentCount >= 15) actions.push('review_blast_only');
  }
  return { status: 'candidate', candidate, actions, pendingCount: sentCount - qualifiedCount,
    matureEvidenceCount: qualifiedCount, enforceable: false };
}
/** Validate the administrative decision, never infer it from a score or count.
 * Authorization/atomic persistence belongs to the server, not this pure validator.
 */
export function validateEvaluationDecision(decision, context) {
  if (context?.isAdmin !== true) return { ok: false, reason: 'admin_required' };
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) return { ok: false, reason: 'valid_now_required' };
  if (context.identityVerified !== true) return { ok: false, reason: 'verified_company_required' };
  if (!decision || !EVALUATION_RANKS.includes(decision.rank)) return { ok: false, reason: 'invalid_rank' };
  if (typeof decision.reason !== 'string' || !decision.reason.trim()) return { ok: false, reason: 'reason_required' };
  if (!validTime(decision.reviewedAt) || Date.parse(decision.reviewedAt) > context.now.getTime()) return { ok: false, reason: 'invalid_review_time' };
  if (decision.rank === 'D' && !(decision.improvementDiscussed === true && decision.noProgressConfirmed === true)) {
    return { ok: false, reason: 'improvement_review_required' };
  }
  if (!['normal', 'restricted', 'hold', 'stopped', 'blast_only'].includes(decision.policy)) return { ok: false, reason: 'invalid_policy' };
  if (decision.rank === 'D' && !['stopped', 'blast_only'].includes(decision.policy)) return { ok: false, reason: 'stopped_policy_required' };
  if (decision.rank !== 'D' && decision.policy === 'stopped') return { ok: false, reason: 'D_required' };
  return { ok: true };
}
