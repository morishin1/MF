import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMemDb } from './_memdb.mjs';

const path = name => fileURLToPath(new URL('../' + name, import.meta.url));
const tenant = '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
const mem = createMemDb();
const proposals = 'gw_sales_proposals';
const assessments = 'gw_sales_proposal_assessments';
const outcomes = 'gw_sales_proposal_latest_results';
let ctx, signedIn;
const actor = {id:id(5)};
function admin() {
  const client = mem.admin();
  client.schema = name => ({from:table=>client.from(name+'.'+table)});
  client.rpc = async (_name, change) => {
    const next = change.p_revision + 1;
    const row = { tenant_id:change.p_tenant, proposal_id:change.p_proposal, revision:next, facts:change.p_facts, assessment:change.p_assessment };
    mem.rows[assessments].push(row);
    mem.rows[outcomes] = [{tenant_id:tenant,proposal_id:id(1),interview_result:row.facts.interviewResult}];
    return {data:next,error:null};
  };
  return client;
}
mock.module(path('lib/supabase.js'), {namedExports:{admin,userClient:() => mem.userClient('tester')}});
mock.module(path('lib/auth.js'), {namedExports:{requireUser:async (_req,res) => {
  if (signedIn) return actor;
  res.statusCode = 401; res.end('{}'); return null;
}}});
mock.module(path('lib/gw.js'), {namedExports:{gwContext:async () => ctx,canSell:c => c.roles.includes('sales')}});
const {default:handler,runReadiness} = await import('../api/sales/proposals/readiness.js');
function reset() {
  ctx = {tenantId:tenant,employee:{id:id(6),status:'active'},roles:['sales']};
  signedIn = true;
  mem.rows[proposals] = [{id:id(1),tenant_id:tenant,source_system:'enger',source_proposal_id:id(2),company_name:'Example Inc.',
    sent_at:'2026-11-01T01:00:00Z',status:'meeting_done',sales_owner_id:id(6)}];
  mem.rows['enger.organization_memberships'] = [];
  mem.rows['enger.proposals'] = [{id:id(2),job_id:id(3),candidate_id:id(4),stage:'面談',job_action_type:'proceed'}];
  mem.rows['enger.jobs'] = [{id:id(3),skills:['Java'],detail:'【必須スキル】\n・Javaの開発経験',salary_max:90}];
  mem.rows['enger.candidates'] = [{id:id(4),skills:['Java'],rate:'80万円',exp:'5年',status:'提案可',
    skill_sheet_url:'https://private.example.test/sheet',name:'Secret Candidate',email:'secret@example.test'}];
  mem.rows['enger.dx2_match_ai_evaluations'] = [];
  mem.rows.gw_sales_proposal_activities = [];
  mem.rows[assessments] = [];
  mem.rows[outcomes] = [];
}
async function call({method='GET',body,proposal=id(1),prepare}={}) {
  const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=JSON.parse(value);}};
  const req={method,url:'/api/sales/proposals/readiness?id='+proposal,body};
  if (prepare) await runReadiness(req,res,{db:admin(),sb:mem.userClient('tester'),ctx,user:actor,prepare});
  else await handler(req,res);
  return res;
}
test('sales assessment requires authenticated active internal Sales and visible source',async()=>{
  reset();signedIn=false;assert.equal((await call()).statusCode,401);
  signedIn=true;ctx.tenantId=id(99);assert.equal((await call()).statusCode,403);
  ctx.tenantId=tenant;ctx.roles=[];assert.equal((await call()).statusCode,403);
  ctx.roles=['sales'];mem.rows['enger.organization_memberships']=[{user_id:actor.id,membership_type:'external',status:'active'}];
  assert.equal((await call()).statusCode,403);
  mem.rows['enger.organization_memberships']=[];assert.equal((await call({proposal:id(99)})).statusCode,404);
  mem.rows['enger.proposals'][0].deleted_at='2026-11-20';assert.equal((await call()).statusCode,404);
});
test('facts and outcome persist once, readers cannot write, counts contain only the authorized tenant',async()=>{
  reset();
  mem.rows[proposals].push({...mem.rows[proposals][0],id:id(99),tenant_id:id(100),status:'won'});
  const before=await call();
  assert.equal(before.statusCode,200);
  assert.equal(before.body.conditions.talentMin,80);
  assert.equal(before.body.history.won,0);
  assert.equal(before.body.history.meetings,1);
  assert.doesNotMatch(JSON.stringify(before.body),/private\.example|Secret Candidate|secret@/);
  const write={method:'POST',body:{id:id(1),revision:0,action:'save',facts:{interviewResult:'passed',contact:'direct'}}};
  ctx.employee.id=id(90);
  assert.equal((await call(write)).statusCode,403);
  ctx.employee.id=id(6);
  assert.equal((await call(write)).body.revision,1);
  assert.equal((await call(write)).statusCode,409);
  const after=await call();
  assert.equal(after.body.facts.interviewResult,'passed');
  assert.equal(after.body.history.passed,1);
  assert.equal(mem.rows[assessments].length,1);
  assert.equal(mem.rows[proposals][0].status,'meeting_done');
});
test('on-demand interview coaching reuses the current evidence without changing the grade',async()=>{
  reset();
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY='fixture';
  try{
    const result=await call({
      method:'POST',body:{id:id(1),revision:0,action:'analyze'},
      prepare:async fit=>{
        assert.deepEqual(fit.matched,['Java']);
        return {strengths:['Javaの経験を確認'],concerns:[],questions:['担当工程は何ですか']};
      },
    });
    assert.equal(result.statusCode,200);
    assert.equal(result.body.assessment.grade,null);
    assert.deepEqual(result.body.interview.questions,['担当工程は何ですか']);
    assert.equal((await call()).body.canAnalyze,false);
  }finally{
    if(key===undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY=key;
  }
});
