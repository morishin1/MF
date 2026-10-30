import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {signGwRequest} from '../lib/sales-proposal-intake.js';
const tenant='11111111-1111-4111-8111-111111111111',company='22222222-2222-4222-8222-222222222222',source='33333333-3333-4333-8333-333333333333';
process.env.COMPANY_EVALUATION_LINK_ENABLED='1';
process.env.ENGER_SALES_SECRET='synthetic-test-only-key-32-characters-long';process.env.SALES_PROPOSAL_TENANT_ID=tenant;
let rows,errorTable=null,queries=[];
function reset(){rows={gw_sales_company_links:[{source_company_id:source,company_id:company}],gw_sales_companies:[{id:company}],gw_sales_company_evaluations:[{company_id:company,revision:'9007199254740993',evaluation:{status:'confirmed',rank:'A',score:90,policy:'normal',reason:'確認済み',scores:{private:'not shared'},updated_by:'private'},updated_at:'2026-10-30T00:00:00Z'}]};queries=[];errorTable=null;}
const sb={from(table){let columns='';const filters=[];const q={select(x){columns=x;return q;},eq(k,v){filters.push([k,v]);return q;},in(k,v){filters.push([k,v]);return q;},limit(){return q;},then(resolve){queries.push({table,columns,filters});assert.ok(filters.some(([k,v])=>k==='tenant_id'&&v===tenant),'fixed tenant on every query');resolve({data:rows[table],error:errorTable===table?{message:'private db detail'}:null});}};return q;}};
mock.module('../lib/supabase.js',{namedExports:{admin:()=>sb}});
mock.module('../lib/http.js',{namedExports:{readJson:async req=>req.body,json:(res,status,body)=>Object.assign(res,{status,body}),methodNotAllowed:(res)=>Object.assign(res,{status:405})}});
const {default:handler}=await import('../api/sales/company-evaluations/status.js');
async function run(body={source_company_ids:[source]},purpose='company-evaluation-status',method='POST',bad=false){const ts=String(Math.floor(Date.now()/1000));const req={method,body,headers:{'x-gw-timestamp':ts,'x-gw-signature':bad?'bad':signGwRequest(process.env.ENGER_SALES_SECRET,purpose,ts,body)}};const res={setHeader(){}};await handler(req,res);return res;}
reset();delete process.env.COMPANY_EVALUATION_LINK_ENABLED;assert.equal((await run()).status,503);assert.equal(queries.length,0);process.env.COMPANY_EVALUATION_LINK_ENABLED='1';
reset();let r=await run();assert.equal(r.status,200);assert.equal(r.body.items[0].rank,'A');assert.equal(r.body.items[0].revision,'9007199254740993');assert.equal(r.body.items[0].enforcementEnabled,false);assert.ok(!JSON.stringify(r.body).includes('private'));assert.ok(queries.find(q=>q.table==='gw_sales_company_evaluations').columns.includes('revision::text'));
for(const [body,purpose] of [[{source_company_ids:[source]},'proposal-status'],[{source_company_ids:[source]},'proposal']]){reset();assert.equal((await run(body,purpose)).status,401);assert.equal(queries.length,0);}
reset();assert.equal((await run(undefined,undefined,'GET')).status,405);assert.equal((await run(undefined,undefined,'POST',true)).status,401);assert.equal(queries.length,0);
for(const body of [{source_company_ids:[]},{source_company_ids:['bad']},{source_company_ids:Array(51).fill(source)},{company_id:source}]){reset();assert.equal((await run(body)).status,400);assert.equal(queries.length,0);}
reset();r=await run({source_company_ids:[source],tenant_id:'attacker'});assert.equal(r.status,200);
reset();rows.gw_sales_company_links=[];r=await run();assert.deepEqual(r.body.missing,[source]);assert.equal(queries.length,1);
reset();rows.gw_sales_companies=[];r=await run();assert.deepEqual(r.body.items,[]);
reset();rows.gw_sales_company_links.push({...rows.gw_sales_company_links[0]});r=await run();assert.deepEqual(r.body.items,[],'ambiguous link is not merged');
for(const table of Object.keys(rows)){reset();errorTable=table;r=await run();assert.equal(r.status,503);assert.ok(!JSON.stringify(r.body).includes('private db detail'));}
console.log('PASS company evaluation signed status: separate purpose, bad signature, fixed tenant, limits, missing/ambiguous links, read errors, minimal payload, bigint text');
