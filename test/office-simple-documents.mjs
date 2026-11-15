// Office契約書類は、PDFを保管・確認するシンプルな画面に限定する。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../office/hiring-documents.html',import.meta.url),'utf8');
const uploader=readFileSync(new URL('../js/hr-candidate-documents-ui.js',import.meta.url),'utf8');
assert.match(html,/>契約・書類</);
assert.match(html,/mode:'office-upload'/,'Office専用のアップロード・閲覧モード');
assert.match(html,/未アップロード/);
assert.match(html,/アップロード済み/);
assert.match(html,/uploadedKinds/,'API由来の実際の書類状態だけを表示');
assert.match(html,/HRCandidateDocuments\.mount/);
assert.doesNotMatch(html,/id="office-hiring-review"|id="office-hiring-publish"|id="office-hiring-steps"/,'公開・契約フローの余分な操作を表示しない');
assert.match(uploader,/mode==='office-upload'/);
assert.match(uploader,/data-action="preview"/,'登録したPDFを閲覧できる');
assert.match(uploader,/data-action="upload"/,'登録または新しい版を保存できる');
assert.doesNotMatch(html,/\/admin-onboard\.html|\/admin-hr\.html/,'この画面で署名・入社手続きを促さない');
const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline,'画面のイベント処理が存在');
new Function(inline[1]); // JS構文の確認
console.log('PASS Office simplified signed-PDF archive: binary status, read/upload only, no publication or sign controls');
