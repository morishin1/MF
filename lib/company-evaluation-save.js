import { EVALUATION_AXES, COMPANY_EVALUATION_VERSION, evaluateScores, validateEvaluationDecision, evaluationWindow } from './company-evaluation-policy.js';
export const EVALUATION_TABLE = 'gw_sales_company_evaluations';
export const EVALUATION_HISTORY_TABLE = 'gw_sales_company_evaluation_history';
export const EVALUATION_SQL = 'db/153_sales_company_evaluations.sql';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canConfirmEvaluation(ctx) {
  return Boolean(ctx?.tenantId && ((ctx.roles || []).includes('owner')
    || (ctx.memberships || []).some(m=>m.tenant_id === ctx.tenantId && m.role === 'admin')));
}
export function normalizeEvaluationSave(body, ctx, now = new Date()) {
  if (!canConfirmEvaluation(ctx)) return {error:'admin_required',status:403};
  if (!body || !UUID.test(body.company_id || '') || !UUID.test(body.request_id || '')) return {error:'invalid_identifiers',status:400};
  if (typeof body.expected_revision !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(body.expected_revision)) return {error:'invalid_revision',status:400};
  if (typeof body.reviewedAt !== 'string' || !Number.isFinite(Date.parse(body.reviewedAt)) || Date.parse(body.reviewedAt)>now.getTime() || Date.parse(body.reviewedAt)<Date.parse(evaluationWindow(now).since)) return {error:'invalid_review_time',status:400};
  if (!['draft','confirmed'].includes(body.status)) return {error:'invalid_status',status:400};
  if (!body.scores || typeof body.scores !== 'object' || Array.isArray(body.scores)) return {error:'invalid_scores',status:400};
  const scores = {};
  for (const axis of EVALUATION_AXES) {
    const value = body.scores[axis.key];
    if (value == null) { scores[axis.key] = {points:null,evidence:null,observedAt:null}; continue; }
    if (typeof value !== 'object' || Array.isArray(value)) return {error:'invalid_axis',status:400};
    const empty = value.points == null && !value.evidence && !value.observedAt;
    if (empty) { scores[axis.key] = {points:null,evidence:null,observedAt:null}; continue; }
    if (typeof value.points !== 'number' || !Number.isFinite(value.points) || value.points<0 || value.points>axis.max
      || typeof value.evidence !== 'string' || !value.evidence.trim() || value.evidence.trim().length>500
      || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return {error:'invalid_axis',status:400};
    scores[axis.key] = {points:value.points,evidence:value.evidence.trim(),observedAt:new Date(value.observedAt).toISOString()};
  }
  const calculated = evaluateScores(scores,now);
  // Invalid/expired supplied evidence is rejected, never silently saved as null.
  if (calculated.axes.some(a=>scores[a.key].points != null && a.points == null)) return {error:'evidence_outside_window',status:400};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length>1000) return {error:'reason_too_long',status:400};
  const evaluation = {version:COMPANY_EVALUATION_VERSION,scoreMethod:'manual_evidence',scores,
    score:calculated.score,suggestedRank:calculated.suggestedRank,status:body.status,
    rank:null,policy:'normal',reason,reviewedAt:new Date(body.reviewedAt).toISOString(),
    improvementDiscussed:body.improvementDiscussed===true,noProgressConfirmed:body.noProgressConfirmed===true,enforcementEnabled:false};
  if (body.status === 'confirmed') {
    if (calculated.score == null) return {error:'complete_evidence_required',status:400};
    const decision = {rank:body.rank,policy:body.policy,reason,reviewedAt:new Date(body.reviewedAt).toISOString(),improvementDiscussed:evaluation.improvementDiscussed,noProgressConfirmed:evaluation.noProgressConfirmed};
    const checked = validateEvaluationDecision(decision,{isAdmin:true,identityVerified:true,now});
    if (!checked.ok) return {error:checked.reason,status:400};
    evaluation.rank = body.rank; evaluation.policy = body.policy;
  }
  return {value:{companyId:body.company_id,requestId:body.request_id,expectedRevision:body.expected_revision,evaluation}};
}
