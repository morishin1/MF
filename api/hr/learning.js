import {requireUser} from '../../lib/auth.js';
import {gwContext,canRecruit} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {callLms} from '../../lib/hr-lms-client.js';
import {UUID,learningView,validatePlan,validateReview} from '../../lib/hr-learning.js';
import {TRIAL_FIT_ITEMS,TRIAL_FIT_GRADES,TRIAL_FIT_DECISIONS} from '../../lib/hr-trial-fit.js';

export default async function handler(req,res){
 res.setHeader('Cache-Control','private,no-store');
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:'forbidden'});
 if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
 const sb=admin(),url=new URL(req.url||'/','http://localhost');
 const body=req.method==='POST'?await readJson(req):null;
 const id=body?.applicantId||url.searchParams.get('id');
 if(id&&!UUID.test(id))return json(res,400,{error:'invalid_applicant_id'});
 const offset=Number(url.searchParams.get('offset')||0);
 if(!Number.isSafeInteger(offset)||offset<0)return json(res,400,{error:'invalid_offset'});
 let query=sb.from('gw_hr_applicants').select('id,name,email').eq('tenant_id',ctx.tenantId).order('id');
 query=id?query.eq('id',id):query.range(offset,offset+24);
 const found=await query;
 if(found.error)return json(res,503,{error:'applicant_unavailable'});
 const applicants=found.data||[];
 if(id&&!applicants.length)return json(res,404,{error:'not_found'});
 const ids=applicants.map(a=>a.id);
 const states=ids.length?await sb.from('gw_hr_learning').select('*').eq('tenant_id',ctx.tenantId).in('applicant_id',ids):{data:[]};
 if(states.error)return json(res,503,{error:'learning_state_unavailable',hint:'育成・評価の保存先を確認してください。'});
 const lms=ids.length?await callLms('/api/hr/lms/learning-status',{tenant_id:ctx.tenantId,applicant_ids:ids},{timeoutMs:45000}):{ok:true,data:{items:[]}};
 const items=applicants.map(a=>learningView(a,(states.data||[]).find(s=>s.applicant_id===a.id),lms.ok?lms.data.items?.find(s=>s.id===a.id):null));
 if(req.method==='GET')return json(res,200,{items,nextOffset:!id&&applicants.length===25?offset+25:null,lmsAvailable:lms.ok,checkedAt:new Date().toISOString(),itemsDefinition:TRIAL_FIT_ITEMS,grades:TRIAL_FIT_GRADES,decisions:TRIAL_FIT_DECISIONS});
 if(!id||!Number.isSafeInteger(body?.expectedVersion)||body.expectedVersion<0)return json(res,400,{error:'invalid_version'});
 const current=items[0],stored=(states.data||[])[0];
 if(current.version!==body.expectedVersion)return json(res,409,{error:'version_conflict',hint:'別の担当者が更新しました。最新を読み直してください。'});
 let value;
 if(body.action==='participation'){
  if(typeof body.participation!=='boolean')return json(res,400,{error:'invalid_participation'});
  if(!body.participation&&current.source==='LMS')return json(res,409,{error:'already_learning',hint:'LMSで学習が始まっています。参加状況はONのままです。'});
  const verified=current.lmsStatus==='verified'?lms.data.items?.find(s=>s.id===id):null;
  value={participation:body.participation,...(body.participation&&verified?{userId:verified.userId,email:verified.email}:{})};
 }else if(body.action==='plan'){
  const checked=validatePlan(body.plan);if(checked.error)return json(res,400,{error:checked.error});
  if(stored?.reviews&&Object.keys(stored.reviews).length&&stored.plan?.startOn!==checked.value.startOn)return json(res,409,{error:'reviewed_plan_dates_locked',hint:'評価済みの開始日は変更できません。'});
  value=checked.value;
 }else if(body.action==='review'){
  const checked=validateReview(body,stored?.plan);if(checked.error)return json(res,400,{error:checked.error});
  value=checked.value;value.evaluation.actorId=user.id;
 }else return json(res,400,{error:'invalid_action'});
 const saved=await sb.rpc('gw_hr_save_learning',{p_tenant:ctx.tenantId,p_applicant:id,p_actor:user.id,p_expected:body.expectedVersion,p_action:body.action,p_value:value});
 if(saved.error)return json(res,saved.error.code==='40001'?409:503,{error:saved.error.code==='40001'?'version_conflict':'save_failed',hint:'保存できませんでした。最新を読み直して確認してください。'});
 const state=Array.isArray(saved.data)?saved.data[0]:saved.data;
 return json(res,200,{ok:true,item:learningView(applicants[0],state,lms.ok?lms.data.items?.find(s=>s.id===id):null)});
}
