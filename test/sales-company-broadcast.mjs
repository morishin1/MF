import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createMemDb} from './_memdb.mjs';
const at=p=>new URL('../'+p,import.meta.url).pathname;
const tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const mem=createMemDb({schema:{gw_sales_enger_company_overrides:{unique:[['tenant_id','company_id']]}}});
let authenticated=true,ctx={tenantId:tenant,sell:true},logs=[];
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{const db=mem.admin();return {...db,schema:()=>db};}}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>{if(authenticated)return{id:other};res.statusCode=401;res.end('{}');return null;}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async e=>logs.push(e)}});
const handler=(await import('../api/sales/enger-company-bulk.js')).default;
async function run(body={action:'broadcast',ids:[id],blastTarget:true},method='PATCH'){
 const res={setHeader(){},end(v){this.body=JSON.parse(v);}};await handler({method,body},res);return res;
}
mem.rows.companies=[{id,deleted_at:null}];
mem.rows.gw_sales_enger_company_overrides=[{tenant_id:tenant,company_id:id,priority:'A',relationship_status:'active',relationship_evidence:'確認済みの取引を維持する',hidden_at:null},{tenant_id:other,company_id:id,blast_target:false}];
authenticated=false;assert.equal((await run()).statusCode,401);authenticated=true;
ctx.sell=false;assert.equal((await run()).statusCode,403);ctx.sell=true;
ctx.tenantId=other;assert.equal((await run()).statusCode,403);ctx.tenantId=tenant;
assert.equal((await run({},'GET')).statusCode,405);
for(const body of [{action:'broadcast',ids:[id],blastTarget:'true'},{action:'broadcast',ids:[id,id],blastTarget:true},{action:'broadcast',ids:['activity:name'],blastTarget:true},{action:'broadcast',ids:[],blastTarget:true}])assert.equal((await run(body)).statusCode,400);
assert.equal((await run({action:'broadcast',ids:[other],blastTarget:true})).statusCode,409);
assert.equal((await run()).statusCode,200);
let saved=mem.rows.gw_sales_enger_company_overrides.find(r=>r.tenant_id===tenant);
assert.equal(saved.blast_target,true);assert.equal(saved.priority,'A');assert.equal(saved.relationship_status,'active');assert.equal(saved.blast_updated_by,other);
assert.equal(mem.rows.gw_sales_enger_company_overrides.find(r=>r.tenant_id===other).blast_target,false);
assert.equal(logs.at(-1).action,'sales.enger_directory_broadcast');
assert.equal((await run({action:'priority',ids:[id],priority:'B'})).statusCode,200);
assert.equal(mem.rows.gw_sales_enger_company_overrides.find(r=>r.tenant_id===tenant).blast_target,true,'priority edits preserve membership');
assert.equal((await run({action:'broadcast',ids:[id],blastTarget:false})).statusCode,200);
assert.equal(mem.rows.gw_sales_enger_company_overrides.find(r=>r.tenant_id===tenant).blast_target,false);
assert.equal(mem.rows.gw_sales_enger_company_overrides.find(r=>r.tenant_id===tenant).priority,'B');
assert(mem.state.log.every(r=>!['gw_sales_company_mail','gw_sales_approaches'].includes(r.table)),'classification never sends or creates contact history');
console.log('PASS broadcast: tenant/auth/selection validation, persisted reversible membership, independent field updates, audit and no sending');
for(const segment of ['current','past','future','broadcast','auto']){
 assert.equal((await run({action:'segment',ids:[id],segment})).statusCode,200);
 const s=mem.rows.gw_sales_enger_company_overrides.find(r=>r.tenant_id===tenant);
 assert.equal(s.lifecycle_segment,['current','past','future'].includes(segment)?segment:null);
 assert.equal(s.blast_target,segment==='broadcast');assert.equal(s.relationship_status,'active');assert.equal(s.priority,'B');
}
assert.equal((await run({action:'segment',ids:[id],segment:'invalid'})).statusCode,400);
console.log('PASS segment: reversible workflow movement does not change relationship evidence');
