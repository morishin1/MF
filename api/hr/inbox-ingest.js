// Gmail Apps Script -> HR新着受付。公開URLでもHMAC+時間制限+環境固定tenant以外は書込不可。
// Gmail API資格情報の保管・接続はApps Script（利用者のGoogle権限）側で行う。
import { admin } from "../../lib/supabase.js";
import { json, methodNotAllowed } from "../../lib/http.js";
import { verifySignature } from "../../lib/hr-inbox-sync-auth.js";

const TABLE="gw_hr_inbound_mail";
const RECIPIENT="saiyou@8grp.co.jp";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MSGID=/^[a-f0-9]{12,64}$/i;
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_BYTES=120000;
const trim=(s,len)=>typeof s==="string"?s.trim().slice(0,len):"";
const send=(res,code,data)=>json(res,code,data);
function validMessage(m,now){
  if(!m||typeof m!=="object"||Array.isArray(m))return null;
  const id=trim(m.id,200),received=trim(m.receivedAt,45);
  const ms=Date.parse(received);
  if(!MSGID.test(id)||!Number.isFinite(ms)||
      ms<now-14*86400000||ms>now+600000)return null;
  if(trim(m.recipient,254).toLowerCase()!==RECIPIENT)return null;
  const sender=trim(m.sender,254).toLowerCase();
  const reply=trim(m.replyTo,254).toLowerCase();
  if(sender&&!EMAIL.test(sender))return null;
  if(reply&&!EMAIL.test(reply))return null;
  return {
    provider:"gmail",provider_message_id:id,recipient:RECIPIENT,
    received_at:new Date(ms).toISOString(),
    subject:trim(m.subject,300),sender_address:sender,
    reply_to:reply||null,body_text:trim(m.text,5000)||null,
    // 応募者本人の氏名・媒体はGmailから自動推定しない。
    status:"new"
  };
}
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return methodNotAllowed(res,["POST"]);
  // 設定前は必ず停止。未知のtenant・共有された既定secretでの運用を防止。
  const secret=process.env.HR_INBOX_SYNC_SECRET;
  const tenant=process.env.HR_INBOX_TENANT_ID;
  if(process.env.HR_INBOX_SYNC_ENABLED!=="1"||!UUID.test(tenant||"")||
     !secret||secret.length<32)return send(res,503,{error:"sync_not_configured"});
  // Apps Scriptは text/plain で送る。JSONパーサの再直列化差分をなくす。
  const body=typeof req.body==="string"?req.body:null;
  if(body===null||Buffer.byteLength(body,"utf8")>MAX_BYTES)
    return send(res,400,{error:"invalid_body"});
  if(!verifySignature({
    secret,timestamp:req.headers["x-eight-timestamp"],
    signatureHex:req.headers["x-eight-signature"],body
  }))return send(res,401,{error:"unauthorized"});
  let payload;
  try{payload=JSON.parse(body);}catch{return send(res,400,{error:"invalid_json"});}
  if(!Array.isArray(payload?.messages)||payload.messages.length<1||payload.messages.length>10)
    return send(res,400,{error:"invalid_batch"});
  const now=Date.now();
  const records=payload.messages.map(x=>validMessage(x,now));
  if(records.some(x=>!x))return send(res,400,{error:"invalid_message"});
  if(new Set(records.map(x=>x.provider_message_id)).size!==records.length)
    return send(res,400,{error:"duplicate_in_batch"});

  let sb;
  try{sb=admin();}catch(e){
    console.error("[hr/inbox-ingest] Supabase not configured");
    return send(res,503,{error:"db_unavailable"});
  }
  // 既存台帳の状態/担当者メモは絶対更新しない。重複は23505でスキップ。
  let inserted=0,duplicates=0,failed=0;
  for(const row of records){
    const {error:e}=await sb.from(TABLE)
      .insert({tenant_id:tenant,...row}).select("id").single();
    if(!e){inserted++;continue;}
    if(e.code==="23505"){duplicates++;continue;}
    failed++;
    // Gmail本文・差出人・候補者データをログに出さない。
    console.error("[hr/inbox-ingest] insert failed",e.code||"unknown");
  }
  // 一部失敗は503として再送させる。重複制約により既成功レコードは保全。
  return send(res,failed?503:200,{
    ok:failed===0,inserted,duplicates,failed,
    ...(failed?{error:"retry_required"}:{})
  });
}
