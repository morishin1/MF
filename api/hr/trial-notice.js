// HR trial-period labor conditions Word notice.
// No consent by silence, no inferred employment terms, and no mail on draft/export.
import crypto from "node:crypto";
import {json,readJson} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canRecruit,canDecideHire,canSeeSalary} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
import {gwLog} from "../../lib/gw-audit.js";
import {mailConfig,sendMail,isEmail} from "../../lib/mail/index.js";
import * as W from "../../lib/hr-trial-word.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(res,code,hint,status=409)=>json(res,status,{error:code,hint});
const tables={notice:"gw_hr_trial_notices",delivery:"gw_hr_trial_notice_deliveries"};
const enabled=()=>process.env.HR_TRIAL_NOTICE_ENABLED==="1";
const sendingEnabled=()=>process.env.HR_TRIAL_NOTICE_SEND_ENABLED==="1";
const jstDay=()=>new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
const digestOf=v=>W.hash(JSON.stringify(v));
const take=async(q,label)=>{const r=await q;if(r.error)throw Object.assign(new Error(label),{status:503});return r.data;};

export function createHandler(deps={}){
 const D={requireUser,gwContext,admin,gwLog,mailConfig,sendMail,createTrialDocx:W.createTrialDocx,...deps};
 return async function handler(req,res){
  res.setHeader?.("Cache-Control","no-store");
  res.setHeader?.("Referrer-Policy","no-referrer");
  try{
   const user=await D.requireUser(req,res);if(!user)return;
   const ctx=await D.gwContext(user.id);
   if(!ctx.tenantId||!canRecruit(ctx)||!canSeeSalary(ctx))
    return fail(res,"forbidden","採用条件を確認できる人事担当者のみ操作できます。",403);
   if(!enabled())return json(res,req.method==="GET"?200:403,{enabled:false,error:"feature_disabled"});
   if(!["GET","POST"].includes(req.method))return fail(res,"method_not_allowed","利用できない操作です。",405);
   const q=new URL(req.url||"/","https://example.invalid").searchParams;
   const b=req.method==="POST"?await readJson(req):{};
   const applicantId=b.applicantId||q.get("applicantId");
   if(!UUID.test(applicantId||""))return fail(res,"invalid_applicant","応募者IDが正しくありません。",400);
   const sb=D.admin(),tenant=ctx.tenantId;
   const applicant=await take(sb.from("gw_hr_applicants")
     .select("id,name,email,stage,decision,status,lead_category,offer_type,employment_type,employee_id")
     .eq("tenant_id",tenant).eq("id",applicantId).maybeSingle(),"applicant_unavailable");
   if(!applicant)return fail(res,"not_found","応募者が見つかりません。",404);
   const [flow,company,current]=await Promise.all([
    take(sb.from("gw_hr_pdf_flows").select("id,offer_doc_id,phase,accepted_at")
      .eq("tenant_id",tenant).eq("applicant_id",applicantId).maybeSingle(),"offer_flow_unavailable"),
    take(sb.from("tenants").select("name").eq("id",tenant).maybeSingle(),"company_unavailable"),
    take(sb.from(tables.notice).select("*").eq("tenant_id",tenant).eq("applicant_id",applicantId)
      .order("version",{ascending:false}).limit(1).maybeSingle(),"trial_notice_unavailable")
   ]);
   let offerDoc=null;
   if(flow?.offer_doc_id){
    offerDoc=await take(sb.from("gw_hr_pdf_docs").select("id,kind,revoked_at,superseded_at")
      .eq("tenant_id",tenant).eq("flow_id",flow.id).eq("id",flow.offer_doc_id).maybeSingle(),"offer_document_unavailable");
   }
   const eligible=Boolean(
    applicant.stage==="offer"&&applicant.decision==="hired"&&
    ["executive_employee","part_time"].includes(applicant.offer_type)&&
    !/業務委託|請負|スポット|フリーランス|contractor|freelance/i.test(applicant.employment_type||"")&&
    offerDoc?.kind==="offer"&&!offerDoc.revoked_at&&!offerDoc.superseded_at&&!applicant.employee_id
   );
   const canApprove=canDecideHire(ctx);
   const shape=()=>({
    enabled:true,eligible,canApprove,sendEnabled:sendingEnabled(),
    applicant:{id:applicant.id,name:applicant.name,email:applicant.email},
    companyName:company?.name||"",
    fields:W.previewRows(current?.values_json||{}),
    current:current?{id:current.id,version:current.version,state:current.state,issuedOn:current.issued_on,
      approvedAt:current.approved_at,createdAt:current.created_at,sentAt:current.sent_at}:null,
    blockReason:eligible?null:"内定通知書PDFが発行済みで、採用判断が確定した雇用対象者のみ作成できます。"
   });
   if(req.method==="GET")return json(res,200,shape());
   if(!eligible && !["export"].includes(b.action))
    return fail(res,"not_eligible","採用判断・内定通知書PDFの状態を確認してください。");
   if(b.action==="save"){
    if(!Number.isInteger(b.expectedVersion)||b.expectedVersion!==(current?.version||0))
     return fail(res,"stale_version","表示が古くなっています。再読み込みして確認してください。");
    if((current?.version||0)>=9999)return fail(res,"version_limit","版数の上限に達しました。管理者に確認してください。");
    const values=W.validateNotice(b.values||{});
    const issuedOn=jstDay(),version=(current?.version||0)+1;
    const contentHash=digestOf({applicantId,companyName:company?.name,issuedOn,values});
    const draft=await sb.from(tables.notice).insert({
      tenant_id:tenant,applicant_id:applicantId,applicant_name:applicant.name,
      company_name:company?.name||"",issued_on:issuedOn,values_json:values,
      content_sha256:contentHash,state:"draft",version,created_by:user.id
    }).select("id,version").maybeSingle();
    if(draft.error||!draft.data)
      return fail(res,"save_conflict","保存できませんでした。最新版を読み込み直してください。");
    await D.gwLog({tenantId:tenant,actorId:user.id,action:"hr.trial_notice_draft",target:"applicant:"+applicantId,
      detail:{noticeId:draft.data.id,version}});
    return json(res,200,{ok:true,id:draft.data.id,version,mailSent:false});
   }
   if(!current)return fail(res,"draft_missing","先に書類の内容を入力して保存してください。");
   const word=()=>D.createTrialDocx({
     applicantName:current.applicant_name,companyName:current.company_name,
     issuedOn:String(current.issued_on).slice(0,10),values:current.values_json
   });
   if(b.action==="export"){
    const doc=word();
    if(current.docx_sha256 && current.docx_sha256!==doc.sha256)
      return fail(res,"notice_changed","保存版の内容とWordの内容が一致しません。",409);
    return json(res,200,{filename:doc.filename,mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentBase64:doc.bytes.toString("base64"),sha256:doc.sha256,mailSent:false});
   }
   if(b.action==="approve"){
    if(!canApprove)return fail(res,"forbidden","採用判断権限を持つ責任者のみ確定できます。",403);
    if(current.state!=="draft"||b.confirmed!==true||b.professionalReviewed!==true||
      typeof b.reviewEvidence!=="string"||b.reviewEvidence.trim().length<20||b.reviewEvidence.length>1000)
      return fail(res,"review_required","社労士・法務確認の記録と、責任者の明示承認が必要です。",400);
    const doc=word();
    const updated=await sb.from(tables.notice).update({
      state:"approved",docx_sha256:doc.sha256,approved_by:user.id,
      approved_at:new Date().toISOString(),review_evidence:b.reviewEvidence.trim()
    }).eq("tenant_id",tenant).eq("id",current.id).eq("state","draft").select("id").maybeSingle();
    if(updated.error||!updated.data)return fail(res,"approval_conflict","書類を確定できませんでした。再読み込みしてください。");
    await D.gwLog({tenantId:tenant,actorId:user.id,action:"hr.trial_notice_approved",target:"applicant:"+applicantId,
      detail:{noticeId:current.id,version:current.version,sha256:doc.sha256}});
    return json(res,200,{ok:true,approved:true,mailSent:false});
   }
   if(["previewSend","send"].includes(b.action)){
    if(!canApprove)return fail(res,"forbidden","採用判断権限を持つ責任者のみ送信できます。",403);
    if(!sendingEnabled())return fail(res,"mail_disabled","トライアル通知書の送信は現在無効です。",403);
    if(current.state!=="approved"||!current.approved_at)
      return fail(res,"unapproved_notice","レビュー・責任者承認済みの最新版のみ送れます。");
    if(!isEmail(applicant.email))return fail(res,"invalid_email","応募者に有効なメールアドレスが必要です。",400);
    const doc=word();
    if(current.docx_sha256!==doc.sha256)return fail(res,"notice_changed","承認後の文書が一致しません。");
    const cfg=D.mailConfig("recruiting");
    if(!cfg.configured)return fail(res,"mail_not_configured","採用メールの送信設定を確認してください。");
    const subject="【株式会社エイト】トライアル期間の労働条件通知書";
    const mailBody=applicant.name+" 様\n\nトライアル期間に関する労働条件通知書を添付いたします。内容をご確認ください。\n不明点や条件の相違があれば、ご署名・ご承諾前に採用担当へご連絡ください。\n\nこのメールの送信だけで承諾済みとは扱いません。";
    const digest=digestOf({tenant,applicantId,noticeId:current.id,version:current.version,
      sha256:doc.sha256,to:applicant.email,subject,mailBody});
    const confirmation={to:applicant.email,from:cfg.from,filename:doc.filename,
      version:current.version,subject,body:mailBody,digest};
    if(b.action==="previewSend")return json(res,200,{confirmation,mailSent:false});
    if(b.confirmed!==true||b.confirmDigest!==digest||!UUID.test(b.requestKey||""))
      return fail(res,"confirmation_changed","宛先・文書版・確認内容が変わっています。再確認してください。",409);
    const claim=await sb.from(tables.delivery).insert({
      tenant_id:tenant,notice_id:current.id,applicant_id:applicantId,request_key:b.requestKey,
      confirmation_digest:digest,docx_sha256:doc.sha256,recipient_email:applicant.email,
      created_by:user.id,status:"sending"
    }).select("id,status").maybeSingle();
    if(claim.error||!claim.data){
      const old=await take(sb.from(tables.delivery)
        .select("notice_id,confirmation_digest,status").eq("tenant_id",tenant)
        .eq("request_key",b.requestKey).maybeSingle(),"delivery_unavailable");
      if(old&&old.notice_id===current.id&&old.confirmation_digest===digest)
        return json(res,200,{replayed:true,delivery:{status:old.status},mailSent:old.status==="sent"});
      return fail(res,"delivery_conflict","同じ送信IDの処理があります。再送せず管理者が履歴を確認してください。");
    }
    let sent;
    try{
      sent=await D.sendMail({purpose:"recruiting",to:applicant.email,subject,text:mailBody,
        attachments:[{filename:doc.filename,content:doc.bytes,
          contentType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}]});
    }catch{sent={status:"unknown"};}
    const status=sent?.status==="sent"?"sent":sent?.status==="skipped"?"failed":"unknown";
    const upd=await sb.from(tables.delivery).update({status,provider_message_id:sent?.providerMessageId||null,
      finished_at:new Date().toISOString()}).eq("id",claim.data.id).eq("tenant_id",tenant).eq("status","sending");
    if(upd.error)return json(res,202,{mailSent:false,delivery:{status:"unknown"},
      hint:"配信結果が不明です。自動再送せず管理者が確認してください。"});
    if(status==="sent"){
      await sb.from(tables.notice).update({state:"sent",sent_at:new Date().toISOString()})
        .eq("id",current.id).eq("tenant_id",tenant).eq("state","approved");
    }
    await D.gwLog({tenantId:tenant,actorId:user.id,action:"hr.trial_notice_mail_"+status,
      target:"applicant:"+applicantId,detail:{noticeId:current.id,version:current.version}});
    return json(res,200,{mailSent:status==="sent",delivery:{status},hint:status!=="sent"?
      "配信結果を確認してください。自動再送は行いません。":undefined});
   }
   return fail(res,"invalid_action","未対応の操作です。",400);
  }catch(e){
   const known=/^(invalid_|required_|unknown_notice_field|docx_too_large)/.test(e.message||"");
   return fail(res,known?"invalid_notice":"trial_notice_unavailable",
     known?"未確定または不正な入力があります。すべての条件を確認してください。":"通知書を処理できませんでした。設定・データベース状態を確認してください。",
     known?400:(e.status||503));
  }
 };
}
export default createHandler();
