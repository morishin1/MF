import crypto from 'node:crypto';
import {json,readJson} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {ymd} from '../../lib/jst.js';
import {emptyPlan,normalizePlan,UUID} from '../../lib/career-self-plan.js';
import {coach,configured} from '../../lib/career-coach-ai.js';
const fail=(status,error,hint)=>{throw Object.assign(new Error(error),{status,hint});};
const publicTurn=t=>Object.fromEntries(['id','status','question','advice','created_at','request_key'].map(k=>[k,t[k]]));
export function createHandler(deps={}){const D={requireUser,gwContext,admin,coach,configured,...deps};return async(req,res)=>{
 res.setHeader('Cache-Control','private,no-store');
 try{
  const user=await D.requireUser(req,res);if(!user)return;const ctx=await D.gwContext(user.id);
  if(!ctx.tenantId||!ctx.employee||ctx.employee.status==='left'||ctx.employee.user_id&&ctx.employee.user_id!==user.id)fail(403,'not_enrolled','本人のアカウントでログインしてください。');
  if(!['GET','POST'].includes(req.method))return json(res,405,{error:'method_not_allowed'});
  const sb=D.admin(),scope=q=>q.eq('tenant_id',ctx.tenantId).eq('employee_id',ctx.employee.id).eq('user_id',user.id);
  const read=async q=>{const r=await q;if(r.error)fail(503,'not_ready','自分の計画を取得できません。再読み込みしてください。');return r.data;};
  const snapshot=async()=>{
   const [p,turns]=await Promise.all([read(scope(sb.from('gw_career_self_plans').select('plan,revision,updated_at')).maybeSingle()),read(scope(sb.from('gw_career_coach_turns').select('id,status,question,advice,created_at,request_key')).order('created_at',{ascending:false}).limit(20))]);
   const start=new Date(ymd()+'T00:00:00+09:00').toISOString();
   const r=await scope(sb.from('gw_career_coach_turns').select('id',{head:true,count:'exact'})).gte('created_at',start);
   if(r.error)fail(503,'not_ready');
   return {plan:p?.plan||emptyPlan(),revision:p?.revision||0,updatedAt:p?.updated_at||null,turns:turns||[],coachReady:D.configured(),dailyLimit:5,usedToday:r.count||0};
  };
  if(req.method==='GET')return json(res,200,await snapshot());
  const b=await readJson(req),rpc=async(action,data)=>{const r=await sb.rpc('gw_career_self_manage',{p_tenant:ctx.tenantId,p_employee:ctx.employee.id,p_user:user.id,p_action:action,p_data:data});if(r.error){if(/stale_plan/.test(r.error.message||''))fail(409,'plan_changed','別の画面で更新されています。再読み込みして確認してください。');if(/self_only/.test(r.error.message||''))fail(403,'self_only','本人のアカウントでログインしてください。');fail(503,'plan_unavailable','保存・相談を完了できませんでした。時間をおいてお試しください。');}return r.data;};
  let plan;try{plan=normalizePlan(b.plan);}catch(e){fail(400,'invalid_plan',e.message);}
  if(b.action==='save'){
   if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0)fail(400,'revision_required');
   await rpc('save',{plan,expectedRevision:b.expectedRevision});return json(res,200,await snapshot());
  }
  if(b.action!=='coach')fail(400,'invalid_action');
  if(!D.configured())fail(503,'coach_unavailable','AIコーチは現在準備中です。計画の入力・保存はそのまま利用できます。');
  if(!UUID.test(b.requestKey||'')||typeof b.question!=='string'||!b.question.trim()||b.question.length>1000)fail(400,'invalid_question','相談したいことを1,000文字以内で入力してください。');
  const question=b.question.trim(),draftHash=crypto.createHash('sha256').update(JSON.stringify({plan,question})).digest('hex');
  const claim=await rpc('claim',{requestKey:b.requestKey,question,draftHash});
  if(claim.blocked)fail(429,'coach_limit',claim.reason==='daily'?'本日の相談は5回までです。計画は引き続き編集・保存できます。':'今月のAI利用上限に達しました。計画は引き続き編集・保存できます。');
  if(claim.replayed){if(claim.draftHash!==draftHash)fail(409,'request_changed','相談内容が変わっています。新しい相談として送信してください。');return json(res,200,{turn:publicTurn(claim.turn),pending:claim.turn.status==='pending',draftHash});}
  const recent=await read(scope(sb.from('gw_career_coach_turns').select('question,advice')).eq('status','done').order('created_at',{ascending:false}).limit(4));
  let result;
  try{result=await D.coach({plan,question,history:(recent||[]).reverse().map(t=>({question:t.question.slice(0,400),reply:String(t.advice?.reply||'').slice(0,600)}))});}
  catch{await rpc('finish',{requestKey:b.requestKey,status:'failed'});fail(503,'coach_failed','相談の回答を取得できませんでした。計画は変更していません。時間をおいてお試しください。');}
  const turn=await rpc('finish',{requestKey:b.requestKey,status:'done',advice:result.advice,model:result.model,usage:result.usage,estimatedYen:result.estimatedYen});
  return json(res,200,{turn:publicTurn(turn),draftHash});
 }catch(e){return json(res,e.status||500,{error:e.status?e.message:'career_plan_failed',hint:e.hint||'保存・相談を完了できませんでした。再読み込みして確認してください。'});}
};}
export default createHandler();
