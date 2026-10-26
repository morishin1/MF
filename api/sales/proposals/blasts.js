// Sales提案のブラスト履歴。これは「外部配信した記録」であり、一斉送信APIではない。
// 面談化はSalesの面談予定/実施記録が配信以降にあるとき、担当者が根拠を記入した場合だけ。
import { json,readJson,methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext,canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { canManageProposals,isUuid } from "../../../lib/sales-proposals.js";
const TABLE="gw_sales_proposal_blasts";
const SQL="db/149_sales_proposal_blast_tracking.sql";
const finiteTime=x=>typeof x==="string"&&Number.isFinite(Date.parse(x));
function fail(res,e){
 console.error("[sales/blasts]",e?.code||"unknown");
 return json(res,["42P01","42703","PGRST205"].includes(e?.code)?503:500,{
  error:"db_failed",message:["42P01","42703","PGRST205"].includes(e?.code)
  ?SQL+" が未適用です。管理者へお知らせください":"ブラスト履歴を保存できませんでした。担当者に確認してください"});
}
async function proposal(sb,tenant,id){
 const {data,error}=await sb.from("gw_sales_proposals")
  .select("id,tenant_id,sales_owner_id,archived_at,status")
  .eq("tenant_id",tenant).eq("id",id).maybeSingle();
 return {data,error};
}
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:"forbidden"});
 res.setHeader("Cache-Control","private,no-store");
 const sb=userClient(req);
 if(req.method==="GET"){
  const id=new URL(req.url,"http://localhost").searchParams.get("proposalId");
  if(!isUuid(id))return json(res,400,{error:"invalid_proposal"});
  const p=await proposal(sb,ctx.tenantId,id);
  if(p.error)return fail(res,p.error);
  if(!p.data)return json(res,404,{error:"not_found"});
  const {data,error}=await sb.from(TABLE).select("id,proposal_id,sent_at,channel,send_reference,meeting_confirmed_at,meeting_note")
    .eq("tenant_id",ctx.tenantId).eq("proposal_id",id).order("sent_at",{ascending:false}).limit(100);
  if(error)return fail(res,error);
  return json(res,200,{blasts:data||[]});
 }
 if(req.method!=="POST")return methodNotAllowed(res,["GET","POST"]);
 const b=await readJson(req);
 if(!b||typeof b!=="object")return json(res,400,{error:"invalid_body"});
 if(b.action==="record"){
  const ids=b.ids, batchId=String(b.batchId||"");
  if(!Array.isArray(ids)||!ids.length||ids.length>50||!isUuid(batchId)||
    ids.some(id=>!isUuid(id))||new Set(ids).size!==ids.length)
   return json(res,400,{error:"invalid_selection",message:"提案は最大50件まで選び、画面からもう一度記録してください"});
  const ref=String(b.reference||"").trim().slice(0,200);
  const channel=["external_email","external_service"].includes(b.channel)?b.channel:null;
  const at=b.sentAt;
  const ms=Date.parse(at);
  if(ref.length<4||!channel||!finiteTime(at)||ms>Date.now()+60000||ms<Date.now()-365*86400000)
   return json(res,400,{error:"invalid_send",message:"外部配信ツール名・配信識別子、配信日時、方法を確認してください"});
  const {data:targets,error:e1}=await sb.from("gw_sales_proposals")
   .select("id,sales_owner_id,archived_at")
   .eq("tenant_id",ctx.tenantId).in("id",ids);
  if(e1)return fail(res,e1);
  if((targets||[]).length!==ids.length||
      targets.some(p=>p.archived_at||!(canManageProposals(ctx)||(ctx.employee?.id&&ctx.employee.id===p.sales_owner_id))))
   return json(res,403,{error:"readonly",message:"対象に編集権限のない提案が含まれます"});
  const records=ids.map(proposalId=>({
   tenant_id:ctx.tenantId,proposal_id:proposalId,batch_id:batchId,
   sent_at:new Date(ms).toISOString(),channel,send_reference:ref,sent_by:user.id
  }));
  const {data,error}=await sb.from(TABLE).insert(records).select("id,proposal_id");
  if(error){
   if(error.code==="23505")return json(res,409,{error:"already_recorded",
     message:"この配信は記録済みです。提案一覧を更新してください"});
   return fail(res,error);
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.blast_record",
    target:"sales_proposal:blast_batch",detail:{count:records.length,channel}});
  return json(res,200,{ok:true,count:data?.length||0});
 }
 if(b.action==="confirmMeeting"){
  const id=String(b.blastId||""),note=String(b.note||"").trim();
  if(!isUuid(id)||note.length<10||note.length>1000)return json(res,400,{error:"invalid_meeting",
    message:"ブラスト履歴を選択し、面談化したと判断した根拠を10文字以上で入力してください"});
  const {data:blast,error:e2}=await sb.from(TABLE)
   .select("id,proposal_id,sent_at,meeting_confirmed_at")
   .eq("tenant_id",ctx.tenantId).eq("id",id).maybeSingle();
  if(e2)return fail(res,e2);
  if(!blast)return json(res,404,{error:"not_found"});
  if(blast.meeting_confirmed_at)return json(res,409,{error:"already_confirmed",
   message:"すでに面談化として記録されています"});
  const p=await proposal(sb,ctx.tenantId,blast.proposal_id);
  if(p.error)return fail(res,p.error);
  if(!p.data||p.data.archived_at||
    !(canManageProposals(ctx)||(ctx.employee?.id&&ctx.employee.id===p.data.sales_owner_id)))
   return json(res,403,{error:"readonly"});
  const {data:acts,error:e3}=await sb.from("gw_sales_proposal_activities")
   .select("id,kind,result,occurred_at").eq("tenant_id",ctx.tenantId)
   .eq("proposal_id",blast.proposal_id).eq("kind","meeting")
   .in("result",["scheduled","done"]).gte("occurred_at",blast.sent_at).limit(1);
  if(e3)return fail(res,e3);
  if(!acts?.length)return json(res,409,{error:"meeting_not_confirmed",
   message:"このブラスト配信後の面談予定・実施記録がありません。先に［面談］で日程確定か実施を記録してください"});
  const now=new Date().toISOString();
  const {data,error}=await sb.from(TABLE).update({
    meeting_confirmed_at:now,meeting_note:note,meeting_recorded_by:user.id
  }).eq("tenant_id",ctx.tenantId).eq("id",id)
    .is("meeting_confirmed_at",null).select("id,meeting_confirmed_at").maybeSingle();
  if(error)return fail(res,error);
  if(!data)return json(res,409,{error:"already_confirmed"});
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.blast_meeting_confirm",
    target:"sales_proposal:"+blast.proposal_id,detail:{blastId:id}});
  return json(res,200,{ok:true,blast:data});
 }
 return json(res,400,{error:"invalid_action"});
}
