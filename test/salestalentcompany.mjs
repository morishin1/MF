import assert from 'node:assert/strict';
import { applyTalentCompanySnapshot } from '../lib/sales-proposal-intake.js';
const snapshot={talentCompanyName:'New Company',talentCompanyObservedAt:'2026-10-03T00:00:00.000Z',initials:'N.C.'};
function fixture({conflictAt=null,alwaysConflict=false,tenant='t'}={}){
 const row={id:'p',tenant_id:tenant,source_system:'enger',talent_company_observed_at:'2026-10-01T00:00:00.000Z',talent_company_name:'Old Company'};
 let writes=0; const seen=[];
 const sb={from:table=>{
  assert.equal(table,'gw_sales_proposals');const filters=[];let patch=null;
  const matches=()=>filters.every(([k,v])=>(row[k]??null)===v);
  const q={eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},
   update(p){patch=p;return q;},select(){
    if(!patch)return q;
    writes++;seen.push(filters);
    if(alwaysConflict)return Promise.resolve({data:[],error:null});
    if(conflictAt && writes===1)row.talent_company_observed_at=conflictAt;
    if(!matches())return Promise.resolve({data:[],error:null});
    Object.assign(row,patch);return Promise.resolve({data:[{id:row.id}],error:null});
   },maybeSingle(){seen.push(filters);return Promise.resolve({data:matches()?{...row}:null,error:null});}};
  return q;
 }};
 return {sb,row,seen,writes:()=>writes};
}
for(const conflictAt of [null,'2026-10-02T00:00:00.000Z']){
 const f=fixture({conflictAt});assert.equal(await applyTalentCompanySnapshot(f.sb,'t','p',snapshot),'updated');
 assert.equal(f.row.talent_company_name,'New Company');assert.equal(f.row.talent_initials,'N.C.');
 assert.ok(f.seen.every(filters=>filters.some(([k,v])=>k==='tenant_id'&&v==='t')&&filters.some(([k,v])=>k==='source_system'&&v==='enger')));
}
const newer=fixture({conflictAt:'2026-10-04T00:00:00.000Z'});
assert.equal(await applyTalentCompanySnapshot(newer.sb,'t','p',snapshot),'stale');assert.equal(newer.row.talent_company_name,'Old Company');
const missing=fixture({tenant:'other'});await assert.rejects(applyTalentCompanySnapshot(missing.sb,'t','p',snapshot),/missing/);assert.equal(missing.writes(),0);
const conflict=fixture({alwaysConflict:true});await assert.rejects(applyTalentCompanySnapshot(conflict.sb,'t','p',snapshot),/conflict/);assert.equal(conflict.writes(),3);
console.log('Talent company CAS: sequential, race retry, newer-wins, tenant/source bounds, bounded retry PASS (model, not live Postgres concurrency)');
