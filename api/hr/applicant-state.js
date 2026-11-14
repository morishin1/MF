// State-only fingerprints; read is distinct from work completion and private to each reviewer.
import { requireUser } from '../../lib/auth.js';
import { gwContext,canRecruit } from '../../lib/gw.js';
import { admin } from '../../lib/supabase.js';
import { json,readJson,methodNotAllowed } from '../../lib/http.js';
import { gwLog } from '../../lib/gw-audit.js';
import { readProgressEvents, PROGRESS_EVENT } from '../../lib/hr-progress.js';
const UUID=/^[0-9a-f-]{36}$/i;
const fingerprint=(a,revision)=>JSON.stringify([a.stage,a.status,a.decision,a.offer_type,a.employee_id,...(revision?[revision]:[])]);
const revisionOf=(events,id)=>events.find(e=>e.applicant_id===id&&e.event_key===PROGRESS_EVENT)?.id||null;
export default async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:'forbidden'});
 const sb=admin();
 if(req.method==='GET'){
  const [a,r,t]=await Promise.all([
   sb.from('gw_hr_applicants').select('id,stage,status,decision,offer_type,employee_id,talent_category').eq('tenant_id',ctx.tenantId).limit(1000),
   sb.from('gw_hr_applicant_reads').select('applicant_id,fingerprint').eq('tenant_id',ctx.tenantId).eq('user_id',user.id).limit(1000),
   sb.from('gw_hr_trial_periods').select('id,applicant_id,status').eq('tenant_id',ctx.tenantId).in('status',['planned','active']).order('created_at',{ascending:false}).limit(1000)
  ]);
  if(a.error||r.error)return json(res,503,{error:'not_ready'});
  const progress=await readProgressEvents(sb,ctx.tenantId,(a.data||[]).map(x=>x.id));
  if(!progress.ready)return json(res,503,{error:'not_ready'});
  const seen=new Map((r.data||[]).map(x=>[x.applicant_id,x.fingerprint]));
  return json(res,200,{states:(a.data||[]).map(x=>({id:x.id,talentCategory:x.talent_category,currentTrial:(t.data||[]).find(t=>t.applicant_id===x.id)||null,unread:seen.get(x.id)!==fingerprint(x,revisionOf(progress.events,x.id)),kind:seen.has(x.id)?'status':'application'}))});
 }
 if(req.method!=='POST')return methodNotAllowed(res,['GET','POST']);
 const b=await readJson(req);if(!UUID.test(b?.id||''))return json(res,400,{error:'invalid_id'});
 const {data:a,error}=await sb.from('gw_hr_applicants').select('id,stage,status,decision,offer_type,employee_id,updated_at,lead_category').eq('tenant_id',ctx.tenantId).eq('id',b.id).maybeSingle();
 if(error)return json(res,503,{error:'not_ready'});if(!a)return json(res,404,{error:'not_found'});
 if(b.action==='category'){
  if(a.lead_category==='mugendojo')return json(res,409,{error:'dedicated_workflow'});
  if(!['recruitment','contractor'].includes(b.category))return json(res,400,{error:'invalid_category'});
  const {error:e}=await sb.from('gw_hr_applicants').update({talent_category:b.category}).eq('tenant_id',ctx.tenantId).eq('id',b.id);
  if(e)return json(res,503,{error:'not_ready'});
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:'hr.talent_category',target:'hr_applicant:'+b.id,detail:{category:b.category}});
  return json(res,200,{ok:true});
 }
 if(b.action!=='read')return json(res,400,{error:'invalid_action'});
 if(!b.expectedUpdatedAt||Date.parse(b.expectedUpdatedAt)!==Date.parse(a.updated_at))return json(res,409,{error:'stale_record',message:'状態が更新されています。読み直して確認してください'});
 const progress=await readProgressEvents(sb,ctx.tenantId,[a.id]);if(!progress.ready)return json(res,503,{error:'not_ready'});
 const revision=revisionOf(progress.events,a.id);
 if(Object.hasOwn(b,'expectedProgressRevision')&&(b.expectedProgressRevision||null)!==revision)return json(res,409,{error:'stale_record',message:'状態が更新されています。読み直して確認してください'});
 const {error:e}=await sb.from('gw_hr_applicant_reads').upsert({tenant_id:ctx.tenantId,applicant_id:a.id,user_id:user.id,fingerprint:fingerprint(a,revision),read_at:new Date().toISOString()},{onConflict:'applicant_id,user_id'});
 return json(res,e?503:200,e?{error:'not_ready'}:{ok:true});
}
