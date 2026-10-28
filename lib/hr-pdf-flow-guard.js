// Legacy writes cannot bypass an adopted uploaded-PDF flow, including terminal history.
import {enabled} from './hr-pdf-flow.js';
const conflict={ok:false,status:409,body:{error:'pdf_flow_owned',hint:'この方はPDF採用フローで管理しています。専用の手続きから進めてください。'}};
const unavailable={ok:false,status:503,body:{error:'pdf_flow_unavailable',hint:'PDF採用フローの状態を確認できません。保存せず管理者へ確認してください。'}};
const idsOf=x=>[...new Set((Array.isArray(x)?x:[x]).filter(v=>typeof v==='string'&&v))];
export async function assertLegacyPdfFlowAbsent(sb,tenantId,applicantIds){
 if(!enabled())return {ok:true};const ids=idsOf(applicantIds);if(!tenantId||!ids.length)return unavailable;
 try{const r=await sb.from('gw_hr_pdf_flows').select('applicant_id').eq('tenant_id',tenantId).in('applicant_id',ids).limit(1);return r.error?unavailable:r.data?.length?conflict:{ok:true};}catch{return unavailable;}
}
export function isPdfFlowStateMutation(body){if(!body||typeof body!=='object')return false;if(body.action&&body.action!=='saveNote')return true;return Object.keys(body).some(k=>!['id','action','note','recruiterId','expectedNote','requestKey'].includes(k));}
export async function readPdfFlowSummaries(sb,tenantId,applicantIds){const base={enabled:enabled(),ready:true,byApplicant:new Map()};if(!base.enabled)return base;const ids=idsOf(applicantIds);if(!tenantId||!ids.length)return {...base,ready:!ids.length&&Boolean(tenantId)};
 try{const r=await sb.from('gw_hr_pdf_flows').select('id,applicant_id,phase,version,accepted_at,ready_at,joined_at').eq('tenant_id',tenantId).in('applicant_id',ids);if(r.error)return {...base,ready:false};for(const f of r.data||[])base.byApplicant.set(f.applicant_id,{id:f.id,phase:f.phase,version:f.version,acceptedAt:f.accepted_at,readyAt:f.ready_at,joinedAt:f.joined_at});return base;}catch{return {...base,ready:false};}}
