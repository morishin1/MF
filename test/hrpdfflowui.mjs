// Real UI code in minimal DOM. Not a browser/layout or live API test.
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../js/hr-pdf-flow-ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function harness(data,now=Date.now()){
 const map=new Map(),calls=[],events={};let next=null;
 class Clock extends Date {static now(){return now;}}
 function el(id){if(!map.has(id))map.set(id,{id,innerHTML:'',textContent:'',value:'',checked:false,disabled:false,files:[],attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},focus(){this.focused=true;},events:{},addEventListener(k,f){this.events[k]=f;},showModal(){this.open=true;},close(){this.open=false;},click(){this.clicked=true;}});return map.get(id);}
 const document={getElementById:el,querySelectorAll:()=>[...map.values()],createElement:()=>el('created')};
 const ctx=vm.createContext({document,location:{search:'?applicantId=one'},window:{addEventListener(k,f){events[k]=f;}},Date:Clock,URLSearchParams,crypto:webcrypto,console,fetch:async()=>({ok:true}),API:{api:async(url,opts)=>{calls.push({url,body:opts?.body});if(!opts)return data;if(next)return next(opts.body);return {};}}});
 vm.runInContext(source,ctx);
 return {el,calls,ctx,focus:()=>events.focus(),advance:ms=>now+=ms,setNext:fn=>next=fn,click:type=>el('pdf-content').events.click({target:{closest:()=>({dataset:{act:type,doc:'d1'}})}})};
}
const base={enabled:true,canStart:true,canManage:true,canMigrateLegacy:true,applicant:{name:'<script>bad</script>',email:'test@example.test'},flow:null,documents:[]};
const now=Date.parse('2026-10-30T00:00:00Z');
const sent={id:'d1',kind:'offer',version:1,filename:'test.pdf',sha256:'fake',state:'sent',current:true,expiresAt:'2026-10-30T00:00:00Z'};
for(const [label,patch,expired] of [
 ['at boundary',{},true],['past',{expiresAt:'2026-10-29T23:59:59Z'},true],
 ['future',{expiresAt:'2026-10-30T00:00:01Z'},false],
 ['responded',{state:'responded',respondedAt:'2026-10-29T23:00:00Z'},false],
 ['revoked',{state:'revoked',current:false},false],['superseded',{state:'superseded',current:false},false],
 ['draft',{state:'draft'},false],['unknown',{state:'unknown'},false],
 ['missing',{expiresAt:null},false],['malformed',{expiresAt:'<script>bad</script>'},false],
 ['terms',{kind:'terms'},true]
]){
 const t=harness({...base,flow:{phase:'offer_waiting'},documents:[{...sent,...patch}]},now);await tick();
 const html=t.el('pdf-content').innerHTML;
 assert.equal(html.includes('回答期限切れ'),expired,label);
 assert.equal(t.calls.filter(c=>c.body).length,0,label+' display has no writes');
 if(expired){assert.match(html,/保存・閲覧は引き続き可能/);assert.match(html,/（日本時間）/);}
 if(label==='at boundary')assert.match(html,/2026\/10\/30 09:00/);
 if(label==='malformed')assert.ok(!html.includes('<script>bad</script>'));
}
const elapsed=harness({...base,flow:{phase:'offer_waiting'},documents:[{...sent,expiresAt:'2026-10-30T00:00:01Z'}]},now);await tick();
assert.ok(!elapsed.el('pdf-content').innerHTML.includes('回答期限切れ'));elapsed.advance(1000);elapsed.focus();
assert.match(elapsed.el('pdf-content').innerHTML,/回答期限切れ/);
assert.equal(elapsed.calls.filter(c=>c.body).length,0);
console.log('HR PDF deadlines VM: boundary/future/past, responded/revoked/superseded/draft/unknown, malformed/missing, terms, JST, focus refresh and no mutation PASS');
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
// Office card must await the same server-provided access gate as the page.
const layoutSource=readFileSync(new URL('../js/layout.js',import.meta.url),'utf8');
const officeGate=vm.runInNewContext('('+layoutSource.match(/function hasAccess\(me, key\) \{[\s\S]*?\n  \}/)[0]+')');
function officeHarness(identity,data={enabled:true,flows:[]}){
 const calls=[],shown=[];let resolveMe,rejectMe;
 const pending=new Promise((resolve,reject)=>{resolveMe=resolve;rejectMe=reject;});
 const host={prepend:node=>shown.push(node)};
 const ctx=vm.createContext({API:{me:()=>pending,api:async url=>{calls.push(url);return data;}},KPLayout:{hasAccess:officeGate},document:{querySelector:()=>host,body:host,createElement:()=>({style:{},setAttribute(){}})}});
 vm.runInContext(officeSource,ctx);return {calls,shown,resolve:()=>resolveMe(identity),reject:()=>rejectMe(new Error('identity unavailable'))};
}
for(const identity of [{appRole:'member',access:{officeHr:false}},{appRole:'owner',access:{officeHr:false}},{appRole:'member',access:{}},{appRole:'sr',access:{officeHr:true}},null]){
 const card=officeHarness(identity);await tick();assert.equal(card.calls.length,0,'no HR request before identity');card.resolve();await tick();assert.equal(card.calls.length,0,'no HR request without Office HR access');assert.equal(card.shown.length,0);
}
const lostIdentity=officeHarness(null);lostIdentity.reject();await tick();assert.equal(lostIdentity.calls.length,0);assert.equal(lostIdentity.shown.length,0);
for(const identity of [{appRole:'member',access:{officeHr:true}},{appRole:'owner',access:{officeHr:true}}]){
 const card=officeHarness(identity,{enabled:true,flows:[{applicantId:'one',applicantName:'<Candidate>',phase:'onboarding'}]});card.resolve();await tick();assert.deepEqual(card.calls,['/api/hr/pdf-flow?office=1']);assert.equal(card.shown.length,1);assert.match(card.shown[0].innerHTML,/&lt;Candidate&gt;/);
}
const disabledCard=officeHarness({access:{officeHr:true}},{enabled:false});disabledCard.resolve();await tick();assert.equal(disabledCard.shown.length,0);
console.log('Office PDF card: pending/denied/missing/SR/failed identity makes no HR request; authorized role renders escaped GET-only card PASS');
const pub=readFileSync(new URL('../js/hr-pdf-response.js',import.meta.url),'utf8');assert.match(pub,/location.hash/);assert.match(pub,/history.replaceState/);assert.match(pub,/method:'POST'/);assert.ok(!pub.includes('?token='));assert.ok(!pub.includes('localStorage'));assert.match(pub,/agreementText/);assert.match(pub,/canRespond/);
console.log('HR PDF UI VM: XSS, explicit confirmation, double click, dialog lock, migration preview, stable retry key, permissions, token hygiene PASS');
// Form correction paths reproduce the reported checked-but-old-error and invalid send details.
const formData={...base,flow:{phase:'offer_preparing',version:1},documents:[{...sent,state:'draft'}]};
const form=harness(formData,now);await tick();form.click('send');
assert.equal(form.el('pdf-dialog-submit').textContent,'送付内容を確認');
await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-dialog-error').textContent,/チェック/);
form.el('pdf-confirm').checked=true;
form.el('pdf-dialog-content').events.change({target:form.el('pdf-confirm')});
assert.equal(form.el('pdf-dialog-error').textContent,'','checking clears previous validation feedback');
await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-expiry-error').textContent,/入力/);
assert.equal(form.el('pdf-expiry').attributes['aria-invalid'],'true');assert.equal(form.el('pdf-expiry-error').hidden,false);
form.el('pdf-expiry').value='2026-10-30T00:00:00Z';await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-expiry-error').textContent,/現在より後/);
form.el('pdf-expiry').value='2027-02-01T00:00:00Z';await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-expiry-error').textContent,/90日/);
form.el('pdf-expiry').value='2026-10-31T00:00:00Z';
form.el('pdf-dialog-content').events.input({target:form.el('pdf-expiry')});
assert.equal(form.el('pdf-expiry-error').hidden,true);assert.equal(form.el('pdf-expiry').attributes['aria-invalid'],undefined);
await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-requested-at-error').textContent,/入力/);
form.el('pdf-requested-at').value='2026-10-31T00:00:00Z';await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-requested-at-error').textContent,/未来/);
form.el('pdf-requested-at').value='2026-10-29T23:00:00Z';await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-evidence-error').textContent,/5〜1000文字/);
form.el('pdf-evidence').value='    ';await form.el('pdf-dialog-submit').onclick();assert.match(form.el('pdf-evidence-error').textContent,/5〜1000文字/);
assert.equal(form.calls.filter(c=>c.body).length,0,'invalid fields never reach preview/send API');
form.el('pdf-evidence').value='本人メールでPDF受取の希望を確認';
form.setNext(async()=>{throw new Error('send_details_required');});await form.el('pdf-dialog-submit').onclick();
assert.match(form.el('pdf-dialog-error').textContent,/送信設定/);assert.ok(!form.el('pdf-dialog-error').textContent.includes('send_details_required'));
assert.equal(form.el('pdf-evidence').value,'本人メールでPDF受取の希望を確認','failure retains evidence');
form.setNext(async()=>({confirmation:{to:'test@example.test',filename:'test.pdf',version:1,digest:'digest'}}));await form.el('pdf-dialog-submit').onclick();
assert.equal(form.el('pdf-dialog-submit').textContent,'この内容で送信');assert.match(form.el('pdf-dialog-content').innerHTML,/回答期限/);
assert.equal(form.calls.filter(c=>c.body?.action==='send').length,0,'preview never sends');
const upload=harness(formData,now);await tick();upload.click('upload');
assert.equal(upload.el('pdf-dialog-submit').textContent,'PDFを登録');assert.match(upload.el('pdf-dialog-content').innerHTML,/まだ送信されません/);
assert.match(upload.el('pdf-dialog-content').innerHTML,/<details/);assert.match(upload.el('pdf-dialog-content').innerHTML,/class="pdf-check"/);
const css=readFileSync(new URL('../css/hr-pdf-flow.css',import.meta.url),'utf8');
assert.match(css,/input\[type=checkbox\]\{width:18px/);assert.match(css,/label\.pdf-check\{display:flex/);
console.log('HR PDF simple forms VM: explicit labels, checkbox stale-error correction, per-field required/past/future/90-day/evidence validation, Japanese API fallback, retained input and no accidental sends PASS');
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
