// No network or database: real API, policy and record builder through scoped read-only mocks.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
const at = path => new URL(`../${path}`, import.meta.url).pathname;
let ctx, authenticated, tables, errors, queries, source, sourceCalls;
const proposal = (id='p') => ({id,tenant_id:'t',source_system:'enger',source_proposal_id:`source-${id}`,source_company_id:'c',company_id:'local',company_name:'確認企業',sent_at:new Date(Date.now()-86400000).toISOString(),status:'proposal_sent'});
function reset() {
  ctx={tenantId:'t',isAdmin:true,roles:[],sell:true}; authenticated=true;
  tables={gw_sales_proposals:[proposal()],gw_sales_company_links:[],gw_sales_proposal_activities:[]};
  errors={gw_sales_company_evaluations:{code:'42P01'}}; queries=[]; sourceCalls=[]; source={available:true,states:new Map(),missingIds:[]};
}
function from(name) {
  const filters=[]; let bounds; const query={name,filters}; queries.push(query);
  const q={
    select(fields){query.fields=fields;return q;},
    eq(k,v){filters.push(['eq',k,v]);return q;},
    gte(k,v){filters.push(['gte',k,v]);return q;},
    lte(k,v){filters.push(['lte',k,v]);return q;},
    in(k,v){filters.push(['in',k,v]);return q;},
    order(k,opts){query.order=[k,opts];return q;},
    range(a,b){bounds=[a,b];query.bounds=bounds;return q;},
    then(resolve,reject){
      assert(filters.some(([op,k,v])=>op==='eq'&&k==='tenant_id'&&v==='t'),'Every DB read must be scoped to authenticated tenant');
      assert.deepEqual(query.order,[name==='gw_sales_company_evaluations'?'company_id':'id',{ascending:true}]);
      let rows=(tables[name]||[]).filter(r=>filters.every(([op,k,v])=>op==='eq'?r[k]===v:op==='in'?v.includes(r[k]):op==='gte'?r[k]>=v:r[k]<=v));
      rows=rows.slice().sort((a,b)=>String(a.id||a.company_id).localeCompare(String(b.id||b.company_id)));
      if(bounds)rows=rows.slice(bounds[0],bounds[1]+1);
      return Promise.resolve({data:errors[name]?null:rows,error:errors[name]||null}).then(resolve,reject);
    }
  };
  // Deliberately no insert/update/delete/rpc: any write immediately fails this test.
  return q;
}
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>{
  if(authenticated)return{id:'u'};res.statusCode=401;res.end(JSON.stringify({error:'unauthorized'}));return null;
}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell===true}});
mock.module(at('lib/supabase.js'),{namedExports:{userClient:()=>({from})}});
mock.module(at('lib/sales-proposals.js'),{namedExports:{canManageProposals:c=>Boolean(c.isAdmin)||(c.roles||[]).some(x=>['owner','manager'].includes(x))}});
mock.module(at('lib/sales-proposal-source-state.js'),{namedExports:{
  readSourceStates:async(_sb,tenant,proposals)=>{sourceCalls.push({tenant,proposals});return source;},
  sourceStateFor:(p,states)=>p.source_system==='enger'?states.get(p.source_proposal_id)||null:null,
}});
const {default:handler}=await import('../api/sales/company-evaluations.js');
async function run(method='GET') {
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=JSON.parse(body);}};
  await handler({method,query:{tenant_id:'attacker'},body:{tenant_id:'attacker'}},res);return res;
}
reset();authenticated=false;assert.equal((await run()).statusCode,401);assert.equal(queries.length,0);
reset();assert.equal((await run('POST')).statusCode,405);assert.equal(queries.length,0);
reset();ctx.tenantId=null;assert.equal((await run()).statusCode,403);assert.equal(queries.length,0);
reset();ctx.sell=false;assert.equal((await run()).body.error,'forbidden');assert.equal(queries.length,0);
reset();ctx.isAdmin=false;assert.equal((await run()).body.error,'team_scope_required');assert.equal(queries.length,0);
reset();ctx.isAdmin=false;ctx.roles=['manager'];assert.equal((await run()).statusCode,200);
reset();tables.gw_sales_proposals.push({...proposal('foreign'),tenant_id:'other'});
let res=await run();assert.equal(res.statusCode,200);assert.equal(res.headers['Cache-Control'],'private, no-store');
assert.equal(res.body.companies[0].sentCount,1);assert.equal(sourceCalls[0].tenant,'t');
assert.equal(res.body.qualificationComplete,false);assert.equal(res.body.companies[0].review.status,'unavailable');assert.equal(res.body.canConfirm,false);assert.equal(res.body.persistence,'not_configured');assert.equal(res.body.companies[0].rank,null);assert.equal(res.body.companies[0].review.enforceable,false);
assert(queries.find(q=>q.name==='gw_sales_proposals').filters.some(([op,k])=>op==='gte'&&k==='sent_at'));
assert(queries.find(q=>q.name==='gw_sales_proposals').filters.some(([op,k])=>op==='lte'&&k==='sent_at'));
reset();source={available:false,states:new Map()};res=await run();assert.equal(res.statusCode,200);assert.equal(res.body.complete,false);assert.equal(res.body.sourceState,'unconfirmed');assert.equal(res.body.companies[0].review.status,'unavailable');
reset();source.missingIds=['source-p'];assert.equal((await run()).body.complete,false);
reset();source.error={message:'PRIVATE_INTERNAL_DETAIL'};res=await run();assert.equal(res.statusCode,503);assert.equal(res.body.error,'source_state_unavailable');assert(!JSON.stringify(res.body).includes('PRIVATE_INTERNAL_DETAIL'));
reset();source.states.set('source-p',{deleted:true});assert.equal((await run()).body.companies.length,0);
for(const table of ['gw_sales_proposals','gw_sales_company_links','gw_sales_proposal_activities']){
 reset();errors[table]={message:'PRIVATE_INTERNAL_DETAIL'};res=await run();assert.equal(res.statusCode,503,table);assert.equal(res.body.error,'evaluation_data_unavailable');assert(!JSON.stringify(res.body).includes('PRIVATE_INTERNAL_DETAIL'));
}
reset();tables.gw_sales_proposals=[];res=await run();assert.equal(res.statusCode,200);assert.deepEqual(res.body.companies,[]);assert(!queries.some(q=>q.name==='gw_sales_proposal_activities'));
reset();tables.gw_sales_proposals=Array.from({length:1001},(_,i)=>proposal(`p${String(i).padStart(5,'0')}`));
res=await run();assert.equal(res.statusCode,200);assert.equal(res.body.companies[0].sentCount,1001);
assert.deepEqual(queries.filter(q=>q.name==='gw_sales_proposals').map(q=>q.bounds),[[0,999],[1000,1999]]);
assert.equal(queries.filter(q=>q.name==='gw_sales_proposal_activities').length,11);
assert(queries.filter(q=>q.name==='gw_sales_proposal_activities').every(q=>q.filters.find(([op,k])=>op==='in'&&k==='proposal_id')[2].length<=100));
// Boundary exactly 20,000 is complete; 20,001 must fail closed, never truncate.
for(const count of [20000,20001]){
 reset();tables.gw_sales_proposals=Array.from({length:count},(_,i)=>proposal(`p${String(i).padStart(5,'0')}`));
 res=await run();assert.equal(res.statusCode,count===20000?200:503);
 if(count===20000)assert.equal(res.body.companies[0].sentCount,20000);else assert.equal(res.body.error,'evaluation_data_limit');
 assert.deepEqual(queries.filter(q=>q.name==='gw_sales_proposals').at(-1).bounds,[20000,20000]);
}
console.log('PASS company evaluation API: auth/method/team scope, tenant isolation, read-only, 90-day filters, source incomplete/error/deletion, paging/batching, exact limit/overflow');
