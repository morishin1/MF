// 採用メール新着受付。採用HR権限でのみ閲覧・レビュー・応募者紐づけ。
// Gmailへの接続はここでは行わない。import は認証済みHRの明示操作だけ。
import { requireUser } from "../../lib/auth.js";
import { gwContext,canRecruit } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { json,readJson,methodNotAllowed } from "../../lib/http.js";
import { gwLog } from "../../lib/gw-audit.js";

const TABLE="gw_hr_inbound_mail";
const SQL="db/147_hr_inbound_mail.sql";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX=500;
const COLUMN="id,provider,provider_message_id,recipient,received_at,subject,sender_address,reply_to,body_text,source_guess,candidate_name_guess,job_title_guess,status,applicant_id,review_note,reviewed_at,created_at";
const str=(v,max)=>typeof v==="string"?v.trim().slice(0,max):"";
const missing=e=>["42P01","PGRST205"].includes(e?.code)||/schema cache/i.test(String(e?.message||""));
function dbFail(res,e){
  console.error("[hr/inbox] DB error",e?.code||"unknown");
  return json(res,missing(e)?503:500,{
    error:missing(e)?"not_ready":"db_failed",
    message:missing(e)?"新着受付のデータベースが未設定です。管理者が "+SQL+" を適用してください":"新着受付の保存・読込に失敗しました。管理者に連絡してください"
  });
}
const validEmail=s=>!s||EMAIL.test(s);
const isDate=s=>!!s&&Number.isFinite(Date.parse(s));

export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:"forbidden",message:"HR採用権限が必要です"});
  res.setHeader("Cache-Control","private,no-store");
  const sb=admin();

  if(req.method==="GET"){
    const {data,error:e}=await sb.from(TABLE).select(COLUMN)
      .eq("tenant_id",ctx.tenantId).order("received_at",{ascending:false}).limit(MAX);
    if(e)return dbFail(res,e);
    const rows=data||[];
    // 受信用サーバの設定状況のみ返す。Gmailトリガーが動いている証明ではない。
    const syncConfigured=process.env.HR_INBOX_SYNC_ENABLED==="1"
      && ctx.tenantId===process.env.HR_INBOX_TENANT_ID
      && String(process.env.HR_INBOX_SYNC_SECRET||"").length>=32;
    const lastGmailImportedAt=rows.filter(x=>x.provider==="gmail"&&x.created_at)
      .map(x=>x.created_at).sort().at(-1)||null;
    return json(res,200,{mails:rows,newCount:rows.filter(x=>x.status==="new").length,
      capped:rows.length===MAX,syncConfigured,lastGmailImportedAt});
  }
  if(req.method!=="POST")return methodNotAllowed(res,["GET","POST"]);
  const b=await readJson(req);if(!b||typeof b!=="object")return json(res,400,{error:"invalid_body"});

  if(b.action==="import"){
    // 外部メールからの情報は推測で応募者情報に上書きしない。
    // Gmail実連携は認証済みの別プロバイダ接続ができるまで禁止。
    // HR担当による手動貼り付けを「Gmail由来の確定データ」と偽装させない。
    if(b.provider==="gmail")return json(res,409,{error:"source_not_connected",
      message:"Gmailの自動取り込みは未接続です。現在は手動受付を使用してください"});
    if(b.provider!=="manual")return json(res,400,{error:"invalid_provider"});
    const providerMessageId=str(b.providerMessageId,200);
    const originalId=String(b.providerMessageId||"").trim();
    if(!providerMessageId||originalId!==providerMessageId)
      return json(res,400,{error:"invalid_message_id",message:"受信メールIDが必要です"});
    const recipient=str(b.recipient,254).toLowerCase();
    if(recipient!=="saiyou@8grp.co.jp")return json(res,400,{error:"invalid_recipient",message:"採用窓口宛メールのみ取り込めます"});
    const receivedAt=str(b.receivedAt,40);
    const senderAddress=str(b.senderAddress,254);
    const replyTo=str(b.replyTo,254);
    if(!isDate(receivedAt)||!validEmail(senderAddress)||!validEmail(replyTo))
      return json(res,400,{error:"invalid_mail",message:"受信日時・送信元アドレスを確認してください"});
    const {data, error:e}=await sb.from(TABLE).insert({
      tenant_id:ctx.tenantId,provider:b.provider,provider_message_id:providerMessageId,
      recipient,received_at:new Date(receivedAt).toISOString(),
      subject:str(b.subject,300),sender_address:senderAddress.toLowerCase(),
      reply_to:replyTo?replyTo.toLowerCase():null,body_text:str(b.bodyText,5000)||null,
      source_guess:str(b.source,80)||null,candidate_name_guess:str(b.candidateName,100)||null,
      job_title_guess:str(b.jobTitle,180)||null,created_by:user.id
    }).select("id,status").single();
    if(e?.code==="23505"){
      const old=await sb.from(TABLE).select("id,status").eq("tenant_id",ctx.tenantId)
        .eq("provider",b.provider).eq("provider_message_id",providerMessageId).maybeSingle();
      if(old.error)return dbFail(res,old.error);
      return json(res,200,{ok:true,duplicate:true,mail:old.data||null});
    }
    if(e)return dbFail(res,e);
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.inbound_import",
      target:"hr_mail:"+data.id,detail:{provider:b.provider}});
    return json(res,201,{ok:true,duplicate:false,mail:data});
  }

  const id=str(b.id,40);
  if(!UUID.test(id))return json(res,400,{error:"invalid_id"});
  const {data:current,error:oneErr}=await sb.from(TABLE).select("id,status,applicant_id")
    .eq("tenant_id",ctx.tenantId).eq("id",id).maybeSingle();
  if(oneErr)return dbFail(res,oneErr);
  if(!current)return json(res,404,{error:"not_found"});
  if(current.status==="linked")return json(res,409,{error:"already_linked",
    message:"応募者に紐づけ済みの受信記録は変更できません"});

  if(b.action==="review"){
    if(!["review","ignored","new"].includes(b.status))return json(res,400,{error:"invalid_status"});
    const next={status:b.status,review_note:str(b.note,1000)||null,
      reviewed_by:user.id,reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    const {data,error:e}=await sb.from(TABLE).update(next).eq("tenant_id",ctx.tenantId)
      .eq("id",id).eq("status",current.status).select("id,status").maybeSingle();
    if(e)return dbFail(res,e);
    if(!data)return json(res,409,{error:"stale_record",message:"別の担当者が更新しました。読み直してください"});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.inbound_review",
      target:"hr_mail:"+id,detail:{status:data.status}});
    return json(res,200,{ok:true,mail:data});
  }
  if(b.action==="link"){
    const applicantId=str(b.applicantId,40);
    if(!UUID.test(applicantId))return json(res,400,{error:"invalid_applicant"});
    const {data:applicant,error:check}=await sb.from("gw_hr_applicants")
      .select("id").eq("tenant_id",ctx.tenantId).eq("id",applicantId).maybeSingle();
    if(check)return dbFail(res,check);
    if(!applicant)return json(res,404,{error:"applicant_not_found",message:"同じ組織に登録済みの応募者を指定してください"});
    const {data,error:e}=await sb.from(TABLE).update({
      status:"linked",applicant_id:applicantId,reviewed_by:user.id,
      reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString()
    }).eq("tenant_id",ctx.tenantId).eq("id",id).eq("status",current.status)
      .is("applicant_id",null).select("id,status,applicant_id").maybeSingle();
    if(e)return dbFail(res,e);
    if(!data)return json(res,409,{error:"stale_record",message:"紐づけ状態が更新されています。読み直してください"});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.inbound_link",
      target:"hr_mail:"+id,detail:{applicantId}});
    return json(res,200,{ok:true,mail:data});
  }
  return json(res,400,{error:"invalid_action"});
}
