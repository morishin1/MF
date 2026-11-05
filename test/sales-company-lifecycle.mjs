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
assert.equal(selectLifecycle(model,params({segment:'all',q:'A'})).rows[0].companyId,'a','company ID search is case insensitive');
const idModel={...model,rows:[{...model.rows[0],companyId:'12345678-abcd-0000-0000-000000000001',salesId:'98765432-aaaa-0000-0000-000000000002'}]};
assert.equal(selectLifecycle(idModel,params({segment:'all',q:'12345678'})).selectedCount,1,'partial ENGER ID');
assert.equal(selectLifecycle(idModel,params({segment:'all',q:'98765432-AAAA'})).selectedCount,1,'Sales ID search');

for(const v of ['0','-1','NaN','1.5','1001'])assert.throws(()=>selectLifecycle(model,params({page:v})),/invalid_filter/);
assert.throws(()=>buildLifecycle({directory,contacts:[],proposals}),/contact_source_incomplete/);
const overridden=buildLifecycle({directory,contacts,proposals,links:[{source_company_id:'a',company_id:'s'}],sales:[{id:'s',emails:[],phone:null,form_url:null,ng_reason:'停止'}]});
assert.equal(overridden.rows[0].hasContact,false,'cleared Sales contacts must not fall back to stale source');assert.equal(overridden.rows[0].blocked,true);
// Contact-channel filtering uses the same verified contacts as the row icons.
const channelModel=buildLifecycle({directory,proposals,contacts:[
 {id:'a',contact_email:'mail@example.test'}, {id:'b',phone:'03-0000-0000'},
 {id:'c',contact_email:'both@example.test',phone:'03-0000-0001'},
 {id:'d',contact_form_url:'https://example.test/contact'},
 {id:'e',contact_email:' ',phone:' ',contact_form_url:' '}, {id:'f'}
]});
for(const [contact,ids] of [['email',['a','c']],['phone',['b','c']],['both',['c']],['form',['d']],['no',['e','f']]]){
 assert.deepEqual(selectLifecycle(channelModel,params({segment:'all',contact})).rows.map(r=>r.id).sort(),ids);
 assert.equal(selectLifecycle(overridden,params({segment:'all',contact})).rows.some(r=>r.id==='a'),contact==='no','cleared verified contacts stay cleared');
}
assert.equal(selectLifecycle(channelModel,params({segment:'current',contact:'email'})).selectedCount,1,'unlinked activity is excluded');
assert.equal(selectLifecycle(channelModel,params({segment:'past',contact:'email',q:'同名'})).selectedCount,1,'channel composes with segment and search');
assert.throws(()=>selectLifecycle(channelModel,params({contact:'invalid'})),/invalid_filter/);
// Broadcast is explicit membership, not inferred from a legacy rank or email presence.
const broadcastModel=buildLifecycle({directory,contacts,proposals,broadcasts:[{company_id:'a',blast_target:true},{company_id:'c',blast_target:true},{company_id:'e',blast_target:true},{company_id:'b',blast_target:false},{company_id:'missing',blast_target:true}]});
assert.equal(broadcastModel.counts.broadcast,3);
assert.deepEqual(selectLifecycle(broadcastModel,params({segment:'broadcast',sort:'name'})).rows.map(r=>r.id).sort(),['a','c','e']);
assert.equal(selectLifecycle(broadcastModel,params({segment:'past'})).selectedCount,1);
assert.equal(selectLifecycle(broadcastModel,params({segment:'current'})).selectedCount,2);
assert.equal(selectLifecycle(broadcastModel,params({segment:'all'})).selectedCount,6);
assert.equal(broadcastModel.rows.find(r=>r.id==='e').statusLabel,'連絡停止・注意');
const restored=buildLifecycle({directory,contacts,proposals,broadcasts:[]});
assert.equal(restored.rows.find(r=>r.id==='a').segment,'pending');
// Every sort runs over the entire filtered dataset before pagination; blanks stay last.
const sortRows=Array.from({length:110},(_,i)=>({...model.rows[0],id:String(i).padStart(3,'0'),name:'企業'+String(i).padStart(3,'0'),owner:'担当'+String(i).padStart(3,'0'),nextDate:'2026-'+String(Math.floor(i/28)+1).padStart(2,'0')+'-'+String(i%28+1).padStart(2,'0'),lastContact:new Date(Date.UTC(2026,0,i+1)).toISOString(),nextAction:'対応'+String(i).padStart(3,'0'),statusLabel:'状態'+String(i).padStart(3,'0'),email:i%2===0,phone:i%3===0,form:false}));
const sm={rows:sortRows,activities:[],counts:{}};
for(const key of ['name','owner','deadline','last','nextAction','status','contact']){
 const asc=selectLifecycle(sm,params({segment:'all',sort:key,direction:'asc'}));
 const desc=selectLifecycle(sm,params({segment:'all',sort:key,direction:'desc'}));
 assert.equal(asc.selectedCount,110);assert.equal(desc.rows.length,50);
 assert.notEqual(asc.rows[0].id,desc.rows[0].id,key+' direction');
 const second=selectLifecycle(sm,params({segment:'all',sort:key,direction:'desc',page:'2'}));
 assert.equal(new Set([...desc.rows,...second.rows].map(r=>r.id)).size,100,key+' stable pages');
}
assert.equal(selectLifecycle(sm,params({segment:'all',sort:'name',direction:'desc'})).rows[0].id,'109');
for(const direction of ['asc','desc']){
 const blanks={rows:[{...sortRows[0],id:'missing',lastContact:null,nextDate:'',owner:''},sortRows[1]],activities:[],counts:{}};
 for(const key of ['last','deadline','owner'])assert.equal(selectLifecycle(blanks,params({segment:'all',sort:key,direction})).rows.at(-1).id,'missing');
}
assert.throws(()=>selectLifecycle(model,params({direction:'invalid'})),/invalid_filter/);
assert.throws(()=>selectLifecycle(model,params({sort:'invalid'})),/invalid_filter/);
// Sales CRM entries without an ENGER link must remain visible in Current.
const crmModel=buildLifecycle({directory,contacts,proposals,links:[{source_company_id:'a',company_id:'sales-linked'}],sales:[
 {id:'sales-linked',name:'連携済企業',status:'attacked',emails:[]},
 {id:'sales-active',name:'対応中の企業',status:'proposal',emails:['contact@example.test'],next_action:'返信を確認',last_contact_at:'2026-11-05T02:00:00Z'},
 {id:'sales-click',name:'反応あり',status:'clicked',phone:'03-1234-5678'},
 {id:'sales-untouched',name:'未着手',status:'untouched'},
 {id:'sales-hidden',name:'非表示',status:'meeting',hidden_at:'2026-11-01T00:00:00Z'}
]});
assert.equal(crmModel.salesOnly.length,2,'unlinked active CRM companies are included, untouched/hidden/linked excluded');
assert.equal(selectLifecycle(crmModel,params({segment:'current'})).selectedCount,5,'Current shows ENGER active, unlinked activity, and Sales CRM active');
assert.equal(selectLifecycle(crmModel,params({segment:'all'})).selectedCount,6,'All ENGER directory remains ID scoped');
assert.equal(selectLifecycle(crmModel,params({segment:'current',q:'sales-active'})).selectedCount,1,'Sales ID search works for unlinked CRM companies');
assert.equal(selectLifecycle(crmModel,params({segment:'current',contact:'email'})).selectedCount,1,'Sales contacts can filter Current');
assert.equal(crmModel.salesOnly[0].statusLabel,'営業中・Sales企業DB');
assert.equal(crmModel.rows.find(r=>r.id==='a').segment,'current','linked Sales outreach also appears in Current');
const at=p=>new URL('../'+p,import.meta.url).pathname;
let authenticated=true,ctx={tenantId:'4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',sell:true},calls=0;
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_r,res)=>{if(authenticated)return{id:'user'};res.statusCode=401;res.end('{}');return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell}});
const tables={dx2_sales_company_directory_for_tenant:directory,companies:contacts,proposals:proposals.filter(p=>!['失注','稼働'].includes(p.stage)),gw_sales_company_links:[],gw_sales_companies:[],gw_employees:[],gw_sales_enger_company_overrides:[],jobs:[]};
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
await run('GET','?refresh=1');assert.equal(calls,2,'read after registration bypasses stale cache');
const source=Array.from({length:1201},(_,i)=>({id:String(i)}));
assert.equal((await readAll(()=>({range:async(a,b)=>({data:source.slice(a,b+1),count:source.length})}))).length,1201);
await assert.rejects(readAll(()=>({range:async()=>({data:source.slice(0,499),count:1201})})),/incomplete_source/);
await assert.rejects(readAll(()=>({range:async(a,b)=>({data:source.slice(a,b+1),count:a?1200:1201})})),/incomplete_source/);
console.log('PASS lifecycle: conservative classification, IDs, candidate overlap, contact overrides, filters, authentication/tenant/GET gates, complete pagination, cache');
