import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {buildLifecycle,selectLifecycle} from '../lib/sales-company-lifecycle.js';
const params=o=>new URLSearchParams(o);
const directory=[
 {id:'a',name:'同名企業',bucket:'revive',relationship_status:'unknown'},
 {id:'b',name:'同名企業',bucket:'new',relationship_status:'unknown'},
 {id:'c',name:'取引中',bucket:'new',relationship_status:'active'},
 {id:'d',name:'過去取引',bucket:'revive',relationship_status:'past'},
 {id:'e',name:'停止企業',bucket:'new',needs_contact_review:true},
 {id:'f',name:'提案先',bucket:'revive',relationship_status:'past'},
];
const contacts=directory.map(d=>({id:d.id,contact_email:d.id==='a'?'sample@example.test':null}));
const proposals=[{id:'p1',company:'同名企業',stage:'提案中',company_id:null},{id:'p2',company:'同名企業',stage:'確認中',company_id:null},{id:'p3',company:'提案先',stage:'面談',company_id:'f'},{id:'p4',company:'同名企業',stage:'失注',company_id:null},{id:'p5',company:'稼働の記録',stage:'稼働',company_id:null}];
const model=buildLifecycle({directory,contacts,proposals});
assert.equal(model.counts.total,6);assert.equal(model.counts.current,2);assert.equal(model.counts.activeProposals,3);assert.equal(model.activities.length,1);
assert.equal(model.activities[0].companyId,null);assert.equal(model.activities[0].candidateIds.length,2);assert.equal(model.activities[0].contactKnown,false);
assert.equal(model.rows.find(r=>r.id==='a').segment,'pending');assert.equal(model.rows.find(r=>r.id==='f').segment,'current');assert.equal(model.rows.find(r=>r.id==='e').blocked,true);
assert.equal(selectLifecycle(model,params({segment:'current'})).selectedCount,3);
assert.equal(selectLifecycle(model,params({segment:'past'})).selectedCount,2);
assert.equal(selectLifecycle(model,params({segment:'future'})).selectedCount,2);
assert.equal(selectLifecycle(model,params({segment:'current',contact:'no'})).selectedCount,2,'unknown activity contacts are not missing contacts');
assert.equal(selectLifecycle(model,params({segment:'current',contact:'unknown'})).selectedCount,1);
assert.equal(selectLifecycle(model,params({segment:'all',contact:'yes'})).selectedCount,1);
assert.equal(selectLifecycle(model,params({segment:'all',quick:'blocked'})).selectedCount,1);
assert.equal(selectLifecycle(model,params({segment:'all',q:'不存在'})).selectedCount,0);
for(const v of ['0','-1','NaN','1.5','1001'])assert.throws(()=>selectLifecycle(model,params({page:v})),/invalid_filter/);
assert.throws(()=>buildLifecycle({directory,contacts:[],proposals}),/contact_source_incomplete/);
const overridden=buildLifecycle({directory,contacts,proposals,links:[{source_company_id:'a',company_id:'s'}],sales:[{id:'s',emails:[],phone:null,form_url:null,ng_reason:'停止'}]});
assert.equal(overridden.rows[0].hasContact,false,'cleared Sales contacts must not fall back to stale source');assert.equal(overridden.rows[0].blocked,true);
const at=p=>new URL('../'+p,import.meta.url).pathname;
let authenticated=true,ctx={tenantId:'4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',sell:true},calls=0;
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_r,res)=>{if(authenticated)return{id:'user'};res.statusCode=401;res.end('{}');return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell}});
const tables={dx2_sales_company_directory_for_tenant:directory,companies:contacts,proposals:proposals.filter(p=>!['失注','稼働'].includes(p.stage)),gw_sales_company_links:[],gw_sales_companies:[],gw_employees:[],jobs:[]};
function query(table){const q={select(){return q},eq(){return q},is(){return q},in(){return q},order(){return q},async range(a,b){return{data:tables[table].slice(a,b+1),count:tables[table].length}}};return q;}
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{calls++;return{schema:()=>({from:query}),from:query}}}});
const {default:handler,readAll}=await import('../api/sales/company-lifecycle.js');
const run=async(method='GET',suffix='')=>{const res={headers:{},setHeader(k,v){this.headers[k]=v},end(v){this.body=JSON.parse(v)}};await handler({method,url:'/api/sales/company-lifecycle'+suffix},res);return res;};
authenticated=false;assert.equal((await run()).statusCode,401);authenticated=true;
ctx.sell=false;assert.equal((await run()).statusCode,403);ctx.sell=true;
ctx.tenantId='other';assert.equal((await run()).statusCode,403);ctx.tenantId='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
assert.equal((await run('POST')).statusCode,405);assert.equal((await run('GET','?page=0')).statusCode,400);assert.equal(calls,0,'reject before reading sources');
const r=await run();assert.equal(r.statusCode,200);assert.equal(r.body.readonly,true);assert.equal(r.headers['Cache-Control'],'private, no-store');assert.equal(r.body.rows.length,3);
await run();assert.equal(calls,1,'short tenant-scoped cache avoids repeat full reads');
const source=Array.from({length:1201},(_,i)=>({id:String(i)}));
assert.equal((await readAll(()=>({range:async(a,b)=>({data:source.slice(a,b+1),count:source.length})}))).length,1201);
await assert.rejects(readAll(()=>({range:async()=>({data:source.slice(0,499),count:1201})})),/incomplete_source/);
await assert.rejects(readAll(()=>({range:async(a,b)=>({data:source.slice(a,b+1),count:a?1200:1201})})),/incomplete_source/);
console.log('PASS lifecycle: conservative classification, IDs, candidate overlap, contact overrides, filters, authentication/tenant/GET gates, complete pagination, cache');
