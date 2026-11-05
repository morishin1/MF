// Run the real page event handlers in a minimal DOM harness; no browser/login or live data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const page=readFileSync(new URL('../hr/spot.html',import.meta.url),'utf8');
const script=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function detail('));
const ID='12345678-1234-4234-8234-123456789012';
let record,requests,questions,answer,fail;
const nodes=new Map();
const node=id=>{
 if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,scrollTop:0,listeners:{},
 addEventListener(type,fn){this.listeners[type]=fn;},querySelectorAll(){return [];}});
 return nodes.get(id);
};
const context={document:{getElementById:node},location:{origin:'https://example.test'},URL,console,
 confirm:text=>{questions.push(text);return answer;},alert:()=>{},
 HRLayout:{init:()=>Promise.resolve(null)},
 API:{api:async(url,options)=>{
  if(!options)return {people:[structuredClone(record)]};
  requests.push(options.body);if(fail)throw Error('保存失敗');
  if(options.body.action==='mark'){record.status=options.body.status;return {person:{id:ID,status:record.status},ok:true};}
  if(options.body.action==='invite'){record.status='invited';return {url:'/hr/spot-survey.html#token='+'a'.repeat(64),expiresAt:'2099-01-01'};}
  if(options.body.action==='bulk'){record.status='closed';return {changed:1};}
 }}
};
runInNewContext(readFileSync(new URL('../js/vendor/qrcode-generator.js',import.meta.url),'utf8'),context);
runInNewContext(script.replace('HRLayout.init(', 'globalThis.testSpot={detail,load,bulkAction,select:id=>selected.add(id)};HRLayout.init('),context);
async function seed(extra={}){
 record={id:ID,name:'テスト人材',source:'タイミー',worked_on:'2026-11-05',status:'closed',applicant_id:null,deleted_at:null,
 survey_sent_at:'2026-11-05',survey_answered_at:null,staff_scores:null,...extra};
 requests=[];questions=[];answer=false;fail=false;node('filter').value='';
 await context.testSpot.load();context.testSpot.detail(ID);
}
const click=action=>node('drawer').listeners.click({target:{closest:()=>({dataset:{action}})}});
await seed();
assert.match(node('drawer').innerHTML,/ステータス変更/);
assert.match(node('drawer').innerHTML,/value="invited"/);
assert.doesNotMatch(node('drawer').innerHTML,/data-action="invite"/);
node('spotStatus').value='invited';await click('status');
assert.equal(requests.length,0,'cancel reopen must not write');assert.equal(record.status,'closed');
answer=true;await click('status');
assert.equal(record.status,'invited');assert.equal(requests[0].expectedStatus,'closed');
assert.match(node('drawer').innerHTML,/アンケートURL・QRコードを再発行/);
assert.match(node('rows').innerHTML,/回答待ち/);
answer=false;await click('invite');assert.equal(requests.length,1,'cancel reissue must not write');
answer=true;await click('invite');assert.equal(requests.length,2);
assert.match(node('spotQR').innerHTML,/<svg/,'reissued QR rendered by bundled QR generator');
assert.match(node('spotQR').innerHTML,/アンケートURLのQRコード/);
console.log('  ok 終了取消のキャンセル・保存・一覧反映・QR再発行');
await seed({status:'invited'});
await click('closed');assert.equal(requests.length,0);
assert.match(questions.at(-1),/QRコードは利用できなく/);
answer=true;fail=true;await click('closed');
assert.equal(record.status,'invited');assert.equal(node('overlay').hidden,false,'failed close must leave detail open');
fail=false;await click('closed');assert.equal(record.status,'closed');
assert.match(node('drawer').innerHTML,/ステータス変更/);assert.equal(node('overlay').hidden,false);
console.log('  ok 個別終了の確認・キャンセル・失敗・成功後も詳細維持');
await seed({status:'invited'});context.testSpot.select(ID);
await context.testSpot.bulkAction('closed');assert.equal(requests.length,0);
assert.match(questions.at(-1),/QRコードは利用できなく/);
answer=true;await context.testSpot.bulkAction('closed');assert.equal(requests.at(-1).bulkAction,'closed');
console.log('  ok 一括終了にも影響を明示し、キャンセル時は変更しない');
await seed({status:'converted',applicant_id:'existing'});
assert.doesNotMatch(node('drawer').innerHTML,/id="spotStatus"/);
console.log('  ok 引き継ぎ済みは状態変更を表示しない');
console.log('HRスポット画面イベント・QR生成テスト OK');
