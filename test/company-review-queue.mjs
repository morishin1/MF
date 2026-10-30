// Real review-queue JS with tiny DOM facade and fake read-only API.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const root={listeners:{},html:'',text:'',addEventListener(k,f){this.listeners[k]=f;},set textContent(v){this.text=String(v);this.html='';},get textContent(){return this.text;},set innerHTML(v){this.html=String(v);this.text=this.html.replace(/<[^>]*>/g,'');},get innerHTML(){return this.html;}};
const fixture=()=>({page:0,scope:'assigned',linkEnabled:false,hasMore:true,items:[{companyName:'検証企業',kind:'alert_owner',counts:{sentCount:15,meetingCount:0,qualifiedCount:10},assignmentKnown:false,deadlineKnown:false,last_seen:new Date(Date.now()-86400001).toISOString()}]});
let answer=async()=>fixture();const calls=[];
const context=createContext({document:{getElementById:id=>{assert.equal(id,'company-review-queue');return root;}},window:{API:{api:(...args)=>{calls.push(args);return answer(...args);}}},Date,Math,Number});
new Script(readFileSync(new URL('../js/company-review-queue.js',import.meta.url),'utf8')+'\nglobalThis.queueTest={load};').runInContext(context);
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(calls.length,1);assert.deepEqual(calls[0],['/api/sales/company-evaluations/review-tasks?page=0']);
assert.match(root.innerHTML,/自分の担当/);assert.match(root.innerHTML,/連携は有効化待ち/);assert.match(root.innerHTML,/担当未設定/);assert.match(root.innerHTML,/期限未設定/);assert.match(root.innerHTML,/返答待ち等5/);assert.match(root.innerHTML,/24時間以上前/);assert.match(root.innerHTML,/data-page="-1" disabled/);
let before=calls.length;root.listeners.click({target:{closest:()=>({disabled:true,dataset:{page:'-1'}})}});assert.equal(calls.length,before);
answer=async()=>({...fixture(),page:1,scope:'team',linkEnabled:true,hasMore:false});root.listeners.click({target:{closest:()=>({disabled:false,dataset:{page:'1'}})}});await new Promise(resolve=>setTimeout(resolve,0));assert.match(calls.at(-1)[0],/page=1$/);assert.match(root.innerHTML,/2ページ/);assert.match(root.innerHTML,/data-page="2" disabled/);assert(!root.innerHTML.includes('自分の担当'));assert(!root.innerHTML.includes('有効化待ち'));
answer=async()=>({...fixture(),items:[]});await context.queueTest.load();assert.match(root.innerHTML,/集計の未実施・未取得を確認事項ゼロとは断定しません/);
answer=async()=>{const f=fixture(),r=f.items[0];r.companyName='<img src=x onerror=alert(1)>';r.kind='<script>bad()</script>';r.assignmentKnown=true;r.deadlineKnown=true;r.due_at='<svg onload=alert(2)>';r.last_seen='<img src=x>';return f;};await context.queueTest.load();assert(!root.innerHTML.includes('<img'));assert(!root.innerHTML.includes('<script>'));assert(!root.innerHTML.includes('<svg'));assert(root.innerHTML.includes('&lt;img'));assert.match(root.innerHTML,/担当者に割当済み/);
answer=async()=>{throw {hint:'<img src=x>取得失敗'};};await context.queueTest.load();assert.equal(root.textContent,'<img src=x>取得失敗');assert.equal(root.innerHTML,'');
answer=async()=>{throw new Error('private detail');};await context.queueTest.load();assert.match(root.textContent,/未取得/);assert(!root.textContent.includes('private detail'));
for(const rejectOld of [false,true]){
 const pending=[];answer=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));const old=context.queueTest.load(0),latest=context.queueTest.load(1);
 pending[1].resolve({...fixture(),page:1,items:[{...fixture().items[0],companyName:'最新企業'}]});await latest;
 if(rejectOld)pending[0].reject({hint:'古い失敗'});else pending[0].resolve({...fixture(),items:[{...fixture().items[0],companyName:'古い企業'}]});await old;
 assert.match(root.innerHTML,/最新企業/);assert(!root.textContent.includes('古い'));
}
assert(calls.every(args=>args.length===1&&args[0].startsWith('/api/sales/company-evaluations/review-tasks?page=')),'Only read calls');
console.log('PASS company review queue VM: assigned/team, disabled link/unknown ownership/deadline, stale warning, bounded nav, empty != uncollected, XSS, errors, stale response races, no writes');
