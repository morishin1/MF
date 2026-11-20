import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMemDb } from './_memdb.mjs';
const path = name => fileURLToPath(new URL('../' + name, import.meta.url));
const tenant = '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let signedIn = true, sales = true, allowed = true, currentTenant = tenant, adminReads = 0;
const db = createMemDb({ rls: () => allowed });
mock.module(path('lib/auth.js'), { namedExports: { requireUser: async (_req,res) => { if (signedIn) return {id:'staff'};res.statusCode=401;res.end('{}');return null; } } });
mock.module(path('lib/gw.js'), { namedExports: { gwContext: async () => ({tenantId:currentTenant}), canSell: () => sales } });
mock.module(path('lib/supabase.js'), { namedExports: { userClient: () => db.userClient('staff'), admin: () => {adminReads++;const client=db.admin();client.schema=name=>({from:table=>client.from(name+'.'+table)});return client;} } });
const handler = (await import('../api/sales/proposals/entity.js')).default;
function seed() {
  signedIn=true;sales=true;allowed=true;currentTenant=tenant;adminReads=0;db.state.missing=null;
  db.rows.gw_sales_proposals=[{id:id(1),tenant_id:tenant,source_system:'enger',source_proposal_id:id(2)}];
  db.rows['enger.proposals']=[{id:id(2),job_id:id(3),candidate_id:id(4),deleted_at:null}];
  db.rows['enger.jobs']=[{id:id(3),job_no:123,title:'Java開発',role_label:'エンジニア',skills:['Java','SQL'],remote_type:'full_remote',start_date:'2026-12-01',is_closed:false,deleted_at:null,detail:'private mail',contact_email:'secret@example.test'}];
  db.rows['enger.candidates']=[{id:id(4),candidate_no:456,initials:'T.K.',title:'Javaエンジニア',skills:['Java','SQL'],status:'提案可',is_closed:false,deleted_at:null,name:'秘密の氏名',email:'secret@example.test',rate:900000,skill_sheet_url:'https://private.example.test/file'}];
}
async function call(kind='job', proposal=id(1)) {
  const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=JSON.parse(value);}};
  await handler({method:'GET',url:`/api/sales/proposals/entity?id=${proposal}&kind=${kind}`,headers:{}},res);return res;
}
test('entity lookup requires sign-in, Sales and the existing ENGER tenant scope',async()=>{
  seed();signedIn=false;assert.equal((await call()).statusCode,401);
  signedIn=true;sales=false;assert.equal((await call()).statusCode,403);
  sales=true;currentTenant=id(99);assert.equal((await call()).statusCode,403);assert.equal(adminReads,0);
});
test('entity lookup authorizes the proposal before reading ENGER and never accepts a caller entity ID',async()=>{
  seed();assert.equal((await call('job',id(99))).statusCode,404);assert.equal(adminReads,0);
  assert.equal((await call('other')).statusCode,400);assert.equal(adminReads,0);
  db.rows.gw_sales_proposals[0].tenant_id=id(99);assert.equal((await call()).statusCode,404);assert.equal(adminReads,0);
  seed();allowed=false;assert.notEqual((await call()).statusCode,200);assert.equal(adminReads,0);
});
test('job and talent projections return the linked item without private fields or original files',async()=>{
  seed();const job=await call();assert.equal(job.statusCode,200);assert.equal(job.headers['Cache-Control'],'private, no-store');assert.equal(job.body.title,'エンジニア');assert.match(job.body.dxUrl,/jobs/);
  const talent=await call('talent');assert.equal(talent.statusCode,200);assert.equal(talent.body.title,'T.K.');assert.match(talent.body.dxUrl,/talents/);
  for(const result of [job,talent])assert.doesNotMatch(JSON.stringify(result.body),/secret@|秘密の氏名|900000|private\.example|private mail|skill_sheet/);
});
test('deleted, closed, unlinked and unavailable source records fail without fabricated details',async()=>{
  seed();db.rows['enger.proposals'][0].deleted_at='2026-11-20';assert.equal((await call()).statusCode,404);
  seed();db.rows['enger.jobs'][0].is_closed=true;assert.equal((await call()).statusCode,404);
  seed();db.rows['enger.candidates'][0].status='稼働中';assert.equal((await call('talent')).statusCode,404);
  seed();db.rows['enger.proposals'][0].candidate_id=null;assert.equal((await call('talent')).statusCode,404);
  seed();db.state.missing='enger.proposals';assert.equal((await call()).statusCode,503);
});
