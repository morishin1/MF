// Office人事労務のみ：採用決定をもとに安全なキュー、旧通知と現行PDFの状態を返す。
import assert from 'node:assert/strict';
import {createHandler} from '../api/office/hiring-documents.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const T='tenant-1';
const fixture={
 gw_hr_applicants:[
  {id:A,tenant_id:T,name:'架空 内定者',email:'test@example.test',stage:'offer',status:'offer_draft_pending',decision:'hired',offer_type:'part_time',employee_id:null,updated_at:'2026-11-15T01:00:00Z'},
  {id:B,tenant_id:T,name:'架空 待機者',stage:'applied',status:'todo',decision:null,offer_type:null,updated_at:'2026-11-15T01:00:00Z'},
  {id:'training',tenant_id:T,name:'育成枠',status:'offer_draft_pending',decision:'hired',offer_type:'training'},
  {id:'other-tenant',tenant_id:'other',name:'別会社',status:'offer_draft_pending',decision:'hired',offer_type:'part_time'}
 ],
 gw_hr_candidate_documents:[
  {applicant_id:A,tenant_id:T,kind:'terms',status:'published',created_at:'2026-11-15T01:00:00Z'},
  {applicant_id:A,tenant_id:T,kind:'employment_contract',status:'draft',created_at:'2026-11-15T01:01:00Z'}
 ],
 gw_hr_offers:[{applicant_id:A,tenant_id:T,notice_pdf_path:'test/path.pdf',sent_at:'2026-11-15T00:00:00Z',created_at:'2026-11-15T00:00:00Z',revoked_at:null}]
};
let ctx={tenantId:T,isHr:true,roles:['hr'],apps:['office']},breakDocs=false,breakLegacy=false;
const sb={from(table){
  let rows=fixture[table]||[];
  const builder={
    select(){return this;},
    eq(k,v){rows=rows.filter(r=>r[k]===v);return this;},
    in(k,values){rows=rows.filter(r=>values.includes(r[k]));return this;},
    order(k,{ascending=true}={}){rows=[...rows].sort((a,b)=>String(a[k]||'').localeCompare(String(b[k]||''))*(ascending?1:-1));return this;},
    limit(n){rows=rows.slice(0,n);return this;},
    then(resolve){return Promise.resolve({data:rows,error:breakDocs&&table==='gw_hr_candidate_documents'||breakLegacy&&table==='gw_hr_offers'?{code:'PGRST202'}:null}).then(resolve)}
  };return builder;
}};
const handler=createHandler({requireUser:async()=>({id:'test-user'}),gwContext:async()=>ctx,admin:()=>sb});
async function call(method='GET'){
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=JSON.parse(v);}};
 await handler({method,url:'/api/office/hiring-documents'},res);return res;
}
ctx={tenantId:T,roles:['recruiter'],apps:['hr'],isHr:false};
assert.equal((await call()).statusCode,403,'HR採用担当はOffice正式書類キューに入れない');
ctx={tenantId:T,roles:['finance'],apps:['office'],isHr:false};
assert.equal((await call()).statusCode,403,'Office経理も労務へ入れない');
ctx={tenantId:T,isHr:true,roles:['hr'],apps:['office']};
let res=await call();assert.equal(res.statusCode,200);
assert.equal(res.body.ready,true);
assert.equal(res.body.candidates.length,1,'本人と同一テナント・内定済みだけ、育成枠は除外');
assert.equal(res.body.pending,1);
assert.equal(res.body.candidates[0].workflow.offer,'旧通知で本人へ送付済み');
assert.equal(res.body.candidates[0].workflow.phase,'contract_review');
assert.equal(res.body.candidates[0].workflow.terms,'本人に公開済み');
assert.equal(res.body.candidates[0].workflow.contract,'アップロード済み（未公開）');
assert.ok(!JSON.stringify(res.body).includes('test/path.pdf'),'Storageの内部パスを返さない');
assert.ok(!JSON.stringify(res.body).includes('架空 待機者'),'未採用・他社のデータを返さない');
breakLegacy=true;res=await call();assert.equal(res.statusCode,200,'旧通知の状態取得失敗でも新台帳は参照できる');
assert.equal(res.body.candidates[0].workflow.offer,'旧通知の状況はHRで確認','旧通知を未発行と誤認しない');
breakLegacy=false;breakDocs=true;res=await call();
assert.equal(res.statusCode,503,'書類台帳を取得できないときは未提出と表示しない');
assert.equal(res.body.ready,false);
console.log('PASS Office handoff queue: role/tenant checks, legacy sent offer, actual PDF status, fail-closed');
