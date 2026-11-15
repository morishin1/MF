// 内定者キューはDBの採用判断・PDFの実在事実から算出。本人の合意を自動的に推定しない。
import assert from 'node:assert/strict';
import {officeHandoffSummary,officeHrRecipientIds,contractKindOf,notifyOfficeHandoff} from '../lib/hr-office-handoff.js';
const a={id:'test-id',name:'架空 内定者',decision:'hired',offer_type:'part_time',status:'offer_draft_pending'};
const f=(kind,status,created_at='2026-11-15T01:00:00Z')=>({kind,status,created_at});
const route=docs=>officeHandoffSummary(a,docs);
assert.equal(contractKindOf('contractor'),'contractor_contract');
assert.equal(contractKindOf('spot'),'contractor_contract');
assert.equal(contractKindOf('part_time'),'employment_contract');
assert.equal(contractKindOf('training'),null);
assert.equal(route([]).next,'労働条件通知書PDFを準備・登録');
assert.equal(route([f('terms','draft')]).phase,'terms_review');
assert.equal(route([f('terms','published')]).phase,'offer','内定通知の公開が未確認ならOfficeの行に残る');
assert.equal(route([f('terms','published'),f('offer','published')]).phase,'contract');
assert.equal(route([f('terms','published'),f('offer','published'),f('employment_contract','draft')]).phase,'contract_review');
const published=[f('terms','published'),f('offer','published'),f('employment_contract','published')];
assert.equal(route(published).phase,'acceptance','公開済みPDFだけで合意済みとみなさない');
assert.equal(officeHandoffSummary({...a,status:'accepted'},published).phase,'onboarding');
assert.equal(officeHandoffSummary({...a,status:'done',employee_id:'emp'},published).phase,'done');
assert.equal(officeHandoffSummary({...a,offer_type:'contractor'},[f('terms','published'),f('offer','published'),f('contractor_contract','published')]).phase,'acceptance');
assert.equal(officeHandoffSummary({...a,offer_type:null},[]).phase,'category');
const employees=[
 {id:'owner',user_id:'u1',status:'active'},
 {id:'hr-office',user_id:'u2',status:'active'},
 {id:'hr-only',user_id:'u3',status:'active'},
 {id:'recruiter',user_id:'u4',status:'active'},
 {id:'finance',user_id:'u5',status:'active'},
 {id:'admin',user_id:'u6',status:'active'},
 {id:'retired',user_id:'u7',status:'left'},
 {id:'no-user',user_id:null,status:'active'}
];
const grants=[
 {employee_id:'owner',role:'owner'},
 {employee_id:'hr-office',role:'hr'},
 {employee_id:'hr-only',role:'hr'},
 {employee_id:'recruiter',role:'recruiter'},
 {employee_id:'finance',role:'finance'},
 {employee_id:'retired',role:'hr'}
];
const apps=new Map([['hr-office',['office']],['hr-only',['hr']],['recruiter',['hr']],['finance',['office']],['retired',['office']]]);
assert.deepEqual(officeHrRecipientIds(employees,grants,[{user_id:'u6'}],apps),['owner','hr-office','admin']);
const fakeRows={
 gw_employees:employees.filter(x=>x.user_id),
 memberships:[{user_id:'u6',role:'admin'}],
 gw_role_grants:grants,
 gw_app_grants:[{employee_id:'hr-office',app_key:'office'},{employee_id:'hr-only',app_key:'hr'},{employee_id:'recruiter',app_key:'hr'},{employee_id:'finance',app_key:'office'}]
};
const sb={from(table){let rows=(fakeRows[table]||[]).map(r=>({...r,tenant_id:'test-tenant'})),q={};
 const api={
 select(){return this;},eq(k,v){rows=rows.filter(r=>r[k]===v);return this;},
 in(k,v){rows=rows.filter(r=>v.includes(r[k]));return this;},
 limit(n){rows=rows.slice(0,n);return this;},
 then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve);}
 };return api;}};
const called=[];
const output=await notifyOfficeHandoff({sb,tenantId:'test-tenant',applicantId:'app-1',applicantName:'架空 内定者',
  decisionAt:'2026-11-15T01:00:00Z',notifyFn:async(rows,opts)=>{called.push({rows,opts});return {created:rows.length};}});
assert.equal(output.ready,true);
assert.deepEqual(called[0].rows.map(x=>x.employeeId),['owner','hr-office','admin']);
assert.ok(called[0].rows.every(x=>x.link==='/office/hiring-documents.html?applicantId=app-1'&&x.dedupeKey.startsWith('hr_office_handoff:')));
assert.equal(called[0].opts.replace,false,'同じ決定でベル通知を積み増さない');
console.log('PASS HR→Office: role-scoped handoff, deduped notification, real PDF-only progress, no implied signature');
