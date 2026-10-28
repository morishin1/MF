// Real UI code in minimal DOM. Not a browser/layout or live API test.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../js/hr-pdf-flow-ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function harness(data){
 const map=new Map(),calls=[];let next=null;
 function el(id){if(!map.has(id))map.set(id,{id,innerHTML:'',textContent:'',value:'',checked:false,disabled:false,files:[],events:{},addEventListener(k,f){this.events[k]=f;},showModal(){this.open=true;},close(){this.open=false;},click(){this.clicked=true;}});return map.get(id);}
 const document={getElementById:el,querySelectorAll:()=>[...map.values()],createElement:()=>el('created')};
 const ctx=vm.createContext({document,location:{search:'?applicantId=one'},window:{addEventListener(){}},URLSearchParams,crypto:webcrypto,console,fetch:async()=>({ok:true}),API:{api:async(url,opts)=>{calls.push({url,body:opts?.body});if(!opts)return data;if(next)return next(opts.body);return {};}}});
 vm.runInContext(source,ctx);
 return {el,calls,ctx,setNext:fn=>next=fn,click:type=>el('pdf-content').events.click({target:{closest:()=>({dataset:{act:type,doc:'d1'}})}})};
}
const base={enabled:true,canStart:true,canManage:true,canMigrateLegacy:true,applicant:{name:'<script>bad</script>',email:'test@example.test'},flow:null,documents:[]};
const h=harness(base);await tick();
assert.ok(h.el('pdf-content').innerHTML.includes('&lt;script&gt;'));assert.ok(!h.el('pdf-content').innerHTML.includes('<script>bad'));
h.click('create');assert.equal(h.el('pdf-dialog').open,true);
await h.el('pdf-dialog-submit').onclick();assert.match(h.el('pdf-dialog-error').textContent,/チェック/);assert.equal(h.calls.filter(x=>x.body).length,0);
h.el('pdf-confirm').checked=true;
let release;h.setNext(()=>new Promise(r=>release=r));const pending=h.el('pdf-dialog-submit').onclick();await tick();
assert.equal(h.el('pdf-dialog-submit').disabled,true);await h.el('pdf-dialog-submit').onclick();assert.equal(h.calls.filter(x=>x.body?.action==='create').length,1);
h.el('pdf-dialog-close').onclick();assert.equal(h.el('pdf-dialog').open,true);release({});await pending;assert.equal(h.el('pdf-dialog').open,false);
h.click('migrate');h.el('pdf-reason').value='short';await h.el('pdf-dialog-submit').onclick();assert.match(h.el('pdf-dialog-error').textContent,/10文字/);
h.el('pdf-reason').value='未承諾の旧通知をPDF方式へ移行';h.setNext(async body=>({confirmation:{applicantName:'A',applicantEmail:'a@example.test',digest:'digest',legacyOffers:[{version:2,sentAt:'2026-10-01'}],warning:'旧リンク無効'}}));
await h.el('pdf-dialog-submit').onclick();assert.match(h.el('pdf-dialog-title').textContent,/旧案内を無効化/);assert.match(h.el('pdf-dialog-content').innerHTML,/第2版/);
h.el('pdf-confirm').checked=true;h.setNext(async()=>{throw new Error('競合');});await h.el('pdf-dialog-submit').onclick();assert.equal(h.el('pdf-dialog').open,true);assert.match(h.el('pdf-dialog-error').textContent,/競合/);
const first=h.calls.filter(x=>x.body?.action==='migrateUnacceptedLegacy').at(-1).body;await h.el('pdf-dialog-submit').onclick();const second=h.calls.filter(x=>x.body?.action==='migrateUnacceptedLegacy').at(-1).body;assert.equal(first.requestKey,second.requestKey);assert.equal(first.confirmDigest,'digest');
const readonly=harness({...base,canStart:false,canManage:false,canMigrateLegacy:false});await tick();assert.ok(!readonly.el('pdf-content').innerHTML.includes('data-act="create"'));readonly.click('create');await tick();assert.equal(readonly.calls.filter(x=>x.body).length,0);
const officeSource=readFileSync(new URL('../js/hr-pdf-office-card.js',import.meta.url),'utf8');assert.match(officeSource,/office=1/);assert.ok(!officeSource.includes('method:'));
const pub=readFileSync(new URL('../js/hr-pdf-response.js',import.meta.url),'utf8');assert.match(pub,/location.hash/);assert.match(pub,/history.replaceState/);assert.match(pub,/method:'POST'/);assert.ok(!pub.includes('?token='));assert.ok(!pub.includes('localStorage'));assert.match(pub,/agreementText/);assert.match(pub,/canRespond/);
console.log('HR PDF UI VM: XSS, explicit confirmation, double click, dialog lock, migration preview, stable retry key, permissions, token hygiene PASS');
// Public page executes its real callbacks with only synthetic PDF/API results.
const publicMap=new Map(),publicCalls=[];let current={applicantName:'本人 <A>',document:{id:'doc',kind:'offer',version:2,sha256:'hash',filename:'offer.pdf',responseMode:'offer_accept',expiresAt:'2026-12-01'},agreementText:'確認した第2版を承諾します',canRespond:true};
function pe(id){if(!publicMap.has(id))publicMap.set(id,{innerHTML:'',textContent:'',checked:false,value:'',disabled:false,click(){this.clicked=true;}});return publicMap.get(id);}
let cleanUrl=null;
const pctx=vm.createContext({document:{getElementById:pe,querySelectorAll:()=>[...publicMap.values()],createElement:()=>pe('download')},location:{hash:'#token='+'a'.repeat(64),pathname:'/hr/pdf-response.html'},history:{replaceState:(a,b,url)=>{cleanUrl=url;}},URLSearchParams,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{}},setTimeout:()=>0,console,fetch:async(url,opts)=>{const body=JSON.parse(opts.body);publicCalls.push({url,body});if(body.action==='accept')current={...current,canRespond:false};return {ok:true,json:async()=>current,blob:async()=>({fake:true})};}});
vm.runInContext(pub,pctx);await tick();
assert.equal(cleanUrl,'/hr/pdf-response.html');assert.match(pe('response-content').innerHTML,/本人 &lt;A&gt;/);assert.match(pe('response-content').innerHTML,/確認した第2版/);
pe('response-agreed').checked=true;await pe('response-submit').onclick();assert.equal(publicCalls.filter(c=>c.body.action==='accept').length,0,'cannot agree before opening PDF');
await pe('response-download').onclick();assert.ok(pe('download').clicked);assert.deepEqual(publicCalls.slice(-2).map(c=>c.body.action),['file','view']);
await pe('response-submit').onclick();assert.equal(publicCalls.filter(c=>c.body.action==='accept').length,1);
const accepted=publicCalls.find(c=>c.body.action==='accept').body;assert.equal(accepted.documentId,'doc');assert.equal(accepted.version,2);assert.equal(accepted.sha256,'hash');assert.equal(accepted.agreed,true);assert.ok(publicCalls.every(c=>!c.url.includes('token')));assert.match(pe('response-content').innerHTML,/回答済み/);
console.log('HR PDF public UI VM: fragment removal, server agreement text, PDF-before-confirm, version/hash, immutable response display PASS');
