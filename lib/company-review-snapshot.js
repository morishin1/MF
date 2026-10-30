import {evaluationWindow} from './company-evaluation-policy.js';
import {UUID} from './company-evaluation-save.js';
export const REVIEW_PURPOSE='company-review-snapshot';
export function validateCompanyReviewSnapshot(body,now=new Date()) {
  if(!body || Object.keys(body).some(k=>!['version','complete','snapshotId','observedAt','windowStart','companies'].includes(k)) || body.version!=='20261030-company-review-v1' || body.complete!==true || !UUID.test(body.snapshotId || '') || !Array.isArray(body.companies) || body.companies.length>5000)return {error:'invalid_snapshot'};
  const observedAt=Date.parse(body.observedAt);if(!Number.isFinite(observedAt)||observedAt>now.getTime()||observedAt<now.getTime()-86400000)return {error:'invalid_snapshot_time'};
  const window=evaluationWindow(new Date(observedAt));if(body.windowStart!==window.since)return {error:'invalid_snapshot_window'};
  const ids=new Set();let total=0;
  for(const row of body.companies){
    if(!row || !UUID.test(row.sourceCompanyId || '') || row.sourceCompanyId!==row.sourceCompanyId.toLowerCase() || ids.has(row.sourceCompanyId))return {error:'invalid_company_identity'};
    ids.add(row.sourceCompanyId);
    if(Object.keys(row).some(k=>!['sourceCompanyId','sentCount','meetingCount','qualifiedCount','unknownReasonCount','wonCount'].includes(k)))return {error:'unexpected_snapshot_data'};
    for(const key of ['sentCount','meetingCount','qualifiedCount','unknownReasonCount','wonCount'])if(!Number.isSafeInteger(row[key])||row[key]<0||row[key]>20000)return {error:'invalid_snapshot_counts'};
    if(row.meetingCount>row.qualifiedCount || row.wonCount>row.meetingCount || row.unknownReasonCount>row.qualifiedCount || row.qualifiedCount>row.sentCount)return {error:'inconsistent_snapshot_counts'};
    total+=row.sentCount;
  }
  if(total>20000)return {error:'snapshot_limit'};
  return {value:{snapshotId:body.snapshotId,observedAt:new Date(observedAt).toISOString(),windowStart:window.since,companies:body.companies}};
}
