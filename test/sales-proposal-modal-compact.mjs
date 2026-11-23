import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const html=readFileSync(join(root,'sales/proposals.html'),'utf8');
const css=readFileSync(join(root,'css/sales-proposals-simple.css'),'utf8');
const ui=readFileSync(join(root,'js/sales-proposal-readiness.js'),'utf8');

test('proposal modal uses exactly three tabs and defaults to matching',()=>{
 assert.match(html,/ppActiveDetailTab = 'matching'/);
 assert.match(html,/ppActiveDetailTab='matching'/);
 assert.match(html,/\['matching','マッチング'\],\['business','商談'\],\['history','履歴'\]/);
 assert.doesNotMatch(html,/const tabs=\[\['response','対応'\],\['finance'/);
 assert.match(html,/const keys=\['matching','business','history'\]/);
 assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});
test('match score and skills have clear provenance, detail is inline',()=>{
 assert.match(ui,/登録スキル一致率/);
 assert.match(ui,/ENGER AIマッチングスコア/);
 assert.match(ui,/pp-match-big-number/);
 assert.match(ui,/fit\.matched/);
 assert.match(html,/class="pp-inline-entity"/);
 assert.match(html,/<summary role="button">詳細<\/summary>/);
 assert.match(html,/class="pp-inline-sheet"/);
});
test('business correspondence stays inline; mailto is not counted as automatically sent',()=>{
 assert.match(html,/function ppOpenInlineContact\(side\)/);
 assert.match(html,/id="pp-mail-form"/);
 assert.match(html,/メールアプリで開く/);
 assert.match(html,/送信したことを確認/);
 assert.match(html,/function ppConfirmContactMail\(\)/);
 assert.match(html,/action:'mail'/);
 assert.match(html,/action:'memo'/);
});
test('history is expandable with a timestamp, and existing Gmail history remains accessible',()=>{
 assert.match(html,/class="pp-history-item"/);
 assert.match(html,/<summary><time>\$\{esc\(fmt\(a\.occurredAt\)\)\}/);
 assert.match(html,/pp-history-note/);
 assert.match(html,/Gmailで送信内容を検索/);
 assert.match(css,/\.pp-history-content/);
});
