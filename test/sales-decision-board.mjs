import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('../sales/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../js/sales-decision-board.js',import.meta.url),'utf8');
const api=readFileSync(new URL('../api/sales/decision-brief.js',import.meta.url),'utf8');
new Script(js);
assert.match(html,/id="db-decision-board"/);
assert.match(html,/id="db-legacy-queue"/);
assert.match(html,/SalesDecisionBoard\.ready\(\)/);
assert.match(html,/営業判断/);
assert.match(html,/従来のリード・アタック一覧（移行中・参考）/);
assert.doesNotMatch(html,/API\.warm\(KEY, fetchDashboard/,'Attack queue must not fetch on initial load');
assert.match(api,/requireUser/);
assert.match(api,/canSell/);
assert.match(api,/userClient/);
assert.match(api,/\.eq\('tenant_id',ctx\.tenantId\)/);
// Query bounds are verified below against the handler, not its constant names.
assert.doesNotMatch(api,/\badmin\s*\(/,'No service-role admin use');
assert.doesNotMatch(api,/\b(insert|update|upsert|delete)\s*\(/,'GET API has no writes');

let requested=0,view=null,selectedPeriod=null;
let expectedPath='/api/sales/decision-brief';
const root={innerHTML:'',listeners:{},addEventListener(k,f){this.listeners[k]=f;}};
const w={API:{api:async p=>{requested++;assert.equal(p,expectedPath);return {
  metrics:{openCases:8,proposalToVerify:3,contactToInspect:4,interviewToInspect:1},partial:false,
  note:'同期済み',updatedAt:'2026-11-03T02:00:00Z',
  priority:[{title:'<img onerror=alert(1)>',companyName:'テスト&企業',statusLabel:'条件確認',
    hasRegisteredOwner:false,sourceProposalId:'11111111-1111-4111-8111-111111111111'}]};
}},SalesDashboardReport:{getPeriod:()=>selectedPeriod},SalesDashboardTabs:{selectView:v=>{view=v;}}};
new Script(js).runInContext(createContext({document:{getElementById:id=>id==='db-decision-board'?root:null,addEventListener(){}},window:w,Number,String,Date,encodeURIComponent,URLSearchParams}));
assert.equal(requested,0,'No pre-auth request');
await w.SalesDecisionBoard.periodChanged();
assert.equal(requested,0,'Period changes must not request data before authorization');
await w.SalesDecisionBoard.ready();
assert.equal(requested,1);
assert.match(root.innerHTML,/&lt;img/);
assert.doesNotMatch(root.innerHTML,/<img/);
assert.match(root.innerHTML,/需要：未確認/);
assert.match(root.innerHTML,/利益・企業実績/);
assert.match(root.innerHTML,/data-metric=\"openCases\"/);
assert.match(api,/resolvePeriod/);
assert.match(api,/metric/);
assert.match(root.innerHTML,/ENGERで確認/);
assert.match(root.innerHTML,/https:\/\/dx\.enger\.jp\/proposals\/1111/);
root.listeners.click({target:{closest:selector=>selector==='#db-judge-company'?{}:null}});
assert.equal(view,'company');
await w.SalesDecisionBoard.ready();
assert.equal(requested,1,'Do not requery on repeated ready');
selectedPeriod={key:'custom',from:'2026-11-01',to:'2026-11-03'};
expectedPath='/api/sales/decision-brief?period=custom&from=2026-11-01&to=2026-11-03';
await w.SalesDecisionBoard.periodChanged();
assert.equal(requested,2,'An authorized period change refreshes the dashboard');
await w.SalesDecisionBoard.ready();
assert.equal(requested,2,'Repeated ready must not discard the selected period cache');


// Exercise the real handler with a read-only query recorder. Imports are injected
// so no auth service, database, or network is contacted by this test.
const {resolvePeriod,DEFAULT_PERIOD}=await import('../lib/sales-period.js');
let user={id:'user-1'},tenantId='tenant-1',allowed=true,queries=[],result;
const dbRows=[{id:'row-1',status:'proposal_wait',job_title:'Example',updated_at:'2026-11-02T00:00:00Z'}];
let total=1;
const context=createContext({URL,Date,Number,Object,String,Promise,
  requireUser:async()=>user,
  gwContext:async()=>({tenantId}),canSell:()=>allowed,
  resolvePeriod,DEFAULT_PERIOD,
  json:(_res,status,body)=>{result={status,body};},
  methodNotAllowed:()=>{result={status:405};},
  userClient:()=>({from(table){
    const operations=[['from',table]];queries.push(operations);
    const q={then(resolve){return Promise.resolve({data:dbRows,count:total,error:null}).then(resolve);}};
    for(const op of ['select','eq','is','in','gte','lt','order','range'])
      q[op]=(...args)=>{operations.push([op,...args]);return q;};
    // No mutation methods are exposed: any accidental write fails the test.
    return q;
  }})
});
new Script(api.replace(/^import .*;$/gm,'').replace('export default async function handler','async function handler')+'\nglobalThis.handler=handler;').runInContext(context);
const headers={};
async function run(url='/api/sales/decision-brief?period=custom&from=2026-11-01&to=2026-11-03',method='GET'){
  queries=[];result=undefined;
  await context.handler({url,method},{setHeader:(key,value)=>headers[key]=value});
  return result;
}
user=null;await run();assert.equal(queries.length,0,'No unauthenticated database access');
user={id:'user-1'};allowed=false;assert.equal((await run()).status,403);assert.equal(queries.length,0);
allowed=true;tenantId=null;assert.equal((await run()).status,403);assert.equal(queries.length,0);
tenantId='tenant-1';assert.equal((await run(undefined,'POST')).status,405);assert.equal(queries.length,0);
for(const query of ['metric=unknown','page=0','page=1.5','period=custom&from=bad&to=bad']){
  assert.equal((await run('/api/sales/decision-brief?'+query)).status,400);
  assert.equal(queries.length,0,'Invalid filters must not query the database');
}
const response=await run();
assert.equal(response.status,200);
assert.equal(headers['Cache-Control'],'private, no-store');
assert.equal(response.body.metrics.openCases,1);
assert.equal(response.body.conditionsVerified,false);
assert.deepEqual(queries[0].find(op=>op[0]==='range'),['range',0,500],'Priority sampling stays bounded');
const assertScope=ops=>{
  assert.deepEqual(ops.find(op=>op[0]==='eq'),['eq','tenant_id','tenant-1']);
  assert.deepEqual(ops.find(op=>op[0]==='is'),['is','archived_at',null]);
  assert.deepEqual(ops.find(op=>op[0]==='gte'),['gte','updated_at','2026-10-31T15:00:00.000Z']);
  assert.deepEqual(ops.find(op=>op[0]==='lt'),['lt','updated_at','2026-11-03T15:00:00.000Z']);
};
queries.forEach(assertScope);
const drilldown=await run('/api/sales/decision-brief?period=custom&from=2026-11-01&to=2026-11-03&metric=proposalToVerify&page=2');
assert.equal(drilldown.body.pageSize,100);
assert.deepEqual(queries[0].find(op=>op[0]==='range'),['range',100,199]);
assert.equal(JSON.stringify(queries[0].find(op=>op[0]==='in')),JSON.stringify(['in','status',['proposal_wait']]));
queries.forEach(assertScope);
total=501;const oversized=await run();
assert.equal(oversized.body.partial,true);
assert.equal(queries.length,4,'Oversized windows fetch all three exact subgroup counts');
queries.forEach(assertScope);
for(const ops of queries.slice(1))assert.equal(ops.find(op=>op[0]==='select')[2].head,true);
console.log('PASS Sales judgment board: private lazy loading, safe encoding, tenant/auth gates, bounded period queries and drilldown');
