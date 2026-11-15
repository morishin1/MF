// HR応募者一覧：NEXTを1つに絞り、行クリックの詳細と状態ボタンの対応モーダルを分ける。
// バイナリの書類表示と、編集権限・保存操作は既存の実装を使う。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../hr/applicants.html',import.meta.url),'utf8');
const list=fs.readFileSync(new URL('../js/hr-applicant-list.js',import.meta.url),'utf8');
const ctx=vm.createContext({URL});
vm.runInContext(list,ctx);
const M=ctx.HRApplicantList;

const a={id:'a',stage:'casual_interview',status:'eval_pending',jobTitle:'エンジニア',docs:{
  resume:true,workHistory:false,skillSheet:true,conditions:{notice:false,contract:true},
  reviews:{resume:'defective',skill_sheet:'confirmed'}
}};
const rows=M.documents(a);
assert.equal(rows.length,5);
assert.deepEqual([...rows].map(x=>x.state),['uploaded','not-uploaded','uploaded','not-uploaded','uploaded']);
assert.deepEqual([...rows].map(x=>x.text),['アップロード済み','未アップロード','アップロード済み','未アップロード','アップロード済み']);
assert.ok(rows.every(x=>['uploaded','not-uploaded'].includes(x.state)),'一覧は二値だけ');
assert.equal(M.documents({...a,docs:null}).every(x=>x.state==='not-uploaded'),true);

assert.match(html,/<th>社内メモ<\/th><th>NEXT<\/th><th>担当者<\/th>/,'メモの右隣にNEXTを一つ表示');
assert.match(html,/standard:\s*\[[^\]]*"書類",\s*"社内メモ",\s*"NEXT",\s*"担当者"\]/);
assert.match(html,/class="hr-next-choice"/,'NEXTは選択式で管理段階の変更もできる');
assert.match(html,/onclick="runListNext\('/,'主ボタンは本人ごとのNEXTへ接続する');
assert.match(html,/onpointermove="scheduleApplicantHover\(event,/,'マウスオーバーから詳細を開く');
assert.match(html,/function scheduleApplicantHover\(event,id\)/);
assert.match(html,/event\.pointerType!=='mouse'/,'タッチで勝手に開かない');
assert.match(html,/openDetail\('\$\{esc\(a\.id\)\}'\)/,'行クリックも詳細へ');
assert.match(html,/\.hr-detail\s*\{[^}]*width:80vw;/,'PC幅は80%');
assert.match(html,/id="hr-detail-upload"/,'詳細から書類をアップロード');
assert.match(html,/id="hr-detail-status"/,'詳細からステータスを変更');
assert.match(html,/!\['work','details'\]\.includes\(detailMode\)/,'詳細でも同じ安全な変更導線を使う');
assert.match(html,/data-doc-kind/,'種類ごとのアップロード状態を維持');
console.log('PASS HR simplified applicant detail, 80vw, hover, status, upload and binary document indicators');
