import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import {OFFER_TYPES_PUBLIC} from '../lib/hr-offer-types.js';
const c=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../js/hr-applicant-list.js',import.meta.url),'utf8'),c);const H=c.HRApplicantList;
assert.equal(H.categories.length,6);assert.deepEqual(JSON.parse(JSON.stringify(H.categories.map(({key,label})=>({key,label})))),OFFER_TYPES_PUBLIC.map(({key,label})=>({key,label})));
for(const t of OFFER_TYPES_PUBLIC)assert.equal(H.categoryOf({offerType:t.key}),t.key);
assert.equal(H.categoryOf({employmentType:'正社員',name:'営業候補',talentCategory:'recruitment'}),null,'do not infer an unassigned offer type');
assert.equal(H.categoryOf({offerType:'unsupported'}),null);
const cases=[
 [{stage:'applied',status:'todo'},'screening'],
 [{stage:'casual_interview',status:'eval_pending'},'interview'],
 [{stage:'ceo_interview',status:'ceo_decision_pending'},'final'],
 [{stage:'offer',status:'offer_draft_pending'},'offer'],
 [{stage:'offer',status:'offer_sent',pdfFlow:{phase:'offer_waiting'}},'offer'],
 [{stage:'offer',currentTrial:{status:'active'}},'trial'],
 [{stage:'offer',contractState:'request_pending'},'terms'],
 [{stage:'offer',pdfFlow:{phase:'terms_preparing',acceptedAt:'2026-11-14'}},'terms'],
 [{stage:'offer',pdfFlow:{phase:'terms_waiting',acceptedAt:'2026-11-14'}},'agreement'],
 [{stage:'offer',status:'accepted',handoffState:'ready'},'agreement'],
 [{stage:'joining_scheduled',status:'accepted',handoffState:'done'},'office'],
 [{stage:'offer',pdfFlow:{phase:'onboarding',acceptedAt:'2026-11-14'}},'office'],
];
const snapshots=JSON.stringify(cases);for(const [record,stage] of cases){assert.equal(H.pipeline(record).stage,stage);assert.equal(H.view(record).stage,stage);}
assert.equal(JSON.stringify(cases),snapshots,'display mapping never transitions the saved facts');
assert.equal(H.pipeline({status:'declined',currentTrial:{status:'active'}}).stage,'closed');
console.log('PASS six canonical offer categories, explicit unknown classification, eight-stage facts and no early Office transition');
