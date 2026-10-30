// DOM-light VM fallback: actual UI module + real scoring policy. No browser/network/database.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
import {EVALUATION_AXES,evaluateScores} from '../lib/company-evaluation-policy.js';
class Element {
  constructor(){this.listeners={};this.text='';this.html='';this.values={};this.open=false;}
  addEventListener(kind,fn){this.listeners[kind]=fn;}
  set textContent(v){this.text=String(v);this.html='';} get textContent(){return this.text;}
  set innerHTML(v){this.html=String(v);this.text=this.html.replace(/<[^>]*>/g,'');} get innerHTML(){return this.html;}
}
const ids=['company-evaluation-preview','company-evaluation-results','company-evaluation-axes','company-evaluation-preview-result','company-evaluation-refresh','company-evaluation-panel'];
const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));
const calls=[];let answer;
const window={API:{api:(...args)=>{calls.push(args);return answer();}}};
const context=createContext({window,document:{getElementById:id=>elements[id]},FormData:class{constructor(form){this.values=form.values;}get(key){return this.values[key]??'';}},EVALUATION_AXES,evaluateScores,Date,console});
const code=readFileSync(new URL('../js/company-evaluation.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace('export async function load','async function load');
new Script(code+'\nglobalThis.testLoad=load;').runInContext(context);
const target=elements['company-evaluation-results'],form=elements['company-evaluation-preview'],result=elements['company-evaluation-preview-result'];
const fixture=()=>({note:'参考データ',window:{since:new Date(Date.now()-86400000).toISOString(),until:new Date().toISOString()},unmappedCount:0,complete:true,companies:[{companyName:'確認企業',sentCount:15,meetingCount:0,qualifiedCount:10,review:{status:'candidate',actions:['review_blast_only']}}]});
const submit=()=>{let prevented=false;form.listeners.submit({preventDefault(){prevented=true;}});assert(prevented);};
assert.equal((elements['company-evaluation-axes'].innerHTML.match(/<fieldset/g)||[]).length,5);
assert.equal((elements['company-evaluation-axes'].innerHTML.match(/<input/g)||[]).length,15);
assert.equal(calls.length,0,'setup must not fetch');
submit();assert.match(result.textContent,/^未評価/);
const day=new Date(Date.now()+32400000).toISOString().slice(0,10);
for(const axis of EVALUATION_AXES){form.values[axis.key+'-points']='0';form.values[axis.key+'-date']=day;form.values[axis.key+'-evidence']='<svg onload=alert(1)>根拠';}
submit();assert.match(result.textContent,/0 \/ 100点 → D候補.*未保存・未確定.*改善協議.*管理者/);assert.equal(result.innerHTML,'');assert.equal(calls.length,0);
for(const axis of EVALUATION_AXES)form.values[axis.key+'-points']=String(axis.max);
submit();assert.match(result.textContent,/100 \/ 100点 → A候補/);
form.values['response-points']='';submit();assert.match(result.textContent,/^未評価.*返信速度/);
form.values['response-points']='0';form.values['response-evidence']=' ';submit();assert.match(result.textContent,/^未評価/);
form.values['response-evidence']='確認';form.values['response-date']='2000-01-01';submit();assert.match(result.textContent,/^未評価/);
form.values['response-date']='2999-01-01';submit();assert.match(result.textContent,/^未評価/);
form.values['response-date']=day;form.values['response-points']='21';submit();assert.match(result.textContent,/^未評価/);
assert.equal(calls.length,0,'all trials must stay client-side');
answer=async()=>fixture();await context.testLoad();assert.match(target.innerHTML,/確認企業/);assert.match(target.innerHTML,/未評価/);assert.match(target.innerHTML,/ブラスト移行の審査候補/);
assert.deepEqual(calls[0],['/api/sales/company-evaluations']);
answer=async()=>{const f=fixture();f.note='<img src=x onerror=alert(1)>';f.companies[0].companyName='<svg onload=alert(2)>';f.companies[0].review.actions=['<script>bad()</script>'];return f;};
await context.testLoad();assert(!target.innerHTML.includes('<svg'));assert(!target.innerHTML.includes('<img'));assert(!target.innerHTML.includes('<script>'));assert(target.innerHTML.includes('&lt;svg'));assert(target.innerHTML.includes('&lt;script&gt;'));
answer=async()=>{throw{data:{hint:'<img src=x>読取失敗'}}};await context.testLoad();assert.equal(target.textContent,'<img src=x>読取失敗');assert.equal(target.innerHTML,'');
answer=async()=>{throw new Error('private database detail')};await context.testLoad();assert.match(target.textContent,/企業評価を取得できません/);assert(!target.textContent.includes('private database'));
answer=async()=>({...fixture(),companies:[]});await context.testLoad();assert.match(target.innerHTML,/対象の企業記録はありません/);
answer=async()=>{const f=fixture();f.complete=false;f.companies[0].review.status='unavailable';return f;};await context.testLoad();assert.match(target.innerHTML,/未完了/);assert.match(target.innerHTML,/全件・同期状態・配信種別の確認が必要/);
// Slow older response must never overwrite current result, even if it fails.
for(const rejectOld of [false,true]){
 const pending=[];answer=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const old=context.testLoad(),latest=context.testLoad();pending[1].resolve({...fixture(),note:'最新応答'});await latest;
 if(rejectOld)pending[0].reject({data:{hint:'古いエラー'}});else pending[0].resolve({...fixture(),note:'古い応答'});
 await old;assert.match(target.innerHTML,/最新応答/);assert(!target.innerHTML.includes('古い'));
}
// Lazy initial loading only when open and empty; reopening must not duplicate requests.
answer=async()=>fixture();target.textContent='';const count=calls.length;
elements['company-evaluation-panel'].listeners.toggle({target:{open:false}});assert.equal(calls.length,count);
elements['company-evaluation-panel'].listeners.toggle({target:{open:true}});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls.length,count+1);
elements['company-evaluation-panel'].listeners.toggle({target:{open:true}});assert.equal(calls.length,count+1);
assert(calls.every(args=>args.length===1&&args[0]==='/api/sales/company-evaluations'));
console.log('PASS company evaluation UI VM: form/zero/missing/stale/future evidence, D review, client-only trial, XSS escaping, read failure, empty/incomplete results, stale-success/error races, lazy load');
