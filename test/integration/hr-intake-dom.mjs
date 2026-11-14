// Full DOM/event execution with synthetic API responses; this is not visual browser QA.
import fs from 'node:fs';import assert from 'node:assert/strict';
import {OFFER_TYPES_PUBLIC} from '../../lib/hr-offer-types.js';
const {JSDOM}=await import(process.env.HR_JSDOM_MODULE||'jsdom');
const repo=new URL('../..',import.meta.url).pathname;
const read=p=>fs.readFileSync(repo+'/'+p,'utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const id='11111111-1111-4111-8111-111111111111',mid='22222222-2222-4222-8222-222222222222';
const person={id,name:'架空 応募者',jobTitle:'営業',source:'自社フォーム',email:'fiction@example.test',createdAt:'2026-11-14T01:23:00Z',updatedAt:'2026-11-14T01:23:00Z',stage:'applied',status:'todo',statusLabel:'未対応',nextActionKey:'detail',note:'',docs:{resume:true,resumeId:'doc1'},offerType:null};
const trial={id:'trial1',applicantId:id,applicantName:person.name,startOn:'2026-11-14',endOn:'2026-11-27',status:'planned',basis:'employment',agreementConfirmed:true,reviewScores:{},kpiDescription:'提案10件'};
const interview={id:'iv1',kind:'casual',memo:'',done:false};
const mail={id:mid,status:'review',subject:'営業への応募',provider:'gmail',provider_message_id:'abcdef0123456789',received_at:person.createdAt,candidate_name_guess:person.name,body_text:'原文 <script>悪い命令</script> fiction@example.test',read:false};
const analysis={mail_id:mid,classification:'application',fields:{name:person.name,email:person.email,jobTitle:'営業'},reason:'応募の明記',state:'review',updated_at:'2026-11-14T00:00:00Z'};
const writes=[],errors=[],pdfRequests=[],revokedUrls=[];let readState=false,offers=[],pdfSeq=0;
const endedPeople=[
 {...person,id:'closed1',status:'passed'}, {...person,id:'closed2',status:'declined',talentCategory:'contractor'},
 {...person,id:'closed3',status:'position_closed',leadCategory:'mugendojo'}, {...person,id:'closed4',status:'done'},
 {...person,id:'closed5',pdfFlow:{phase:'cancelled'}}, {...person,id:'closed6',pdfFlow:{phase:'declined'}},
 {...person,id:'closed7',pdfFlow:{phase:'joined'}}
];
const receivedDoc={id:'contract-pdf',title:'雇用契約書',status:'received'};
const response=()=>({applicant:person,interviews:[{...interview}],timeline:[],offers,salaryVisible:true,offerTypes:OFFER_TYPES_PUBLIC,contract:{ready:true,types:['part_time']}});
const applicationDoc={id:'doc1',applicantId:id,filename:'履歴書.pdf',mimeType:'application/pdf'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function mockApi(path,opts){
 const b=opts?.body;if(b){assert.equal(typeof b,'object','API.api expects a JSON object');writes.push({path,body:b});}
 if(path.startsWith('/api/hr/applicants?'))return {applicants:[{...person},...endedPeople],employees:[],sources:{counts:[]}};
 if(path==='/api/hr/applicant-state'){if(b){readState=true;return {ok:true};}return {states:[{id,unread:!readState,kind:'application'}]};}
 if(path.startsWith('/api/hr/inbox?id='))return {mail};
 if(path.startsWith('/api/hr/inbox'))return b?{ok:true}:{mails:[mail],openCount:1,unreadCount:1};
 if(path==='/api/hr/intake')return b?{ok:true}:{analyses:[analysis],budget:{committed_yen:10,budget_yen:1000}};
 if(path.startsWith('/api/hr/offers/contract?'))return {docs:[receivedDoc],perms:{salary:true}};
 if(path==='/api/hr/trials')return {trials:[trial]};
 return {};
}
const ctx={canDecide:true,me:{userId:'fixture',access:{officeHr:true},gw:{tenantId:'tenant',roles:['owner'],employee:{id:'emp'}}}};
async function page(file,query='',savedCategory=null){
 let html=read(file).replace(/<script[^>]*src=[^>]*><\/script>/g,tag=>tag.includes('hr-modal-ui.js')?'<script>'+read('js/hr-modal-ui.js')+'</script>':'');
 const dom=new JSDOM(html,{url:'http://local.test/'+file+query,runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  if(savedCategory)w.sessionStorage.setItem('hr-applicants-view',JSON.stringify({category:savedCategory}));
  w.URL.createObjectURL=()=>`blob:http://local.test/pdf-${++pdfSeq}`;w.URL.revokeObjectURL=url=>revokedUrls.push(url);
  w.fetch=async(path,opts)=>{pdfRequests.push({path,opts});return {ok:true,blob:async()=>new w.Blob(['%PDF-fixture'],{type:'application/pdf'}),headers:{get:()=>"attachment; filename*=UTF-8''%E6%8E%A1%E7%94%A8%E9%80%9A%E7%9F%A5%E6%9B%B8.pdf"}};};
  w.alert=()=>{};w.confirm=()=>true;w.scrollTo=()=>{};w.prompt=()=>'';
  w.addEventListener('error',e=>errors.push(String(e.error||e.message)));
  w.HRLayout={esc,init:async()=>ctx,allows:()=>true};w.KPLayout={esc,busy:async(_btn,_label,fn)=>fn()};
  w.API={api:mockApi,warm:()=>{},swr:async(_key,fetch,render)=>render(await fetch()),morph:(node,html)=>node.innerHTML=html,
   listHrApplicants:async()=>({applicants:[{...person},...endedPeople],employees:[]}),getHrApplicant:async()=>response(),hrDocuments:async()=>({documents:[{docType:'resume',label:'履歴書',latest:applicationDoc,history:[]}],limits:{}}),
   getToken:async()=>'synthetic-token',hrDocumentUrl:async(doc,download,applicantId)=>{assert.equal(doc,'doc1');assert.equal(applicantId,id);return {url:'https://files.example.test/resume.pdf',mimeType:'application/pdf'};},
   createHrOffer:async b=>{writes.push({path:'offer-create',body:b});person.status='offer_review_pending';offers=[{id:'offer1',offerType:'part_time',status:'draft',respondBy:b.respondBy,offerTerms:{},...b}];return {offer:offers[0]};},
   updateHrOffer:async b=>{writes.push({path:'offer-update',body:b});offers=[{...offers[0],...b}];return {offer:offers[0]};},hrOfferAct:async b=>{writes.push({path:'offer-act',body:b});return {};},
   todayHrInterviews:async()=>({interviews:[]}),hrInterviewAct:async b=>{writes.push({path:'interview',body:b});interview.memo=b.memo;return {};}};
  w.eval(read('js/jst.js'));w.eval(read('js/hr-applicant-list.js'));
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 }});
 if(file==='hr/intake.html')dom.window.eval(read('js/hr-intake-ui.js'));
 await pause(150);return dom;
}
let d=await page('hr/applicants.html'),doc=d.window.document;
assert.deepEqual([...doc.querySelectorAll('#thead th')].map(n=>n.textContent),['','登録日時','応募者','現在の状態','書類','社内メモ','NEXT','担当者']);
assert.match(doc.querySelector('#rows td:nth-child(2)').textContent,/2026\/11\/14 10:23/);
assert.equal(doc.querySelectorAll('.hr-doc-state').length,5);assert.equal(doc.querySelector('#hr-new-count').textContent,'1');
assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,1,'closed applicants hidden by default');
doc.querySelector('[data-category="closed"]').click();assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,endedPeople.length);
doc.querySelector('[data-stage="status:done"]').click();assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,2,'completed status and joined PDF flow');
doc.querySelector('[data-category="active"]').click();
doc.querySelector('.hr-doc-state').click();await pause(100);assert.ok(doc.querySelector('[data-tab="docs"].on'));assert.ok(readState);
const visibleDialogs=()=>[...doc.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(n=>!n.closest('[hidden]'));
assert.equal(visibleDialogs().length,1);const detailBox=doc.querySelector('#hr-detail-box');
assert.equal(d.window.getComputedStyle(detailBox).left,'50%');
assert.ok(Number(d.window.getComputedStyle(detailBox).zIndex)>Number(d.window.getComputedStyle(doc.querySelector('#modal-root .hr-modal-bg')).zIndex),'dialog above backdrop');
await d.window.previewDoc('doc1');await pause(0);assert.equal(visibleDialogs().length,1);assert.ok(doc.querySelector('#modal-root').hidden);assert.match(doc.querySelector('#pdf-preview-root iframe').src,/resume.pdf/);
d.window.HRModalUI.closePdf();await pause(0);assert.equal(doc.querySelector('#modal-root').hidden,false);
// Reproduce the part-time form in the supplied screenshot using only synthetic data.
Object.assign(person,{stage:'offer',status:'offer_draft_pending',offerType:'part_time',contractState:'conditions',employmentType:'パート',joinDate:'2027-01-01',wageType:'時給',wageAmount:1500});
await d.window.refreshDetail();d.window.openOfferForm();await pause(0);
assert.ok(doc.querySelector('#modal-root').hidden);assert.equal(visibleDialogs().length,1);assert.match(doc.querySelector('#action-root h2').textContent,/採用通知書のPDFを作成/);
assert.equal(doc.querySelector('#of-send').textContent,'PDFを作成する');
assert.equal(doc.querySelector('#of-confirm').textContent,'契約書の準備へ進む');
await d.window.submitOfferAndPreview(doc.querySelector('#of-send'));await pause(50);
assert.match(pdfRequests.at(-1).path,/file=previewOffer/);assert.equal(pdfRequests.at(-1).opts.headers.Authorization,'Bearer synthetic-token');
assert.ok(doc.querySelector('#pdf-preview-root iframe'));assert.equal(visibleDialogs().length,1);
assert.equal(writes.filter(w=>w.path==='offer-create').length,1);assert.equal(writes.filter(w=>w.path==='offer-act').length,0,'PDF preview must not confirm or send');
doc.dispatchEvent(new d.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause(0);assert.equal(doc.querySelector('#action-root').hidden,false);assert.equal(revokedUrls.length,1,'release PDF blob on close');
d.window.closeAction();await pause(0);d.window.setDetailTab('docs');await pause(0);
const contractButton=[...doc.querySelectorAll('.hr-contract-pdf button')].find(b=>b.textContent==='PDFを見る');assert.ok(contractButton,'employment contract has a PDF button');
await d.window.openOfficialPdf('contract-pdf',contractButton);await pause(0);assert.match(pdfRequests.at(-1).path,/docId=contract-pdf&file=1/);assert.equal(doc.querySelector('#pdf-preview-root h2').textContent,'雇用契約書');assert.equal(visibleDialogs().length,1);
d.window.HRModalUI.closePdf();d.window.closeModal();await pause(0);assert.equal(visibleDialogs().length,0);assert.equal(doc.body.classList.contains('hr-dialog-open'),false);
assert.throws(()=>d.window.HRModalUI.showDocument({url:'javascript:alert(1)'}),/URL/);
d.window.close();
d=await page('hr/applicants.html','', 'closed');doc=d.window.document;assert.equal(doc.querySelector('[data-category="active"]').getAttribute('aria-selected'),'true','do not restore ended filter on default entry');d.window.close();
d=await page('hr/applicants.html','?category=closed');doc=d.window.document;assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,endedPeople.length,'explicit ended link still works');d.window.close();
d=await page('hr/intake.html');doc=d.window.document;assert.equal(doc.querySelector('#sync').disabled,true);
doc.querySelector('#rows button').click();await pause(100);assert.ok(doc.querySelector('dialog[open]'));assert.equal(doc.querySelector('pre script'),null,'external email is text only');
doc.querySelector('#reason').value='原文を確認';doc.querySelector('#correct').click();await pause(100);assert.ok(writes.some(w=>w.path==='/api/hr/intake'&&w.body.action==='correct'));d.window.close();
d=await page('hr/trials.html');doc=d.window.document;doc.querySelector('.tr-list-row').click();doc.querySelector('#tr-scores button').click();assert.ok(doc.querySelector('#tr-scores button.on'));d.window.close();
d=await page('hr/interviews.html','?applicantId='+id+'&interviewId=iv1');doc=d.window.document;const note=doc.querySelector('#iv-note');note.value='成果の具体例と数字を確認';note.dispatchEvent(new d.window.Event('input'));await pause(1350);assert.ok(writes.some(w=>w.path==='interview'&&w.body.memo.includes('具体例')));d.window.close();
assert.deepEqual(errors,[]);console.log('PASS synthetic DOM: closed filters, single centered dialog, notification/contract PDF views without send/confirm, blob cleanup, keyboard return; column order/time, unread/document interaction, safe email text, classification correction payload, trial score buttons and interview autosave');
