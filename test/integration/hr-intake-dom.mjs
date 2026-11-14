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
const receivedDoc={id:'contract-pdf',title:'雇用契約書',status:'received',docKind:'employment_contract'};
let progressEnabled=false;
const response=()=>({...progressEnabled?{progressMoves:{options:['screening','interview','final','offer','trial','terms','agreement','office'].map(key=>({key,label:({trial:'トライアル',terms:'条件通知書',agreement:'合意',office:'OFFICE'})[key]||key,state:'allowed'}))}}:{},statusOptions:[{key:'todo',label:'未対応'},{key:'scheduling',label:'日程調整中'},{key:'interview_scheduled',label:'面談予定'}],stepMoves:{current:person.stage,options:[{key:'applied',label:'応募受付',state:person.stage==='applied'?'current':'allowed'},{key:'casual_interview',label:'採用面談',state:person.stage==='casual_interview'?'current':'allowed'}]},applicant:person,interviews:[{...interview}],timeline:[],offers,salaryVisible:true,offerTypes:OFFER_TYPES_PUBLIC,contract:{ready:true,types:['part_time']}});
let uploadedWork=null;
const applicationDoc={id:'doc1',applicantId:id,filename:'履歴書.pdf',mimeType:'application/pdf'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function mockApi(path,opts){
 const b=opts?.body;if(b){assert.equal(typeof b,'object','API.api expects a JSON object');writes.push({path,body:b});}
 if(path.startsWith('/api/hr/applicants?'))return {applicants:[{...person},...endedPeople],employees:[],sources:{counts:[]}};
 if(path==='/api/hr/applicant-state'){if(b){readState=true;return {ok:true};}return {states:[{id,unread:!readState,kind:'application'}]};}
 if(path==='/api/hr/progress'){if(b.dryRun)return {from:'合格通知',to:b.to,token:'preview-check',warnings:[]};assert.equal(b.token,'preview-check');person.manualProgress={phase:b.to,method:b.method,confirmedOn:b.confirmedOn,note:b.note};person.progressRevision='progress-'+writes.length;return {ok:true};}
 if(path.startsWith('/api/hr/inbox?id='))return {mail};
 if(path.startsWith('/api/hr/inbox'))return b?{ok:true}:{mails:[mail],openCount:1,unreadCount:1};
 if(path==='/api/hr/intake')return b?{ok:true}:{analyses:[analysis],budget:{committed_yen:10,budget_yen:1000}};
 if(path.startsWith('/api/hr/offers/contract?'))return {docs:[receivedDoc],perms:{salary:true}};
 if(path==='/api/hr/trials')return {trials:[trial]};
 if(path.startsWith('/api/hr/candidate-documents'))return {ready:true,documents:[],canUpload:true,canPublish:true};
 return {};
}
const documentGroups=()=>[{docType:'resume',label:'履歴書',icon:'description',latest:applicationDoc,history:[]},{docType:'work_history',label:'職務経歴書',icon:'work_history',latest:uploadedWork,history:[]},{docType:'skill_sheet',label:'スキルシート',icon:'assignment_ind',latest:null,history:[]},{docType:'other',label:'その他の書類',icon:'attach_file',latest:null,history:[]}];
const ctx={canDecide:true,me:{userId:'fixture',access:{officeHr:true},gw:{tenantId:'tenant',roles:['owner'],employee:{id:'emp'}}}};
async function page(file,query='',savedCategory=null){
 let html=read(file).replace(/<script[^>]*src=[^>]*><\/script>/g,tag=>tag.includes('hr-modal-ui.js')?'<script>'+read('js/hr-modal-ui.js')+'</script>':'');
 html=html.replace(/<link[^>]+href="\.\.\/css\/hr-applicant-detail[^>]+>/,'<style>'+read('css/hr-applicant-detail.css')+'</style>');
 const dom=new JSDOM(html,{url:'http://local.test/'+file+query,runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  if(savedCategory)w.sessionStorage.setItem('hr-applicants-view',JSON.stringify({category:savedCategory}));
  w.URL.createObjectURL=()=>`blob:http://local.test/pdf-${++pdfSeq}`;w.URL.revokeObjectURL=url=>revokedUrls.push(url);
  w.fetch=async(path,opts)=>{pdfRequests.push({path,opts});return {ok:true,blob:async()=>new w.Blob(['%PDF-fixture'],{type:'application/pdf'}),headers:{get:()=>"attachment; filename*=UTF-8''%E6%8E%A1%E7%94%A8%E9%80%9A%E7%9F%A5%E6%9B%B8.pdf"}};};
  w.alert=()=>{};w.confirm=()=>true;w.scrollTo=()=>{};w.prompt=()=>'';
  w.addEventListener('error',e=>errors.push(String(e.error||e.message)));
  w.HRLayout={esc,init:async()=>ctx,allows:()=>true};w.KPLayout={esc,busy:async(_btn,_label,fn)=>fn()};
  w.API={api:mockApi,warm:()=>{},swr:async(_key,fetch,render)=>render(await fetch()),morph:(node,html)=>node.innerHTML=html,
   listHrApplicants:async()=>({applicants:[{...person},...endedPeople],employees:[]}),getHrApplicant:async()=>response(),hrDocuments:async()=>({documents:documentGroups(),limits:{}}),uploadHrDocument:async(applicantId,type,file)=>{assert.equal(applicantId,id);assert.equal(type,'work_history');uploadedWork={id:'workdoc',filename:file.name,mimeType:file.type};writes.push({path:'upload',type,fileName:file.name});return {};},
   updateHrApplicant:async b=>{writes.push({path:'applicant-update',body:b});if(b.dryRun)return {from:person.status,to:b.to||b.status,warnings:[]};if(b.action==='moveStep'){person.stage=b.to;person.status='scheduling';person.statusLabel='日程調整中';person.nextActionKey='schedule';}else if(b.action==='setStatus'){person.status=b.status;person.statusLabel=b.status==='interview_scheduled'?'面談予定':b.status;}else if(b.offerType){person.offerType=b.offerType;}else if(b.email){person.email=b.email;person.nextActionKey='sendSchedulingLink';}return {applicant:person};},
   getToken:async()=>'synthetic-token',hrDocumentUrl:async(doc,download,applicantId)=>{assert.equal(doc,'doc1');assert.equal(applicantId,id);return {url:'https://files.example.test/resume.pdf',mimeType:'application/pdf'};},
   createHrOffer:async b=>{writes.push({path:'offer-create',body:b});person.status='offer_review_pending';offers=[{id:'offer1',offerType:'part_time',status:'draft',respondBy:b.respondBy,offerTerms:{},...b}];return {offer:offers[0]};},
   updateHrOffer:async b=>{writes.push({path:'offer-update',body:b});offers=[{...offers[0],...b}];return {offer:offers[0]};},hrOfferAct:async b=>{writes.push({path:'offer-act',body:b});return {};},
   todayHrInterviews:async()=>({interviews:[]}),hrInterviewAct:async b=>{writes.push({path:'interview',body:b});interview.memo=b.memo;return {};}};
  w.eval(read('js/jst.js'));w.eval(read('js/hr-applicant-list.js'));w.eval(read('js/hr-candidate-documents-ui.js'));
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 }});
 if(file==='hr/intake.html')dom.window.eval(read('js/hr-intake-ui.js'));
 await pause(150);return dom;
}
let d=await page('hr/applicants.html'),doc=d.window.document;
assert.deepEqual([...doc.querySelectorAll('#thead th')].map(n=>n.textContent),['','登録日時','応募者','現在の状態','書類','社内メモ','NEXT','担当者']);
assert.match(doc.querySelector('#rows td:nth-child(2)').textContent,/2026\/11\/14 10:23/);
assert.equal(doc.querySelectorAll('#cat-tabs [role="tab"]').length,6);
assert.deepEqual([...doc.querySelectorAll('#cat-tabs [data-category]')].map(n=>n.dataset.category),OFFER_TYPES_PUBLIC.map(t=>t.key));
assert.deepEqual([...doc.querySelectorAll('#stage-tabs button')].map(n=>n.firstChild.textContent),['すべて','事前選考','カジュアル面談','代表面談','合格通知','トライアル','条件通知書','合意','OFFICE']);
assert.equal(doc.querySelectorAll('#stage-tabs .hr-pipeline-arrow').length,8);
assert.equal(doc.querySelector('#category-scope').value,'active');d.window.selectCategoryScope('unassigned');assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,1);d.window.setCategory('part_time');assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,0);d.window.selectCategoryScope('active');
assert.equal(doc.querySelectorAll('.hr-doc-state').length,5);assert.equal(doc.querySelector('#hr-new-count').textContent,'1');
assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,1,'closed applicants hidden by default');
d.window.selectCategoryScope('closed');assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,endedPeople.length);
doc.querySelector('[data-stage="status:done"]').click();assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,2,'completed status and joined PDF flow');
d.window.selectCategoryScope('active');
doc.querySelector('[data-doc-kind="resume"]').click();await pause(100);assert.ok(doc.querySelector('#pdf-preview-root iframe'));assert.equal(doc.querySelector('#hr-detail-box'),null,'resume icon does not open applicant details');assert.match(doc.querySelector('#pdf-preview-root h2').textContent,/履歴書/);assert.equal(readState,false,'file preview does not mark the hiring state as reviewed');
d.window.HRModalUI.closePdf();
await d.window.openListDocument(id,'work_history');assert.equal(doc.querySelector('#pdf-preview-root iframe'),null);assert.match(doc.querySelector('.hr-file-entry').textContent,/職務経歴書はまだ登録/);assert.doesNotMatch(doc.querySelector('.hr-file-entry').textContent,/履歴書.pdf/);d.window.closeModal();
// The default row/NEXT dialog explains the task without profile tabs or automatic status changes.
doc.querySelector('#rows [data-applicant]').click();await pause(100);assert.ok(doc.querySelector('.hr-work-modal'));assert.equal(doc.querySelectorAll('.hr-detail-tabs').length,0);assert.match(doc.querySelector('.hr-work-task').textContent,/次にすること/);assert.ok(readState);
const changesBefore=writes.filter(w=>w.path==='applicant-update').length;
d.window.openStatusChange();assert.ok(doc.querySelector('#mv-to'));assert.equal(writes.filter(w=>w.path==='applicant-update').length,changesBefore,'opening the status dialog never changes status');
doc.querySelector('#mv-to').value='casual_interview';await d.window.pickStepMove('casual_interview');assert.equal(writes.at(-1).body.dryRun,true);doc.querySelector('#mv-reason').value='電話で面談の日程を確認';d.window.syncStepMove();assert.equal(doc.querySelector('#mv-go').disabled,false);await d.window.submitStepMove(doc.querySelector('#mv-go'));assert.ok(doc.querySelector('.hr-work-modal'));assert.match(doc.querySelector('.hr-work-state').textContent,/日程調整中/);
d.window.openManualStatusModal();doc.querySelector('#work-status').value='interview_scheduled';d.window.confirmManualStatus();await pause(50);assert.ok(doc.querySelector('#list-edit-save'));assert.equal(doc.querySelector('.hr-doc-fold').open,false,'deadline options stay collapsed');await d.window.saveListEdit(doc.querySelector('#list-edit-save'));assert.match(doc.querySelector('.hr-work-state').textContent,/面談予定/);
const empty=person.email;person.email='';person.nextActionKey='registerEmail';await d.window.openWorkModal(id);await d.window.performWorkAction('registerEmail');assert.equal(doc.querySelectorAll('#action-root input').length,1,'email task contains only the email field');doc.querySelector('#work-email').value=empty;await d.window.saveWorkEmail(doc.querySelector('#action-root .btn-primary'));assert.equal(doc.querySelector('#action-root').children.length,0);assert.equal(person.email,empty);
assert.equal(writes.filter(w=>['send','sendOffer','sendSchedulingLink'].includes(w.body?.action)).length,0,'navigation and status changes never send messages');
// Current eight-stage picker works even while PDF preparation would lock legacy step moves.
progressEnabled=true;person.pdfFlow={phase:'offer_preparing'};const originalStage=person.stage,originalStatus=person.status;
await d.window.openWorkModal(id);d.window.openStatusChange();
assert.equal(doc.querySelector('#mv-to option[value="trial"]').disabled,false,'Trial is selectable');
doc.querySelector('#mv-to').value='trial';await d.window.pickStepMove('trial');
assert.equal(doc.querySelector('#mv-method').value,'phone');assert.equal(doc.querySelector('#mv-date').value,d.window.JST.ymd(new Date()));
doc.querySelector('#mv-reason').value='電話で期間と報酬を説明。開始日を調整中。';d.window.syncStepMove();await d.window.submitStepMove(doc.querySelector('#mv-go'));await pause(100);
assert.match(doc.querySelector('.hr-work-state').textContent,/トライアルの準備/);assert.match(doc.querySelector('#hr-work-primary').href,/trials.html/);
assert.equal(doc.querySelector('#rows [data-current-state]').textContent,'トライアルの準備・確認','same current state in list and dialog');
assert.equal(person.stage,originalStage);assert.equal(person.status,originalStatus,'progress never forges contract/workflow facts');
const manualSave=writes.filter(w=>w.path==='/api/hr/progress'&&!w.body.dryRun).at(-1);assert.equal(manualSave.body.method,'phone');assert.match(manualSave.body.note,/報酬/);
d.window.openStatusChange();doc.querySelector('#mv-to').value='terms';await d.window.pickStepMove('terms');doc.querySelector('#mv-method').value='interview';doc.querySelector('#mv-reason').value='面談で勤務日と時給を確認';d.window.syncStepMove();await d.window.submitStepMove(doc.querySelector('#mv-go'));await pause(100);
assert.match(doc.querySelector('.hr-work-state').textContent,/条件通知書/);assert.match(doc.querySelector('.hr-work-task').textContent,/電話・面談/);
await d.window.performWorkAction('detail');assert.ok(doc.querySelector('[data-tab="docs"].on'),'selected phase routes to relevant documents');
progressEnabled=false;delete person.manualProgress;delete person.progressRevision;delete person.pdfFlow;

Object.assign(person,{stage:'ceo_interview',status:'ceo_decision_pending',statusLabel:'代表判断待ち'});await d.window.refreshDetail();d.window.showApplicantInfo('overview');d.window.openRecruitCategoryModal();d.window.pickModalOfferType('part_time');const offersBefore=writes.filter(w=>w.path==='offer-create').length;await d.window.saveRecruitCategory(doc.querySelector('#action-root .btn-primary'));assert.equal(person.offerType,'part_time');assert.equal(writes.filter(w=>w.path==='offer-create').length,offersBefore,'setting a category never creates an offer');assert.equal(person.status,'ceo_decision_pending','setting a category does not change the selection state');
await d.window.openDocumentList(id);assert.ok(doc.querySelector('[data-tab="docs"].on'));
const labels=[...doc.querySelectorAll('.hr-detail-tabs [role="tab"]')].map(n=>n.childNodes[n.childNodes.length-1].textContent);
assert.deepEqual(labels,['応募者情報','面談・評価','書類・契約','連絡・履歴']);
assert.equal(doc.querySelector('#hr-detail-next'),null,'unrelated email/NEXT banner is absent on documents');
assert.equal(d.window.getComputedStyle(doc.querySelector('#hr-detail-box')).overflow,'hidden');
assert.equal(d.window.getComputedStyle(doc.querySelector('#hr-detail-tab')).overflowY,'auto');
assert.equal(doc.querySelector('#hr-docs-optional').open,false,'unregistered optional docs collapsed');
assert.equal(doc.querySelectorAll('#hr-docs-app > .hr-file-row').length,2,'registered resume plus required work history');
assert.match(doc.querySelector('#hr-docs-app [data-doc="resume"]').textContent,/履歴書.pdf/);
assert.match(doc.querySelector('#hr-docs-app [data-doc="work_history"]').textContent,/未提出・必要/);
assert.equal(doc.querySelector('#hr-docs-app [data-doc="resume"] .hr-file-actions').querySelectorAll(':scope > button').length,1,'one primary button');
const visibleDialogs=()=>[...doc.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(n=>!n.closest('[hidden]'));
assert.equal(visibleDialogs().length,1);const detailBox=doc.querySelector('#hr-detail-box');
assert.equal(d.window.getComputedStyle(detailBox).left,'50%');
assert.ok(Number(d.window.getComputedStyle(detailBox).zIndex)>Number(d.window.getComputedStyle(doc.querySelector('#modal-root .hr-modal-bg')).zIndex),'dialog above backdrop');
await d.window.previewDoc('doc1');await pause(0);assert.equal(visibleDialogs().length,1);assert.ok(doc.querySelector('#modal-root').hidden);assert.match(doc.querySelector('#pdf-preview-root iframe').src,/resume.pdf/);
d.window.HRModalUI.closePdf();await pause(0);assert.equal(doc.querySelector('#modal-root').hidden,false);
// Upload updates the same document row and success message without a real request.
d.window.openUploadDoc('work_history');d.window.pickDocFile(new d.window.File(['fixture'],'職務経歴書.pdf',{type:'application/pdf'}));await d.window.submitUploadDoc(doc.querySelector('#doc-save'));await pause(0);
assert.match(doc.querySelector('#hr-docs-app [data-doc="work_history"]').textContent,/職務経歴書.pdf/);
assert.equal(doc.querySelector('.hr-document-feedback').hidden,false);assert.match(doc.querySelector('.hr-document-feedback').textContent,/登録しました/);
d.window.setDetailTab('mail');await pause(30);assert.ok(doc.querySelector('[data-tab="activity"].on'));assert.ok(doc.querySelector('#hr-mail-history'));
d.window.setDetailTab('history');assert.ok(doc.querySelector('[data-tab="activity"].on'));
d.window.setDetailTab('docs');
// Reproduce the part-time form in the supplied screenshot using only synthetic data.
Object.assign(person,{stage:'offer',status:'offer_draft_pending',offerType:'part_time',contractState:'conditions',employmentType:'パート',joinDate:'2027-01-01',wageType:'時給',wageAmount:1500});
await d.window.refreshDetail();d.window.openOfferForm();await pause(30);assert.equal(doc.querySelector('#action-root h2').textContent,'書類をアップロード');assert.equal(doc.querySelector('#of-fields'),null,'generated conditions form is no longer the default');assert.equal(doc.querySelector('[data-kind]').value,'terms');d.window.closeAction();d.window.openGeneratedOfferForm();await pause(0);
assert.ok(doc.querySelector('#modal-root').hidden);assert.equal(visibleDialogs().length,1);assert.match(doc.querySelector('#action-root h2').textContent,/採用通知書のPDFを作成/);
assert.equal(doc.querySelector('#of-send').textContent,'PDFを作成する');
assert.equal(doc.querySelector('#of-confirm').textContent,'契約書の準備へ進む');
await d.window.submitOfferAndPreview(doc.querySelector('#of-send'));await pause(50);
assert.match(pdfRequests.at(-1).path,/file=previewOffer/);assert.equal(doc.querySelector('[data-category="part_time"] .n').textContent,'1');assert.equal(pdfRequests.at(-1).opts.headers.Authorization,'Bearer synthetic-token');
assert.ok(doc.querySelector('#pdf-preview-root iframe'));assert.equal(visibleDialogs().length,1);
assert.equal(writes.filter(w=>w.path==='offer-create').length,1);assert.equal(writes.filter(w=>w.path==='offer-act').length,0,'PDF preview must not confirm or send');
doc.dispatchEvent(new d.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause(0);assert.equal(doc.querySelector('#action-root').hidden,false);assert.equal(revokedUrls.length,1,'release PDF blob on close');
d.window.closeAction();await pause(0);d.window.setDetailTab('docs');await pause(0);
const contractButton=[...doc.querySelectorAll('[data-official-doc] button')].find(b=>b.textContent.endsWith('PDFを見る'));assert.ok(contractButton,'employment contract has a PDF button');
await d.window.openOfficialPdf('contract-pdf',contractButton);await pause(0);assert.match(pdfRequests.at(-1).path,/docId=contract-pdf&file=1/);assert.equal(doc.querySelector('#pdf-preview-root h2').textContent,'雇用契約書');assert.equal(visibleDialogs().length,1);
d.window.HRModalUI.closePdf();d.window.closeModal();await pause(0);assert.equal(visibleDialogs().length,0);assert.equal(doc.body.classList.contains('hr-dialog-open'),false);
assert.throws(()=>d.window.HRModalUI.showDocument({url:'javascript:alert(1)'}),/URL/);
const originalDocuments=d.window.API.hrDocuments;let release;
d.window.API.hrDocuments=()=>new Promise(resolve=>{release=resolve;});const pendingDocument=d.window.openListDocument(id,'resume');d.window.closeModal();release({documents:documentGroups()});await pendingDocument;assert.equal(doc.querySelector('#pdf-preview-root iframe'),null,'closed file request does not reopen');d.window.API.hrDocuments=originalDocuments;
const originalUrl=d.window.API.hrDocumentUrl;d.window.API.hrDocumentUrl=async()=>{throw new Error('閲覧権限がありません');};await d.window.openListDocument(id,'resume');assert.match(doc.querySelector('.hr-file-entry [role="alert"]').textContent,/権限/);assert.equal(doc.querySelector('#pdf-preview-root iframe'),null);d.window.API.hrDocumentUrl=originalUrl;d.window.closeModal();
d.window.close();
d=await page('hr/applicants.html','', 'closed');doc=d.window.document;assert.equal(doc.querySelector('#category-scope').value,'active','do not restore ended filter on default entry');d.window.close();
d=await page('hr/applicants.html','?category=closed');doc=d.window.document;assert.equal(doc.querySelectorAll('#rows [data-applicant]').length,endedPeople.length,'explicit ended link still works');d.window.close();
d=await page('hr/intake.html');doc=d.window.document;assert.equal(doc.querySelector('#sync').disabled,true);
doc.querySelector('#rows button').click();await pause(100);assert.ok(doc.querySelector('dialog[open]'));assert.equal(doc.querySelector('pre script'),null,'external email is text only');
doc.querySelector('#reason').value='原文を確認';doc.querySelector('#correct').click();await pause(100);assert.ok(writes.some(w=>w.path==='/api/hr/intake'&&w.body.action==='correct'));d.window.close();
d=await page('hr/trials.html');doc=d.window.document;doc.querySelector('.tr-list-row').click();doc.querySelector('#tr-scores button').click();assert.ok(doc.querySelector('#tr-scores button.on'));d.window.close();
d=await page('hr/interviews.html','?applicantId='+id+'&interviewId=iv1');doc=d.window.document;const note=doc.querySelector('#iv-note');note.value='成果の具体例と数字を確認';note.dispatchEvent(new d.window.Event('input'));await pause(1350);assert.ok(writes.some(w=>w.path==='interview'&&w.body.memo.includes('具体例')));d.window.close();
assert.deepEqual(errors,[]);console.log('PASS synthetic DOM: six offer categories/unknown and ended scope, requested eight-stage order/counts; task-only default modal, validated stage/status changes, focused email form, exact-file list preview/missing-file message; compact document rows/optional fold/upload feedback, four icon tabs, merged mail/history, fixed header/single scroll, closed filters, single centered dialog, notification/contract PDF views without send/confirm, blob cleanup, keyboard return; column order/time, unread/document interaction, safe email text, classification correction payload, trial score buttons and interview autosave');
