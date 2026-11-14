// 応募者の2週間トライアルを、5つの選択式項目と総合判断だけで評価する。
// 既存の契約・採否・面談履歴・トライアル計画は変更しない。
// GET ?applicantId=uuid / POST {applicantId,scores,decision}
import {requireUser} from '../../lib/auth.js';
import {gwContext,canRecruit} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {gwLog} from '../../lib/gw-audit.js';
import {readOfferTypes} from '../../lib/hr.js';
import {TRIAL_FIT_EVENT,validateTrialFit,trialFitEvent} from '../../lib/hr-trial-fit.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
  res.setHeader('Cache-Control','private,no-store');
  const user=await requireUser(req,res);if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:'forbidden'});
  if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
  const body=req.method==='POST'?await readJson(req):{};
  const id=req.method==='GET'?new URL(req.url||'/', 'http://localhost').searchParams.get('applicantId'):body?.applicantId;
  if(typeof id!=='string'||!UUID.test(id))return json(res,400,{error:'invalid_applicant_id'});
  const sb=admin();
  const found=await sb.from('gw_hr_applicants').select('id').eq('tenant_id',ctx.tenantId).eq('id',id).maybeSingle();
  if(found.error)return json(res,503,{error:'applicant_unavailable'});
  if(!found.data)return json(res,404,{error:'not_found'});
  const types=await readOfferTypes(sb,ctx.tenantId,[id]);
  if(!types.ready)return json(res,503,{error:'offer_type_unavailable'});
  let eligible=types.byId.get(id)==='trial_2weeks';
  // 既に登録済みの旧トライアルも、評価だけはここから行える。
  if(!eligible){
    const old=await sb.from('gw_hr_trial_periods').select('id').eq('tenant_id',ctx.tenantId).eq('applicant_id',id).limit(1);
    if(old.error)return json(res,503,{error:'trial_unavailable'});
    eligible=Boolean(old.data?.length);
  }
  if(!eligible)return json(res,409,{error:'not_trial',hint:'トライアル対象の応募者だけ評価できます。'});
  if(req.method==='GET'){
    const records=await sb.from('gw_hr_timeline').select('detail,occurred_at,created_by')
      .eq('tenant_id',ctx.tenantId).eq('applicant_id',id).eq('event_key',TRIAL_FIT_EVENT)
      .order('occurred_at',{ascending:false}).limit(1);
    if(records.error)return json(res,503,{error:'evaluation_unavailable'});
    return json(res,200,{evaluation:trialFitEvent(records.data?.[0]||null)});
  }
  const checked=validateTrialFit(body);
  if(checked.error)return json(res,400,{error:checked.error});
  const saved=await sb.from('gw_hr_timeline').insert({
    tenant_id:ctx.tenantId,applicant_id:id,event_key:TRIAL_FIT_EVENT,
    label:'トライアルの相性評価',detail:JSON.stringify({version:1,scores:checked.scores,decision:checked.decision}),
    created_by:user.id,
  }).select('id,occurred_at').single();
  if(saved.error)return json(res,503,{error:'save_failed',hint:'評価を保存できませんでした。'});
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:'hr.trial_fit_evaluated',
    target:'hr_applicant:'+id,detail:{eventId:saved.data.id,decision:checked.decision}});
  return json(res,200,{ok:true,evaluation:{...checked,recordedAt:saved.data.occurred_at}});
}
