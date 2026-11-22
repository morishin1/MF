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
test('comparison shows one linked pair and counts only this tenant’s sent proposals for the same affiliation',async()=>{
  seed();
  const base = db.rows.gw_sales_proposals[0];
  db.rows['enger.jobs'][0].required_experience_years = '3';
  Object.assign(base,{talent_company_name:'所属テスト社',sent_at:'2026-11-18T10:00:00Z',status:'reply_wait'});
  db.rows.gw_sales_proposals.push(
    {...base,id:id(11),status:'won'},
    {...base,id:id(12),tenant_id:id(99),status:'won'},
    {...base,id:id(13),talent_company_name:'別の所属企業',status:'won'},
    {...base,id:id(14),sent_at:null,status:'proposal_wait'},
    {...base,id:id(15),archived_at:'2026-11-20T00:00:00Z',status:'won'},
  );
  db.rows.gw_sales_proposal_activities = [
    {tenant_id:tenant,proposal_id:id(11),kind:'meeting',result:'done'},
    {tenant_id:tenant,proposal_id:id(11),kind:'meeting',result:'done'},
    {tenant_id:tenant,proposal_id:id(1),kind:'meeting',result:'scheduled'},
  ];
  const compare = await call('compare');
  assert.equal(compare.statusCode,200);
  assert.deepEqual(compare.body.affiliation,{sent:2,meetings:1,won:1,limited:false});
  assert.equal(compare.body.job.jobTitle,'Java開発');
  assert.deepEqual(compare.body.job.fields.find(f=>f.label==='必要経験'),{label:'必要経験',value:'3年以上'});
  assert.deepEqual(compare.body.talent.sheet.skills,['Java','SQL']);
  assert.doesNotMatch(JSON.stringify(compare.body),/secret@|秘密の氏名|900000|private\.example|private mail|別の所属企業/);
  db.rows['enger.jobs'][0].is_closed = true;
  const partial = await call('compare');
  assert.equal(partial.body.job.error,'job_unavailable');
  assert.equal(partial.body.talent.title,'T.K.');
  db.rows['enger.proposals'][0].deleted_at = '2026-11-20';
  assert.equal((await call('compare')).statusCode,404);
});
