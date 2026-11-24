import { canAccessEightEngerDirectory } from "./sales-enger-scope.js";
import { inChunks } from "./sales-proposals-db.js";
import { membershipFor } from "./enger-agent-role.js";
import { isEmail } from "./mail/index.js";
import { notify } from "./notify.js";
import { salesMailConfig, deliverSalesMail } from "./sales-mail.js";
import { notifySlack } from "./slack.js";

export const REACTION_EVENT = "proposal.reacted";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const receiptTable = "gw_sales_reaction_deliveries";
const fields = "id,side,result,reason_label,wishes,memo,slots,answered_at,recorded_at,proposed_at,message_id,job_no,job_title,company,contact_name";
const channels = ["bell","mail","slack"];

export function validReaction(eventId, sourceId, reactionId) {
  return uuid.test(sourceId) && uuid.test(reactionId) && eventId === "enger:reaction:" + reactionId;
}
export function parseJobNumber(value) {
  const match = /^(?:J-)?(\d+)$/i.exec(String(value ?? "").trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}
export const jobLabel = value => value == null ? "案件番号未登録" : "J-" + String(value).padStart(6,"0");

export async function jobNumbers(sb, ctx, { ids, number = null }) {
  if (!canAccessEightEngerDirectory(ctx)) return { data: [] };
  const rpc = part => sb.rpc("gw_sales_proposal_job_numbers",{p_tenant:ctx.tenantId,p_ids:part,p_job_no:number});
  if (ids) return inChunks(ids,rpc,100);
  const rows = [];
  for (let start=0; ; start+=500) {
    const result = await rpc(null).range(start,start+499);
    if (result.error) return result;
    rows.push(...result.data);
    if (result.data.length < 500) return { data:rows };
  }
}

const date = time => time ? new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",dateStyle:"medium",timeStyle:"short"}).format(new Date(time)) + " JST" : "未取得";
const singleLine = value => String(value || "").replace(/[\r\n\t]+/g," ").trim();
export function originalMail(id) {
  const match = /^<?([^\s<>@]+@[^\s<>@]+)>?$/.exec(String(id || "").trim());
  return match ? "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent("rfc822msgid:" + match[1]) : null;
}
export function reactionMessage(r,salesId) {
  const no = jobLabel(r.job_no), title = singleLine(r.job_title) || "案件名未登録";
  const result = r.result === "pass" ? "見送り" : "興味あり";
  const side = r.side === "job" ? "案件側" : "人材側";
  const summary = r.result === "pass" ? "見送り理由："+(r.reason_label || "理由未取得") : "確認ポイント／希望条件："+(r.wishes || "なし");
  const path = "/sales/proposals.html?id=" + encodeURIComponent(salesId);
  const link = "https://gw.8grp.co.jp" + path;
  const subject = "【案件番号："+no+"】ご提案リアクションのご共有（"+result+"）／"+title;
  const text = [no+" ／ "+title, "回答結果："+result, summary, "回答側："+side, "企業："+(r.company || "未登録"),
    "先方窓口："+(r.contact_name || "未登録"), "提案日："+date(r.proposed_at), "回答日時："+date(r.answered_at),
    "補足メモ："+(r.memo || "なし"), r.slots?.length ? "面談希望日時："+r.slots.join("、") : null,
    "提案詳細："+link, "提案メール："+(originalMail(r.message_id) || "提案メール未特定")].filter(Boolean).join("\n");
  const next = r.slots?.length ? "面談候補日の確認" : singleLine(r.wishes) || "詳細確認";
  const action = r.result==="pass" ? "理由："+(r.reason_label || "理由未取得") : "要対応："+next;
  const noticeTitle = "【"+result+"】["+no+"] "+title+"（"+action+"）";
  const noticeBody = [side, "企業："+(r.company||"未登録"), "先方窓口："+(r.contact_name||"未登録"),
    summary,"補足メモ："+(r.memo||"なし"),r.slots?.length ? "面談希望日時："+r.slots.join("、") : null,
    "提案メール："+(originalMail(r.message_id)||"提案メール未特定")].filter(Boolean).join("\n");
  return {subject,text,path,link,noticeTitle,noticeBody};
}

export async function internalReactionAccess(sb,ctx) {
  if (!canAccessEightEngerDirectory(ctx) || ctx.employee?.status !== "active" || !uuid.test(ctx.reactionUserId)) return false;
  const member=await membershipFor(sb,ctx.reactionUserId);
  return !member || (member.status==="active" && member.membership_type==="internal" && !member.partner_organization_id);
}

export async function readReactions(sb,ctx,p) {
  if (!canAccessEightEngerDirectory(ctx) || p.source_system !== "enger" || !uuid.test(p.source_proposal_id)) return { data:[] };
  try {
    if (!await internalReactionAccess(sb,ctx)) return {data:[]};
  } catch { return {error:{code:"scope_unavailable",message:"回答の閲覧権限を確認できません。"}}; }
  const [facts,receipts] = await Promise.all([
    sb.schema("enger").from("dx2_proposal_email_reactions").select(fields).eq("proposal_id",p.source_proposal_id).order("recorded_at",{ascending:false}),
    sb.from(receiptTable).select("reaction_id,channel,status").eq("tenant_id",ctx.tenantId).eq("proposal_id",p.id),
  ]);
  if (facts.error || receipts.error) return {error:facts.error || receipts.error};
  const delivered = new Map();
  for (const row of receipts.data) {
    if (!delivered.has(row.reaction_id)) delivered.set(row.reaction_id,{});
    delivered.get(row.reaction_id)[row.channel]=row.status;
  }
  return { data:facts.data.map(({message_id,...fact})=>({...fact,mailLink:originalMail(message_id),delivery:delivered.get(fact.id)||{}})) };
}

// Reserve before external I/O. A timeout after acceptance requires manual reconciliation.
async function deliverChannel(sb,key,channel,unavailable,send) {
  const base = { ...key,channel };
  const ledger = () => sb.from(receiptTable);
  const where = query => query.eq("tenant_id",key.tenant_id).eq("reaction_id",key.reaction_id).eq("channel",channel);
  const {error:insertError} = await ledger().insert(base);
  if (insertError && insertError.code !== "23505") throw insertError;
  const status = unavailable || "sending";
  const {data:claimed,error} = await where(ledger().update({status,updated_at:new Date().toISOString()}))
    .in("status",["pending","not_configured","unassigned"]).select("channel");
  if (error) throw error;
  if (!claimed.length || unavailable) return;
  let finalStatus;
  try { finalStatus = await send(); } catch { finalStatus = channel==="bell" ? "pending" : "unknown"; }
  const write = await where(ledger().update({status:finalStatus,updated_at:new Date().toISOString()})).eq("status","sending");
  if (write.error) throw write.error;
  if (finalStatus === "pending") throw Error("notification_pending");
}

export async function acceptReaction(sb,tenantId,v) {
  if (!canAccessEightEngerDirectory({tenantId})) return {error:"reaction_scope"};
  const found = await sb.from("gw_sales_proposals").select("id,sales_owner_id,archived_at").eq("tenant_id",tenantId)
    .eq("source_system","enger").eq("source_proposal_id",v.proposal.id).maybeSingle();
  if (found.error || !found.data) return {error:"reaction_proposal_pending"};
  const p = found.data;
  const [fact,source] = await Promise.all([
    sb.schema("enger").from("dx2_proposal_email_reactions").select(fields).eq("id",v.reactionId).eq("proposal_id",v.proposal.id).maybeSingle(),
    sb.schema("enger").from("proposals").select("deleted_at").eq("id",v.proposal.id).maybeSingle(),
  ]);
  if (fact.error || !fact.data || !fact.data.answered_at || source.error) return {error:"reaction_unavailable"};
  if (!source.data || source.data.deleted_at || p.archived_at) return {result:"skipped",proposalId:p.id,warnings:[]};
  const lookup = p.sales_owner_id ? await sb.from("gw_employees").select("id,email,user_id").eq("tenant_id",tenantId)
    .eq("id",p.sales_owner_id).eq("status","active").maybeSingle() : {data:null};
  if (lookup.error) return {error:"reaction_owner_unavailable"};
  let owner=lookup.data;
  if (owner) {
    try {
      if (!await internalReactionAccess(sb,{tenantId,employee:{status:"active"},reactionUserId:owner.user_id})) owner=null;
    } catch { return {error:"reaction_owner_unavailable"}; }
  }
  const mail = salesMailConfig(), webhook = String(process.env.SALES_SLACK_WEBHOOK_URL || "").trim();
  const msg = reactionMessage(fact.data,p.id);
  const key = {tenant_id:tenantId,proposal_id:p.id,reaction_id:v.reactionId};
  const slackText = value => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const unavailable = {bell:!owner && "unassigned",mail:!owner ? "unassigned" : (!isEmail(owner.email||"") || !mail.configured) && "not_configured",slack:!webhook && "not_configured"};
  const send = {
    bell:async ()=>(await notify([{tenantId,employeeId:owner.id,kind:"sales",title:msg.noticeTitle,body:msg.noticeBody,link:msg.path,dedupeKey:v.eventId}],{replace:false})).error ? "pending" : "sent",
    mail:async ()=>(await deliverSalesMail({to:owner.email,subject:msg.subject,text:msg.text},mail)).status==="accepted" ? "sent" : "unknown",
    slack:async ()=>(await notifySlack({webhook,text:slackText(msg.noticeTitle),lines:[slackText(msg.noticeBody),msg.link]})).sent ? "sent" : "unknown",
  };
  const deliveries = await Promise.allSettled(channels.map(channel=>deliverChannel(sb,key,channel,unavailable[channel],send[channel])));
  if (deliveries.some(item=>item.status==="rejected")) return {error:"reaction_delivery_pending"};
  return {result:"updated",proposalId:p.id,warnings:[],suppressNotifications:true};
}
