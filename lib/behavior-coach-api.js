import {UUID,requireValue,processCoachReview,approveCoachReview,rpc,readCoachSources} from './behavior-coach.js';
const respond=(res,status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
export function evaluationEpoch(reportDate,now=new Date()){
 const cutoff=Date.parse(reportDate+'T08:00:00+09:00')+86400000;
 return (now.getTime()>=cutoff?'final:':'provisional:')+reportDate;
}
export function createCoachHandler({requireUser,gwContext,getAdmin,askJson,readJson,now=()=>new Date()}){
 return async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return respond(res,405,{error:'method_not_allowed'});}
  const user=await requireUser(req,res);if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!(ctx.isAdmin||ctx.roles?.includes('owner')))return respond(res,403,{error:'forbidden'});
  try{
   const sb=getAdmin();
   const {data:config,error:ce}=await sb.from('gw_coach_config').select('enabled,ai_enabled,owner_user_id').eq('tenant_id',ctx.tenantId).maybeSingle();
   if(ce)return respond(res,503,{error:'coach_setup_required'});
   if(config?.owner_user_id!==user.id)return respond(res,403,{error:'owner_only'});
   if(config.enabled!==true)return respond(res,503,{error:'coach_disabled'});
   if(req.method==='GET'){
    const {data,error}=await sb.from('gw_coach_reviews').select('id,employee_id,report_date,source_revision,evaluation_epoch,generation,state,draft,approval,delivery_state,updated_at').eq('tenant_id',ctx.tenantId).order('updated_at',{ascending:false}).limit(100);
    if(error)throw new Error('coach_store_unavailable');
    return respond(res,200,{reviews:data||[],limit:100,deliveryEnabled:false});
   }
   const b=await readJson(req);
   if(b?.action==='collect'){
    const count=await rpc(sb,'gw_coach_collect',{p_tenant_id:ctx.tenantId,p_limit:10});
    return respond(res,200,{collected:count,deliveryEnabled:false});
   }
   requireValue(UUID.test(b?.id||''),'invalid_id');
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
   // No send, Slack webhook, recipient editing, delete or source mutation action exists.
   return respond(res,400,{error:'unsupported_action'});
  }catch(e){
   const allowed=['invalid_id','draft_changed_or_not_sendable','source_changed','recipient_unverified','unsafe_recipient','recipient_changed'];
   return respond(res,allowed.includes(e.message)?409:503,{error:allowed.includes(e.message)?e.message:'coach_unavailable'});
  }
 };
}
