// Real editor JS with minimum DOM/FormData facade. Only fake API calls; no network or DB.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
import {EVALUATION_AXES} from '../lib/company-evaluation-policy.js';
class Element {
 constructor(){this.listeners={};this.values={};this.buttons=[{disabled:false},{disabled:false}];this.html='';this.text='';this.hidden=true;}
 addEventListener(k,f){this.listeners[k]=f;}
 querySelectorAll(selector){assert.equal(selector,'button');return this.buttons;}
 set textContent(v){this.text=String(v);this.html='';}get textContent(){return this.text;}
 set innerHTML(v){this.html=String(v);this.text=this.html.replace(/<[^>]*>/g,'');}get innerHTML(){return this.html;}
}
function harness(){
 const ids=['company-evaluation-editor','company-evaluation-save-form','company-evaluation-save-message'];
 const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));
 const events={},calls=[];let answer=async()=>fixture();let nonce=0;
 const window={addEventListener:(k,f)=>events[k]=f,API:{api:async(...args)=>{calls.push(args);return answer(...args);}}};
 const context=createContext({window,document:{getElementById:id=>elements[id]},EVALUATION_AXES,Date,encodeURIComponent,
  crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++nonce).padStart(12,'0')}`},
  FormData:class{constructor(form){this.values=form.values;}get(k){return this.values[k]??'';}has(k){return Object.hasOwn(this.values,k);}}});
 const code=readFileSync(new URL('../js/company-evaluation-editor.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
 new Script(code+'\nglobalThis.editorTest={load,save};').runInContext(context);
 return {elements,events,calls,api:context.editorTest,setAnswer:f=>answer=f};
}
function fixture(id='company-1') {return {company:{id,name:'検証用企業'},current:{revision:'9007199254740993',evaluation:{status:'draft',scores:{},reason:''}},canConfirm:true,history:[]};}
function fill(form){
 for(const a of EVALUATION_AXES){form.values[a.key+'-points']='0';form.values[a.key+'-date']='2026-10-30';form.values[a.key+'-evidence']='確認済み根拠';}
 Object.assign(form.values,{rank:'D',policy:'stopped',reason:'改善協議でも進展なし',improvementDiscussed:'on',noProgressConfirmed:'on'});
}
function event(form,action='confirmed'){return {currentTarget:form,submitter:{value:action},preventDefault(){this.prevented=true;}};}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
// Success, exact revision, D checkboxes, server-owned tenant/actor never sent.
{
 const h=harness();await h.api.load('company-1');const form=h.elements['company-evaluation-save-form'];fill(form);
 h.setAnswer(async(path,options)=>options?{status:'saved'}:fixture());const e=event(form);await h.api.save(e);assert(e.prevented);
 const writes=h.calls.filter(([,options])=>options?.method==='POST');assert.equal(writes.length,1);
 const [path,options]=writes[0];assert.equal(path,'/api/sales/company-evaluations/detail');
 const b=options.body;assert.equal(b.company_id,'company-1');assert.equal(b.expected_revision,'9007199254740993');assert.equal(typeof b.expected_revision,'string');
 assert.equal(b.status,'confirmed');assert.equal(b.rank,'D');assert.equal(b.policy,'stopped');assert.equal(b.improvementDiscussed,true);assert.equal(b.noProgressConfirmed,true);
 assert.equal(b.scores.outcomes.points,0);assert.equal(b.scores.outcomes.observedAt,'2026-10-30T00:00:00+09:00');
 assert(!Object.keys(b).some(k=>/tenant|actor|updated_by|enforcement|scoreMethod/.test(k)));assert.match(b.request_id,/^[0-9a-f-]{36}$/);
 assert.equal(h.calls.length,3,'load, one save, one reconciliation read');assert.match(h.elements['company-evaluation-save-message'].textContent,/保存しました.*停止・配信設定は変更していません/);
}
// First-save draft, unchecked D flags, missing point is null not zero.
{
 const h=harness();h.setAnswer(async()=>({...fixture(),current:null}));await h.api.load('company-1');const f=h.elements['company-evaluation-save-form'];fill(f);delete f.values.improvementDiscussed;delete f.values.noProgressConfirmed;f.values['outcomes-points']='';
 await h.api.save(event(f,'draft'));const b=h.calls.find(([,o])=>o?.method==='POST')[1].body;
 assert.equal(b.expected_revision,'0');assert.equal(b.status,'draft');assert.equal(b.scores.outcomes.points,null);assert.equal(b.improvementDiscussed,false);assert.equal(b.noProgressConfirmed,false);
}
// Forbidden UI cannot submit; unknown submitter cannot trigger a write.
{
 const h=harness();h.setAnswer(async()=>({...fixture(),canConfirm:false}));await h.api.load('company-1');assert.match(h.elements['company-evaluation-editor'].innerHTML,/<fieldset disabled>/);
 await h.api.save(event(h.elements['company-evaluation-save-form']));assert.equal(h.calls.length,1);
 h.setAnswer(async()=>fixture());await h.api.load('company-1');await h.api.save(event(h.elements['company-evaluation-save-form'],'delete'));assert.equal(h.calls.length,2);
}
// 409, 503 and uncertain network outcome: exactly one POST, then GET, never automatic retry.
for(const error of [{status:409},{status:503,hint:'DB準備待ち'},{message:'network lost'}]){
 const h=harness();await h.api.load('company-1');const f=h.elements['company-evaluation-save-form'];fill(f);
 h.setAnswer(async(_path,options)=>{if(options)throw error;return fixture();});await h.api.save(event(f));
 assert.equal(h.calls.filter(([,o])=>o?.method==='POST').length,1);assert.equal(h.calls.length,3);
 assert.match(h.elements['company-evaluation-save-message'].textContent,error.status===409?/競合.*編集し直し/:/保存完了を確認できません.*自動再送せず/);
}
// Busy save suppresses duplicate submit AND selection of a different company.
{
 const h=harness();await h.api.load('company-1');const f=h.elements['company-evaluation-save-form'];fill(f);let finish;
 h.setAnswer((_path,options)=>options?new Promise(resolve=>finish=resolve):Promise.resolve(fixture()));
 const saving=h.api.save(event(f));assert(f.buttons.every(b=>b.disabled));
 await h.api.save(event(f));await h.api.load('company-2');h.events['company-evaluation-selected']({detail:{companyId:'company-3'}});
 assert.equal(h.calls.length,2);finish({status:'saved'});await saving;assert.equal(h.calls.length,3);assert.match(h.calls[2][0],/company_id=company-1$/);
}
// Late success/failure for an old company cannot overwrite a new selection.
for(const rejectOld of [false,true]){
 const h=harness(),pending=[];h.setAnswer(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
 const old=h.api.load('old'),latest=h.api.load('latest');pending[1].resolve({...fixture('latest'),company:{id:'latest',name:'最新企業'}});await latest;
 if(rejectOld)pending[0].reject({hint:'古いエラー'});else pending[0].resolve({...fixture('old'),company:{id:'old',name:'古い企業'}});
 await old;assert.match(h.elements['company-evaluation-editor'].innerHTML,/最新企業/);assert(!h.elements['company-evaluation-editor'].textContent.includes('古い'));
}
// Company/evidence/reason/history HTML must be escaped, and error hints use textContent.
{
 const h=harness();const malicious='<img src=x onerror="globalThis.xss=1">';const f=fixture();f.company.name=malicious;f.current.evaluation.reason=malicious;f.current.evaluation.scores.outcomes={points:0,evidence:malicious};f.history=[{revision:'1',created_at:malicious,evaluation:{status:malicious,rank:malicious,reason:malicious}}];
 h.setAnswer(async()=>f);await h.api.load('x & y');const html=h.elements['company-evaluation-editor'].innerHTML;assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('&quot;'));assert.match(h.calls[0][0],/company_id=x%20%26%20y$/);
 h.setAnswer(async()=>{throw {hint:malicious};});await h.api.load('failure');assert.equal(h.elements['company-evaluation-editor'].textContent,malicious);assert.equal(h.elements['company-evaluation-editor'].innerHTML,'');
}
// A failed reconciliation read does not trigger a retrying write.
{
 const h=harness();await h.api.load('company-1');const f=h.elements['company-evaluation-save-form'];fill(f);h.setAnswer(async(_p,o)=>{if(o)throw {status:503};throw {hint:'最新状態の読取も失敗'};});await h.api.save(event(f));assert.equal(h.calls.length,3);assert.equal(h.elements['company-evaluation-editor'].textContent,'最新状態の読取も失敗');
}
// Known validation errors preserve all inputs, unlock buttons, and do not read or retry.
for(const status of [400,422]){
 const h=harness();await h.api.load('company-1');const f=h.elements['company-evaluation-save-form'];fill(f);
 const snapshot=JSON.stringify(f.values);h.setAnswer(async()=>{throw {status,hint:'<img src=x>入力を確認'};});
 await h.api.save(event(f));assert.equal(h.calls.length,2,'No reconciliation GET on validation error');
 assert.equal(JSON.stringify(f.values),snapshot);assert(f.buttons.every(b=>!b.disabled));
 assert.equal(h.elements['company-evaluation-save-message'].textContent,'<img src=x>入力を確認');
 assert.equal(h.elements['company-evaluation-save-message'].innerHTML,'');
 // busy is cleared by finally; an explicit user correction can submit once again.
 h.setAnswer(async(_p,o)=>o?{status:'saved'}:fixture());await h.api.save(event(f));
 assert.equal(h.calls.filter(([,o])=>o?.method==='POST').length,2);assert.equal(h.calls.length,4);
}
console.log('PASS company evaluation editor VM: save/reconcile, 400/422 preserve inputs, 409/503/unknown no auto-resend, no client tenant/actor, string revision, D flags, XSS, stale loads, busy suppression');
