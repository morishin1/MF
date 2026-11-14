// /api/hr/trials — 14日間の実務トライアル。既存の採用ステージや内定・契約を更新しない。
// GET: 採用担当が一覧・候補者別を表示
// POST: 計画作成（実施開始はしない）
// PATCH: update / confirmAgreement / start / complete / cancel
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canManageHr, canDecideHire } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { ymd as jstYmd } from "../../../lib/jst.js";

const SQL="db/180_hr_trial_periods.sql";
const FIELDS="id, tenant_id, applicant_id, start_on, end_on, status, basis, onsite_limit_days, agreement_checked_at, agreement_reference, kpi_description, week1_result, week2_result, review_scores, decision, review_note, reviewed_at, created_at, updated_at";
const SCORE_KEYS=["outcomes","skills","autonomy","teamwork","growth"];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDay=s=>DATE.test(s)&&!Number.isNaN(Date.parse(s+"T00:00:00Z"))&&new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;
const endDay=s=>{const d=new Date(s+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+13);return d.toISOString().slice(0,10);};
const textField=(value,max)=>typeof value==="string"&&value.length<=max;
function shape(row){
 return {
  id:row.id,applicantId:row.applicant_id,startOn:row.start_on,endOn:row.end_on,
  status:row.status,basis:row.basis,onsiteLimitDays:row.onsite_limit_days,
  agreementConfirmed:Boolean(row.agreement_checked_at),agreementCheckedAt:row.agreement_checked_at,
  agreementReference:row.agreement_reference||"",kpiDescription:row.kpi_description||"",
  week1Result:row.week1_result||"",week2Result:row.week2_result||"",
  reviewScores:row.review_scores||{},decision:row.decision||null,reviewNote:row.review_note||"",
  reviewedAt:row.reviewed_at,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
const failSql=(res,error)=>{
 const hint=dbSetupHint(error,SQL);
 if(hint)return json(res,200,{notReady:true,message:hint,trials:[]});
 return json(res,error.code==="42501"?403:500,{error:"db_query_failed",detail:error.message});
};
const audit=async(ctx,user,action,trial,detail={})=>gwLog({
 tenantId:ctx.tenantId,actorId:user.id,action:"hr.trial_"+action,target:"hr_trial:"+trial.id,
 detail:{applicantId:trial.applicant_id,...detail}
});
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId)return json(res,403,{error:"no_membership"});
 if(!canRecruit(ctx))return json(res,403,{error:"forbidden"});
 // GETはRLS付きの本人クライアント。作成・更新はサーバのロール検証後に限りservice_role使用。
 const sb=req.method==="GET"?userClient(req):admin();
 if(req.method==="GET")return list(req,res,sb,ctx);
 if(req.method==="POST")return create(req,res,sb,ctx,user);
 if(req.method==="PATCH")return patch(req,res,sb,ctx,user);
 return methodNotAllowed(res,["GET","POST","PATCH"]);
}
async function list(req,res,sb,ctx){
 const filter=new URL(req.url||"/", "http://localhost").searchParams.get("applicantId");
 if(filter&&!UUID.test(filter))return json(res,400,{error:"invalid_applicant_id"});
 let q=sb.from("gw_hr_trial_periods").select(FIELDS)
   .eq("tenant_id",ctx.tenantId).order("start_on",{ascending:false}).limit(400);
 if(filter)q=q.eq("applicant_id",filter);
 const {data,error}=await q;
 if(error)return failSql(res,error);
 const ids=[...new Set((data||[]).map(x=>x.applicant_id))];
 let people=[];
 if(ids.length){
  const p=await sb.from("gw_hr_applicants").select("id,name,job_title,stage,status")
   .eq("tenant_id",ctx.tenantId).in("id",ids);
  if(p.error)return failSql(res,p.error);
  people=p.data||[];
 }
 const byId=new Map(people.map(p=>[p.id,p]));
 return json(res,200,{trials:(data||[]).map(r=>({
  ...shape(r),
  applicantName:byId.get(r.applicant_id)?.name||"（応募者を確認）",
  jobTitle:byId.get(r.applicant_id)?.job_title||""
 }))});
}
async function create(req,res,sb,ctx,user){
 const b=await readJson(req);
 if(!UUID.test(b?.applicantId||"")||!validDay(b?.startOn||""))
  return json(res,400,{error:"invalid_body",hint:"応募者と開始日を指定してください"});
 if(!["employment","contractor"].includes(b.basis))
  return json(res,400,{error:"invalid_basis",hint:"雇用または業務委託を選択してください"});
 const limit=Number(b.onsiteLimitDays??3);
 if(!Number.isInteger(limit)||limit<0||limit>14)return json(res,400,{error:"invalid_onsite_limit"});
 const kpi=String(b.kpiDescription||"").trim();
 if(!kpi||kpi.length>1000)return json(res,400,{error:"invalid_kpi",hint:"2週間の成果目標を1000文字以内で入力してください"});
 const {data:applicant}=await sb.from("gw_hr_applicants").select("id,status")
   .eq("tenant_id",ctx.tenantId).eq("id",b.applicantId).maybeSingle();
 if(!applicant)return json(res,404,{error:"applicant_not_found"});
 if(["passed","declined","done","position_closed"].includes(applicant.status))
  return json(res,409,{error:"applicant_closed",hint:"選考終了の応募者には新しいトライアルを作成できません"});
 const row={tenant_id:ctx.tenantId,applicant_id:applicant.id,
  start_on:b.startOn,end_on:endDay(b.startOn),basis:b.basis,
  onsite_limit_days:limit,kpi_description:kpi,created_by:user.id};
 const {data,error}=await sb.from("gw_hr_trial_periods").insert(row).select(FIELDS).single();
 if(error){
  const hint=dbSetupHint(error,SQL);if(hint)return json(res,503,{error:"not_ready",message:hint});
  if(error.code==="23505")return json(res,409,{error:"duplicate_trial",hint:"同じ応募者・開始日のトライアルが登録済みです"});
  return json(res,error.code==="42501"?403:500,{error:"db_insert_failed",detail:error.message});
 }
 await audit(ctx,user,"plan",data);
 return json(res,200,{trial:shape(data)});
}
async function patch(req,res,sb,ctx,user){
 const b=await readJson(req);
 if(!UUID.test(b?.id||""))return json(res,400,{error:"invalid_trial_id"});
 const {data:current,error:loadError}=await sb.from("gw_hr_trial_periods").select("*")
  .eq("tenant_id",ctx.tenantId).eq("id",b.id).maybeSingle();
 if(loadError)return failSql(res,loadError);
 if(!current)return json(res,404,{error:"trial_not_found"});
 if(["completed","cancelled"].includes(current.status))return json(res,409,{error:"trial_closed"});
 let data={},action=b.action;
 if(action==="update"){
  const fields=[["kpiDescription","kpi_description",1000],["week1Result","week1_result",2000],
   ["week2Result","week2_result",2000],["reviewNote","review_note",2000]];
  for(const [front,db,max] of fields)if(Object.prototype.hasOwnProperty.call(b,front)){
   if(!textField(b[front],max))return json(res,400,{error:"invalid_"+front});
   data[db]=b[front].trim();
  }
  if(b.reviewScores!==undefined){
   const s=b.reviewScores;
   if(!s||typeof s!=="object"||Array.isArray(s)||Object.keys(s).some(k=>!SCORE_KEYS.includes(k)||!Number.isInteger(s[k])||s[k]<1||s[k]>5))
    return json(res,400,{error:"invalid_scores"});
   data.review_scores=s;
  }
  if(!Object.keys(data).length)return json(res,400,{error:"no_changes"});
 }else if(action==="confirmAgreement"){
  if(!canManageHr(ctx))return json(res,403,{error:"hr_approval_required"});
  if(current.status!=="planned")return json(res,409,{error:"invalid_state"});
  const ref=String(b.agreementReference||"").trim();
  if(ref.length<5||ref.length>500)return json(res,400,{error:"agreement_reference_required",hint:"締結済みの契約書・労働条件の確認先を入力してください"});
  data={agreement_checked_at:new Date().toISOString(),agreement_checked_by:user.id,agreement_reference:ref};
 }else if(action==="start"){
  if(!canManageHr(ctx))return json(res,403,{error:"hr_approval_required"});
  if(current.status!=="planned"||!current.agreement_checked_at)
   return json(res,409,{error:"agreement_not_confirmed",hint:"契約・報酬・労働条件の合意と確認を済ませてください"});
  if(current.start_on>jstYmd())return json(res,409,{error:"not_started_yet",hint:"予定日より前に開始済みにはできません"});
  data.status="active";
 }else if(action==="complete"){
  if(!canDecideHire(ctx))return json(res,403,{error:"ceo_approval_required"});
  if(current.status!=="active")return json(res,409,{error:"invalid_state"});
  if(!["recommend","continue","close"].includes(b.decision))return json(res,400,{error:"invalid_decision"});
  const s=current.review_scores||{};
  if(SCORE_KEYS.some(k=>!Number.isInteger(s[k])||s[k]<1||s[k]>5))
    return json(res,400,{error:"scores_required",hint:"5項目の評価をすべて入力してください"});
  if(!String(current.week1_result||"").trim()||!String(current.week2_result||"").trim())
    return json(res,400,{error:"weekly_results_required",hint:"1週目・2週目の成果記録が必要です"});
  data={status:"completed",decision:b.decision,reviewed_by:user.id,reviewed_at:new Date().toISOString()};
 }else if(action==="cancel"){
  if(!canDecideHire(ctx))return json(res,403,{error:"ceo_approval_required"});
  const note=String(b.reason||"").trim();
  if(note.length<5||note.length>1000)return json(res,400,{error:"reason_required"});
  data={status:"cancelled",review_note:note,reviewed_by:user.id,reviewed_at:new Date().toISOString()};
 }else return json(res,400,{error:"unknown_action"});
 data.updated_at=new Date().toISOString();
 const {data:updated,error}=await sb.from("gw_hr_trial_periods").update(data)
  .eq("id",current.id).eq("tenant_id",ctx.tenantId).eq("status",current.status).select(FIELDS).maybeSingle();
 if(error)return failSql(res,error);
 if(!updated)return json(res,409,{error:"concurrent_update",hint:"別の担当者が状態を更新しました。再読込してください"});
 await audit(ctx,user,action,updated,{status:updated.status});
 return json(res,200,{trial:shape(updated)});
}