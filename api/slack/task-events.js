// Slack Events API -> 本人の「未完了タスク」。Slackが署名したメッセージだけ処理する。
// Slackアプリが参加した許可チャンネルかつ本人宛ての明示依頼のみ取り込む。
// Vercel側は SLACK_TASK_* の接続設定が揃うまで自動取込しない。
import {admin} from "../../lib/supabase.js";
import {verifySlackSignature,slackRequestTask} from "../../lib/slack-task-ingest.js";

// Slack署名は「生のHTTP本文」に対して計算する。JSONの再シリアライズは禁止。
export const config = {api:{bodyParser:false}};

async function rawRequest(req) {
  if(typeof req.rawBody==="string")return req.rawBody;
  if(Buffer.isBuffer(req.rawBody))return req.rawBody.toString("utf8");
  let size=0;const parts=[];
  for await(const chunk of req){
    const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=buf.length;
    if(size>262144)throw new Error("body_too_large");
    parts.push(buf);
  }
  return Buffer.concat(parts).toString("utf8");
}
function send(res,status,data){
  res.statusCode=status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export default async function handler(req,res) {
  if(req.method!=="POST")return send(res,405,{error:"method_not_allowed"});
  const secret=process.env.SLACK_TASK_SIGNING_SECRET;
  if(!secret)return send(res,503,{error:"not_configured"});
  let raw;
  try {raw=await rawRequest(req);} catch {return send(res,413,{error:"body_too_large"});}
  if(!raw)return send(res,401,{error:"unsigned_body"});
  if(!verifySlackSignature({
    secret,body:raw,
    timestamp:req.headers?.["x-slack-request-timestamp"],
    signature:req.headers?.["x-slack-signature"],
  }))return send(res,401,{error:"invalid_signature"});
  let packet;
  try {packet=JSON.parse(raw);} catch {return send(res,400,{error:"invalid_json"});}
  if(packet.type==="url_verification")return send(res,200,{challenge:packet.challenge});
  if(packet.type!=="event_callback")return send(res,200,{ok:true,skipped:"not_event"});
  const teamId=String(process.env.SLACK_TASK_TEAM_ID||"").trim();
  const slackUserId=String(process.env.SLACK_TASK_OWNER_SLACK_USER_ID||"").trim();
  const ownerEmployeeId=String(process.env.SLACK_TASK_OWNER_EMPLOYEE_ID||"").trim();
  const channels=String(process.env.SLACK_TASK_ALLOWED_CHANNEL_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
  if(!teamId||!slackUserId||!ownerEmployeeId||!channels.length)
    return send(res,503,{error:"slack_task_mapping_not_configured"});
  if(packet.team_id!==teamId)return send(res,403,{error:"unknown_workspace"});
  const task=slackRequestTask(packet.event,{targetUserId:slackUserId,channels,workspaceId:teamId});
  if(!task)return send(res,200,{ok:true,skipped:"not_an_allowed_request"});
  try {
    const sb=admin();
    const {data:owner,error:lookupError}=await sb.from("gw_employees")
      .select("id,tenant_id,user_id,status").eq("id",ownerEmployeeId).maybeSingle();
    if(lookupError||!owner||!owner.user_id||owner.status!=="active")
      return send(res,503,{error:"owner_unavailable"});
    const {error:insertError}=await sb.from("gw_tasks").insert({
      tenant_id:owner.tenant_id,assignee_id:owner.id,created_by:owner.user_id,
      title:task.title,body:"Slackで依頼された業務です。元メッセージを関連URLから確認してください。",
      category:"Slack依頼",priority:task.priority,status:"todo",link:task.link,
      accepted_at:new Date().toISOString(),occ_key:task.key,
    });
    if(insertError?.code==="23505")return send(res,200,{ok:true,duplicate:true});
    if(insertError){console.error("[slack/task-events] insert",insertError.code||"unknown");return send(res,503,{error:"task_insert_failed"});}
    return send(res,200,{ok:true,created:true});
  }catch(e){
    console.error("[slack/task-events]",e?.message||"unknown");
    return send(res,503,{error:"task_insert_failed"});
  }
}
