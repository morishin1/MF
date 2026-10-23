import assert from 'node:assert/strict';
import { proposalJourney } from '../lib/sales-proposal-journey.js';
const since = '2026-10-18T15:00:00Z', until = '2026-10-23T11:00:00Z';
const p = (id, extra = {}) => ({id, sent_at: '2026-10-19T01:00:00Z', source_system:'enger', ...extra});
const a = (proposal_id, kind, result, extra={}) => ({proposal_id,kind,result,occurred_at:'2026-10-20T01:00:00Z',...extra});
const proposals = [p('a'),p('b',{status:'won'}),p('c',{source_stage:'合格'}),p('d',{source_stage:'稼働'}), p('a'),
 p('before',{sent_at:'2026-10-18T14:59:59Z'}),p('boundary',{sent_at:since}),p('future',{sent_at:'2026-10-24T00:00:00Z'}),
 p('archived',{archived_at:until}),p('draft',{sent_at:null}),p('manual',{source_system:'manual',source_stage:'合格'})];
const activities = [a('a','meeting','scheduled'),a('a','meeting','done'),a('a','meeting','done'),
 a('a','sync',null,{detail:{to:'合格'}}),a('a','result','lost'),a('b','meeting','canceled'),
 a('c','meeting','done',{occurred_at:'2026-10-25T01:00:00Z'}),a('d','meeting','done',{occurred_at:'2026-10-18T01:00:00Z'}),
 a('a','reply',null,{outcome:'meeting'})];
const r = proposalJourney(proposals,activities,{since,until});
assert.equal(r.cohortCount,5); assert.deepEqual(r.counts,{sent:5,adjusted:1,scheduled:1,held:1,accepted:2,won:1,working:1});
assert.equal(r.coverage.acceptedUnknown,3); assert.equal(r.rates.acceptedFromHeld,null);
assert.equal(r.rows.find(x=>x.id==='a').acceptedAt,null,'legacy dispatch time is not pass time');
assert.equal(r.rows.find(x=>x.id==='b').heldAt,null,'won/cancel does not imply held');
assert.equal(r.rows.find(x=>x.id==='d').acceptedEvidence,null,'working does not imply pass');
const recorded = '2026-10-22T00:00:00.000Z';
const explicit = proposalJourney([p('a')],[a('a','sync',null,{occurred_at:recorded,detail:{to:'合格',stageChange:{to:'合格',occurred_at:recorded}}})],{since,until});
assert.equal(explicit.rows[0].acceptedAt,recorded);
assert.equal(explicit.counts.held,0,'pass does not imply interview');
assert.equal(proposalJourney([],[],{since,until}).rates.heldFromSent,null);
assert.equal(proposalJourney(proposals,activities,{since,until,activityTruncated:true}).rates.heldFromSent,null);
assert.throws(()=>proposalJourney([],[],{since:'bad',until}),/invalid_period/);
console.log('sales proposal journey: cohort, boundaries, dedupe, evidence, no inference, missing history passed');
const owners = proposalJourney([p('one',{sales_owner_id:'e1'}),p('two',{sales_owner_id:'e2'}),p('closed',{status:'lost'})],
 [a('one','meeting','done')],{since,until,nameOf:()=> '同じ名前'});
assert.equal(owners.byCurrentOwner.length,3,'IDs not names identify owners');
assert.equal(owners.byCurrentOwner.find(x=>x.ownerId==='e1').heldRate,100);
assert.equal(owners.byCurrentOwner.find(x=>x.ownerId==='e1').heldMedianDays,1);
assert.equal(owners.bottlenecks.awaitingHeld,1,'closed/lost not waiting');
assert.equal(owners.bottlenecks.awaitingAcceptedEvidence,1);
assert.equal(owners.bottlenecks.heldMeasured,1);
console.log('current owner responsibility and measured calendar days passed');
const companies = proposalJourney([
 p('c1',{company_id:'x',company_name:'同名',status:'lost',close_reason:'client_declined',close_note:'原文そのまま'}),
 p('c2',{company_id:'y',company_name:'同名',status:'lost'}),
 p('c3',{company_id:'x',company_name:'同名',status:'closed_no_reply',close_reason:'no_reply'}),
 p('c4',{company_name:'同名'}),p('c5',{company_name:'同名'})],[],{since,until});
assert.equal(companies.byCompany.length,4,'company IDs not display names; missing IDs not merged');
const co = companies.byCompany.find(x=>x.companyKey==='sales:x');
assert.equal(co.sent,2); assert.equal(co.lost,1,'no reply is not rejection');
assert.deepEqual(co.reasons,[{code:'client_declined',count:1,label:'企業側の見送り'}]);
assert.equal(companies.byCompany.find(x=>x.companyKey==='sales:y').unknownReason,1);
assert.equal(companies.rows.find(x=>x.id==='c1').closeNote,'原文そのまま');
console.log('company identity, recorded loss reasons, unknown reasons and no inferred rejection passed');
const reasonRows = ['not_asked','no_answer','vague','specific','legacy'].map(id=>p(id,{company_id:'one-company',status:'lost',close_reason:'other'}));
const reasonActs = reasonRows.filter(x=>x.id!=='legacy').map((x,i)=>a(x.id,'result','lost',{id:String(i),detail:{reasonCollection:{version:1,status:x.id}}}));
const acquired = proposalJourney(reasonRows,reasonActs,{since,until});
assert.deepEqual(acquired.byCompany[0].collectionCounts,{not_asked:1,no_answer:1,vague:1,specific:1,unclassified:1});
assert.equal(acquired.byCompany[0].reasons[0].count,2,'information gaps excluded from reason distribution');
assert.equal(acquired.rows.find(x=>x.id==='legacy').reasonCollectionStatus,'unclassified','no backfill');
const updated = proposalJourney([reasonRows[0]], [...reasonActs,a('not_asked','memo',null,{occurred_at:'2026-10-21T00:00:00Z',detail:{reasonCollection:{version:1,status:'no_answer'}}})],{since,until});
assert.equal(updated.rows[0].reasonCollectionStatus,'no_answer');
const reset = proposalJourney([reasonRows[0]], [...reasonActs,a('not_asked','result','lost',{occurred_at:'2026-10-22T00:00:00Z'})],{since,until});
assert.equal(reset.rows[0].reasonCollectionStatus,'unclassified','new loss must not inherit old collection status');
console.log('reason acquisition states: explicit only, chronological updates, legacy no backfill and separate distribution passed');

const resetAfterReopen = proposalJourney([reasonRows[0]], [...reasonActs,
 a('not_asked','decision','continue',{occurred_at:'2026-10-21T00:00:00Z'}),
 a('not_asked','reply',null,{outcome:'declined',occurred_at:'2026-10-22T00:00:00Z'})],{since,until});
assert.equal(resetAfterReopen.rows[0].reasonCollectionStatus,'unclassified','reopened then declined call/reply is a new loss');

const laterSpecific = proposalJourney([reasonRows[0]], [...reasonActs,a('not_asked','memo',null,{occurred_at:'2026-10-21T00:00:00Z',detail:{reasonCollection:{version:1,status:'specific'}}})],{since,until});
assert.equal(laterSpecific.rows[0].reasonCollectionStatus,'specific');
assert.equal(laterSpecific.rows[0].reasonCategoryUnrecorded,true,'memo must not turn compatibility other into a factual category');
assert.equal(laterSpecific.byCompany[0].unknownReason,1);
assert.deepEqual(laterSpecific.byCompany[0].reasons,[{code:'unrecorded',count:1,label:'理由未入力'}]);
const explicitOther = proposalJourney([reasonRows[0]], [...reasonActs,a('not_asked','result','lost',{outcome:'other',occurred_at:'2026-10-22T00:00:00Z',detail:{reasonCollection:{version:1,status:'specific'}}})],{since,until});
assert.equal(explicitOther.rows[0].reasonCategoryUnrecorded,false);
assert.equal(explicitOther.byCompany[0].unknownReason,0);
assert.equal(explicitOther.byCompany[0].reasons[0].code,'other','explicit new category distinct from compatibility placeholder');
