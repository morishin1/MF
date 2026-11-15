// NEXTの書類導線はローカルで作ったPDFの登録。採用判断を勝手に変えない。
import assert from 'node:assert/strict';
import '../js/hr-applicant-list.js';
const H=globalThis.HRApplicantList;
const base={id:'fixture-1',name:'架空 応募者',stage:'offer',status:'offer_draft_pending',decision:'hired',nextActionKey:'createOffer'};
assert.deepEqual(H.pdfUploadTarget(base),{kind:'offer',title:'合格通知書',cta:'合格通知PDFをアップロード'});
assert.deepEqual(H.pdfUploadTarget({...base,offerType:'contractor'}),{kind:'offer',title:'業務委託オファー',cta:'オファーPDFをアップロード'});
assert.deepEqual(H.pdfUploadTarget({...base,nextActionKey:'reviewOffer'}),H.pdfUploadTarget(base),'レビュー待ちもまずファイルを登録する');
assert.equal(H.pdfUploadTarget({...base,nextActionKey:'formalContract',stage:'joining_scheduled',status:'accepted'}),null,'雇用契約書はOfficeで発行する');
assert.equal(H.pdfUploadTarget({...base,nextActionKey:'formalContract',stage:'joining_scheduled',status:'accepted',offerType:'contractor'}),null,'業務委託契約書もOfficeで管理');
assert.equal(H.pdfUploadTarget({...base,stage:'joining_scheduled',status:'interview_scheduled',nextActionKey:'detail',manualProgress:{phase:'terms'}}),null,'労働条件通知書はOfficeで管理');
for(const changes of [{decision:null},{decision:'rejected'},{status:'done'},{status:'declined'},{stage:'casual_interview'},{nextActionKey:'sendOffer'},{employeeId:'employee-1'},{handoffState:'done'},{pdfFlow:{phase:'offer_preparing'}}]){
 assert.equal(H.pdfUploadTarget({...base,...changes}),null,'不適切な状態ではPDFアップロードを主操作にしない: '+JSON.stringify(changes));
}
console.log('PASS HR PDF NEXT: one precise upload CTA only when approved, no offer send/closed/applicant mix-ups');
