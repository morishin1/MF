import { classifyMail, ruleClassification, MODEL } from './hr-intake-classifier.js';
import { notify } from './notify.js';
export const ANALYSES='gw_hr_mail_analysis';
export async function processIntake(sb,tenantId,mailId,{actorId=null,automated=false}={}) {
 const {data:mail,error}=await sb.from('gw_hr_inbound_mail').select('*').eq('tenant_id',tenantId).eq('id',mailId).maybeSingle();
 if(error)throw error;
 if(!mail||!['new','review'].includes(mail.status))return {skipped:true};
 const rule=ruleClassification(mail);
 const enabled=process.env.HR_INBOX_AI_ENABLED==='1'&&Boolean(process.env.ANTHROPIC_API_KEY);
 // Claim and reserve atomically, before the one billable API attempt. No automatic paid retry.
 const {data:claim,error:ce}=await sb.rpc('gw_hr_intake_claim',{p_tenant:tenantId,p_mail:mailId,p_reserve:!rule&&enabled?2:0});
 if(ce)throw ce;
 if(!claim?.claimed)return {skipped:true};
 let result=rule||{classification:'unknown',fields:{},reason:enabled?'月額予算に達したため要確認':'AI分類は未設定です',method:'rule'};
 if(!rule&&enabled&&claim.budget_ok) {
  try{result=await classifyMail(mail);}catch{
   result={classification:'unknown',fields:{},reason:'AI処理結果を確認できません。自動再解析せず人が確認します',method:'ai',model:MODEL,estimated_yen:2,error:true};
  }
 }
 const {data:analysis,error:se}=await sb.from(ANALYSES).update({
  classification:result.classification,fields:result.fields,reason:result.reason,method:result.method,
  model:result.model||null,input_tokens:result.input_tokens||0,output_tokens:result.output_tokens||0,
  estimated_yen:result.estimated_yen||0,state:result.error?'error':'review',processed_at:new Date().toISOString(),updated_at:new Date().toISOString()
 }).eq('tenant_id',tenantId).eq('mail_id',mailId).eq('state','processing').select('mail_id').maybeSingle();
 if(se)throw se;if(!analysis)return {skipped:true};
 const senderDomain=String(mail.sender_address||'').split('@').at(-1).toLowerCase();
 const allowedDomains=String(process.env.HR_INBOX_AUTO_SENDER_DOMAINS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 const allow=allowedDomains.includes(senderDomain)&&automated&&process.env.HR_INBOX_AUTO_REGISTER==='1'&&result.ready&&result.fields?.service!=='spot'&&result.fields?.service!=='mugendojo';
 const {data:final,error:fe}=await sb.rpc('gw_hr_intake_finish',{p_tenant:tenantId,p_mail:mailId,p_actor:actorId,p_auto:allow});
 if(fe)throw fe;
 // Only an opaque intake link is sent; no email text, address or candidate name.
 const employee=process.env.HR_INBOX_RECRUITER_ID;
 if(employee&&/^[a-f0-9-]{36}$/i.test(employee)) {
  const {data:assignee}=await sb.from('gw_employees').select('id').eq('id',employee).eq('tenant_id',tenantId).in('status',['active','invited']).maybeSingle();
  if(assignee&&final?.created&&final.applicantId)await sb.from('gw_hr_applicants').update({recruiter_id:employee}).eq('tenant_id',tenantId).eq('id',final.applicantId).is('recruiter_id',null);
  if(assignee)await notify([{tenantId,employeeId:employee,kind:'notice',title:'HRに新しい応募受付があります',link:'/hr/intake.html?id='+mailId,dedupeKey:'hr-intake:'+mailId}]);
 }
 return final;
}
