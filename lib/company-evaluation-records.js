import { evaluationWindow, evaluateReviewCandidates } from './company-evaluation-policy.js';
/** Build review candidates only from a complete, tenant-scoped dataset and verified links.
 * No name matching, duplicate delivery counts, cross-tenant data, or implicit blast counting.
 */
export function buildCompanyEvaluationCandidates({ tenantId, proposals = [], meetings = [], links = [], now = new Date(), complete = false, qualificationComplete = complete }) {
  const window = evaluationWindow(now);
  const sourceByLocal = new Map();
  const ambiguous = new Set();
  for (const link of links) {
    if (link.tenant_id !== tenantId || link.source_system !== 'enger' || !link.source_company_id || !link.company_id) continue;
    if (sourceByLocal.has(link.company_id) && sourceByLocal.get(link.company_id) !== link.source_company_id) ambiguous.add(link.company_id);
    sourceByLocal.set(link.company_id, link.source_company_id);
  }
  const met = new Set(meetings.filter(x=>x.tenant_id === tenantId && x.kind === 'meeting' && x.result === 'done'
    && Date.parse(x.occurred_at) <= now.getTime()).map(x=>x.proposal_id));
  const byId = new Map();
  const conflicts = new Set();
  for (const p of proposals) {
    if (p.tenant_id !== tenantId || !p.id || p.deleted_at || p.delivery_kind === 'blast') continue;
    if (byId.has(p.id) && JSON.stringify(byId.get(p.id)) !== JSON.stringify(p)) conflicts.add(p.id);
    byId.set(p.id,p);
  }
  const groups = new Map();
  let unmappedCount = 0;
  for (const p of byId.values()) {
    const sentAt = Date.parse(p.sent_at);
    if (!Number.isFinite(sentAt) || sentAt < Date.parse(window.since) || sentAt > now.getTime() || conflicts.has(p.id)) continue;
    const mapped = sourceByLocal.get(p.company_id);
    const direct = p.source_system === 'enger' ? p.source_company_id : null;
    if (ambiguous.has(p.company_id) || (mapped && direct && mapped !== direct)) { unmappedCount++; continue; }
    const companyId = direct || mapped;
    if (!companyId) { unmappedCount++; continue; }
    const key = `${tenantId}:enger:${companyId}`;
    const row = groups.get(key) || { key, sourceCompanyId:companyId, localCompanyId:mapped ? p.company_id : null, companyName:p.company_name || '企業名未取得',
      sentCount:0, meetingCount:0, qualifiedCount:0, unknownReasonCount:0 };
    row.sentCount++;
    const reached = met.has(p.id) || p.status === 'meeting_done' || p.status === 'won';
    if (reached) row.meetingCount++;
    const final = ['lost','closed_no_reply','stopped','won'].includes(p.status);
    if (reached || final || (p.response_due_at && Date.parse(p.response_due_at) <= now.getTime())) row.qualifiedCount++;
    if (final && p.status !== 'won' && (!p.close_reason || p.close_reason === 'unknown')) row.unknownReasonCount++;
    groups.set(key,row);
  }
  const datasetComplete = complete === true && conflicts.size === 0;
  return { version:'20261030-ad-v1', window, complete:datasetComplete, qualificationComplete:qualificationComplete === true, unmappedCount, conflictingProposalCount:conflicts.size,
    companies:[...groups.values()].map(row=>({...row,score:null,rank:null,evaluationStatus:'unevaluated',
      review:evaluateReviewCandidates({...row,complete:datasetComplete && qualificationComplete === true,identityVerified:true})}))
      .sort((a,b)=>b.sentCount-a.sentCount || a.key.localeCompare(b.key)) };
}
