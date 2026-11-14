import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createMemDb} from './_memdb.mjs';
import {createHandler} from '../api/hr/candidate-documents.js';
import {createHandler as selfHandler} from '../api/my-documents.js';
import * as R from '../lib/hr-candidate-documents.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=id(1),A=id(2),U=id(3),E=id(4),D=id(5),OTHER=id(6);
const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save());
const mem=createMemDb();let user,ctx,downloadHook;
const model=()=>{
 const real=mem.admin();
 return {...real,storage:{from:bucket=>{const api=real.storage.from(bucket);return {...api,download:async path=>{const r=await api.download(path);if(downloadHook)downloadHook();return r;}};}},rpc:async(name,p)=>{
  assert.equal(name,'gw_hr_candidate_document_manage');const input=p.p_data,rows=mem.rows[R.TABLE],a=mem.rows.gw_hr_applicants.find(a=>a.id===p.p_applicant&&a.tenant_id===p.p_tenant);if(!a)return {error:{code:'P0001'}};
  let d=rows.find(d=>d.id===input.documentId);
  if(p.p_action==='attach'){d={id:id(100+rows.length),tenant_id:T,applicant_id:A,kind:input.kind,filename:input.filename,path:input.path,size_bytes:input.size,sha256:input.sha256,version:rows.length+1,status:'draft'};rows.push(d);}
  if(p.p_action==='publish'){if(!d||d.status!=='draft'||a.decision!=='hired'||R.emailOf(a.email)!==input.recipientEmail)return {error:{code:'P0001'}};Object.assign(d,{status:'published',recipient_email:input.recipientEmail,published_at:'2026-11-14T01:00:00Z'});}
  if(p.p_action==='withdraw')d.status='withdrawn';
  return {data:structuredClone(d)};
 }};
};
const api=createHandler({requireUser:async()=>user,gwContext:async()=>ctx,admin:model});
const mine=selfHandler({requireUser:async()=>user,gwContext:async()=>ctx,admin:model,requireMfa:async()=>true});
async function call(h,body={},url='/api/hr/candidate-documents',method='POST'){
 const r={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){if(this.headers['Content-Type']==='application/pdf')this.body=v;else this.body=JSON.parse(v);}};
 await h({method,url,body,headers:{}},r);return r;
}
const post=b=>call(api,{applicantId:A,...b});
function setup(){
 mem.reset();downloadHook=null;user={id:U,email:'person@example.test',email_confirmed_at:'2026-01-01'};ctx={tenantId:T,roles:['owner'],employee:{id:E,user_id:U}};
 mem.rows.gw_hr_applicants=[{id:A,tenant_id:T,name:'架空 候補者',email:user.email,stage:'offer',status:'offer_draft_pending',decision:'hired'}];
 mem.rows[R.TABLE]=[{id:D,tenant_id:T,applicant_id:A,kind:'terms',filename:'条件通知書.pdf',path:`${T}/candidates/${A}/sealed/${D}.pdf`,sha256:R.hash(bytes),size_bytes:bytes.length,status:'draft',version:1}];
 mem.put(R.BUCKET,mem.rows[R.TABLE][0].path,bytes);
}
setup();
const original=structuredClone(mem.rows.gw_hr_applicants);
let r=await post({action:'previewPublish',documentId:D});assert.equal(r.statusCode,200);assert.equal(mem.state.log.length,0,'review never publishes');
assert.equal((await post({action:'publish',documentId:D,confirmDigest:r.body.confirmation.digest})).statusCode,409);
assert.equal((await post({action:'publish',documentId:D,confirmDigest:r.body.confirmation.digest,confirmed:true})).statusCode,200);
assert.deepEqual(mem.rows.gw_hr_applicants,original,'publish never accepts an offer, signs a contract or creates an employee');
ctx={roles:[],employee:null};
r=await call(api,{},'/api/hr/candidate-documents?scope=me','GET');assert.equal(r.body.documents.length,1);assert.equal(r.body.documents[0].path,undefined);assert.equal(r.body.documents[0].recipientEmail,undefined);
r=await call(api,{scope:'me',action:'file',documentId:D});assert.equal(r.statusCode,200);assert.deepEqual(r.body,bytes,'exact original PDF, including seal placement');assert.match(r.headers['Content-Disposition'],/^inline/);assert.ok(mem.rows[R.TABLE][0].viewed_at);assert.deepEqual(mem.rows.gw_hr_applicants,original);
assert.equal((await call(api,{scope:'me',action:'file',documentId:OTHER})).statusCode,404);
user.email='other@example.test';assert.equal((await call(api,{},'/api/hr/candidate-documents?scope=me','GET')).body.documents.length,0);assert.equal((await call(api,{scope:'me',action:'file',documentId:D})).statusCode,404);
user.email='person@example.test';user.email_confirmed_at=null;user.user_metadata={email_confirmed:true};assert.equal((await call(api,{},'/api/hr/candidate-documents?scope=me','GET')).statusCode,403);
setup();ctx={tenantId:T,roles:['recruiter']};assert.equal((await post({action:'prepare',kind:'terms',fileName:'x.pdf',sizeBytes:100})).statusCode,403);
setup();ctx.tenantId=OTHER;assert.equal((await post({action:'previewPublish',documentId:D})).statusCode,404);
setup();let c=(await post({action:'previewPublish',documentId:D})).body.confirmation;mem.rows.gw_hr_applicants[0].email='changed@example.test';assert.equal((await post({action:'publish',documentId:D,confirmDigest:c.digest,confirmed:true})).statusCode,409);
setup();r=await post({action:'previewPublish',documentId:D});await post({action:'publish',documentId:D,confirmDigest:r.body.confirmation.digest,confirmed:true});downloadHook=()=>{mem.rows[R.TABLE][0].status='withdrawn';};assert.equal((await call(api,{scope:'me',action:'file',documentId:D})).statusCode,404,'withdrawal during download is rechecked');
setup();assert.equal((await post({action:'prepare',kind:'terms',fileName:'x.html',sizeBytes:100})).statusCode,400);
const prepared=await post({action:'prepare',kind:'terms',fileName:'外部で作成.pdf',sizeBytes:bytes.length});assert.equal(prepared.statusCode,200);assert.match(prepared.body.path,/\/staging\//);mem.put(R.BUCKET,prepared.body.path,bytes);
r=await post({action:'attach',kind:'terms',fileName:'外部で作成.pdf',sizeBytes:bytes.length,path:prepared.body.path});assert.equal(r.statusCode,200);assert.equal(r.body.document.status,'draft');assert.deepEqual(mem.storageFiles.get(R.BUCKET+'/'+mem.rows[R.TABLE].at(-1).path),bytes);assert.ok(!mem.storageFiles.has(R.BUCKET+'/'+prepared.body.path));
assert.equal((await post({action:'attach',kind:'terms',fileName:'x.pdf',sizeBytes:bytes.length,path:`${OTHER}/candidates/${A}/staging/${D}.pdf`})).statusCode,400);
setup();mem.rows.gw_hr_applicants[0].decision=null;assert.equal((await post({action:'previewPublish',documentId:D})).statusCode,409);
setup();mem.rows[R.TABLE][0].status='published';mem.rows[R.TABLE][0].recipient_email=user.email;mem.rows.gw_hr_applicants[0].email='new@example.test';assert.equal((await call(api,{},'/api/hr/candidate-documents?scope=me','GET')).body.documents.length,0);
mem.rows.gw_employees=[{id:E,tenant_id:T,user_id:U,status:'active'}];mem.rows.gw_hr_applicants[0].employee_id=E;user.email='corporate@example.test';assert.equal((await call(api,{},'/api/hr/candidate-documents?scope=me','GET')).body.documents.length,1,'explicit Office employee/user binding preserves access after address changes');
// Existing member register is scoped to authenticated tenant+employee; private drafts and somebody else's uploads stay hidden.
setup();mem.rows.gw_procedures=[{id:'p',tenant_id:T,employee_id:E,kind:'onboarding',created_at:'2026-01-01'}];
mem.rows.gw_procedure_items=[{id:'i',tenant_id:T,procedure_id:'p',item_key:'doc_resume',title:'履歴書',owner:'employee',required:true,status:'submitted',submitted_at:'2026-01-02'}, {id:'missing',tenant_id:T,procedure_id:'p',item_key:'doc_pension',title:'年金通知書',owner:'employee',required:true,status:'todo'}, {id:'na',tenant_id:T,procedure_id:'p',item_key:'doc_withholding',title:'源泉徴収票',owner:'employee',required:false,status:'na'}, {id:'number',tenant_id:T,procedure_id:'p',item_key:'doc_mynumber',title:'マイナンバー',owner:'employee',required:true,status:'todo'}];
mem.rows.gw_procedure_files=[{id:'self',tenant_id:T,procedure_id:'p',item_id:'i',uploaded_by:U,filename:'履歴書.pdf',mime_type:'application/pdf',storage_path:T+'/p/self.pdf',created_at:'2026-01-01'}, {id:'pending',tenant_id:T,procedure_id:'p',item_id:'i',uploaded_by:U,filename:'途中.pdf',created_at:'2026-01-03'}, {id:'colleague',tenant_id:T,procedure_id:'p',item_id:'i',uploaded_by:OTHER,filename:'代理.pdf',created_at:'2026-01-01'}];
mem.rows.gw_labor_notices=[{id:'published',tenant_id:T,employee_id:E,filename:'条件.pdf',storage_path:T+'/notice.pdf',version:1,published_at:'2026-01-01'}, {id:'private',tenant_id:T,employee_id:E,filename:'社内下書き.pdf',storage_path:T+'/secret.pdf',version:2,published_at:null}];
mem.rows.gw_member_documents=[{id:'manual',tenant_id:T,employee_id:E,uploaded_by:U,filename:'自分のPDF.pdf',storage_path:T+'/manual.pdf'}, {id:'foreign',tenant_id:OTHER,employee_id:E,uploaded_by:U,filename:'別社.pdf'}];
r=await call(mine,{},'/api/my-documents?employeeId='+OTHER,'GET');assert.equal(r.statusCode,200);assert.deepEqual(r.body.uploads.map(x=>x.id),['self','manual']);assert.equal(r.body.checklist.find(x=>x.id==='missing').status,'未提出');assert.equal(r.body.checklist.find(x=>x.id==='na').status,'対象外');assert.ok(!JSON.stringify(r.body).includes('マイナンバー'));assert.deepEqual(r.body.received.map(x=>x.id),['published']);assert.ok(!JSON.stringify(r.body).includes('storage_path'));assert.equal((await call(mine,{},'/api/my-documents?file=1&source=notice&id=private','GET')).statusCode,404);
ctx.employee=null;assert.equal((await call(mine,{},'/api/my-documents','GET')).body.employee,false);
console.log('PASS original PDF upload/publication, verified-email ownership, tenant/salary guards, revoked/stale access, no consent/contract/mail changes; own uploads and required/optional checklist');
