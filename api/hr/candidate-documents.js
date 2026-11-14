import crypto from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {json,readJson} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canRecruit,canOfficeHr,canSeeSalary} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import * as R from '../../lib/hr-candidate-documents.js';
const fail=(status,error,hint)=>{throw Object.assign(new Error(error),{status,hint});};
const take=async q=>{const r=await q;if(r.error)fail(503,'not_ready','書類のアップロード・公開は現在準備中です。');return r.data;};
export function createHandler(deps={}){const D={requireUser,gwContext,admin,...deps};return async(req,res)=>{
 res.setHeader('Cache-Control','private,no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
 try{
  const user=await D.requireUser(req,res);if(!user)return;
  if(!['GET','POST'].includes(req.method))return json(res,405,{error:'method_not_allowed'});
  const q=new URL(req.url||'/', 'http://localhost').searchParams,b=req.method==='POST'?await readJson(req):{},sb=D.admin();
  if(q.get('scope')==='me'||b.scope==='me'){
   if(!R.verifiedEmail(user))fail(403,'verified_email_required','メールアドレスの確認が済んだアカウントでログインしてください。');
   const mine=await R.readMine(sb,user);if(!mine.ready)fail(503,'not_ready','書類を取得できません。時間をおいて再読み込みしてください。');
   if(req.method==='GET')return json(res,200,{email:mine.email,documents:mine.documents.map(d=>{const {recipientEmail,...out}=R.shape(d);return out;})});
   if(b.action!=='file')fail(400,'invalid_action');
   let d=mine.documents.find(d=>d.id===b.documentId);if(!d)fail(404,'not_found');
   const bytes=await original(sb,d);
   // ダウンロード中の公開停止・宛先変更も再検査する。
   const check=await R.readMine(sb,user);d=check.ready&&check.documents.find(x=>x.id===d.id&&x.sha256===d.sha256);
   if(!d)fail(404,'not_found');
   const viewed=await sb.from(R.TABLE).update({viewed_at:new Date().toISOString()}).eq('id',d.id).eq('tenant_id',d.tenant_id).eq('status','published').is('viewed_at',null).select('id');
   if(viewed.error)fail(503,'view_unavailable');
   res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
   res.setHeader('Content-Disposition',`${b.download===true?'attachment':'inline'}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(d.filename)}`);res.statusCode=200;return res.end(bytes);
  }
  const ctx=await D.gwContext(user.id);if(!ctx.tenantId||!canSeeSalary(ctx)||!(canRecruit(ctx)||canOfficeHr(ctx)))fail(403,'forbidden','書類を管理する権限がありません。');
  const id=b.applicantId||q.get('applicantId');if(!R.UUID.test(id||''))fail(400,'invalid_applicant');
  const a=await take(sb.from('gw_hr_applicants').select('id,tenant_id,name,email,stage,status,decision').eq('tenant_id',ctx.tenantId).eq('id',id).maybeSingle());if(!a)fail(404,'not_found');
  const docs=await take(sb.from(R.TABLE).select('*').eq('tenant_id',ctx.tenantId).eq('applicant_id',id).order('created_at',{ascending:false}).limit(200));
  const active=!['passed','declined','position_closed','done'].includes(a.status);
  if(req.method==='GET')return json(res,200,{ready:true,applicant:{id:a.id,name:a.name,email:a.email},documents:docs.map(R.shape),canUpload:active,canPublish:active&&a.decision==='hired'&&Boolean(R.emailOf(a.email)),portalUrl:'/contracts.html'});
  const d=docs.find(d=>d.id===b.documentId),rpc=async(action,data)=>{
   const r=await sb.rpc('gw_hr_candidate_document_manage',{p_tenant:ctx.tenantId,p_actor:user.id,p_applicant:id,p_action:action,p_data:data});
   if(r.error)fail(['42P01','42883','PGRST202'].includes(r.error.code)?503:409,'document_changed','書類・宛先・採用判断が更新されています。最新の状態を確認してください。');return r.data;
  };
  if(b.action==='file'){if(!d)fail(404,'not_found');const bytes=await original(sb,d);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(d.filename)}`);res.statusCode=200;return res.end(bytes);}
  if(!active&&b.action!=='withdraw')fail(409,'closed','選考が終了しています。履歴から確認してください。');
  if(b.action==='prepare'){
   if(!R.validUpload(b))fail(400,'invalid_pdf','5MB以下のPDFを選んでください。');
   const path=`${ctx.tenantId}/candidates/${id}/staging/${crypto.randomUUID()}.pdf`,r=await sb.storage.from(R.BUCKET).createSignedUploadUrl(path,{upsert:false});
   if(r.error||!r.data?.signedUrl)fail(503,'upload_unavailable');return json(res,200,{path,uploadUrl:r.data.signedUrl});
  }
  if(b.action==='attach'){
   const prefix=`${ctx.tenantId}/candidates/${id}/staging/`,suffix=typeof b.path==='string'&&b.path.startsWith(prefix)?b.path.slice(prefix.length):'';
   if(!R.validUpload(b)||!suffix.endsWith('.pdf')||!R.UUID.test(suffix.slice(0,-4)))fail(400,'invalid_pdf');
   const r=await sb.storage.from(R.BUCKET).download(b.path);if(r.error||!r.data)fail(400,'missing_file');const bytes=Buffer.from(await r.data.arrayBuffer());
   if(bytes.length!==b.sizeBytes||bytes.subarray(0,5).toString()!=='%PDF-')fail(400,'invalid_pdf');
   try{const p=await PDFDocument.load(bytes,{ignoreEncryption:false});if(!p.getPageCount())fail(400,'invalid_pdf');}catch{fail(400,'invalid_pdf','開けるPDFを選んでください。パスワード付きPDFは登録できません。');}
   const path=`${ctx.tenantId}/candidates/${id}/sealed/${crypto.randomUUID()}.pdf`;
   const saved=await sb.storage.from(R.BUCKET).upload(path,bytes,{contentType:'application/pdf',upsert:false});if(saved.error)fail(503,'save_failed');
   let doc;try{doc=await rpc('attach',{kind:b.kind,filename:R.cleanFilename(b.fileName),path,size:bytes.length,sha256:R.hash(bytes)});}catch(e){await sb.storage.from(R.BUCKET).remove([path]);throw e;}
   await sb.storage.from(R.BUCKET).remove([b.path]);return json(res,200,{ok:true,document:R.shape(doc)});
  }
  if(['previewPublish','publish'].includes(b.action)){
   if(!d||d.status!=='draft'||a.decision!=='hired'||!R.emailOf(a.email))fail(409,'publish_unavailable','代表の採用判断・本人のメールアドレス・未公開のPDFを確認してください。');
   await original(sb,d);const digest=R.publicationDigest(a,d);
   if(b.action==='previewPublish')return json(res,200,{confirmation:{...R.shape(d),name:a.name,email:R.emailOf(a.email),digest}});
   if(b.confirmed!==true||b.confirmDigest!==digest)fail(409,'confirmation_changed','公開する本人とPDFをもう一度確認してください。');
   await rpc('publish',{documentId:d.id,sha256:d.sha256,recipientEmail:R.emailOf(a.email)});return json(res,200,{ok:true});
  }
  if(b.action==='withdraw'){
   if(!d||d.status!=='published'||b.confirmed!==true)fail(409,'confirmation_required');
   await rpc('withdraw',{documentId:d.id});return json(res,200,{ok:true});
  }
  fail(400,'invalid_action');
 }catch(e){return json(res,e.status||500,{error:e.status?e.message:'documents_unavailable',hint:e.hint||'書類を取得できません。再読み込みしてください。'});}
};}
async function original(sb,d){
 const prefix=`${d.tenant_id}/candidates/${d.applicant_id}/sealed/`;
 if(!d.path?.startsWith(prefix))fail(409,'invalid_path');
 const r=await sb.storage.from(R.BUCKET).download(d.path);if(r.error||!r.data)fail(404,'missing_file');
 const bytes=Buffer.from(await r.data.arrayBuffer());if(bytes.length!==d.size_bytes||R.hash(bytes)!==d.sha256)fail(409,'file_changed','保存されているPDFを確認してください。');return bytes;
}
export default createHandler();
