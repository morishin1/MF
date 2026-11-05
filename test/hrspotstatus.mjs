// Status transitions use the real handlers with an isolated, tenant-aware mock DB.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
const ID='12345678-1234-4234-8234-123456789012',TENANT='tenant-test';
let stored,logs,role,concurrent,dbFailure;
function seed(overrides={}){
 stored={id:ID,tenant_id:TENANT,name:'ステータス確認用',status:'closed',applicant_id:null,deleted_at:null,
 survey_sent_at:null,survey_answered_at:null,survey_answers:null,survey_token_hash:null,survey_expires_at:null,
 staff_scores:null,scored_at:null,staff_note:'保持するメモ',updated_at:'2026-11-05T01:00:00Z',...overrides};
 logs=[];role=true;concurrent=null;dbFailure=null;
}
function table(){
 let conditions=[],patch,fields;
 const q={select(s){fields=s;return q;},eq(k,v){conditions.push([k,v]);return q;},is(k,v){conditions.push([k,v]);return q;},
 update(v){patch=v;return q;},async maybeSingle(){
  if(patch&&concurrent){Object.assign(stored,concurrent);concurrent=null;}
  if(patch&&dbFailure)return {data:null,error:dbFailure};
  if(!conditions.every(([k,v])=>stored[k]===v))return {data:null,error:null};
  if(patch)Object.assign(stored,patch);
  return {data:structuredClone(fields==='*'?stored:Object.fromEntries(fields.split(',').map(k=>[k,stored[k]]))),error:null};
 }};
 return q;
}
const at=p=>new URL('../'+p,import.meta.url).pathname;
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>({from:()=>table()})}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:'actor'})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:TENANT}),canRecruit:()=>role}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async e=>logs.push(e)}});
const {default:handler}=await import(at('api/hr/spot.js'));
const {default:survey}=await import(at('api/hr/spot-survey.js'));
async function call(body,fn=handler){
 const res={statusCode:0,setHeader(){},end(s){this.body=JSON.parse(s);}};
 await fn({method:'POST',body},res);return res;
}
const mark=(status,extra={})=>call({action:'mark',id:ID,status,expectedStatus:stored.status,...extra});
let count=0;
async function check(title,fn){seed();await fn();console.log('  ok '+title);count++;}
await check('回答待ちに戻すとQR用URLを再発行でき、旧URLは無効・新URLは利用可能',async()=>{
 const old='a'.repeat(64);
 Object.assign(stored,{survey_sent_at:'2026-11-05T01:00:00Z',survey_token_hash:createHash('sha256').update(old).digest('hex'),survey_expires_at:'2099-01-01T00:00:00Z',status:'invited'});
 assert.equal((await mark('closed')).statusCode,200);
 assert.equal(stored.survey_token_hash,null);
 assert.equal((await call({action:'check',token:old},survey)).statusCode,410);
 assert.equal((await mark('invited')).statusCode,200);
 const r=await call({action:'invite',id:ID});assert.equal(r.statusCode,200);
 assert.match(r.body.url,/^\/hr\/spot-survey.html#token=[a-f0-9]{64}$/);
 const token=r.body.url.split('token=')[1];
 assert.equal((await call({action:'check',token},survey)).statusCode,200);
 assert.equal((await call({action:'check',token:old},survey)).statusCode,410);
 assert.equal(stored.staff_note,'保持するメモ');
 assert.deepEqual(logs.map(l=>l.detail),[{from:'invited',to:'closed'},{from:'closed',to:'invited'}]);
});
await check('未発行の終了人材を未送付に戻す',async()=>{
 assert.equal((await mark('registered')).statusCode,200);assert.equal(stored.status,'registered');
 assert.equal((await call({action:'invite',id:ID})).statusCode,200);
});
await check('回答済みで再開しても本人回答・評価・メモ・同意を保持',async()=>{
 Object.assign(stored,{survey_answered_at:'2026-11-04T00:00:00Z',survey_answers:{longTerm:'条件が合えば'},staff_scores:[1,2,3,4,5],contact_consent:true});
 const before=structuredClone(stored);
 assert.equal((await mark('answered')).statusCode,200);
 for(const k of ['survey_answered_at','survey_answers','staff_scores','staff_note','contact_consent'])assert.deepEqual(stored[k],before[k]);
 assert.equal((await call({action:'invite',id:ID})).statusCode,409);
 assert.equal((await mark('evaluated')).statusCode,200);
 assert.equal((await mark('candidate')).statusCode,200);
});
await check('実績のない回答済み・評価済み・候補・回答待ちへは変更不可',async()=>{
 for(const status of ['invited','answered','evaluated','candidate'])assert.equal((await mark(status)).statusCode,409,status);
 assert.equal(stored.status,'closed');assert.equal(logs.length,0);
});
await check('採用候補には評価に加えて本人の同意と継続希望が必要',async()=>{
 stored.staff_scores=[5,5,5,5,5];stored.survey_answered_at='2026-11-05';
 assert.equal((await mark('candidate')).statusCode,409);
 stored.contact_consent=true;stored.survey_answers={longTerm:'希望しない'};
 assert.equal((await mark('candidate')).statusCode,409);
});
await check('送付・回答・評価の記録がある場合は未送付に戻せない',async()=>{
 for(const key of ['survey_sent_at','survey_answered_at','scored_at']){
  seed({[key]:'2026-11-05'});assert.equal((await mark('registered')).statusCode,409);
 }
});
await check('削除済み・選考引継ぎ済みは変更不可',async()=>{
 for(const data of [{deleted_at:'2026-11-05'},{applicant_id:'applicant'},{status:'converted'}]){
  seed(data);assert.equal((await mark('registered')).statusCode,409);assert.equal(logs.length,0);
 }
});
await check('権限・テナント境界を維持',async()=>{
 role=false;assert.equal((await mark('registered')).statusCode,403);
 role=true;stored.tenant_id='other';assert.equal((await mark('registered')).statusCode,404);
});
await check('表示後に状態が変わった場合は上書きしない',async()=>{
 assert.equal((await mark('registered',{expectedStatus:'invited'})).statusCode,409);assert.equal(stored.status,'closed');
});
await check('同時更新・削除・引継ぎは成功扱いにしない',async()=>{
 for(const change of [{updated_at:'2026-11-05T02:00:00Z'},{deleted_at:'2026-11-05'},{applicant_id:'applicant'},{status:'converted'}]){
  seed();concurrent=change;assert.equal((await mark('registered')).statusCode,409);assert.equal(logs.length,0);
 }
});
await check('QR発行中の終了・削除・更新では利用不能なURLを返さない',async()=>{
 for(const change of [{status:'closed'},{deleted_at:'2026-11-05'},{updated_at:'2026-11-05T03:00:00Z'}]){
  seed({status:'invited'});concurrent=change;
  const r=await call({action:'invite',id:ID});assert.equal(r.statusCode,409);assert.equal(r.body.url,undefined);
 }
});
await check('保存エラーは状態を保持し、成功として返さない',async()=>{
 dbFailure={code:'23514'};assert.equal((await mark('registered')).statusCode,500);assert.equal(stored.status,'closed');
});
await check('旧スキーマでも単体の終了取消は利用可能',async()=>{
 delete stored.deleted_at;assert.equal((await mark('registered')).statusCode,200);
});
await check('回答送信中の終了で管理状態を回答済みに巻き戻さない',async()=>{
 const token='b'.repeat(64);
 Object.assign(stored,{status:'invited',survey_token_hash:createHash('sha256').update(token).digest('hex'),survey_expires_at:'2099-01-01T00:00:00Z'});
 concurrent={status:'closed'};
 const r=await call({action:'submit',token,answers:{experience:'普通',longTerm:'単発のみ',weekly:'希望しない／未定',start:'未定',days:[],hours:[],interests:[],comment:'',contactConsent:false}},survey);
 assert.equal(r.statusCode,409);assert.equal(stored.status,'closed');assert.equal(stored.survey_answered_at,null);
});
console.log(`HRスポット状態変更API: ${count}/${count} tests`);
