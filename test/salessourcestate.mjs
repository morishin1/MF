import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemDb } from './_memdb.mjs';
import { normalizeEvent, intakeEvent } from '../lib/sales-proposal-intake.js';
import { normalizeSourceState, readSourceStates, shapeSourceState } from '../lib/sales-proposal-source-state.js';
const originalGate=process.env.SALES_SOURCE_STATE_ENABLED;
process.env.SALES_SOURCE_STATE_ENABLED='1';
const now=new Date('2026-10-29T00:00:00Z');
const event={event_id:'enger:state:p1:10',event_type:'proposal.source_state',occurred_at:now.toISOString(),proposal:{id:'p1'},
 source_state:{version:'10',deleted:true,company_response:'pass',source:'enger.proposals.job_action_type'}};
const parsed=normalizeEvent(event,{now}); assert.ok(parsed.value); assert.equal(parsed.value.sourceState.version,'10');
for(const version of [0,10,'0','-1','1.1','9223372036854775808','0010',null]) {
 assert.ok(normalizeSourceState({...event,source_state:{...event.source_state,version}},{now}).error);
}
assert.ok(normalizeSourceState({...event,source_state:{...event.source_state,version:'9223372036854775807'}},{now}).value);
for(const [key,value] of [['deleted',1],['company_response','提案中'],['company_response',undefined],['source','enger.proposals.cand_action_type']]) {
 assert.ok(normalizeSourceState({...event,source_state:{...event.source_state,[key]:value}},{now}).error);
}
for(const occurred_at of [undefined,'bad','2026-10-30T00:00:00Z'])assert.ok(normalizeSourceState({...event,occurred_at},{now}).error);
for(const value of ['unanswered','proceed','pass',null])assert.ok(normalizeSourceState({...event,source_state:{...event.source_state,company_response:value}},{now}).value);
assert.equal(shapeSourceState({deleted:false,company_response:'pass'}).companyResponseLabel,'見送り');
assert.equal(shapeSourceState(null).companyResponseLabel,null);
assert.equal(shapeSourceState(null,{expected:true}).sourceStatePending,true);
assert.equal(shapeSourceState(null,{expected:true}).sourceDeleted,null);
const mem=createMemDb(); const sb=mem.admin(); const calls=[];
sb.rpc=async(name,args)=>{calls.push({name,args});return {data:'updated',error:null};};
const out=await intakeEvent(sb,'tenant1',parsed.value,{now});
assert.equal(out.result,'updated');assert.equal(out.proposalId,null);
assert.deepEqual(calls[0],{name:'gw_sales_apply_source_state',args:{p_tenant:'tenant1',p_source_id:'p1',p_version:'10',p_deleted:true,p_response:'pass',p_observed_at:now.toISOString(),p_event_id:event.event_id}});
assert.equal((mem.rows.gw_sales_proposals||[]).length,0,'source state never creates a Sales proposal');
assert.equal((mem.rows.gw_sales_proposal_tasks||[]).length,0);
assert.ok(!out.notify&&!out.slack,'no new recipient or notification');
assert.equal((await intakeEvent(sb,'tenant1',parsed.value,{now})).result,'replayed');assert.equal(calls.length,1);
const missing={from:()=>({select:()=>({eq:()=>({in:async()=>({error:{code:'42P01'}})})})})};
assert.ok((await readSourceStates(missing,'t',[{source_system:'enger',source_proposal_id:'p'}])).error,'configured schema disappearance fails closed');
const unavailable={from:()=>({select:()=>({eq:()=>({in:async()=>({error:{code:'42501'}})})})})};
assert.ok((await readSourceStates(unavailable,'t',[{source_system:'enger',source_proposal_id:'p'}])).error,'permission/query failures never become no deletion');
const sql=readFileSync(new URL('../db/149_sales_proposal_source_state.sql',import.meta.url),'utf8');
assert.match(sql,/for update;/);assert.match(sql,/v.source_version > p_version/);assert.match(sql,/v.source_version = p_version/);
assert.match(sql,/source_version_conflict/);assert.match(sql,/primary key \(tenant_id, source_proposal_id\)/);
assert.match(sql,/from public,anon,authenticated/);assert.match(sql,/to service_role/);
assert.match(sql,/public.gw_is_sales\(tenant_id\)/);assert.match(sql,/public.gw_sales_proposal_visible/);assert.match(sql,/p.source_proposal_id = gw_sales_proposal_source_state.source_proposal_id/);assert.doesNotMatch(sql,/delete from|drop table/i);
console.log('Source-state normalization, provenance, minimal intake, replay, migration guards PASS');

for (const gate of [undefined,'0','true','invalid']) {
 if(gate===undefined)delete process.env.SALES_SOURCE_STATE_ENABLED;else process.env.SALES_SOURCE_STATE_ENABLED=gate;
 const never={from:()=>{throw new Error('disabled source state must not query');},rpc:()=>{throw new Error('disabled source state must not write');}};
 assert.equal((await readSourceStates(never,'t',[{source_system:'enger',source_proposal_id:'p'}])).available,false);
 assert.equal((await intakeEvent(never,'tenant1',parsed.value,{now})).status,503);
}
if(originalGate===undefined)delete process.env.SALES_SOURCE_STATE_ENABLED;else process.env.SALES_SOURCE_STATE_ENABLED=originalGate;
console.log('Unset/zero/invalid gate performs no source reads or intake writes PASS');
