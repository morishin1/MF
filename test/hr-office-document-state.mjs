// HRの内定通知書とOfficeの労働条件通知書・契約書を同じ「提出済み」と誤認しない。
import assert from 'node:assert/strict';
import '../js/hr-applicant-list.js';
const H=globalThis.HRApplicantList;
const base={id:'test-applicant',stage:'offer',status:'offer_draft_pending',decision:'hired',offerType:'executive_employee',docs:{conditions:{}}};
const row=(a,key)=>H.documents(a).find(d=>d.key===key);
assert.equal(row(base,'notice').label,'内定通知書（HR）');
assert.equal(row(base,'notice').state,'not-uploaded');
assert.equal(row({...base,docs:{conditions:{notice:true,contract:true,offer:false}}},'notice').state,'not-uploaded','Officeの条件通知書だけではHR内定通知をアップロード済みにしない');
assert.equal(row({...base,docs:{conditions:{offer:true,notice:false,contract:false}}},'notice').state,'uploaded');
assert.equal(row({...base,docs:{conditions:{offer:true,notice:false,contract:false}}},'contract').state,'not-uploaded');
assert.equal(row({...base,docs:{conditions:{contract:true,offer:false}}},'contract').state,'uploaded');
assert.match(row({...base,offerType:'contractor'},'contract').label,/Office/);
console.log('PASS HR vs Office document states: separated offer/terms/contract status, no invented upload');
