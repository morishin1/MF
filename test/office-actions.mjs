// Read-only Office aggregation contract; synthetic data only, no network/DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../js/office-actions.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../office/index.html', import.meta.url), 'utf8');
const window = {};
runInNewContext(source, { window });
const A = window.OfficeActions;
const options = { today: '2026-10-23', selfName: '本人' };
const rows = A.build({ ...options,
  requests: [
    { id: 'same', status: 'pending', kind: 'leave', applicant: { display_name: '<script>bad()</script>' }, starts_on: '2026-11-01' },
    { id: 'same', status: 'pending', kind: 'leave' },
    { id: 'owner', status: 'pending_owner', kind: 'ringi' },
    { id: 'finished', status: 'approved', kind: 'leave' },
    { id: 'cancelled', status: 'cancelled', kind: 'leave' },
  ],
  tasks: [
    { id: 'same', title: '同名', status: 'todo', due_on: '2026-10-22', needsAccept: true, link: 'javascript:bad()' },
    { id: 'same', title: '重複', status: 'todo' },
    { id: 'other', title: '同名', status: 'doing', due_on: '2026-10-23' },
    { id: 'no-date', title: '期限なし', status: 'todo' },
    { id: 'done', title: '完了', status: 'done' },
    { id: 'cancel', title: '取消', status: 'cancelled' },
    { id: 'template', title: '繰り返し設定', status: 'todo', is_template: true },
  ],
  requested: [{ id: 'not-scope', title: '別人の仕事', status: 'todo' }],
});
assert.equal(rows.length, 5, 'only pending requests and own actual open tasks; deduplicate by source ID');
assert.equal(rows.filter(r => r.key === 'request:same').length, 1);
assert.equal(rows.filter(r => r.key === 'task:same').length, 1, 'identical ID in different sources is not duplicate');
assert.equal(rows.filter(r => r.label === '同名').length, 2, 'same titles are separate originals');
assert.equal(rows.find(r => r.key === 'request:owner').state, 'waiting');
assert.equal(rows.find(r => r.key === 'request:same').state, 'decision');
assert.equal(rows.find(r => r.key === 'request:same').due, null, 'leave start is not an invented decision deadline');
assert.equal(rows.find(r => r.key === 'task:same').state, 'decision');
assert.match(rows.find(r => r.key === 'task:same').hint, /引き受ける/);
assert.equal(rows.find(r => r.key === 'task:other').state, 'action');
assert.equal(rows.find(r => r.key === 'task:no-date').due, null);
assert.equal(rows.find(r => r.key === 'task:no-date').owner, '本人');
assert.ok(rows.every(r => ['/tasks.html', '/admin-requests.html'].includes(r.href)), 'only fixed original list routes; no untrusted task link or pretend deep link');
assert.equal(A.filter(rows, 'request', 'waiting').length, 1);
assert.equal(A.filter(rows, 'task', 'decision').length, 1);
assert.equal(A.filter(rows, 'task', 'waiting').length, 0);
assert.equal(A.filter(rows, '', '').length, rows.length);
assert.equal(A.unique([{ key:'x' },{ key:'x' },{ key:'y' }]).length, 2);
assert.equal(A.build(options).length, 0);
assert.doesNotMatch(source, /\.markNotificationRead|\.updateTask|\.decideRequest|fetch\(/, 'adapter does not read-mark or mutate originals');
assert.match(html, /<script src="\.\.\/js\/layout-marketing\.js"><\/script>/, 'preserve current Marketing header integration');
assert.match(html, /el\("office-contract-queue-entry"\)\.hidden = !can\.app/, 'preserve contract queue permission gate');
assert.match(html, /office-people-pulse\.js\?v=20261030officeactions1/, 'updated pulse uses fresh cache version');
assert.match(html, /office-actions\.js\?v=20261030officeactions1/, 'integrated adapter uses matching cache version');
assert.match(html, /can\.hr\s*\?\s*window\.OfficePeoplePulse\.load/, 'requests only for Office HR');
assert.match(html, /API\.listTasks\("mine"\)/, 'personal scope is explicit');
assert.doesNotMatch(html, /API\.listTasks\("all"\)/);
assert.match(html, /office-event:/, 'Office events have their own source namespace');
assert.match(html, /if \(CTX\) load\(CTX\)/, 'existing completion refresh reloads unified list');
assert.match(html, /読むだけでは完了になりません/);
assert.match(html, /0件とは限りません/);
assert.match(html, /itemRows\.slice\(5\)/, 'overflow remains accessible');

// Execute the real rendering function with a tiny DOM fixture. No writes are exposed.
const renderMatch = html.match(/function renderActions\(\) \{([\s\S]*?)\n  let loadGeneration = 0;/);
assert.ok(renderMatch, 'real render function found');
const els = Object.fromEntries(['actionWarnings','actionType','actionState','todo'].map(id => [id, {value:'',textContent:'',innerHTML:'',querySelectorAll:()=>[],appendChild:()=>{}}]));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const context = { window, el:id=>els[id], esc, actionRows:rows, actionMissing:[], PRI:[{label:'要確認'},{label:'期限超過'},{label:'今日期限'},{label:'今週対応'}] };
runInNewContext('function renderActions() {' + renderMatch[1] + '\nrenderActions();', context);
assert.match(els.todo.innerHTML, /&lt;script&gt;/, 'untrusted applicant is escaped');
assert.doesNotMatch(els.todo.innerHTML, /<script>/);
context.actionRows=[]; context.actionMissing=['申請'];
runInNewContext('renderActions();', context);
assert.match(els.actionWarnings.textContent, /申請/);
assert.match(els.todo.innerHTML, /未確認の情報が残っています/, 'failure empty is not no work');
assert.doesNotMatch(els.todo.innerHTML, /対応が必要なものはありません/);
console.log('Office unified actions: adapter, scope, source identity, filters, escaping, failure rendering PASS');
