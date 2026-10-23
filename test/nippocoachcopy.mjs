import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNippoCoachPrompt, readNippoCoachScreen } from '../js/nippo-coach-copy.js';

let passed = 0;
function check(label, fn) {
  try { fn(); console.log('ok', label); passed++; }
  catch (e) { console.error('NG', label, e); process.exitCode = 1; }
}

const data = {
  date: '2026-10-22', todayPriority: '提案を3件出す',
  work: [
    { task: 'A案件提案', status: 'できた', result: '2社へ送付' },
    { task: 'B案件面談', status: 'できなかった', result: '先方の日程待ち' },
  ],
  tomorrow: 'B案件の候補日を確認', nextWorkday: '翌営業日 2026-10-23',
  nextSchedule: ['10:00–11:00 B案件候補日確認'],
};

check('3点以内のコーチ指示と非評価ルール', () => {
  const s = buildNippoCoachPrompt(data);
  assert.match(s, /最大3点/);
  assert.match(s, /人事評価・懲戒/);
  assert.match(s, /予定を実績とみなさず/);
});

check('成果・未完了・次の優先がJSONに含まれる', () => {
  const s = buildNippoCoachPrompt(data);
  assert.match(s, /A案件提案/);
  assert.match(s, /2社へ送付/);
  assert.match(s, /B案件面談/);
  assert.match(s, /先方の日程待ち/);
  assert.match(s, /B案件の候補日を確認/);
});

check('取得できていない情報は未確認扱い', () => {
  const s = buildNippoCoachPrompt();
  assert.match(s, /"reportDate": "未確認"/);
  assert.match(s, /"todayWork": \[\]/);
  assert.match(s, /"nextTopPriority": "未入力"/);
});

check('過剰な入力件数と長文は制限', () => {
  const s = buildNippoCoachPrompt({ work: Array.from({length: 25}, (_,i) => ({
    task: 'task-' + i + 'z'.repeat(500), status: 'できた', result: 'x'.repeat(600),
  })) });
  const value = JSON.parse(s.slice(s.indexOf('{\n')));
  assert.equal(value.todayWork.length, 12);
  assert.equal(value.todayWork[0].task.length, 200);
  assert.equal(value.todayWork[0].outcomeOrProgress.length, 250);
});

check('許可されていない個人情報フィールドを丸ごと転記しない', () => {
  const s = buildNippoCoachPrompt({ ...data, consultNote: '相談の秘密', email: 'private@example.org', pay: '給与情報' });
  assert.doesNotMatch(s, /相談の秘密|private@example\.org|給与情報/);
});

check('UIは日報プレビューと明示コピーがあり別JSを読み込む', () => {
  const html = readFileSync(new URL('../nippo.html', import.meta.url), 'utf8');
  assert.match(html, /id="np-coach-copy-open"/);
  assert.match(html, /id="np-coach-copy-panel" hidden/);
  assert.match(html, /id="np-coach-copy-confirm"/);
  assert.match(html, /type="module" src="js\/nippo-coach-copy\.js/);
});

check('新規コピー機能はAPI送信・fetch・保存をしない', () => {
  const src = readFileSync(new URL('../js/nippo-coach-copy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|axios|localStorage|sessionStorage/);
  assert.match(src, /clipboard\.writeText\(preview\.value\)/);
});

check('相談欄などは画面から収集しない', () => {
  const src = readFileSync(new URL('../js/nippo-coach-copy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /f-consult|consult_note|salary|mail/i);
});

check('別日に切り替えた予定を翌営業日扱いしない', () => {
  const bySelector = new Map([
    ['#np-next-list .np-day-preview-title', { textContent: '選択した日 2026-10-25' }],
    ['#f-date', { value: '2026-10-22' }],
  ]);
  const root = {
    querySelector: selector => bySelector.get(selector) || null,
    querySelectorAll: selector => selector === '#np-next-list .np-preview-event'
      ? [{textContent:'違う日の予定'}] : [],
  };
  const d = readNippoCoachScreen(root);
  assert.equal(d.nextSchedule.length, 0);
  assert.equal(d.date, '2026-10-22');
});

console.log('nippo-coach-copy:', passed, 'checks');
