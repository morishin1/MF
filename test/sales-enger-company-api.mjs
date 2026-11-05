// Exercise real handlers and bridge using isolated DB/auth; no live records/messages.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createMemDb} from './_memdb.mjs';
import {workingCompanyId,readSalesCompanies} from '../lib/sales-enger-company.js';
const at=p=>new URL('../'+p,import.meta.url).pathname;
const tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
const id='bdfee5b5-c88c-4b73-85b3-2c81b4e43b35';
const other='11111111-1111-4111-8111-111111111111';
const actor='22222222-2222-4222-8222-222222222222';
const mem=createMemDb({schema:{
 gw_sales_companies:{unique:[['id'],['tenant_id','domain']]},
 gw_sales_company_links:{unique:[['tenant_id','source_system','source_company_id']]},
}});
let authenticated=true,ctx;
const db=()=>{const base=mem.admin();return {...base,schema:()=>base};};
mock.module(at('lib/supabase.js'),{namedExports:{admin:db}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_r,res)=>{if(authenticated)return{id:actor};res.statusCode=401;res.end('{}');return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async()=>{}}});
const detail=(await import('../api/sales/enger-company-detail.js')).default;
const action=(await import('../api/sales/enger-company-action.js')).default;
function reset(){
 mem.reset();authenticated=true;ctx={tenantId:tenant,sell:true,employee:{id:actor}};
 mem.rows.dx2_sales_company_directory_for_tenant=[{id,tenant_id:tenant,name:'EBA検証',bucket:'revive',needs_contact_review:false}];
 mem.rows.companies=[{id,name:'EBA検証',phone:null,contact_email:null,deleted_at:null}];
}
async function run(handler,method='GET',body={},queryId=id){
 const res={setHeader(){},end(v){this.body=JSON.parse(v);}};
 await handler({method,url:'/api/sales/test?id='+queryId,body},res);return res;
}
reset();let r=await run(detail);assert.equal(r.statusCode,200,'regression: real 8-4-4-4-12 UUID reaches DB');assert.equal(r.body.company.id,id);assert.equal(r.body.company.phone,null);assert.equal(r.body.evidence.proposalCount,0);assert.equal(mem.state.log.length,0,'view never creates a working company');
assert.equal((await run(detail,'GET',{},'bdfee5b5-c88c-4b73-2c81b4e43b35')).statusCode,400);
for(const h of [detail,action]){
 reset();authenticated=false;assert.equal((await run(h,'POST',{id})).statusCode,401);
 reset();ctx.sell=false;assert.equal((await run(h,h===detail?'GET':'POST',{id})).statusCode,403);
 reset();ctx.tenantId=other;assert.equal((await run(h,h===detail?'GET':'POST',{id})).statusCode,403);assert.equal(mem.state.log.length,0);
}
reset();assert.equal((await run(action,'GET')).statusCode,405);
assert.equal((await run(action,'POST',{id:'invalid'})).statusCode,400);
assert.equal((await run(action,'POST',{id:other})).statusCode,404);
for(const field of ['needs_contact_review','directory_hidden_at']){
 reset();mem.rows.dx2_sales_company_directory_for_tenant[0][field]=true;
 assert.equal((await run(action,'POST',{id})).statusCode,409);assert.equal(mem.state.log.length,0);
}
reset();r=await run(action,'POST',{id,tenantId:other,companyId:other});assert.equal(r.statusCode,200);
const linked=r.body.companyId;assert.equal(linked,workingCompanyId(tenant,id));
assert.equal(mem.rows.gw_sales_companies.length,1);assert.equal(mem.rows.gw_sales_company_links.length,1);
assert.equal(mem.rows.gw_sales_companies[0].tenant_id,tenant);
Object.assign(mem.rows.gw_sales_companies[0],{phone:'03-1234-5678',next_action:'再電話',next_action_on:'2026-11-10'});
r=await run(action,'POST',{id});assert.equal(r.body.companyId,linked);assert.equal(mem.rows.gw_sales_companies.length,1);assert.equal(mem.rows.gw_sales_companies[0].phone,'03-1234-5678');
mem.rows.gw_employees=[{id:actor,tenant_id:tenant,display_name:'営業担当'}];
r=await run(detail);assert.equal(r.body.company.phone,'03-1234-5678');assert.equal(r.body.company.sales.nextAction,'再電話');assert.equal(r.body.company.sales.ownerName,'営業担当');
assert.equal((await readSalesCompanies(db(),other,[id])).size,0);
// Retry after company insert succeeds but saving its source link fails: no duplicate or overwritten contact.
reset();mem.state.missing='gw_sales_company_links';assert.equal((await run(action,'POST',{id})).statusCode,503);assert.equal(mem.state.log.length,0);
reset();mem.rows.gw_sales_companies=[{id:workingCompanyId(tenant,id),tenant_id:tenant,name:'編集済',phone:'03-9999-9999'}];
r=await run(action,'POST',{id});assert.equal(r.statusCode,200);assert.equal(mem.rows.gw_sales_companies.length,1);assert.equal(mem.rows.gw_sales_companies[0].name,'編集済');
// Domain match reuses the existing company, preserving its opt-out; names never match.
reset();mem.rows.companies[0].website='https://example.test';
mem.rows.gw_sales_companies=[{id:other,tenant_id:tenant,name:'別表記',domain:'example.test',ng_reason:'unsubscribed'}];
r=await run(action,'POST',{id});assert.equal(r.statusCode,409);assert.equal(mem.rows.gw_sales_companies.length,1);assert.equal(mem.rows.gw_sales_company_links[0].company_id,other);
reset();mem.rows.gw_sales_companies=[{id:other,tenant_id:tenant,name:'EBA検証'}];
r=await run(action,'POST',{id});assert.equal(r.statusCode,200);assert.notEqual(r.body.companyId,other);
// Two simultaneous requests share a stable company and unique link.
reset();const pair=await Promise.all([run(action,'POST',{id}),run(action,'POST',{id})]);assert(pair.every(x=>x.statusCode===200));assert.equal(pair[0].body.companyId,pair[1].body.companyId);assert.equal(mem.rows.gw_sales_companies.length,1);assert.equal(mem.rows.gw_sales_company_links.length,1);
reset();mem.state.missing='company_touchpoints';r=await run(detail);assert.equal(r.statusCode,503);assert.equal(r.body.evidence,undefined,'history failure is not a fake zero');
console.log('PASS ENGER company real handlers: UUID regression, auth/tenant, missing contacts, blocking, retries, concurrency, stable link, Sales contact/NEXT readback, evidence failure');
