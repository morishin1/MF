import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {readFileSync} from 'node:fs';
import {profilePatch,profileBatch,planInput,activityInput,ACTION_RESULTS} from '../lib/sales-company-workbench.js';
import {buildLifecycle,selectLifecycle} from '../lib/sales-company-lifecycle.js';
import {createMemDb} from './_memdb.mjs';
assert.deepEqual(profilePatch({phone:'03-1234-5678'}),{phone:'03-1234-5678'});
assert.deepEqual(profilePatch({contactEmail:''}),{contactEmail:null});
assert.deepEqual(profilePatch(profilePatch({contactEmail:''})),{contactEmail:null},'client-normalized clear must pass server validation');
assert.deepEqual(profilePatch({isFavorite:false}),{isFavorite:false});
for(const p of [{id:'evil'},{name:''},{phone:'javascript:x'},{website:'javascript:x'},{contactEmail:'x@example.test\nBcc:a@test.test'},{name:'a',phone:'12345'},{isFavorite:'true'}])assert.throws(()=>profilePatch(p));
assert.deepEqual(profileBatch({name:'株式会社サンプル',industry:'IT・Web・通信'}),{name:'株式会社サンプル',industry:'IT・Web・通信'});
assert.deepEqual(profileBatch({contactEmail:'',isFavorite:false}),{contactEmail:null,isFavorite:false});
for(const value of [{},{name:'',industry:'IT'},{unknown:'x'},{website:'javascript:x'},{isFavorite:'true'}])
 assert.throws(()=>profileBatch(value),'batch validates every modified field');
assert.throws(()=>planInput({nextDate:'2026-02-30'}));assert.deepEqual(planInput({nextAction:''},true),{nextAction:''});
assert.throws(()=>activityInput({channel:'email',result:'sent'}),'email sending is a separate guarded endpoint');
assert.throws(()=>activityInput({channel:'phone',result:'フォーム送信完了（本人確認）'}));
assert.throws(()=>activityInput({channel:'memo',result:ACTION_RESULTS.memo[0]}));
assert.equal(activityInput({channel:'memo',result:ACTION_RESULTS.memo[0],note:'外部で送信済みを確認',plan:{}}).channel,'memo');
const base={directory:[{id:'a',name:'企業',bucket:'revive',relationship_status:'unknown'},{id:'b',name:'停止企業',bucket:'new',needs_contact_review:true}],contacts:[{id:'a'},{id:'b'}],proposals:[]};
for(const segment of ['current','past','future']){
 const m=buildLifecycle({...base,broadcasts:[{company_id:'a',lifecycle_segment:segment,work_plan:{owner:'担当',nextDate:'2026-11-12',nextAction:'ニーズを確認'}}]});
 assert.equal(m.rows[0].segment,segment);assert.equal(m.rows[0].confirmed,false);assert.equal(m.rows[0].relationship,'unknown');assert.equal(m.rows[0].owner,'担当');
 assert.equal(selectLifecycle(m,new URLSearchParams({segment})).rows.some(r=>r.id==='a'),true);
 assert.equal(m.counts.pending,1);
}
const at=p=>new URL('../'+p,import.meta.url).pathname,tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
const mem=createMemDb();let authenticated=true,ctx={tenantId:tenant,sell:true,employee:{display_name:'担当'}},rpcCalls=[],rpcError=null;
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{const d=mem.admin();return{...d,schema:()=>d,rpc:async(name,args)=>{rpcCalls.push({name,args});return{data:{id:'saved'},error:rpcError};}};}}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_r,res)=>{if(authenticated)return{id:actor};res.statusCode=401;res.end('{}');return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell}});
const handler=(await import('../api/sales/company-workbench.js')).default;
mem.rows.dx2_sales_company_directory_for_tenant=[{id,tenant_id:tenant}];
mem.rows.gw_sales_company_activity=[{id:'own',tenant_id:tenant,company_id:id,created_at:'2026-11-05',payload:{result:'電話対応'}},{id:'other',tenant_id:actor,company_id:id,created_at:'2026-11-05',payload:{}}];
async function run(method='PATCH',body={id,patch:{phone:'03-1234-5678'},requestKey:actor}){const res={setHeader(){},end(x){this.body=JSON.parse(x)}};await handler({url:'/api/sales/company-workbench?id='+id,method,body},res);return res;}
authenticated=false;assert.equal((await run()).statusCode,401);authenticated=true;
ctx.sell=false;assert.equal((await run()).statusCode,403);ctx.sell=true;
ctx.tenantId=actor;assert.equal((await run()).statusCode,403);ctx.tenantId=tenant;
assert.equal((await run('DELETE')).statusCode,405);
assert.equal((await run('PATCH',{id,patch:{contactEmail:'invalid'},requestKey:actor})).statusCode,400);
assert.equal((await run('PATCH',{id,patch:{phone:''}})).statusCode,400);
assert.equal(rpcCalls.length,0);assert.equal((await run()).statusCode,200);assert.equal(rpcCalls[0].args.p_actor,actor);assert.equal(rpcCalls[0].args.p_tenant,tenant);
assert.equal((await run('PATCH',{id,patch:{contactEmail:null},requestKey:actor})).statusCode,200,'clear saved contact');
assert.deepEqual((await run('GET')).body.activities.map(x=>x.id),['own']);
const bulk={id,operation:'profile_batch',
 patch:{name:'新しい企業名',industry:'情報通信業'},expected:{name:'旧社名',industry:null},requestKey:actor};
assert.equal((await run('PATCH',bulk)).statusCode,200,'atomic profile batch saved');
assert.equal(rpcCalls.at(-1).name,'gw_sales_company_profile_batch_save');
assert.deepEqual(rpcCalls.at(-1).args.p_expected,{name:'旧社名',industry:null});
assert.equal((await run('PATCH',{...bulk,expected:{name:'旧社名'}})).statusCode,400,'no missing optimistic field');
assert.equal((await run('PATCH',{...bulk,patch:{website:'javascript:invalid'}})).statusCode,400,'reject invalid multi-edit');
assert.equal((await run('POST',{id,channel:'email',result:'sent',requestKey:actor})).statusCode,400);
rpcError={code:'P0001'};assert.equal((await run()).statusCode,409);
const routes=JSON.parse(readFileSync(at('vercel.json')));
for(const source of ['/sales/companies','/sales/companies.html'])assert.equal(routes.redirects.find(r=>r.source===source&&!r.has).destination,'/sales/company-segments.html');
assert.match(readFileSync(at('js/sales-layout.js'),'utf8'),/key: "companies", href: "\/sales\/company-segments.html"/);
console.log('PASS workbench: safe profile editing, action-specific results, plans, workflow overrides, authenticated tenant-scoped API and canonical navigation');
