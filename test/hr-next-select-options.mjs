// NEXTプルダウンの候補はメモを参考にするだけ。採用判断・面談・本人の承諾を捏造しない。
import assert from 'node:assert/strict';
import '../js/hr-applicant-list.js';
import {progressOptions} from '../lib/hr-progress.js';
const H=globalThis.HRApplicantList;
const a={id:'11111111-1111-4111-8111-111111111111',name:'架空 応募者',stage:'applied',status:'todo',decision:null,offerType:null,
 note:'内定通知書をお出しできておりません。'};
assert.equal(H.memoSuggestedPhase(a.note),'offer');
assert.equal(H.nextStageChoices(a)[0].value,'phase:offer');
assert.equal(H.nextStageChoices(a)[0].recommended,true);
assert.match(H.nextStageChoices(a)[0].label,/未発行/);
assert.equal(H.pdfUploadTarget(a),null,'管理上の段階を選ぶ前に勝手に内定通知をアップロード扱いにしない');
const manually={...a,manualProgress:{phase:'offer',method:'other'}};
assert.equal(H.view(manually).label,'合格通知の準備','正式な採用決定と区別した表示');
assert.equal(H.pdfUploadTarget(manually)?.kind,'offer','対応段階を選んだらPDF下書き登録へ進める');
assert.ok(!H.nextStageChoices(manually).some(x=>x.key==='offer'),'同じ段階への再移動は表示しない');
assert.equal(H.memoSuggestedPhase('内定通知書は送信済みです'),null,'送信済みから未発行を推定しない');
assert.equal(H.memoSuggestedPhase('まだ資料が届いていません'),null,'無関係のメモから推定しない');
assert.equal(H.nextStageChoices({...a,status:'done'}).length,0,'終了者の履歴を変更しない');
assert.equal(H.nextStageChoices({...a,pdfFlow:{phase:'offer_waiting'}}).length,0,'正式PDFフロー稼働中は別操作');
assert.equal(H.nextStageChoices({...a,employeeId:'employee'}).length,0,'Office引継ぎ後は変更しない');
const permitted=progressOptions({id:a.id,stage:'applied',status:'todo',decision:null,lead_category:'recruitment'},{canDecide:false});
assert.equal(permitted.locked,null);
assert.equal(permitted.options.find(x=>x.key==='offer')?.state,'allowed','面談・評価なしでも内定通知書の社内準備段階へ移動できる');
assert.equal(permitted.options.find(x=>x.key==='trial')?.state,'blocked','採用決定前の正式トライアルは制限');
assert.equal(permitted.options.find(x=>x.key==='agreement')?.state,'blocked','本人合意の段階を勝手に確定しない');
assert.ok(progressOptions({id:a.id,stage:'applied',status:'done',employee_id:'employee'},{canDecide:true}).locked);
console.log('PASS HR NEXT choices: memo suggestion, early internal offer preparation, no fabricated decision or contract actions');
