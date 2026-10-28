// Uploaded originals. All mutations are serialized by review-only SQL RPCs.
import crypto from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {json,readJson} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canRecruit,canOfficeHr,canSeeSalary,canDecideHire} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {mailConfig,sendMail,isEmail} from '../../lib/mail/index.js';
import * as R from '../../lib/hr-pdf-flow.js';
const fail=(status,error)=>{throw Object.assign(new Error(error),{status});};
const take=async q=>{const r=await q;if(r.error)fail(503,'pdf_flow_unavailable');return r.data;};
const rpc=async(sb,name,args)=>{const r=await sb.rpc(name,args);if(r.error)fail(['42P01','42883','PGRST202'].includes(r.error.code)?503:409,'pdf_flow_conflict');return r.data;};
export function createHandler(deps={}){const D={requireUser,gwContext,admin,mailConfig,sendMail,...deps};
return async function handler(req,res){res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
try{
 const user=await D.requireUser(req,res);if(!user)return;const ctx=await D.gwContext(user.id);
 if(!ctx.tenantId||!canSeeSalary(ctx)||!(canRecruit(ctx)||canOfficeHr(ctx)))fail(403,'forbidden');
 if(!R.enabled())return json(res,req.method==='GET'?200:403,{enabled:false,flows:[],error:req.method==='GET'?undefined:'feature_disabled'});
 if(!['GET','POST'].includes(req.method))fail(405,'method_not_allowed');
 const sb=D.admin(),tenant=ctx.tenantId,q=new URL(req.url||'/', 'http://localhost').searchParams,b=req.method==='POST'?await readJson(req):{};
 if(req.method==='GET'&&(q.get('office')==='1'||q.get('scope')==='office')){
  if(!canOfficeHr(ctx))fail(403,'forbidden');
  const fs=await take(sb.from(R.TABLES.flows).select('id,applicant_id,phase,version,accepted_at').eq('tenant_id',tenant).not('accepted_at','is',null).order('accepted_at',{ascending:false}).limit(200));
  const as=fs.length?await take(sb.from('gw_hr_applicants').select('id,name').eq('tenant_id',tenant).in('id',fs.map(f=>f.applicant_id))):[];
  return json(res,200,{enabled:true,flows:fs.map(f=>({applicantId:f.applicant_id,applicantName:as.find(a=>a.id===f.applicant_id)?.name||'',phase:f.phase}))});
 }
 const applicantId=b.applicantId||q.get('applicantId');if(!R.UUID.test(applicantId||''))fail(400,'invalid_applicant');
 const a=await take(sb.from('gw_hr_applicants').select('*').eq('tenant_id',tenant).eq('id',applicantId).maybeSingle());if(!a)fail(404,'not_found');
 let f=await take(sb.from(R.TABLES.flows).select('*').eq('tenant_id',tenant).eq('applicant_id',applicantId).maybeSingle());
 if(!canRecruit(ctx)&&!f?.accepted_at)fail(403,'forbidden');
 const manage=()=>f?.accepted_at?canOfficeHr(ctx):canRecruit(ctx);
 const loadDocs=()=>f?take(sb.from(R.TABLES.docs).select('*').eq('tenant_id',tenant).eq('flow_id',f.id).order('version',{ascending:false})):[];
 const shape=async()=>{
  f=await take(sb.from(R.TABLES.flows).select('*').eq('tenant_id',tenant).eq('applicant_id',applicantId).maybeSingle());
  const docs=await loadDocs(),ds=f?await take(sb.from(R.TABLES.deliveries).select('id,document_id,status,created_at').eq('tenant_id',tenant).eq('flow_id',f.id).order('created_at',{ascending:false}).limit(500)):[];
  const old=!f?await take(sb.from('gw_hr_offers').select('id').eq('tenant_id',tenant).eq('applicant_id',applicantId).limit(1)):[];
  return {enabled:true,applicant:{id:a.id,name:a.name,email:a.email},flow:R.flowView(f),documents:docs.map(d=>{const s=ds.find(x=>x.document_id===d.id);return R.documentView({...d,delivery_id:s?.id,delivery_created_at:s?.created_at,latest_delivery_status:s?.status});}),canStart:!f&&!old.length&&R.eligible(a)&&canRecruit(ctx),startBlockReason:old.length?'既存案内履歴があります。確認付き移行が必要です。':!R.eligible(a)?'採用判断済みの雇用対象者のみ開始できます。':null,canMigrateLegacy:!f&&old.length>0&&R.eligible(a)&&canDecideHire(ctx),canManage:manage(),canResolveDelivery:manage()&&canDecideHire(ctx)};
 };
 if(req.method==='GET')return json(res,200,await shape());
 const act=(action,data={})=>rpc(sb,'gw_hr_pdf_manage',{p_tenant:tenant,p_actor:user.id,p_applicant:applicantId,p_action:action,p_data:data});
 const docs=await loadDocs(),d=docs.find(x=>x.id===b.documentId);
 const current=()=>{if(!d||d.superseded_at||d.revoked_at||d.responded_at||!f||d.id!==(d.kind==='offer'?f.offer_doc_id:f.terms_doc_id))fail(409,'document_not_current');if(['sending','unknown'].includes(d.delivery_state))fail(409,'delivery_unresolved');};
 const bytes=async doc=>{const r=await sb.storage.from(R.BUCKET).download(doc.path);if(r.error||!r.data)fail(503,'pdf_unavailable');const v=Buffer.from(await r.data.arrayBuffer());if(!R.checkPdf(v)||R.hash(v)!==doc.sha256)fail(409,'pdf_hash_mismatch');return v;};
 if(b.action==='file'){
  if(!d)fail(404,'not_found');await bytes(d);const r=await sb.storage.from(R.BUCKET).createSignedUrl(d.path,60,{download:d.filename});if(r.error||!r.data?.signedUrl)fail(503,'pdf_unavailable');return json(res,200,{url:r.data.signedUrl});
 }
 if(!manage())fail(403,'forbidden');
 if(b.action==='create'){if(b.confirmed!==true||!R.eligible(a))fail(409,'not_eligible');await act('start');}
 else if(b.action==='prepareUpload'){
  if(!f||!R.declared(b)||['joined','declined','cancelled'].includes(f.phase)||(b.kind==='offer'&&f.accepted_at)||(b.kind==='terms'&&!f.accepted_at))fail(409,'invalid_upload');
  const path=R.stagingPath(tenant,a.id,b.kind,crypto.randomUUID()),r=await sb.storage.from(R.BUCKET).createSignedUploadUrl(path,{upsert:false});if(r.error)fail(503,'upload_unavailable');return json(res,200,{path,uploadUrl:r.data.signedUrl});
 }
 else if(b.action==='attach'){
  if(!f||!R.declared(b)||!R.validStaging(b.path,tenant,a.id,b.kind)||!['offer_accept','receipt','contract_agree'].includes(b.responseMode)||(b.kind==='offer')!==(b.responseMode==='offer_accept'))fail(400,'invalid_pdf');
  const r=await sb.storage.from(R.BUCKET).download(b.path);if(r.error)fail(503,'pdf_unavailable');const content=Buffer.from(await r.data.arrayBuffer());if(!R.checkPdf(content)||content.length!==b.sizeBytes)fail(400,'invalid_pdf');
  try{const pdf=await PDFDocument.load(content,{ignoreEncryption:false});if(!pdf.getPageCount())fail(400,'invalid_pdf');}catch{fail(400,'invalid_pdf');}
  const path=`${tenant}/pdf-flow/${a.id}/sealed/${crypto.randomUUID()}.pdf`;
  const saved=await sb.storage.from(R.BUCKET).upload(path,content,{contentType:'application/pdf',upsert:false});if(saved.error)fail(503,'pdf_store_failed');
  await act('attach',{expectedVersion:b.expectedVersion,kind:b.kind,responseMode:b.responseMode,path,filename:R.filename(b.fileName),sha256:R.hash(content),size:content.length});
 }
 else if(['previewSend','send'].includes(b.action)){
  if(b.action==='send'){
   if(!R.UUID.test(b.requestKey||'')||b.confirmed!==true)fail(400,'confirmation_required');
   const prior=await take(sb.from(R.TABLES.deliveries).select('id,document_id,flow_id,confirmation_digest,status').eq('tenant_id',tenant).eq('request_key',b.requestKey).maybeSingle());
   if(prior){if(prior.flow_id!==f?.id||prior.document_id!==b.documentId||prior.confirmation_digest!==b.confirmDigest)fail(409,'request_key_conflict');return json(res,200,{...await shape(),delivery:{id:prior.id,status:prior.status,replayed:true}});}
  }
  current();const expiresAt=R.expiry(b.expiresAt),electronicDelivery=R.deliveryEvidence(b.electronicDelivery),cfg=D.mailConfig('recruiting'),origin=R.publicOrigin();
  if(!expiresAt||!electronicDelivery||!origin||!isEmail(a.email))fail(400,'send_details_required');const content=await bytes(d),c=R.confirmation(a,f,d,cfg,expiresAt,electronicDelivery);
  if(b.action==='previewSend')return json(res,200,{confirmation:c});
  if(c.digest!==b.confirmDigest)fail(409,'confirmation_changed');if(!cfg.configured)fail(409,'mail_not_configured');
  const token=crypto.randomBytes(32).toString('hex');const claim=await act('claimSend',{documentId:d.id,requestKey:b.requestKey,confirmation:c,tokenHash:R.hash(token)});
  if(claim.replayed)return json(res,200,{...await shape(),delivery:claim});
  let mail;try{mail=await D.sendMail({purpose:'recruiting',to:c.to,subject:c.subject,replyTo:c.replyTo,text:c.body.replace('{{本人専用URL}}',`${origin}/hr/pdf-response.html#token=${token}`),attachments:[{filename:d.filename,content,contentType:'application/pdf'}]});}catch{mail={status:'unknown'};}
  const status=mail.status==='sent'?'sent':mail.status==='skipped'?'failed':'unknown';
  try{await act('finishSend',{deliveryId:claim.id,status,providerMessageId:mail.providerMessageId||null});}catch{return json(res,202,{delivery:{id:claim.id,status:'unknown'},hint:'送信結果の確認が必要です。自動再送しないでください。'});}
  return json(res,200,{...await shape(),delivery:{id:claim.id,status}});
 }
 else if(b.action==='resolveDelivery'){
  if(!canDecideHire(ctx)||!R.UUID.test(b.deliveryId||'')||!['sent','failed'].includes(b.status)||typeof b.evidence!=='string'||b.evidence.trim().length<10||b.evidence.length>1000)fail(403,'resolution_required');
  await act('resolveDelivery',{deliveryId:b.deliveryId,status:b.status,evidence:b.evidence.trim()});
 }
 else if(['revoke','markReady','markJoined'].includes(b.action)){
  if(b.confirmed!==true)fail(400,'confirmation_required');await act(b.action,{expectedVersion:b.expectedVersion,documentId:b.documentId,reason:b.reason,joinDate:b.joinDate,checks:b.checks});
 }
 else if(['previewLegacyMigration','migrateUnacceptedLegacy'].includes(b.action)){
  if(!canDecideHire(ctx)||!R.UUID.test(b.requestKey||'')||typeof b.reason!=='string'||b.reason.trim().length<10||b.reason.length>1000)fail(403,'migration_confirmation_required');
  const reason=b.reason.trim(),prior=await take(sb.from('gw_hr_pdf_legacy_migrations').select('applicant_id,actor_id,confirmation_digest,reason').eq('tenant_id',tenant).eq('request_key',b.requestKey).maybeSingle());
  if(prior){if(b.action!=='migrateUnacceptedLegacy'||b.confirmed!==true||prior.applicant_id!==a.id||prior.actor_id!==user.id||prior.reason!==reason||prior.confirmation_digest!==b.confirmDigest)fail(409,'request_key_conflict');return json(res,200,{...await shape(),migrationReplayed:true});}
  const p=await rpc(sb,'gw_hr_pdf_preview_legacy_migration',{p_tenant:tenant,p_applicant:a.id});if(!p.eligible)return json(res,409,{error:'migration_blocked',blockers:p.blockers,hint:'承諾・契約・送信結果などの履歴を確認してください。'});
  const c=R.migrationConfirmation(p.snapshot,{tenantId:tenant,actorId:user.id,applicantId:a.id,reason,requestKey:b.requestKey});
  if(b.action==='previewLegacyMigration')return json(res,200,{confirmation:c});
  if(b.confirmed!==true||b.confirmDigest!==c.digest)fail(409,'confirmation_changed');
  await rpc(sb,'gw_hr_pdf_migrate_unaccepted_legacy',{p_tenant:tenant,p_actor:user.id,p_applicant:a.id,p_request_key:b.requestKey,p_digest:c.digest,p_reason:reason,p_expected:p.snapshot,p_confirmed:true});
 }
 else fail(400,'invalid_action');
 return json(res,200,await shape());
}catch(e){return json(res,e.status||500,{error:e.status?e.message:'pdf_flow_error',hint:e.status===503?'PDFフローの準備状態を確認してください。':undefined});}
};}
export default createHandler();
