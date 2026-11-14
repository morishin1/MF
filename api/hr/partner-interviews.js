// 社内HR専用パートナー面談ナビ。採用面談・雇用判断とは分離。
// 外部へのメール送信、契約送信、顧客アクセス発行、報酬確定はしない。
import { json,readJson,methodNotAllowed,dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext,canRecruit } from "../../lib/gw.js";
import { aalOf } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const TABLE="gw_hr_partner_interviews";
const PARTNERS="gw_hr_external_partners";
const AUDIT="gw_hr_partner_audit_events";
const SQL="db/184_hr_partner_interviews.sql";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROGRAMS=new Set(["enger","aimachi"]);
const WORK_TYPES=new Set(["research","appointment","matching","sales","content","local_support","other"]);
const DECISIONS=new Set(["recommend","hold","decline"]);
const FIELDS="id,partner_id,status,meeting_kind,current_step,step_notes,recommended_programs,recommended_work_types,security_understood,compensation_understood,summary,first_task_hint,decision,next_action,started_at,completed_at,created_at,updated_at";

const isUuid=v=>typeof v==="string"&&UUID.test(v);
const short=(v,max)=>typeof v==="string"&&v.trim().length<=max?v.trim():null;
const allowed=(v,kind,max=2)=>Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(x=>kind.has(x));
const error=(res,e)=>{
 const hint=dbSetupHint(e,SQL);
 if(hint)return json(res,503,{error:"not_ready",message:hint});
 if(e?.code==="23505")return json(res,409,{error:"open_interview_exists",message:"すでに進行中の面談があります"});
 if(e?.code==="23503")return json(res,409,{error:"partner_not_found"});
 return json(res,e?.code==="42501"?403:500,{error:"database_error"});
};
const view=x=>({
 id:x.id,partnerId:x.partner_id,status:x.status,meetingKind:x.meeting_kind,
 currentStep:x.current_step,notes:x.step_notes||{},
 programs:x.recommended_programs||[],workTypes:x.recommended_work_types||[],
 securityUnderstood:x.security_understood,compensationUnderstood:x.compensation_understood,
 summary:x.summary||"",firstTask:x.first_task_hint||"",decision:x.decision||"",
 nextAction:x.next_action||"",startedAt:x.started_at,completedAt:x.completed_at,
 createdAt:x.created_at,updatedAt:x.updated_at
});
async function audit(ctx,user,id,action,details={}) {
 const {error:e}=await admin().from(AUDIT).insert({
  tenant_id:ctx.tenantId,actor_id:user.id,entity_type:"interview",
  entity_id:id,action,details
 });
 if(e)console.error("[hr-partner-interview]",e.code);
 await gwLog({tenantId:ctx.tenantId,actorId:user.id,
  action:"hr.partner_interview_"+action,target:"partner_interview:"+id,detail:details});
}
function checkedNotes(value){
 if(!value || typeof value!=="object" || Array.isArray(value))return null;
 const notes={};
 for(let i=1;i<=6;i++){
  const v=value["step"+i]??"";
  const s=short(v,900);
  if(s===null)return null;
  notes["step"+i]=s;
 }
 return JSON.stringify(notes).length<=7000?notes:null;
}
function checkedDraft(body,partner){
 const notes=checkedNotes(body?.notes);
 const programs=body?.programs,types=body?.workTypes;
 const step=Number(body?.currentStep);
 const summary=short(body?.summary??"",1000),first=short(body?.firstTask??"",160),
   next=short(body?.nextAction??"",500);
 if(!notes || !Number.isInteger(step)||step<1||step>6
   || !allowed(programs,PROGRAMS) || !programs.every(x=>partner.programs.includes(x))
   || !allowed(types,WORK_TYPES,7) || summary===null||first===null||next===null
   || typeof body.securityUnderstood!=="boolean"||typeof body.compensationUnderstood!=="boolean")
   return null;
 return {step_notes:notes,current_step:step,recommended_programs:programs,
   recommended_work_types:types,security_understood:body.securityUnderstood,
   compensation_understood:body.compensationUnderstood,summary,
   first_task_hint:first,next_action:next};
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canRecruit(ctx)||!ctx.isHr)return json(res,403,{error:"forbidden"});
 if(aalOf(req)!=="aal2")return json(res,403,{error:"mfa_required",
  message:"パートナー面談には二段階認証が必要です"});
 const sb=admin();
 if(req.method==="GET")return list(req,res,sb,ctx);
 if(req.method==="POST")return create(req,res,sb,ctx,user);
 if(req.method==="PATCH")return patch(req,res,sb,ctx,user);
 return methodNotAllowed(res,["GET","POST","PATCH"]);
}
async function list(req,res,sb,ctx){
 const p=new URL(req.url||"/","http://localhost").searchParams.get("partnerId");
 if(p&&!isUuid(p))return json(res,400,{error:"invalid_partner_id"});
 let q=sb.from(TABLE).select(FIELDS).eq("tenant_id",ctx.tenantId)
   .order("created_at",{ascending:false}).limit(300);
 if(p)q=q.eq("partner_id",p);
 const {data,e,error:dbE}=await q;if(dbE)return error(res,dbE);
 return json(res,200,{interviews:(data||[]).map(view),limited:(data||[]).length===300});
}
async function create(req,res,sb,ctx,user){
 const b=await readJson(req);
 if(!isUuid(b?.partnerId) || !["online","onsite","phone"].includes(b.meetingKind))
   return json(res,400,{error:"invalid_body",message:"パートナーと面談方法を選択してください"});
 const {data:p,error:pe}=await sb.from(PARTNERS).select("id,status")
   .eq("id",b.partnerId).eq("tenant_id",ctx.tenantId).maybeSingle();
 if(pe)return error(res,pe);
 if(!p)return json(res,404,{error:"partner_not_found"});
 if(!["screening","approved"].includes(p.status))
   return json(res,409,{error:"wrong_partner_status",message:"稼働中・停止中のパートナーは初回面談の対象外です"});
 const {data,error:dbE}=await sb.from(TABLE).insert({
  tenant_id:ctx.tenantId,partner_id:p.id,meeting_kind:b.meetingKind,
  interviewed_by:user.id
 }).select(FIELDS).single();
 if(dbE)return error(res,dbE);
 await audit(ctx,user,data.id,"planned",{partnerId:p.id});
 return json(res,200,{interview:view(data)});
}
async function patch(req,res,sb,ctx,user){
 const b=await readJson(req);
 if(!isUuid(b?.id))return json(res,400,{error:"invalid_interview_id"});
 const {data:current,error:ie}=await sb.from(TABLE).select("*")
   .eq("tenant_id",ctx.tenantId).eq("id",b.id).maybeSingle();
 if(ie)return error(res,ie);
 if(!current)return json(res,404,{error:"not_found"});
 if(["completed","cancelled"].includes(current.status))
   return json(res,409,{error:"interview_closed"});
 const {data:partner,error:pe}=await sb.from(PARTNERS)
   .select("id,status,programs").eq("tenant_id",ctx.tenantId)
   .eq("id",current.partner_id).maybeSingle();
 if(pe)return error(res,pe);
 if(!partner||!["screening","approved"].includes(partner.status))
   return json(res,409,{error:"partner_not_available"});
 const act=b.action;
 let changes={updated_at:new Date().toISOString()};
 if(act==="start"){
  if(current.status!=="planned")return json(res,409,{error:"invalid_state"});
  changes.status="in_progress";changes.started_at=new Date().toISOString();
 }else if(act==="save"){
  if(current.status!=="in_progress")return json(res,409,{error:"start_first"});
  const checked=checkedDraft(b,partner);
  if(!checked)return json(res,400,{error:"invalid_notes",message:"入力内容、事業・業務区分をご確認ください"});
  changes={...changes,...checked};
 }else if(act==="complete"){
  if(current.status!=="in_progress"||current.current_step!==6)
   return json(res,409,{error:"finish_steps_first",
     message:"すべてのステップを進めてから最終判断を行ってください"});
  const decision=b.decision;
  const notes=current.step_notes||{};
  const summary=String(current.summary||"").trim(),next=String(current.next_action||"").trim();
  if(!DECISIONS.has(decision)||summary.length<10||next.length<5)
   return json(res,400,{error:"decision_details_required"});
  if(decision==="recommend" && (
    !current.security_understood||!current.compensation_understood||
    !(current.recommended_programs||[]).length||
    !["step2","step3","step4","step5"].every(key=>String(notes[key]||"").trim().length>0)
  ))return json(res,400,{error:"interview_incomplete",
    message:"推奨には経験・仕事・報酬・情報管理の記録と、本人の理解確認が必要です"});
  changes={...changes,status:"completed",decision,completed_at:new Date().toISOString()};
 }else if(act==="cancel"){
  const reason=short(b.reason,300);
  if(!reason||reason.length<5)return json(res,400,{error:"reason_required"});
  changes={...changes,status:"cancelled",next_action:reason};
 }else return json(res,400,{error:"unknown_action"});
 const {data,error:dbE}=await sb.from(TABLE).update(changes)
   .eq("id",current.id).eq("tenant_id",ctx.tenantId)
   .eq("updated_at",current.updated_at).eq("status",current.status)
   .select(FIELDS).maybeSingle();
 if(dbE)return error(res,dbE);
 if(!data)return json(res,409,{error:"concurrent_update",
   message:"他の担当者が変更しました。再読み込みしてください"});
 await audit(ctx,user,data.id,act,{partnerId:data.partner_id,status:data.status,
   ...(act==="complete"?{decision:data.decision}:{} )});
 return json(res,200,{interview:view(data)});
}
