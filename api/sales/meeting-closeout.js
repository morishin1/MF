// Closes a Sales-led 30-minute meeting only after authenticated, confirmed
// email delivery. Account issuance occurs at closing when a real recipient exists.
// Never save plaintext temporary passwords in DB, logs or URL.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope,isInternalEmail,logPortalEvent} from "../../lib/sales-company-portal-db.js";
import {formatCompanyNumber} from "../../lib/sales-company-number.js";
import {portalBaseUrl,isCompanyIdOnlyEmail,isReservedCompanyLoginEmail} from "../../lib/sales-company-portal.js";
import {sendMail,mailConfig} from "../../lib/mail/index.js";
import {gwLog} from "../../lib/gw-audit.js";
import {closeoutInput,newMeetingPassword,proposalMail} from "../../lib/sales-meeting-closeout.js";
export const config={maxDuration:60};
const SESSIONS="gw_sales_live_meeting_sessions",CLOSEOUTS="gw_sales_meeting_closeouts";
const fail=(res,code,hint,status=409)=>json(res,status,{error:code,hint});
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(!["GET","POST"].includes(req.method))return methodNotAllowed(res,["GET","POST"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return json(res,403,{error:"forbidden"});
 const data=req.method==="POST"?await readJson(req):{};
 const p=new URL(req.url||"/","http://localhost").searchParams;
 const companyId=req.method==="GET"?p.get("companyId"):data.companyId;
 const sessionId=req.method==="GET"?p.get("sessionId"):data.sessionId;
 if(!isUuid(companyId)||!isUuid(sessionId))return fail(res,"invalid_session","企業IDと商談IDを確認してください。",400);
 const db=admin(),scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return fail(res,scope.error,"この企業の商談を操作する権限がありません。",scope.status||403);
 const [session,company,directory,existing]=await Promise.all([
  db.from(SESSIONS).select("id,tenant_id,company_id,stage,status,selected_keys,started_at")
   .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("id",sessionId).maybeSingle(),
  db.schema("enger").from("companies").select("id,name,company_no,deleted_at")
   .eq("id",companyId).is("deleted_at",null).maybeSingle(),
  db.schema("enger").from("dx2_sales_company_directory_for_tenant")
   .select("id,needs_contact_review,directory_hidden_at")
   .eq("tenant_id",ctx.tenantId).eq("id",companyId).maybeSingle(),
  db.from(CLOSEOUTS).select("id,mail_status,recipient_email,outcome,next_action,next_due,mail_sent_at")
   .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("session_id",sessionId).maybeSingle()
 ]);
 if(session.error||company.error||directory.error||existing.error)
  return fail(res,"closeout_unavailable","商談・企業情報を照合できませんでした。",503);
 if(!session.data||!company.data||!directory.data)return fail(res,"not_found","商談または企業情報が見つかりません。",404);
 if(req.method==="GET")
  return json(res,200,{sessionId,stage:session.data.stage,status:session.data.status,
   mailConfigured:mailConfig("portal").configured,mailReason:mailConfig("portal").reason,
   companyNo:formatCompanyNumber(company.data.company_no),
   portalUrl:portalBaseUrl()+"/business/portal?companyId="+encodeURIComponent(companyId),
   closeout:existing.data?{status:existing.data.mail_status,outcome:existing.data.outcome,
    nextAction:existing.data.next_action,nextDue:existing.data.next_due,
    sentAt:existing.data.mail_sent_at,recipientEmail:existing.data.recipient_email}:null});
 if(data.confirmed!==true)return fail(res,"confirmation_required","宛先・提案内容を確認してから送信してください。",400);
 if(directory.data.needs_contact_review||directory.data.directory_hidden_at)
  return fail(res,"company_blocked","連絡禁止・非表示の企業にはメール送信できません。");
 if(session.data.status==="closed"&&existing.data?.mail_status==="sent")
  return json(res,200,{ok:true,alreadySent:true});
 if(session.data.stage!==5||session.data.status!=="active")
  return fail(res,"closing_step_required","最終ステップまで進めてから送信してください。");
 if(existing.data)return fail(res,"closeout_exists",
  existing.data.mail_status==="sent"?"案内メールは送信済みです。":"処理中または送信失敗の履歴があります。管理者が確認してください。");
 const validated=closeoutInput(data);
 if(validated.error)return json(res,400,validated);
 const input=validated.value;
 if(isReservedCompanyLoginEmail(input.email))return fail(res,"id_only_mail_forbidden",
   "企業ID専用の内部アドレスへ案内メールは送信できません。実在する宛先を指定してください。",400);
 const configured=mailConfig("portal");
 if(!configured.configured)return fail(res,"mail_unavailable",
   "メール送信は未設定です："+(configured.reason||"送信元設定を確認してください。"),503);
 const internal=await isInternalEmail(db,input.email);
 if(internal===null)return fail(res,"recipient_check_failed","送信先を確認できませんでした。",503);
 if(internal)return fail(res,"internal_account","社内のメールアドレスには企業用ログインを発行できません。");
 const members=await db.schema("enger").from("dx2_company_portal_members")
  .select("id,tenant_id,company_id,email,auth_user_id,disabled_at").eq("email",input.email).limit(2);
 if(members.error)return fail(res,"member_check_failed","既存の企業アカウントを確認できません。",503);
 if((members.data||[]).some(m=>m.company_id!==companyId||m.tenant_id!==ctx.tenantId||m.disabled_at||!m.auth_user_id))
  return fail(res,"member_review_required","別法人・停止・招待中の企業アカウントがあります。確認してください。");
 // STEP 4 may have issued a company-number-only account already.
 // A later optional proposal email must not create a second Auth member,
 // which would disable numeric company-ID login for the customer.
 let already=(members.data||[])[0]||null;
 if(!already){
  const scoped=await db.schema("enger").from("dx2_company_portal_members")
    .select("id,tenant_id,company_id,email,auth_user_id,disabled_at")
    .eq("tenant_id",ctx.tenantId).eq("company_id",companyId)
    .is("disabled_at",null).not("auth_user_id","is",null).limit(3);
  if(scoped.error)return fail(res,"member_check_failed",
    "企業専用ログインの状態を確認できません。",503);
  const idOnly=(scoped.data||[]).filter(m=>isCompanyIdOnlyEmail(m.email));
  if(idOnly.length&&scoped.data?.length!==1)
    return fail(res,"id_only_member_review_required",
      "複数の企業アカウントがあります。番号ログインと案内先を確認してください。");
  if(idOnly.length===1)already=idOnly[0];
 }
 if(already){
  const info=await db.auth.admin.getUserById(already.auth_user_id);
  const au=info.data?.user;
  if(info.error||!au||au.email?.toLowerCase()!==already.email||
     !Array.isArray(au.app_metadata?.apps)||!au.app_metadata.apps.includes("business"))
    return fail(res,"account_review_required","企業ログインの認証設定を確認してください。");
 }
 // Confirm the company-specific published shortlist, never email hidden items.
 const selected=Array.isArray(session.data.selected_keys)?session.data.selected_keys:[];
 const offered=Array.isArray(data.offeredKeys)?data.offeredKeys:selected;
 if(offered.length>30||offered.some(key=>typeof key!=="string"||!selected.includes(key))||
    new Set(offered).size!==offered.length)
  return fail(res,"invalid_offered_candidates","商談で紹介した公開候補を確認してください。",400);
 // The enterprise now selects and submits offers on ENGER, not on this
 // staff-only navigator. A real submitted company offer satisfies the outcome
 // only when tenant/company and the current meeting start time agree.
 let companyOfferCount=0;
 if(input.outcome==="offer"&&!offered.length){
  const companyOffers=await db.schema("enger").from("dx2_company_portal_offers")
    .select("id").eq("tenant_id",ctx.tenantId).eq("company_id",companyId)
    .gte("created_at",session.data.started_at).limit(30);
  if(companyOffers.error)
   return fail(res,"company_offers_unavailable","企業からのオファーを確認できませんでした。",503);
  companyOfferCount=(companyOffers.data||[]).length;
  if(!companyOfferCount)
   return fail(res,"offer_candidate_required","企業専用ページからオファーを送信してもらうか、商談結果を「継続検討」に変更してください。",400);
 }
 const shares=await db.schema("enger").from("dx2_company_sales_shortlist")
  .select("item_type,candidate_id,job_id").eq("tenant_id",ctx.tenantId)
  .eq("company_id",companyId).eq("status","published").limit(100);
 if(shares.error)return fail(res,"published_candidates_unavailable","公開候補の照合に失敗しました。",503);
 const pub=new Set((shares.data||[]).map(r=>r.item_type+":"+(r.item_type==="talent"?r.candidate_id:r.job_id)));
 if(selected.some(key=>!pub.has(key)))return fail(res,"candidate_changed","公開候補が変更されています。再確認してください。");
 const claimed=await db.from(CLOSEOUTS).insert({
  tenant_id:ctx.tenantId,company_id:companyId,session_id:sessionId,
  recipient_email:input.email,contact_name:input.name,outcome:input.outcome,
  next_action:input.nextAction,next_due:input.nextDue,offered_keys:offered,
  created_by:user.id,mail_status:"preparing"
 }).select("id").single();
 if(claimed.error)return fail(res,"closeout_claim_failed","別の担当者がクロージングを処理中です。",409);
 let password=null,member=already,newAuthId=null,mailDelivered=false;
 try{
  if(!already){
   password=newMeetingPassword();
   const created=await db.auth.admin.createUser({
    email:input.email,password,email_confirm:true,
    app_metadata:{apps:["business"]},
    user_metadata:{display_name:input.name||"企業ご担当者",company_id:companyId}
   });
   if(created.error||!created.data?.user?.id)throw Error("auth_account_unavailable");
   newAuthId=created.data.user.id;
   const add=await db.schema("enger").from("dx2_company_portal_members").insert({
    tenant_id:ctx.tenantId,company_id:companyId,email:input.email,
    display_name:input.name||"企業ご担当者",role:"admin",
    auth_user_id:newAuthId,registered_at:new Date().toISOString(),created_by:user.id
   }).select("id").single();
   if(add.error||!add.data)throw Error("portal_member_unavailable");
   member=add.data;
  }
  const companyNo=formatCompanyNumber(company.data.company_no);
  const activeMembers=await db.schema("enger").from("dx2_company_portal_members")
    .select("id").eq("tenant_id",ctx.tenantId).eq("company_id",companyId)
    .is("disabled_at",null).not("auth_user_id","is",null).limit(3);
  if(activeMembers.error)throw Error("account_count_unavailable");
  // Multiple active people cannot safely use one shared corporate number as
  // the login identifier; the individual email must be used instead.
  const loginId=activeMembers.data?.length===1?companyNo:input.email;
  const target="/business/portal?companyId="+encodeURIComponent(companyId);
  const url=portalBaseUrl()+"/business/login?next="+encodeURIComponent(target);
  const content=proposalMail({companyName:company.data.name,companyId,companyNo:loginId,
    recipientName:input.name,portalUrl:url,password,itemsCount:Math.max(offered.length,companyOfferCount),action:input.nextAction});
  const sent=await sendMail({purpose:"portal",to:input.email,subject:content.subject,text:content.text});
  if(sent.status!=="sent")throw Error("mail_delivery_"+sent.status);
  mailDelivered=true;
  const saved=await db.from(CLOSEOUTS).update({mail_status:"sent",
    mail_provider:sent.provider,mail_message_id:sent.providerMessageId,
    portal_login_id:loginId,mail_sent_at:new Date().toISOString()})
    .eq("id",claimed.data.id).eq("tenant_id",ctx.tenantId);
  if(saved.error)throw Error("mail_record_failed");
  const sessionSave=await db.from(SESSIONS).update({
    status:"closed",closed_at:new Date().toISOString(),selected_keys:offered,
    closeout_outcome:input.outcome,closeout_next_action:input.nextAction,closeout_next_due:input.nextDue,
    updated_by:user.id,updated_at:new Date().toISOString()
  }).eq("id",sessionId).eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("status","active")
    .select("id").maybeSingle();
  if(sessionSave.error||!sessionSave.data)
    return fail(res,"post_mail_session_sync_failed",
      "メールは送信済みですが商談完了の保存を確認できません。再送せずSales管理者が履歴を確認してください。",503);
  if(password)await logPortalEvent(db,{companyId,memberId:member.id,actorKind:"staff",actorUserId:user.id,
    action:"member.temp_password",detail:{method:"meeting_closeout",passwordStored:false}});
  const link=await db.from("gw_sales_company_links").select("company_id")
    .eq("tenant_id",ctx.tenantId).eq("source_system","enger")
    .eq("source_company_id",companyId).limit(2);
  if(!link.error&&link.data?.length===1){
    await db.from("gw_sales_events").insert({
      tenant_id:ctx.tenantId,company_id:link.data[0].company_id,
      event_key:"meeting",channel:"email",
      label:"30分商談：提案案内を送信",
      detail:input.nextAction.slice(0,250),created_by:user.id
    });
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.meeting_closeout_sent",
    target:"enger_company:"+companyId,detail:{sessionId,recipient:input.email,
    outcome:input.outcome,nextAction:input.nextAction,nextDue:input.nextDue}});
  return json(res,200,{ok:true,mailSent:true,companyId,sessionId,loginId,
   loginUrl:url,oneTimePassword:password,existingAccount:Boolean(already),
   nextAction:input.nextAction});
 }catch(e){
  // If no mail has been delivered, never claim success. No plaintext secret
  // is written to database even on failures.
  // A provider-accepted email may not be safely sent again: keep it in
  // reconciliation state rather than overwriting success with "failed".
  if(!mailDelivered)await db.from(CLOSEOUTS).update({mail_status:"failed"})
   .eq("id",claimed.data.id).eq("tenant_id",ctx.tenantId);
  if(newAuthId&&String(e?.message||"").includes("portal_member_unavailable"))
   await db.auth.admin.deleteUser(newAuthId).catch(()=>{});
  return fail(res,"closeout_failed","アカウント作成・メール送信を確認できませんでした。再送や再発行は管理者が確認してください。",503);
 }
}
