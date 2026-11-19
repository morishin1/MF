// Real API handlers with isolated auth/DB. No live accounts, sends or writes.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createMemDb} from './_memdb.mjs';
import {readEngerOffers} from '../lib/sales-enger-offers.js';
const at=p=>new URL('../'+p,import.meta.url).pathname;
const tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
const company='11111111-1111-4111-8111-111111111111',sales='22222222-2222-4222-8222-222222222222';
const actor='33333333-3333-4333-8333-333333333333',session='44444444-4444-4444-8444-444444444444';
const other='55555555-5555-4555-8555-555555555555',proposal='66666666-6666-4666-8666-666666666666';
const receipt='77777777-7777-4777-8777-777777777777';
const mem=createMemDb();let ctx,authenticated=true;
const rpcCalls=[];const sourceDeals=new Map();let dealCount=0;
const db=()=>{const base=mem.admin();return {...base,from:table=>{const q=base.from(table);if(table==='gw_sales_deals')q.or=()=>{assert.equal((mem.rows.gw_sales_deals||[]).length,0);return q;};return q;},schema:()=>base,rpc:async(name,args)=>{
  assert.equal(name,'gw_link_enger_deal');rpcCalls.push(args);
  const key=args.p_kind+':'+args.p_source;
  let id=sourceDeals.get(key);
  if(id&&args.p_deal&&id!==args.p_deal)return {error:{code:'23505'}};
  if(!id){id=args.p_deal||'deal-'+(++dealCount);sourceDeals.set(key,id);}
  return {data:id,error:null};
}};};
mock.module(at('lib/supabase.js'),{namedExports:{admin:db,userClient:db}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>{
  if(authenticated)return {id:actor};res.statusCode=401;res.end('{}');return null;
}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell,isOwner:c=>c.roles?.includes('owner')}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async()=>{}}});
mock.module(at('lib/sales-proposals-db.js'),{namedExports:{loadPeople:async()=>({employees:[]})}});
mock.module(at('lib/sales-proposal-source-state.js'),{namedExports:{readSourceStates:async()=>({states:new Map()}),sourceStateFor:()=>null}});
const entry=(await import('../api/sales/enger-meeting-entry.js')).default;
const progress=(await import('../api/sales/enger-progress.js')).default;
function reset(){
  mem.reset();authenticated=true;ctx={tenantId:tenant,sell:true,roles:['sales'],employee:{id:actor}};
  rpcCalls.length=0;sourceDeals.clear();dealCount=0;
  mem.rows.gw_sales_company_links=[{tenant_id:tenant,company_id:sales,source_system:'enger',source_company_id:company}];
  mem.rows.gw_sales_companies=[{id:sales,tenant_id:tenant,name:'合成営業企業',status:'untouched',hidden_at:null,ng_reason:null}];
  mem.rows.dx2_sales_company_directory_for_tenant=[{id:company,tenant_id:tenant,name:'合成企業',needs_contact_review:false,directory_hidden_at:null}];
  mem.rows.companies=[{id:company,name:'合成企業',deleted_at:null}];
}
async function call(handler,query='',method='GET',body){
  const headers={};const res={setHeader(k,v){headers[k]=v;},end(raw){this.body=JSON.parse(raw);}};
  await handler({method,url:'/api/test?'+query,body},res);
  assert.equal(headers['Cache-Control'],'private, no-store');return res;
}
reset();let r=await call(entry,'companyId='+company);assert.equal(r.statusCode,200);
assert.equal(r.body.url,'https://enger.jp/business/agent-meeting?companyId='+company);
assert.equal(mem.state.log.length,0);assert.equal(r.body.session,null);
assert.equal((await call(entry,'salesCompanyId='+sales)).body.companyId,company);
assert.equal((await call(entry,'companyId='+company+'&companyId='+other)).statusCode,400);
assert.equal((await call(entry,'companyId='+company+'&salesCompanyId='+sales)).statusCode,400);
assert.equal((await call(entry,'companyId=invalid')).statusCode,400);
assert.equal((await call(entry,'companyId='+company,'POST',{})).statusCode,405);
reset();ctx.sell=false;assert.equal((await call(entry,'companyId='+company)).statusCode,403);
reset();ctx.tenantId=other;assert.equal((await call(entry,'companyId='+company)).statusCode,403);
reset();ctx.left=true;assert.equal((await call(entry,'companyId='+company)).statusCode,403);
reset();ctx.tenantId=other;assert.equal((await call(entry,'salesCompanyId='+sales)).statusCode,403);
reset();mem.rows.gw_sales_company_links=[];
r=await call(entry,'companyId='+company);assert.equal(r.statusCode,409);assert.equal(r.body.error,'sales_link_confirmation_required');
assert.equal(mem.state.log.length,0,'view/refresh must not create Sales/company/account/session');
r=await call(entry,'salesCompanyId='+sales);assert.equal(r.body.error,'company_link_required');
reset();mem.rows.gw_sales_company_links.push({...mem.rows.gw_sales_company_links[0],source_company_id:other});
assert.equal((await call(entry,'companyId='+company)).body.error,'ambiguous_company_link');
reset();mem.rows.gw_sales_company_links.push({...mem.rows.gw_sales_company_links[0],company_id:other});
assert.equal((await call(entry,'companyId='+company)).body.error,'ambiguous_company_link');
for(const property of ['hidden_at','ng_reason']){
  reset();mem.rows.gw_sales_companies[0][property]='blocked';assert.equal((await call(entry,'companyId='+company)).body.error,'company_blocked');
}
for(const property of ['needs_contact_review','directory_hidden_at']){
  reset();mem.rows.dx2_sales_company_directory_for_tenant[0][property]=true;
  assert.equal((await call(entry,'companyId='+company)).body.error,'company_blocked');
}
reset();mem.rows.companies[0].deleted_at='2026-01-01';assert.equal((await call(entry,'companyId='+company)).statusCode,404);
reset();mem.state.missing='gw_sales_live_meeting_sessions';assert.equal((await call(entry,'companyId='+company)).statusCode,503);
reset();mem.rows.gw_sales_live_meeting_sessions=[{id:session,tenant_id:tenant,company_id:company,status:'active',stage:2,started_by:actor}];
r=await call(entry,'companyId='+company);assert.equal(r.body.session.id,session);assert.match(r.body.url,/sessionId=/);
await Promise.all([call(entry,'companyId='+company),call(entry,'companyId='+company)]);assert.equal(mem.state.log.length,0);
mem.rows.gw_sales_live_meeting_sessions[0].started_by=other;assert.equal((await call(entry,'companyId='+company)).body.error,'meeting_owned_by_other');
ctx.roles=['manager'];assert.equal((await call(entry,'companyId='+company)).statusCode,200);
mem.rows.gw_sales_live_meeting_sessions[0].step_details={layout:'compact_v1'};
assert.equal((await call(entry,'companyId='+company)).body.error,'legacy_meeting_review_required');
reset();mem.rows.gw_sales_live_meeting_sessions=[{id:session,tenant_id:tenant,company_id:company,status:'closed',stage:5,started_by:actor}];
r=await call(entry,'companyId='+company+'&sessionId='+session);assert.equal(r.body.session.status,'closed');
assert.equal((await call(entry,'companyId='+company+'&sessionId='+other)).statusCode,404);
reset();mem.rows.gw_sales_live_meeting_sessions=[1,2].map(n=>({id:session+n,tenant_id:tenant,company_id:company,status:'active'}));
assert.equal((await call(entry,'companyId='+company)).body.error,'duplicate_active_meeting');

// The new company-offer receipt maps to the existing Sales proposal, exactly once.
reset();mem.rows.dx2_company_job_offers=[{id:receipt,tenant_id:tenant,company_id:company,created_at:'2026-11-18T01:00:00Z',
  job_title:'合成案件',candidate_id:other,sales_company_id:sales,sales_proposal_id:proposal}];
mem.rows.gw_sales_proposals=[{id:proposal,tenant_id:tenant,company_id:sales,source_company_id:company,source_system:'manual',archived_at:null}];
let receipts=await readEngerOffers(db(),tenant);assert.equal(receipts.length,1);assert.equal(receipts[0].salesProposalId,proposal);
mem.rows.dx2_company_portal_offers=[{id:other,tenant_id:tenant,company_id:company,created_at:'2026-11-17T00:00:00Z',item_type:'talent',status:'new'}];
receipts=await readEngerOffers(db(),tenant);assert.equal(receipts.length,2);
assert.equal((await readEngerOffers(db(),other)).length,0,'other tenant receipts never leak');
const until=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
r=await call(progress,'since=2026-11-01&until='+until);assert.equal(r.statusCode,200);
assert.equal(r.body.rows.length,2);assert.equal(r.body.rows.find(x=>x.id===receipt).title,'合成案件');
assert.equal(r.body.metrics[0].ids.length,0,'inbound offer must not count as an outbound proposal');
assert.equal(mem.state.log.length,0);assert.equal(rpcCalls.length,0,'GET never creates a deal');
r=await call(progress,'','POST',{kind:'offer',id:receipt});assert.equal(r.statusCode,200);const deal=r.body.dealId;
assert.equal(sourceDeals.get('proposal:'+proposal),deal);assert.equal(sourceDeals.get('offer:'+receipt),deal);
r=await call(progress,'','POST',{kind:'offer',id:receipt});assert.equal(r.body.dealId,deal);assert.equal(dealCount,1,'retry must reuse the canonical proposal deal');
mem.rows.gw_sales_proposals[0].company_id=other;
assert.equal((await call(progress,'','POST',{kind:'offer',id:receipt})).body.error,'offer_proposal_mismatch');
reset();mem.state.missing='dx2_company_job_offers';await assert.rejects(()=>readEngerOffers(db(),tenant));
reset();mem.rows.dx2_company_job_offers=[{id:receipt,tenant_id:tenant}];mem.rows.dx2_company_portal_offers=[{id:receipt,tenant_id:tenant}];
await assert.rejects(()=>readEngerOffers(db(),tenant),/ambiguous_offer_receipt/);
console.log('PASS real handlers: tenant/role/left/deleted/blocking, unlinked/ambiguous IDs, session ownership/history/retries, zero GET writes, both offer ledgers, canonical deal reuse, no inbound/outbound double counting');
