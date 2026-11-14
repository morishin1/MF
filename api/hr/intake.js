import { requireUser } from '../../lib/auth.js';
import { gwContext,canRecruit } from '../../lib/gw.js';
import { admin } from '../../lib/supabase.js';
import { json,readJson,methodNotAllowed } from '../../lib/http.js';
import { processIntake,ANALYSES } from '../../lib/hr-intake.js';
import { CLASSES,CLASS_LABELS } from '../../lib/hr-intake-classifier.js';
import { gwLog } from '../../lib/gw-audit.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=(res,e)=>{console.error('[hr/intake]',e?.code||'unknown');return json(res,503,{error:'intake_unavailable',message:'応募受付の設定・保存状態を確認してください（db/182）'});};
export default async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:'forbidden'});
 const sb=admin();
 try {
  if(req.method==='GET'){
   const {data:rows,error}=await sb.from(ANALYSES).select('mail_id,classification,fields,reason,method,state,model,input_tokens,output_tokens,estimated_yen,auto_registered,processed_at,updated_at').eq('tenant_id',ctx.tenantId).limit(1000);
   if(error)return fail(res,error);
   const mon=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'}).slice(0,7)+'-01';
   const usage=await sb.from('gw_hr_intake_budget').select('committed_yen,budget_yen').eq('tenant_id',ctx.tenantId).eq('month',mon).maybeSingle();
   if(usage.error)return fail(res,usage.error);
   return json(res,200,{analyses:rows||[],classes:CLASS_LABELS,budget:usage.data||{committed_yen:0,budget_yen:1000},aiEnabled:process.env.HR_INBOX_AI_ENABLED==='1',autoRegister:process.env.HR_INBOX_AUTO_REGISTER==='1'});
  }
  if(req.method!=='POST')return methodNotAllowed(res,['GET','POST']);
  const b=await readJson(req);if(!UUID.test(b?.id||''))return json(res,400,{error:'invalid_id'});
  const {data:mail,error}=await sb.from('gw_hr_inbound_mail').select('id,status,applicant_id,updated_at').eq('tenant_id',ctx.tenantId).eq('id',b.id).maybeSingle();
  if(error)throw error;if(!mail)return json(res,404,{error:'not_found'});
  if(b.action==='classify')return json(res,200,await processIntake(sb,ctx.tenantId,b.id,{actorId:user.id}));
  if(!['correct','register'].includes(b.action)||!CLASSES.includes(b.classification))return json(res,400,{error:'invalid_action'});
  const reason=typeof b.reason==='string'?b.reason.trim():'';
  if(!reason||reason.length>500)return json(res,400,{error:'reason_required',message:'修正・確認の理由を入力してください'});
  const f=b.fields||{},keys={name:100,email:200,jobTitle:180,source:80,phone:40,applicationId:120};
  const fields={};for(const [key,max]of Object.entries(keys))fields[key]=typeof f[key]==='string'?f[key].trim().slice(0,max):'';
  fields.service=['recruitment','contractor','spot','mugendojo'].includes(f.service)?f.service:'recruitment';
  if(b.action==='register'&&(b.classification!=='application'||!fields.name||!fields.jobTitle||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fields.email)||!['recruitment','contractor'].includes(fields.service)))return json(res,400,{error:'required_fields',message:'氏名・メール・応募職種と採用区分を確認してください'});
  if(mail.applicant_id&&b.action==='register')return json(res,200,{duplicate:true,applicantId:mail.applicant_id});
  const {data:old,error:oe}=await sb.from(ANALYSES).select('state,updated_at').eq('tenant_id',ctx.tenantId).eq('mail_id',b.id).maybeSingle();
  if(oe)throw oe;
  if(old?.state==='processing')return json(res,409,{error:'processing',message:'分類処理中です。少し待って再読込してください'});
  if(old&&old.updated_at!==b.expectUpdatedAt)return json(res,409,{error:'stale_record',message:'別の担当者が更新しました。再読込してください'});
  const patch={...(!mail.applicant_id?{state:'review'}:{}),classification:b.classification,fields,reason,corrected_by:user.id,updated_at:new Date().toISOString()};
  const write=old?await sb.from(ANALYSES).update(patch).eq('tenant_id',ctx.tenantId).eq('mail_id',b.id).eq('updated_at',old.updated_at).select('mail_id').maybeSingle():await sb.from(ANALYSES).insert({mail_id:b.id,tenant_id:ctx.tenantId,state:'review',...patch}).select('mail_id').single();
  if(write.error)throw write.error;if(!write.data)return json(res,409,{error:'stale_record'});
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:'hr.intake_correct',target:'hr_mail:'+b.id,detail:{classification:b.classification}});
  // Registration is explicit; correction by itself never creates a candidate.
  if(b.action==='correct') { if(!mail.applicant_id) {const {error:me}=await sb.from('gw_hr_inbound_mail').update({status:'review',updated_at:new Date().toISOString()}).eq('tenant_id',ctx.tenantId).eq('id',b.id).is('applicant_id',null);if(me)throw me;} return json(res,200,{ok:true}); }
  const {data:result,error:fe}=await sb.rpc('gw_hr_intake_finish',{p_tenant:ctx.tenantId,p_mail:b.id,p_actor:user.id,p_auto:true});
  if(fe)throw fe;
  return json(res,200,result);
 }catch(e){return fail(res,e);}
}
