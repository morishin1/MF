// Real detail API + normalization/policy. Authentication, RLS client and service RPC are synthetic.
// No network, database, email, or existing business-state writes are available to this test.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EVALUATION_AXES } from '../lib/company-evaluation-policy.js';
const at=p=>new URL(`../${p}`,import.meta.url).pathname;
const tenant='11111111-1111-4111-8111-111111111111';
const company='22222222-2222-4222-8222-222222222222';
const actor='33333333-3333-4333-8333-333333333333';
const request='44444444-4444-4444-8444-444444444444';
const largeRevision='9007199254740993';
let authenticated,ctx,tables,errors,queries,rpcCalls,rpcResult;
const recent=()=>new Date(Date.now()-60000).toISOString();
const body=()=>({company_id:company,request_id:request,expected_revision:'0',reviewedAt:recent(),status:'confirmed',rank:'A',policy:'normal',reason:'根拠確認済み',scores:Object.fromEntries(EVALUATION_AXES.map(a=>[a.key,{points:a.max,evidence:'確認済み',observedAt:recent()}]))});
function reset(){
 authenticated=true;ctx={tenantId:tenant,isAdmin:true,roles:[],memberships:[{tenant_id:tenant,role:'admin'}],sell:true};
 tables={gw_sales_companies:[{id:company,tenant_id:tenant,name:'検証企業'}],gw_sales_company_evaluations:[{tenant_id:tenant,company_id:company,revision:largeRevision,evaluation:{status:'draft'}}],gw_sales_company_evaluation_history:[{tenant_id:tenant,company_id:company,revision:largeRevision,evaluation:{status:'draft'},created_at:recent(),actor_id:actor}]};
 errors={};queries=[];rpcCalls=[];rpcResult={data:{status:'saved',revision:'1',evaluation:{revision:'1'}},error:null};
}
function from(name){
 const filters=[];const query={name,filters};queries.push(query);let single=false;
 const q={select(fields){query.fields=fields;return q;},eq(k,v){filters.push([k,v]);return q;},order(k,v){query.order=[k,v];return q;},limit(n){query.limit=n;return q;},maybeSingle(){single=true;return q;},then(resolve,reject){
  assert(filters.some(([k,v])=>k==='tenant_id'&&v===tenant),'All reads must have resolved tenant');
  assert(filters.some(([k,v])=>(k==='company_id'||k==='id')&&v===company),'All reads must have requested company');
  if(name!=='gw_sales_companies')assert(query.fields.includes('revision::text'),'Bigint revisions must be requested as text');
  let rows=(tables[name]||[]).filter(r=>filters.every(([k,v])=>r[k]===v));
  if(query.order)rows=rows.slice().sort((a,b)=>BigInt(a.revision)>BigInt(b.revision)?-1:1);
  if(query.limit)rows=rows.slice(0,query.limit);
  return Promise.resolve({data:errors[name]?null:single?(rows[0]||null):rows,error:errors[name]||null}).then(resolve,reject);
 }};return q;
}
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>{if(authenticated)return{id:actor};res.statusCode=401;res.end(JSON.stringify({error:'unauthorized'}));return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async id=>{assert.equal(id,actor);return ctx;},canSell:c=>c.sell===true}});
mock.module(at('lib/sales-proposals.js'),{namedExports:{canManageProposals:c=>Boolean(c.isAdmin)||(c.roles||[]).some(r=>['owner','manager'].includes(r))}});
mock.module(at('lib/supabase.js'),{namedExports:{userClient:()=>({from}),admin:()=>({rpc:async(name,args)=>{rpcCalls.push({name,args});return rpcResult;}})}});
const {default:handler}=await import('../api/sales/company-evaluations/detail.js');
async function run(method='GET',input=body(),query={company_id:company,tenant_id:'spoof'}){
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=JSON.parse(v);}};
 await handler({method,body:input,query},res);return res;
}
reset();authenticated=false;assert.equal((await run()).statusCode,401);assert.equal(queries.length+rpcCalls.length,0);
reset();assert.equal((await run('DELETE')).statusCode,405);assert.equal(queries.length+rpcCalls.length,0);
for(const patch of [{tenantId:null},{sell:false},{isAdmin:false,roles:[],memberships:[]}]){
 reset();Object.assign(ctx,patch);assert.equal((await run()).statusCode,403);assert.equal(queries.length+rpcCalls.length,0);
}
// General manager reads but cannot write; legacy ctx.isAdmin for staff cannot authorize saves.
for(const patch of [
 {isAdmin:false,roles:['manager'],memberships:[]},
 {isAdmin:true,roles:[],memberships:[{tenant_id:tenant,role:'staff'}]},
 {isAdmin:true,roles:[],memberships:[{tenant_id:'other',role:'admin'}]},
]){
 reset();Object.assign(ctx,patch);let r=await run();assert.equal(r.statusCode,200);assert.equal(r.body.canConfirm,false);r=await run('POST');assert.equal(r.statusCode,403);assert.equal(rpcCalls.length,0);
}
for(const patch of [{isAdmin:true,roles:[],memberships:[{tenant_id:tenant,role:'admin'}]},{isAdmin:false,roles:['owner'],memberships:[]}]){
 reset();Object.assign(ctx,patch);assert.equal((await run('POST')).statusCode,200);assert.equal(rpcCalls.length,1);
}
reset();let input=body();input.tenant_id='attacker';input.actor_id='attacker';input.p_actor='attacker';input.score=-999;input.enforcementEnabled=true;
let res=await run('POST',input);assert.equal(res.statusCode,200);assert.equal(queries.length,0);assert.equal(rpcCalls.length,1);
const {name,args}=rpcCalls[0];assert.equal(name,'gw_sales_save_company_evaluation');assert.equal(args.p_tenant,tenant);assert.equal(args.p_actor,actor);assert.equal(args.p_company,company);assert.equal(args.p_expected_revision,'0');assert.equal(args.p_request_id,request);assert.equal(args.p_evaluation.score,100);assert.equal(args.p_evaluation.enforcementEnabled,false);assert.equal(args.p_evaluation.suggestedRank,'A');assert(!JSON.stringify(args).includes('attacker'));
assert.equal(res.headers['Cache-Control'],'private, no-store');
// Read isolation, bounded history, and exact large revisions.
reset();tables.gw_sales_company_evaluations.push({tenant_id:'other',company_id:company,revision:'1',evaluation:{secret:'foreign'}});tables.gw_sales_company_evaluation_history.push({tenant_id:'other',company_id:company,revision:'2',evaluation:{secret:'foreign'}});
res=await run();assert.equal(res.statusCode,200);assert.equal(res.body.current.revision,largeRevision);assert.equal(res.body.history[0].revision,largeRevision);assert.equal(res.body.history.length,1);assert.equal(res.body.enforcementEnabled,false);assert(!JSON.stringify(res.body).includes('foreign'));assert.equal(rpcCalls.length,0);assert.equal(queries.find(q=>q.name==='gw_sales_company_evaluation_history').limit,20);assert.deepEqual(queries.find(q=>q.name==='gw_sales_company_evaluation_history').order,['revision',{ascending:false}]);
reset();res=await run('GET',{}, {company_id:'invalid'});assert.equal(res.statusCode,400);assert.equal(queries.length,0);
reset();tables.gw_sales_companies=[];assert.equal((await run()).statusCode,404);assert.equal(queries.length,1);
for(const table of ['gw_sales_companies','gw_sales_company_evaluations','gw_sales_company_evaluation_history']){
 reset();errors[table]={code:'42P01',message:'SECRET_DATABASE_DETAILS'};res=await run();assert.equal(res.statusCode,503);assert(!JSON.stringify(res.body).includes('SECRET_DATABASE_DETAILS'));assert.equal(rpcCalls.length,0);
}
reset();tables.gw_sales_company_evaluations=[];tables.gw_sales_company_evaluation_history=[];res=await run();assert.equal(res.statusCode,200);assert.equal(res.body.current,null);assert.deepEqual(res.body.history,[]);
// Invalid client data never reaches privileged RPC.
const bad=[
 b=>b.company_id='bad',b=>b.request_id='bad',b=>b.expected_revision=0,b=>b.expected_revision='01',b=>b.expected_revision='-1',b=>b.expected_revision='9999999999999999999',
 b=>b.status='auto_stop',b=>b.reviewedAt='not-a-date',b=>b.reviewedAt=new Date(Date.now()+86400000).toISOString(),b=>b.reviewedAt='2020-01-01T00:00:00Z',
 b=>b.scores=null,b=>b.scores.outcomes.points=-1,b=>b.scores.outcomes.points=31,b=>b.scores.outcomes.points='30',b=>b.scores.outcomes.evidence='',b=>b.scores.outcomes.evidence='x'.repeat(501),
 b=>b.scores.outcomes.observedAt='invalid',b=>b.scores.outcomes.observedAt='2020-01-01T00:00:00Z',b=>b.scores.outcomes.observedAt=new Date(Date.now()+86400000).toISOString(),
 b=>delete b.scores.outcomes,b=>b.rank='S',b=>b.policy='delete',b=>b.reason='',b=>b.reason='x'.repeat(1001),b=>{b.rank='D';b.policy='stopped';},b=>b.policy='stopped',
];
for(const mutate of bad){reset();input=body();mutate(input);res=await run('POST',input);assert.equal(res.statusCode,400,mutate.toString());assert.equal(rpcCalls.length,0,mutate.toString());}
reset();input=body();input.rank='D';input.policy='stopped';input.improvementDiscussed=true;input.noProgressConfirmed=true;assert.equal((await run('POST',input)).statusCode,200);assert.equal(rpcCalls[0].args.p_evaluation.enforcementEnabled,false);
reset();input=body();input.status='draft';input.scores={};input.rank='D';input.policy='stopped';res=await run('POST',input);assert.equal(res.statusCode,200);assert.equal(rpcCalls[0].args.p_evaluation.rank,null);assert.equal(rpcCalls[0].args.p_evaluation.policy,'normal');assert.equal(rpcCalls[0].args.p_evaluation.score,null);
// Retain deterministic reviewedAt and normalize timestamps for request replay.
reset();input=body();input.scores.outcomes.observedAt=recent().replace('Z','+00:00');await run('POST',input);await run('POST',input);assert.deepEqual(rpcCalls[0].args,rpcCalls[1].args);assert(rpcCalls[0].args.p_evaluation.scores.outcomes.observedAt.endsWith('Z'));
for(const status of ['revision_conflict','idempotency_conflict']){reset();rpcResult.data={status,revision:largeRevision};res=await run('POST');assert.equal(res.statusCode,409);assert.equal(res.body.error,status);assert.equal(res.body.currentRevision,largeRevision);assert.equal(rpcCalls.length,1);}
for(const status of ['unknown',undefined]){reset();rpcResult.data={status};res=await run('POST');assert.equal(res.statusCode,503);assert.equal(res.body.error,'evaluation_save_unconfirmed');assert.equal(rpcCalls.length,1);}
reset();rpcResult={data:null,error:{message:'SECRET_DATABASE_DETAILS'}};res=await run('POST');assert.equal(res.statusCode,503);assert(!JSON.stringify(res.body).includes('SECRET_DATABASE_DETAILS'));assert.equal(rpcCalls.length,1);
reset();rpcResult.data={status:'replayed',revision:largeRevision,evaluation:{revision:largeRevision,evaluation:{status:'confirmed',rank:'A'}}};res=await run('POST');assert.equal(res.statusCode,200);assert.deepEqual(res.body,rpcResult.data);assert.equal(rpcCalls.length,1);
console.log('PASS company evaluation detail API: strict admin/owner, manager read-only, tenant/actor spoof rejection, bounded history, bigint text, validation, deterministic replay, CAS, missing storage, unknown save result, no extra writes');
