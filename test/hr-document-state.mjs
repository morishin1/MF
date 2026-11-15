// HR書類一覧は「アップロード済み／未アップロード」の二値。
// 承認、不備、契約公開・合意を、書類の存在状態と混ぜない。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../js/hr-applicant-list.js',import.meta.url),'utf8'),context);
const H=context.HRApplicantList;
const a={stage:'applied',status:'todo',employmentType:'契約社員',jobTitle:'営業',
 docs:{resume:true,reviews:{resume:'confirmed'}}};
const rows=x=>Object.fromEntries(H.documents(x).map(d=>[d.key,d]));
assert.equal(rows(a).resume.state,'uploaded');
assert.equal(rows(a).work_history.state,'not-uploaded');
assert.equal(rows(a).skill_sheet.state,'not-uploaded');
assert.equal(rows(a).notice.state,'not-uploaded');
assert.equal(rows({...a,docs:{resume:true}}).resume.state,'uploaded','確認結果がなくてもPDFは登録済み');
assert.equal(rows({...a,docs:{resume:true,reviews:{resume:'defective'}}}).resume.state,'uploaded','不備は詳細のレビュー状態として保持する');
assert.equal(rows({...a,docs:null}).resume.state,'not-uploaded','一覧データ上で書類が無い場合');
assert.equal(rows({...a,docs:{},talentCategory:'contractor',jobTitle:'エンジニア'}).resume.required,false);
assert.equal(rows({...a,talentCategory:'contractor',jobTitle:'エンジニア'}).skill_sheet.required,true);
assert.equal(rows({...a,employmentType:'アルバイト'}).work_history.required,false);
assert.equal(rows({...a,offerType:'spot',docs:{}}).resume.required,false);
assert.equal(rows({...a,stage:'offer',docs:{conditions:{notice:true,noticeConfirmed:true}}}).notice.state,'not-uploaded','Officeの条件通知書はHR内定通知ではない');
assert.equal(rows({...a,stage:'offer',docs:{conditions:{offer:true}}}).notice.state,'uploaded','HR内定通知PDFだけで判定');
assert.equal(rows({...a,stage:'offer',pdfFlow:{phase:'terms_preparing'}}).notice.state,'not-uploaded','進捗段階を提出済みとは扱わない');
assert.equal(rows({...a,stage:'offer',docs:{conditions:{contract:true}}}).contract.state,'uploaded','Officeの契約書だけで判定');
for(const value of ['uploaded','not-uploaded'])assert.ok(H.documents(a).every(d=>['uploaded','not-uploaded'].includes(d.state)));
assert.equal(H.view({...a,status:'declined',currentTrial:{status:'active'}}).stage,'closed');
assert.equal(H.pipeline({...a,status:'done',employeeId:'employee'}).stage,'complete');
assert.equal(H.deadline({...a,decisionDueOn:'2026-11-15'},new Date('2026-11-14T01:00:00Z')).overdue,false);
assert.equal(H.deadline({...a,decisionDueOn:'2026-11-13'},new Date('2026-11-14T01:00:00Z')).overdue,true);
console.log('PASS HR binary document state, independent Office docs, required metadata, terminal hiring and JST deadlines');
