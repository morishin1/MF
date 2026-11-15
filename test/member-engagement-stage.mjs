import test from 'node:test';
import assert from 'node:assert/strict';
import { engagementStage, validEngagementStage, loadEngagementStages } from '../lib/member-engagement-stage.js';
const today='2026-11-16';
test('trial, probation and regular are administrative stages; sales roles are never accepted as stages',()=>{
  for(const x of [null,'trial','probation','regular'])assert.equal(validEngagementStage(x),true);
  for(const x of ['agent','active','left','',{},'owner'])assert.equal(validEngagementStage(x),false);
});
test('explicit management choice overrides an older HR trial without changing employment or access',()=>{
  const employee={engagement_stage:'regular',employment_type:'業務委託',status:'active',user_id:'u1'};
  const before=structuredClone(employee);
  assert.equal(engagementStage(employee,{applicant:{offer_type:'trial_2weeks',status:'accepted'}},today).key,'regular');
  assert.deepEqual(employee,before);
});
test('linked accepted HR trial and active contract probation are classified separately',()=>{
  assert.equal(engagementStage({}, {applicant:{offer_type:'trial_2weeks',status:'accepted'}},today).key,'trial');
  assert.equal(engagementStage({}, {applicant:{offer_type:'trial_2weeks',status:'declined'}},today).key,'regular');
  assert.equal(engagementStage({}, {contract:{status:'active',period_from:'2026-11-01',probation_end:'2027-02-01'}},today).key,'probation');
  assert.equal(engagementStage({}, {contract:{status:'active',period_from:'2026-12-01',probation_end:'2027-02-01'}},today).key,'regular');
  assert.match(engagementStage({}, {contract:{status:'active',period_from:'2026-01-01',probation_end:'2026-02-01'}},today).source,/満了/);
});
test('lookup failure is shown as unknown rather than silently normal; manual choice remains usable',async()=>{
  const calls=[];
  const sb={from(table){const q={select(){return q},eq(k,v){calls.push([table,k,v]);return q},in(){return q},order(){return q},limit:async()=>({data:null,error:{message:'offline'}})};return q;}};
  const rows=await loadEngagementStages(sb,'tenant-a',[{id:'e1'},{id:'e2',engagement_stage:'trial'}],today);
  assert.equal(rows.get('e1').key,'unknown');assert.equal(rows.get('e2').key,'trial');
  assert.equal(calls.filter(c=>c[1]==='tenant_id'&&c[2]==='tenant-a').length,2);
});
