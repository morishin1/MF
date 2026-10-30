// Real snapshot verifier/HMAC + API handlers; mocked authentication and database only.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {evaluationWindow} from '../lib/company-evaluation-policy.js';
const at=p=>new URL(`../${p}`,import.meta.url).pathname;
const tenant='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222',sid='33333333-3333-4333-8333-333333333333';
const secret='test-only-company-review-signature-key-000000';
let ctx,authed,tables,errors,queries,rpcCalls,rpcResult,adminCalls;
function reset(){ctx={tenantId:tenant,isAdmin:true,roles:[],sell:true,employee:{id:'employee-1'}};authed=true;tables={gw_sales_company_review_tasks:[],gw_sales_companies:[]};errors={};queries=[];rpcCalls=[];adminCalls=0;rpcResult={data:{status:'applied'},error:null};process.env.COMPANY_EVALUATION_LINK_ENABLED='1';process.env.ENGER_SALES_SECRET=secret;process.env.SALES_PROPOSAL_TENANT_ID=tenant;}
function from(name){const filters=[];let bounds;const query={name,filters,orders:[]};queries.push(query);const q={
 select(fields){query.fields=fields;return q;},eq(k,v){filters.push(['eq',k,v]);return q;},in(k,v){filters.push(['in',k,v]);return q;},order(k,v){query.orders.push([k,v]);return q;},range(a,b){bounds=[a,b];query.bounds=bounds;return q;},
 then(resolve,reject){assert(filters.some(([op,k,v])=>op==='eq'&&k==='tenant_id'&&v===tenant),'all reads fixed to authenticated tenant');let rows=(tables[name]||[]).filter(r=>filters.every(([op,k,v])=>op==='eq'?r[k]===v:v.includes(r[k])));if(bounds)rows=rows.slice(bounds[0],bounds[1]+1);return Promise.resolve({data:errors[name]?null:rows,error:errors[name]||null}).then(resolve,reject);}
};return q;}
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{adminCalls++;return{rpc:async(name,args)=>{rpcCalls.push({name,args});return rpcResult;}};},userClient:()=>({from})}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>{if(authed)return{id:'user'};res.statusCode=401;res.end(JSON.stringify({error:'unauthorized'}));return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell===true}});
const {signGwRequest}=await import('../lib/sales-proposal-intake.js');
const {REVIEW_PURPOSE,validateCompanyReviewSnapshot}=await import('../lib/company-review-snapshot.js');
const {default:snapshot}=await import('../api/sales/company-evaluations/review-snapshot.js');
const {default:queue}=await import('../api/sales/company-evaluations/review-tasks.js');
const row=(id=sourceId)=>({sourceCompanyId:id,sentCount:15,meetingCount:0,qualifiedCount:10,unknownReasonCount:1,wonCount:0});
function body(){const now=new Date(Date.now()-1000);return{version:'20261030-company-review-v1',complete:true,snapshotId:sid,observedAt:now.toISOString(),windowStart:evaluationWindow(now).since,companies:[row()]};}
function signed(b,purpose=REVIEW_PURPOSE,ts=String(Math.floor(Date.now()/1000))){return {'x-gw-timestamp':ts,'x-gw-signature':signGwRequest(secret,purpose,ts,b)};}
async function run(handler,req){const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(s){this.body=JSON.parse(s);}};await handler(req,res);return res;}
async function send(b=body(),purpose=REVIEW_PURPOSE){return run(snapshot,{method:'POST',headers:signed(b,purpose),body:b});}
reset();delete process.env.COMPANY_EVALUATION_LINK_ENABLED;assert.equal((await send()).body.error,'evaluation_link_disabled');assert.equal(adminCalls,0);assert.equal(queries.length,0);
reset();assert.equal((await run(snapshot,{method:'GET'})).statusCode,405);assert.equal(adminCalls,0);
for(const config of [{ENGER_SALES_SECRET:'short'},{SALES_PROPOSAL_TENANT_ID:'not-a-tenant'}]){reset();Object.assign(process.env,config);assert.equal((await send()).body.error,'not_configured');assert.equal(adminCalls,0);}
for(const purpose of ['proposal','proposal-status','sales.']){reset();assert.equal((await send(body(),purpose)).statusCode,401);assert.equal(adminCalls,0);}
reset();let b=body();assert.equal((await run(snapshot,{method:'POST',body:b,headers:signed(b,REVIEW_PURPOSE,String(Math.floor(Date.now()/1000)-600))})).statusCode,401);assert.equal(adminCalls,0);
reset();b=body();const headers=signed(b);b.companies[0].sentCount=16;assert.equal((await run(snapshot,{method:'POST',body:b,headers})).statusCode,401);assert.equal(adminCalls,0);
reset();let res=await send();assert.equal(res.statusCode,200);assert.equal(rpcCalls.length,1);assert.equal(rpcCalls[0].name,'gw_sales_apply_company_review_snapshot');assert.equal(rpcCalls[0].args.p_tenant,tenant);assert.equal(queries.length,0,'snapshot can only call atomic RPC');
for(const status of ['replayed','stale','snapshot_conflict','unknown']){reset();rpcResult.data={status};res=await send();assert.equal(res.statusCode,status==='replayed'?200:['stale','snapshot_conflict'].includes(status)?409:503);assert.equal(rpcCalls.length,1,'No RPC retry');}
reset();rpcResult={data:null,error:{message:'private database detail'}};res=await send();assert.equal(res.statusCode,503);assert.equal(rpcCalls.length,1);assert(!JSON.stringify(res.body).includes('private database'));
const invalids=[
 b=>({...b,complete:false}),b=>({...b,tenant_id:'attacker'}),b=>({...b,companies:[row(),row()]}),
 b=>({...b,companies:[{...row(),email:'must-not-enter@example.test'}]}),
 b=>({...b,companies:[{...row(),sentCount:-1}]}),b=>({...b,companies:[{...row(),sentCount:1.5}]}),
 b=>({...b,companies:[{...row(),qualifiedCount:16}]}),b=>({...b,companies:[{...row(),meetingCount:11}]}),
 b=>({...b,companies:[{...row(),wonCount:1}]}),b=>({...b,companies:[{...row(),unknownReasonCount:11}]}),
 b=>({...b,companies:[{...row(),sourceCompanyId:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}]}),
 b=>({...b,observedAt:new Date(Date.now()+60000).toISOString()}),b=>({...b,observedAt:new Date(Date.now()-86400001).toISOString()}),
 b=>({...b,windowStart:'2000-01-01T00:00:00.000Z'}),
 b=>({...b,companies:Array.from({length:5001},(_,i)=>({...row(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),sentCount:0,qualifiedCount:0,unknownReasonCount:0}))}),
 b=>({...b,companies:[{...row(),sentCount:20000},{...row('44444444-4444-4444-8444-444444444444'),sentCount:1,qualifiedCount:0,unknownReasonCount:0}]}),
];
for(const invalid of invalids){reset();res=await send(invalid(body()));assert.equal(res.statusCode,400,JSON.stringify(res.body));assert.equal(adminCalls,0);}
const boundary=body();boundary.companies=Array.from({length:5000},(_,i)=>({...row(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),sentCount:4,qualifiedCount:0,unknownReasonCount:0}));assert(validateCompanyReviewSnapshot(boundary).value);assert(validateCompanyReviewSnapshot({...body(),companies:[]}).value);
const task=(i,extra={})=>({id:`task-${i}`,tenant_id:tenant,source_company_id:sourceId,company_id:'company-1',kind:'alert_owner',status:'open',assignee_id:'employee-1',due_at:null,first_seen:'2026-10-30',last_seen:'2026-10-30',counts:row(),...extra});
const get=(query={})=>run(queue,{method:'GET',query:{tenant_id:'attacker',assignee_id:'attacker',...query}});
reset();authed=false;assert.equal((await get()).statusCode,401);assert.equal(queries.length,0);
reset();assert.equal((await run(queue,{method:'POST'})).statusCode,405);assert.equal(queries.length,0);
for(const patch of [{tenantId:null},{sell:false},{isAdmin:false,employee:null}]){reset();Object.assign(ctx,patch);assert.equal((await get()).statusCode,403);assert.equal(queries.length,0);}
for(const page of ['-1','01','1.5','1000','abc','1e2']){reset();assert.equal((await get({page})).statusCode,400);assert.equal(queries.length,0);}
reset();tables.gw_sales_company_review_tasks=[task(1),task(2,{tenant_id:'other'}),task(3,{status:'cleared'}),task(4,{assignee_id:'employee-2'})];tables.gw_sales_companies=[{id:'company-1',tenant_id:tenant,name:'安全な企業名'},{id:'company-1',tenant_id:'other',name:'OTHER TENANT SECRET'}];
res=await get();assert.equal(res.statusCode,200);assert.equal(res.body.scope,'team');assert.equal(res.body.items.length,2);assert.equal(res.body.items[0].companyName,'安全な企業名');assert.equal(res.headers['Cache-Control'],'private, no-store');assert.equal(res.body.enforcementEnabled,false);assert(!JSON.stringify(res.body).includes('OTHER TENANT'));assert(!queries[0].filters.some(([,k])=>k==='assignee_id'));
ctx.isAdmin=false;res=await get();assert.equal(res.body.scope,'assigned');assert.equal(res.body.items.length,1);assert(queries.at(-2).filters.some(([op,k,v])=>op==='eq'&&k==='assignee_id'&&v==='employee-1'));
reset();tables.gw_sales_company_review_tasks=[task(1,{company_id:null,assignee_id:null})];res=await get();assert.equal(res.body.items[0].assignmentKnown,false);assert.equal(res.body.items[0].deadlineKnown,false);assert.equal(res.body.items[0].companyName,'企業IDの照合が必要');assert.equal(queries.length,1);
reset();tables.gw_sales_company_review_tasks=Array.from({length:101},(_,i)=>task(i,{company_id:null}));res=await get();assert.equal(res.body.items.length,100);assert.equal(res.body.hasMore,true);assert.deepEqual(queries[0].bounds,[0,100]);res=await get({page:'1'});assert.equal(res.body.items.length,1);assert.equal(res.body.hasMore,false);assert.deepEqual(queries.at(-1).bounds,[100,200]);
reset();res=await get({page:'999'});assert.equal(res.statusCode,200);assert.deepEqual(queries[0].bounds,[99900,100000]);
for(const table of ['gw_sales_company_review_tasks','gw_sales_companies']){reset();tables.gw_sales_company_review_tasks=[task(1)];errors[table]={message:'PRIVATE_ERROR'};res=await get();assert.equal(res.statusCode,503);assert(!('items'in res.body),'Unavailable never becomes empty success');assert(!JSON.stringify(res.body).includes('PRIVATE_ERROR'));}
console.log('PASS review snapshot + queue APIs: real HMAC/purpose, OFF gate, fixed tenant, strict complete/count/limit validation, single RPC/CAS responses, assigned/team scopes, names tenant isolation, bounded paging, unavailable != zero');
