import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {UUID,requireValue,processCoachReview,approveCoachReview,rpc,readCoachSources,digest} from './behavior-coach.js';
import {runCoachCheck,MODES,STATUS_LABEL,REASON_LABEL} from './behavior-coach-morning.js';
import {coachDeliveryEnv,deliverOutbox,deliverReview,deliveryBlock,slackPreflight,createSlackReadClient} from './behavior-coach-delivery.js';
import {addDays,isYmd} from './behavior-coach-days.js';
const respond=(res,status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
export function evaluationEpoch(reportDate,now=new Date()){
 const cutoff=Date.parse(reportDate+'T08:00:00+09:00')+86400000;
 return (now.getTime()>=cutoff?'final:':'provisional:')+reportDate;
}
/** 日本時間の今日（実行環境のタイムゾーンに依存しない） */
export const jstToday=(now)=>new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
export const ROUTINE_HEADER='x-nippo-coach-key';
const KEY_RE=/^[A-Za-z0-9._:-]{8,128}$/;
// 外部（P の定時タスク）からの呼び出しの誤り。retryable=true は同じ idempotencyKey で再送してよい
export const ROUTINE_ERRORS={
 routine_disabled:[503,false],unauthorized:[401,false],method_not_allowed:[405,false],invalid_request:[400,false],
 coach_disabled:[503,false],run_in_progress:[409,true],roster_unreadable:[503,true],coach_store_unavailable:[503,true],coach_unavailable:[503,true],
};
const routineError=(res,code,extra={})=>{const [status,retryable]=ROUTINE_ERRORS[code]||[503,true];return respond(res,status,{error:code,retryable,deliveryEnabled:false,...extra});};
const sameSecret=(a,b)=>{const x=createHash('sha256').update(String(a)).digest(),y=createHash('sha256').update(String(b)).digest();return timingSafeEqual(x,y);};
/** 外部呼び出しの入力。date は JST の今日から7日前まで（未来・古すぎる日は受けない） */
export function parseCheckRequest(b,now){
 const today=jstToday(now);
 const date=b?.date==null?today:b.date;
 const mode=b?.mode==null?'morning':b.mode;
 if(!isYmd(date)||date>today||date<addDays(today,-7)||!MODES.includes(mode))return null;
 if(b?.dryRun!=null&&typeof b.dryRun!=='boolean')return null;
 return {date,mode,dryRun:b?.dryRun===true};
}

/**
 * 外部の定時呼び出し（P の 08:00 / 17:30 / 月曜 08:00）。owner のログインとは別の機械認証。
 *   POST /api/nippo/coach  header x-nippo-coach-key: <NIPPO_COACH_ROUTINE_KEY>
 *   body {action:"morning", date?, mode?, idempotencyKey, dryRun?}
 * テナントは NIPPO_COACH_TENANT_ID だけ（body からは受けない）。仕様は docs/behavior-coach.md。
 */
async function handleRoutine(req,res,{getAdmin,readJson,env,now}){
 const secret=env.NIPPO_COACH_ROUTINE_KEY||'',tenantId=env.NIPPO_COACH_TENANT_ID||'';
 if(secret.length<32||!UUID.test(tenantId))return routineError(res,'routine_disabled');
 if(!sameSecret(req.headers[ROUTINE_HEADER]||'',secret))return routineError(res,'unauthorized');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return routineError(res,'method_not_allowed');}
 const b=await readJson(req);
 const p=parseCheckRequest(b,now());
 if(b?.action!=='morning'||!p||(!p.dryRun&&!KEY_RE.test(String(b?.idempotencyKey||''))))return routineError(res,'invalid_request');
 const sb=getAdmin();
 const {data:config,error}=await sb.from('gw_coach_config').select('*').eq('tenant_id',tenantId).maybeSingle();
 if(error)return routineError(res,'coach_store_unavailable');
 if(config?.enabled!==true||config?.morning_enabled!==true)return routineError(res,'coach_disabled');
 return executeCheck(res,sb,{tenantId,config,...p,idempotencyKey:b.idempotencyKey,now,error:routineError});
}

async function executeCheck(res,sb,{tenantId,config,date,mode,dryRun,idempotencyKey,force=false,now,error}){
 if(dryRun){
  try{return respond(res,200,await runCoachCheck(sb,{tenantId,checkDate:date,mode,config,dryRun:true,now}));}
  catch(e){return error(res,e.message==='roster_unreadable'?'roster_unreadable':'coach_unavailable');}
 }
 const token=randomUUID();
 let lease;
 try{lease=await rpc(sb,'gw_coach_run_begin',{p_tenant_id:tenantId,p_check_date:date,p_mode:mode,p_key:idempotencyKey,p_token:token});}
 catch{return error(res,'coach_store_unavailable');}
 if(lease?.run==='disabled')return error(res,'coach_disabled');
 if(lease?.run==='busy')return error(res,'run_in_progress',{retryAfterSec:60});
 if(lease?.run==='replay')return respond(res,200,{...lease.result,replay:true});
 try{
  const result=await runCoachCheck(sb,{tenantId,checkDate:date,mode,config,force,now});
  const stored={...result,idempotencyKey,replay:false};
  await rpc(sb,'gw_coach_run_finish',{p_tenant_id:tenantId,p_check_date:date,p_mode:mode,p_token:token,p_ok:true,p_result:stored});
  return respond(res,200,stored);
 }catch(e){
  // 途中まで書いた行はそれぞれ冪等（同じ版なら unchanged）。同じ鍵で再送すれば残りを終える
  try{await rpc(sb,'gw_coach_run_finish',{p_tenant_id:tenantId,p_check_date:date,p_mode:mode,p_token:token,p_ok:false,p_result:{error:String(e.message).slice(0,60)}});}catch{}
  const code=e.message==='roster_unreadable'?'roster_unreadable':e.message==='coach_disabled'?'coach_disabled':'coach_unavailable';
  return error(res,code,{partial:true});
 }
}

/** 代表の画面用：指定日・モードの確認結果と、関係するレビュー・送信候補 */
async function checksView(sb,tenantId,{date,mode}){
 const [emps,checks,outbox]=await Promise.all([
  sb.from('gw_employees').select('id,display_name,employment_type').eq('tenant_id',tenantId).order('id').limit(1000),
  sb.from('gw_coach_checks').select('employee_id,status,report_date,next_workday,detail,review_id,revision,checked_at,changed_at').eq('tenant_id',tenantId).eq('check_date',date).eq('mode',mode).order('employee_id').limit(1000),
  sb.from('gw_coach_outbox').select('id,kind,state,generation,body,body_hash,target,target_hash,approval,receipt,updated_at').eq('tenant_id',tenantId).eq('check_date',date).eq('mode',mode).order('kind').limit(10)]);
 if(emps.error||checks.error||outbox.error)throw new Error('coach_store_unavailable');
 const ids=[...new Set((checks.data||[]).map(c=>c.review_id).filter(Boolean))];
 let reviews=[];
 if(ids.length){const r=await sb.from('gw_coach_reviews').select('id,employee_id,report_date,evaluation_epoch,generation,state,draft,approval,delivery_state,updated_at').eq('tenant_id',tenantId).in('id',ids).limit(1000);if(r.error)throw new Error('coach_store_unavailable');reviews=r.data||[];}
 const names=new Map((emps.data||[]).map(e=>[e.id,e]));
 const rows=(checks.data||[]).map(c=>({...c,name:names.get(c.employee_id)?.display_name||'',employmentType:names.get(c.employee_id)?.employment_type||null,statusLabel:STATUS_LABEL[c.status],
  reasons:(c.detail?.reasons||[]).map(code=>({code,label:REASON_LABEL[code]||code}))}));
 const summary={total:rows.length};for(const k of Object.keys(STATUS_LABEL))summary[k]=rows.filter(r=>r.status===k).length;
 summary.checked=summary.ok+summary.check+summary.action;summary.consistent=summary.checked+summary.unconfirmed+summary.excluded===summary.total;
 return {date,mode,checks:rows,reviews,outbox:outbox.data||[],summary};
}

export function createCoachHandler({requireUser,gwContext,getAdmin,askJson,readJson,now=()=>new Date(),env=process.env,fetchImpl=globalThis.fetch,slackClient=null}){
 return async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.headers&&req.headers[ROUTINE_HEADER]!=null)return handleRoutine(req,res,{getAdmin,readJson,env,now});
  if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return respond(res,405,{error:'method_not_allowed'});}
  const user=await requireUser(req,res);if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!(ctx.isAdmin||ctx.roles?.includes('owner')))return respond(res,403,{error:'forbidden'});
  try{
   const sb=getAdmin();
   const {data:config,error:ce}=await sb.from('gw_coach_config').select('*').eq('tenant_id',ctx.tenantId).maybeSingle();
   if(ce)return respond(res,503,{error:'coach_setup_required'});
   if(config?.owner_user_id!==user.id)return respond(res,403,{error:'owner_only'});
   if(config.enabled!==true)return respond(res,503,{error:'coach_disabled'});
   const denv=coachDeliveryEnv(env);
   const settings={enabled:true,aiEnabled:config.ai_enabled===true,morningEnabled:config.morning_enabled===true,deliveryEnabledDb:config.delivery_enabled===true,
    teamChannelSet:!!config.team_channel_id,ownerDmSet:!!config.owner_dm_channel_id,preflightOk:config.slack_preflight?.ok===true,
    deliveryBlockedBy:deliveryBlock(config,denv)};
   if(req.method==='GET'){
    const url=new URL(req.url||'/','http://x');
    if(url.searchParams.get('view')==='checks'){
     const p=parseCheckRequest({date:url.searchParams.get('date')||undefined,mode:url.searchParams.get('mode')||undefined},now());
     if(!p)return respond(res,400,{error:'invalid_request'});
     return respond(res,200,{...await checksView(sb,ctx.tenantId,p),settings,deliveryEnabled:settings.deliveryBlockedBy===null});
    }
    const {data,error}=await sb.from('gw_coach_reviews').select('id,employee_id,report_date,source_revision,evaluation_epoch,generation,state,draft,approval,delivery_state,updated_at').eq('tenant_id',ctx.tenantId).order('updated_at',{ascending:false}).limit(100);
    if(error)throw new Error('coach_store_unavailable');
    return respond(res,200,{reviews:data||[],limit:100,deliveryEnabled:false});
   }
   const b=await readJson(req);
   if(b?.action==='collect'){
    const count=await rpc(sb,'gw_coach_collect',{p_tenant_id:ctx.tenantId,p_limit:10});
    return respond(res,200,{collected:count,deliveryEnabled:false});
   }
   if(b?.action==='morning'){
    // 代表が画面から手動で流す（外部の定時呼び出しと同じ処理・同じ lease）
    if(config.morning_enabled!==true)return respond(res,503,{error:'coach_morning_disabled'});
    const p=parseCheckRequest(b,now());if(!p)return respond(res,400,{error:'invalid_request'});
    return executeCheck(res,sb,{tenantId:ctx.tenantId,config,...p,idempotencyKey:'owner-'+randomUUID(),force:b.force===true,now,
     error:(r,code,extra={})=>respond(r,ROUTINE_ERRORS[code]?.[0]||503,{error:code,...extra})});
   }
   if(b?.action==='preflight'){
    // 読み取りだけ。結果を保存し、ok でなければ送信は止まったまま
    if(!denv.token)return respond(res,503,{error:'coach_slack_not_configured'});
    const {data:owner}=await sb.from('gw_employees').select('email').eq('tenant_id',ctx.tenantId).eq('user_id',config.owner_user_id).maybeSingle();
    const result=await slackPreflight({config,client:slackClient||createSlackReadClient({token:denv.token,fetchImpl}),ownerEmail:owner?.email||null,now});
    const {error}=await sb.from('gw_coach_config').update({slack_preflight:result,updated_at:now().toISOString()}).eq('tenant_id',ctx.tenantId);
    if(error)throw new Error('coach_store_unavailable');
    return respond(res,200,{preflight:result,deliveryEnabled:false});
   }
   requireValue(UUID.test(b?.id||''),'invalid_id');
   if(b.action==='approve_outbox'||(b.action==='deliver'&&b.kind==='outbox')){
    const {data:row,error}=await sb.from('gw_coach_outbox').select('*').eq('tenant_id',ctx.tenantId).eq('id',b.id).maybeSingle();
    if(error)throw new Error('coach_store_unavailable');if(!row)return respond(res,404,{error:'not_found'});
    if(b.action==='approve_outbox'){
     requireValue(row.state==='draft'&&row.target&&b.bodyHash===row.body_hash&&b.targetHash===row.target_hash&&Number(b.generation)===Number(row.generation)&&digest(row.body)===row.body_hash,'draft_changed_or_not_sendable');
     const approval={actor_user_id:user.id,body_hash:row.body_hash,target_hash:row.target_hash,generation:row.generation,target:row.target,approvedAt:now().toISOString()};
     const ok=await rpc(sb,'gw_coach_outbox_approve',{p_id:row.id,p_generation:row.generation,p_approval:approval});
     return respond(res,200,{approved:ok,deliveryEnabled:false});
    }
    const {data:emps}=await sb.from('gw_employees').select('display_name').eq('tenant_id',ctx.tenantId).limit(1000);
    return respond(res,200,await deliverOutbox(sb,row,{config,denv,names:(emps||[]).map(e=>e.display_name),fetchImpl}));
   }
   const {data:row,error}=await sb.from('gw_coach_reviews').select('*').eq('tenant_id',ctx.tenantId).eq('id',b.id).maybeSingle();
   if(error)throw new Error('coach_store_unavailable');if(!row)return respond(res,404,{error:'not_found'});
   if(b.action==='analyze'){
    if(config.ai_enabled!==true)return respond(res,503,{error:'coach_ai_disabled'});
    return respond(res,200,await processCoachReview(sb,row,{askJson}));
   }
   if(b.action==='refresh'){
    // Existing 17:30 / 08:00 tasks can call this endpoint; no new schedule is installed.
    const epoch=evaluationEpoch(row.report_date,now());
    const result=await rpc(sb,'gw_coach_refresh',{p_id:row.id,p_evaluation_epoch:epoch});
    const fresh=await readCoachSources(sb,row);
    if(row.draft&&fresh.sourceHash!==row.draft.sourceHash)await rpc(sb,'gw_coach_enqueue',{p_tenant_id:ctx.tenantId,p_employee_id:row.employee_id,p_report_date:row.report_date,p_source_kind:'refresh',p_source_id:fresh.sourceHash});
    return respond(res,200,{refreshed:result,deliveryEnabled:false});
   }
   if(b.action==='approve')return respond(res,200,await approveCoachReview(sb,row,{userId:user.id,draftId:b.draftId,text:b.text,targetHash:b.targetHash}));
   if(b.action==='deliver'&&b.kind==='review')return respond(res,200,await deliverReview(sb,row,{config,denv,fetchImpl}));
   // No send-by-text, Slack webhook, recipient editing, delete or source mutation action exists.
   return respond(res,400,{error:'unsupported_action'});
  }catch(e){
   const allowed=['invalid_id','draft_changed_or_not_sendable','source_changed','recipient_unverified','unsafe_recipient','recipient_changed','not_approved','team_text_unsafe'];
   return respond(res,allowed.includes(e.message)?409:503,{error:allowed.includes(e.message)?e.message:'coach_unavailable'});
  }
 };
}
