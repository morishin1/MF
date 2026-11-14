// Full DOM/event execution with synthetic API responses; this is not visual browser QA.
import fs from 'node:fs';import assert from 'node:assert/strict';
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
const writes=[],errors=[];let readState=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function mockApi(path,opts){
 const b=opts?.body;if(b){assert.equal(typeof b,'object','API.api expects a JSON object');writes.push({path,body:b});}
 if(path.startsWith('/api/hr/applicants?'))return {applicants:[{...person}],employees:[],sources:{counts:[]}};
 if(path==='/api/hr/applicant-state'){if(b){readState=true;return {ok:true};}return {states:[{id,unread:!readState,kind:'application'}]};}
 if(path.startsWith('/api/hr/inbox?id='))return {mail};
 if(path.startsWith('/api/hr/inbox'))return b?{ok:true}:{mails:[mail],openCount:1,unreadCount:1};
 if(path==='/api/hr/intake')return b?{ok:true}:{analyses:[analysis],budget:{committed_yen:10,budget_yen:1000}};
 if(path==='/api/hr/trials')return {trials:[trial]};
 return {};
}
const ctx={canDecide:true,me:{userId:'fixture',access:{officeHr:true},gw:{tenantId:'tenant',roles:['owner'],employee:{id:'emp'}}}};
async function page(file,query=''){
 let html=read(file).replace(/<script[^>]*src=[^>]*><\/script>/g,'');
 const dom=new JSDOM(html,{url:'http://local.test/'+file+query,runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  w.alert=()=>{};w.confirm=()=>true;w.scrollTo=()=>{};w.prompt=()=>'';
  w.addEventListener('error',e=>errors.push(String(e.error||e.message)));
  w.HRLayout={esc,init:async()=>ctx,allows:()=>true};w.KPLayout={esc,busy:async(_btn,_label,fn)=>fn()};
  w.API={api:mockApi,warm:()=>{},swr:async(_key,fetch,render)=>render(await fetch()),morph:(node,html)=>node.innerHTML=html,
   listHrApplicants:async()=>({applicants:[{...person}],employees:[]}),getHrApplicant:async()=>({applicant:person,interviews:[{...interview}],timeline:[],offers:[],salaryVisible:true}),hrDocuments:async()=>({documents:[],limits:{}}),
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
doc.querySelector('.hr-doc-state').click();await pause(100);assert.ok(doc.querySelector('[data-tab="docs"].on'));assert.ok(readState);d.window.close();
d=await page('hr/intake.html');doc=d.window.document;assert.equal(doc.querySelector('#sync').disabled,true);
doc.querySelector('#rows button').click();await pause(100);assert.ok(doc.querySelector('dialog[open]'));assert.equal(doc.querySelector('pre script'),null,'external email is text only');
doc.querySelector('#reason').value='原文を確認';doc.querySelector('#correct').click();await pause(100);assert.ok(writes.some(w=>w.path==='/api/hr/intake'&&w.body.action==='correct'));d.window.close();
d=await page('hr/trials.html');doc=d.window.document;doc.querySelector('.tr-list-row').click();doc.querySelector('#tr-scores button').click();assert.ok(doc.querySelector('#tr-scores button.on'));d.window.close();
d=await page('hr/interviews.html','?applicantId='+id+'&interviewId=iv1');doc=d.window.document;const note=doc.querySelector('#iv-note');note.value='成果の具体例と数字を確認';note.dispatchEvent(new d.window.Event('input'));await pause(1350);assert.ok(writes.some(w=>w.path==='interview'&&w.body.memo.includes('具体例')));d.window.close();
assert.deepEqual(errors,[]);console.log('PASS synthetic DOM: column order/time, unread/document interaction, safe email text, classification correction payload, trial score buttons and interview autosave');
