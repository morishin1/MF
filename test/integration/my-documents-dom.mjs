import fs from 'node:fs';import assert from 'node:assert/strict';
const {JSDOM}=await import(process.env.HR_JSDOM_MODULE||'jsdom');
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8'),pause=()=>new Promise(r=>setTimeout(r,30));
const writes=[],viewed=[],revoked=[];let uploaded=false,published=false;
const dom=new JSDOM('<main><div id="hr"></div><div id="me"></div></main>',{url:'https://local.test/contracts.html',runScripts:'dangerously',pretendToBeVisual:true});const w=dom.window,d=w.document;
w.URL.createObjectURL=()=>`blob:https://local.test/original-${viewed.length}`;w.URL.revokeObjectURL=u=>revoked.push(u);
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
const doc=()=>({id:'doc',kind:'terms',title:'労働条件通知書',filename:'ローカル作成_押印済.pdf',version:1,status:published?'published':'draft'});
w.fetch=async(url,opts)=>{writes.push({url,opts});return {ok:true,blob:async()=>new w.Blob(['%PDF-original'],{type:'application/pdf'})};};
w.API={getToken:async()=>'fixture',api:async(url,opts)=>{
 const b=opts?.body;if(b)writes.push({url,body:b});
 if(url==='/api/my-documents')return {employee:true,received:[{id:'n',source:'notice',filename:'公開済条件.pdf',title:'労働条件通知書',status:'公開中'}],uploads:[{id:'u',itemId:'resume',source:'procedure',title:'履歴書',filename:'自分の履歴書.pdf',status:'確認待ち'}],checklist:[{id:'pension',title:'年金通知書',required:true,status:'未提出',href:'/onboarding/'},{id:'resume',title:'履歴書',required:true,status:'確認待ち',href:'/onboarding/'},{title:'源泉徴収票',required:false,status:'対象外'}],notReady:[]};
 if(url.includes('scope=me'))return {documents:published?[doc()]:[]};
 if(!b)return {ready:true,documents:uploaded?[doc()]:[],canUpload:true,canPublish:true};
 if(b.action==='prepare')return {uploadUrl:'https://files.example.test/upload',path:'staging/example.pdf'};
 if(b.action==='attach'){uploaded=true;return {ok:true};}
 if(b.action==='previewPublish')return {confirmation:{...doc(),name:'架空 応募者',email:'fixture@example.test',digest:'snapshot'}};
 if(b.action==='publish'){assert.equal(b.confirmed,true);assert.equal(b.confirmDigest,'snapshot');published=true;return {ok:true};}
 return {};
}};
w.eval(read('js/hr-candidate-documents-ui.js'));w.eval(read('js/my-documents-ui.js'));
w.HRCandidateDocuments.mount({element:d.getElementById('hr'),applicantId:'app',showPdf:x=>viewed.push(x)});await pause();
assert.equal(d.querySelector('[data-kind]').value,'terms');assert.equal(writes.length,0,'opening upload does not generate, send or publish');
const file=new w.File(['%PDF-fixture'],'ローカル作成_押印済.pdf',{type:'application/pdf'});Object.defineProperty(d.querySelector('[data-file]'),'files',{value:[file]});d.querySelector('[data-action="upload"]').click();await pause();
assert.match(d.querySelector('[data-message]').textContent,/登録しました/);assert.match(d.querySelector('.hr-upload-state').textContent,/未公開/);assert.equal(writes.filter(x=>x.body?.action==='publish').length,0);
d.querySelector('[data-action="preview"]').click();await pause();assert.equal(viewed.length,1);assert.equal(viewed[0].filename,file.name);
d.querySelector('[data-action="review"]').click();await pause();assert.match(d.querySelector('.hr-publication-review').textContent,/fixture@example.test/);assert.equal(writes.filter(x=>x.body?.action==='publish').length,0);
d.querySelector('[data-action="publish"]').click();await pause();assert.match(d.querySelector('.hr-upload-state').textContent,/本人に公開中/);
let selfView=w.MyDocumentsUI.mount({element:d.getElementById('me'),view:'contracts'});await pause();
assert.match(d.getElementById('me').textContent,/ローカル作成_押印済.pdf/);
assert.equal(d.querySelectorAll('#me [data-my-upload-start]').length,0,'contracts never show submissions');
d.querySelector('#me [data-my-open="0"]').click();await pause();assert.equal(d.querySelector('[data-my-view]').open,true);assert.ok(writes.some(x=>typeof x.opts?.body==='string'&&JSON.parse(x.opts.body).scope==='me'));d.querySelector('[data-my-close]').click();assert.ok(revoked.length>0);
selfView.dispose();selfView=w.MyDocumentsUI.mount({element:d.getElementById('me'),view:'submissions'});await pause();
assert.match(d.getElementById('me').textContent,/提出完了まで、あと1件/);assert.equal(d.querySelectorAll('#me [data-submission-id]').length,2,'N/A is not shown');assert.ok(!d.getElementById('me').textContent.includes('ローカル作成_押印済.pdf'),'submissions never show company contracts');
assert.equal(writes.filter(x=>['send','sendOffer','accept','confirm','sign','generateOffer'].includes(x.body?.action)).length,0,'preview never sends or signs');selfView.dispose();
dom.window.close();
// The actual contracts page retains the existing signing list, with the new register on the same page.
const html=read('contracts.html').replace(/<script[^>]+src=[^>]+><\/script>/g,'');
const real=new JSDOM(html,{url:'https://local.test/contracts.html',runScripts:'dangerously',beforeParse(w){w.KPLayout={esc:s=>String(s),init:async()=>({me:{gw:{employee:{id:'employee'}}}}),viewer:()=>{}};w.MemberPortalNav={mount:()=>{}};w.MyDocumentsUI={mount:({element,view})=>{assert.equal(view,'contracts');element.textContent='会社から届いた契約書';}};w.API={myContracts:async()=>({contracts:[{id:'signed',title:'署名済みの雇用契約',view:'signed',signedAt:'2026-11-14'}],me:{}})};}});await pause();assert.match(real.window.document.querySelector('#my-document-register').textContent,/会社から届いた契約書/);assert.match(real.window.document.querySelector('#done-list').textContent,/署名済みの雇用契約/);assert.equal(real.window.document.querySelector('#done-card').classList.contains('hidden'),false);real.window.close();
console.log('PASS DOM: upload-first, unchanged PDF preview, explicit publication, contracts page own checklist/uploads/received/signed documents, N/A exclusion, blob cleanup and no automatic send/sign');
