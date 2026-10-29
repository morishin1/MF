import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acceptanceEvidence, normalizeSalesRequest, normalizeOfficeUpdate, shapeRequestEnvelope, STATUS_TRANSITIONS } from '../lib/sales-contract-requests.js';

let count=0;
const test=async (name,fn)=>{ await fn(); count++; console.log('ok',name); };
const id='00000001-0000-4000-8000-000000000001';
const base={action:'create',proposalId:id,contractType:'needs_confirmation',requestedDueOn:'2026-10-30',note:'確認してください'};
await test('合格 and explicit system transition only',()=>{
  assert.ok(acceptanceEvidence({source_system:'enger',source_stage:'合格'}));
  for(const stage of ['稼働','成約','面談実施',null]) assert.equal(acceptanceEvidence({source_system:'enger',source_stage:stage}),null);
  assert.equal(acceptanceEvidence({source_system:'manual',source_stage:'合格'}),null);
  const p={source_system:'enger',source_stage:'稼働'};
  assert.ok(acceptanceEvidence(p,[{kind:'sync',source_event:'evt-12345',detail:{to:'面談合格'}}]));
  for(const bad of [{kind:'memo',source_event:'evt'}, {kind:'sync'}, {kind:'sync',source_event:'evt',created_by:'u'}, {kind:'sync',source_event:'evt',employee_id:'e'}])
    assert.equal(acceptanceEvidence(p,[{...bad,detail:{to:'合格'}}]),null);
});
await test('create requires explicit type and real date',()=>{
  assert.equal(normalizeSalesRequest(base).value.payload.contractType,'needs_confirmation');
  for(const value of ['2026-02-30','2026-13-01','yesterday',null]) assert.equal(normalizeSalesRequest({...base,requestedDueOn:value}).error,'invalid_body');
  for(const type of ['',null,'won']) assert.equal(normalizeSalesRequest({...base,contractType:type}).error,'invalid_body');
});
await test('unknown fields and privilege fields rejected',()=>{
  for(const field of ['status','assigneeId','docOrderId','tenantId','signed','salary']) assert.equal(normalizeSalesRequest({...base,[field]:'x'}).error,'invalid_body');
});
await test('resubmit and cancel require version and reason',()=>{
  for(const action of ['resubmit','cancel']) {
    assert.equal(normalizeSalesRequest({...base,action}).error,'invalid_body');
    assert.equal(normalizeSalesRequest({...base,action,expectedVersion:1,reason:'変更'}).error,'invalid_body');
    assert.ok(normalizeSalesRequest({...base,action,expectedVersion:1,reason:'変更理由'}).value);
  }
});
await test('Office changes validated; null clears optional fields',()=>{
  const o={action:'update',proposalId:id,expectedVersion:2,status:'in_progress',contractType:'client_ses',requestedDueOn:'2026-11-02',plannedStartOn:null,assigneeId:null,artifactReference:null,employeeId:null,docOrderId:null,siteContractId:null,reason:'作成を開始'};
  assert.ok(normalizeOfficeUpdate(o).value);
  assert.equal(normalizeOfficeUpdate({...o,assigneeId:'not-uuid'}).error,'invalid_body');
  assert.equal(normalizeOfficeUpdate({...o,requestedDueOn:null}).error,'invalid_body');
  assert.equal(normalizeOfficeUpdate({...o,status:'signed'}).error,'invalid_body');
  assert.equal(normalizeOfficeUpdate({...o,action:'send'}).error,'invalid_body');
  assert.equal(normalizeOfficeUpdate({...o,note:'変更不可'}).error,'invalid_body');
  assert.equal(normalizeOfficeUpdate({...o,artifactReference:'x'.repeat(2001)}).error,'invalid_body');
});
await test('completed is not signed and cannot transition without reopen',()=>{
  assert.deepEqual(STATUS_TRANSITIONS.completed,[]);
  const p=shapeRequestEnvelope({rows:[{request:{status:'completed'}}]},false);
  assert.equal(p.rows[0].request.statusLabel,'作成完了');
  assert.equal(p.canEditOffice,false); assert.deepEqual(p.members,[]);
});

const at=(path)=>fileURLToPath(new URL('../'+path,import.meta.url));
let who={tenantId:id,roles:[],apps:['sales'],employee:{id}};
let loggedIn=true, calls=[], nextError=null, readError=null, readData={rows:[],members:[],truncated:false}, actionData={id,version:1,replayed:false};
mock.module(at('lib/auth.js'),{namedExports:{getMemberships:async()=>[],requireUser:async(_req,res)=>{
  if(loggedIn)return{id};res.statusCode=401;res.end(JSON.stringify({error:'unauthorized'}));return null;
}}});
const real=await import('../lib/gw.js');
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>who,canSell:real.canSell,canAccessOffice:real.canAccessOffice}});
mock.module(at('lib/supabase.js'),{namedExports:{userClient:()=>({rpc:async(name,args)=>{
  calls.push({name,args});if(nextError){const error=nextError;nextError=null;return{error};}
  if(name.endsWith('_read') && readError){const error=readError;readError=null;return{error};}
  return{data:name.endsWith('_read')?readData:actionData};
}})}});
const sales=(await import('../api/sales/proposals/contract-requests.js')).default;
const office=(await import('../api/office/contract-requests.js')).default;
const run=async(handler,method='GET',body=null,url='/api/sales/proposals/contract-requests')=>{
  calls=[];let out;const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){out=JSON.parse(v);}};
  await handler({method,body,url},res);return{code:res.statusCode,body:out,headers:res.headers};
};
await test('method and login guards before RPC',async()=>{
  assert.equal((await run(sales,'DELETE')).code,405);assert.equal(calls.length,0);
  loggedIn=false;assert.equal((await run(sales)).code,401);assert.equal(calls.length,0);loggedIn=true;
});
await test('Sales app does not grant Office changes',async()=>{
  assert.equal((await run(office,'POST',{action:'cancel',proposalId:id,expectedVersion:1,reason:'取消理由'})).code,403);assert.equal(calls.length,0);
});
await test('Office app without role is denied',async()=>{
  who={tenantId:id,apps:['office'],roles:[]};assert.equal((await run(office)).code,403);assert.equal(calls.length,0);
});
await test('Office finance and Sales modes preserved to JWT RPC',async()=>{
  who={tenantId:id,apps:['office'],roles:['finance']};assert.equal((await run(office)).code,200);assert.equal(calls[0].args.p_mode,'office');
  who={tenantId:id,apps:['sales'],roles:[]};assert.equal((await run(sales)).code,200);assert.equal(calls[0].args.p_mode,'sales');
  assert.equal(calls[0].args.p_tenant,id);
});
await test('SQL missing cannot look like successful zero requests',async()=>{
  nextError={code:'PGRST202',message:'function missing'};const r=await run(sales);assert.equal(r.code,503);assert.equal(r.body.ready,false);assert.equal(r.body.rows,undefined);
});
await test('create is a single atomic RPC followed by scoped read',async()=>{
  const r=await run(sales,'POST',base);assert.equal(r.code,200);assert.equal(r.body.ok,true);
  assert.deepEqual(calls.map(c=>c.name),['gw_sales_contract_request_action','gw_sales_contract_requests_read']);
  assert.equal(calls[1].args.p_proposal,id);assert.equal(r.headers['Cache-Control'],'no-store');
});
await test('conflict does not retry or pretend success',async()=>{
  nextError={code:'PT409'};const r=await run(sales,'POST',{...base,action:'resubmit',expectedVersion:1,reason:'作成再依頼'});
  assert.equal(r.code,409);assert.equal(calls.length,1);assert.equal(r.body.error,'version_conflict');
});
await test('committed save remains successful when its follow-up read fails',async()=>{
  readError={code:'PGRST202'};const r=await run(sales,'POST',base);
  assert.equal(r.code,200);assert.equal(r.body.ok,true);assert.equal(r.body.refreshFailed,true);
  assert.equal(r.body.ready,false);assert.equal(r.body.actionResult.id,id);assert.equal(calls.length,2);
});
await test('malformed action response is outcome-unconfirmed, not saved or auto-retried',async()=>{
  for(const bad of [null,{}, {id,version:1}, {id:'bad',version:1,replayed:false}, {id,version:0,replayed:false}]){
    actionData=bad;const r=await run(sales,'POST',base);assert.equal(r.code,503);assert.equal(r.body.error,'outcome_unconfirmed');
    assert.equal(r.body.ok,undefined);assert.equal(r.body.outcomeUnconfirmed,true);assert.equal(calls.length,1);
  }
  actionData={id,version:1,replayed:false};
});
await test('malformed RPC response never becomes fake successful zero',async()=>{
  for(const bad of [null,{},[],{rows:null},{rows:'not-list'}]){
    readData=bad;const r=await run(sales);assert.equal(r.code,503);assert.equal(r.body.ready,false);assert.equal(r.body.rows,undefined);
  }
  readData=null;const r=await run(sales,'POST',base);assert.equal(r.body.ok,true);assert.equal(r.body.refreshFailed,true);
  readData={rows:[],members:[],truncated:false};
});
await test('invalid payload and id never hit DB',async()=>{
  assert.equal((await run(sales,'POST',{...base,tenantId:id})).code,400);assert.equal(calls.length,0);
  assert.equal((await run(sales,'GET',null,'/api/sales/proposals/contract-requests?proposalId=bad')).code,400);assert.equal(calls.length,0);
});
await test('SQL safety boundaries are retained',()=>{
  const sql=readFileSync(at('db/proposal_sales_office_contract_requests.sql'),'utf8');
  for(const needle of ['unique(tenant_id,proposal_id)','for update','PT409','enable row level security','source_provenance_readonly','gw_sales_contract_request_events']) assert.ok(sql.includes(needle));
  assert.ok(!/update\s+public\.(gw_sign_requests|gw_doc_orders|gw_site_contracts|gw_sales_proposals)\s+set/i.test(sql));
  const api=readFileSync(at('lib/sales-contract-requests-db.js'),'utf8');
  assert.ok(!api.includes('admin('));assert.ok(!api.includes('notify('));assert.ok(!api.includes('/api/sign/'));
});
console.log(`${count}/${count} Sales/Office contract request API and model tests passed`);
