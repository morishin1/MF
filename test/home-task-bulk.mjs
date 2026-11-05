// ホーム下段は実タスクだけ。未完了が既定で、完了後は履歴と完了日時へ移動する。
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=p=>readFileSync(join(root,p),"utf8");
const home=read("home.html");
const calendar=read("calendar.html");
const api=read("api/tasks/index.js");
const inline=[...home.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
assert(inline.length>=1,"ホームの実装JSがある");
for(const script of inline)new Function(script);
const js=inline.at(-1);
assert(home.indexOf('id="home-calendar-frame"')<home.indexOf('id="home-tasks"'),"カレンダー下部にタスク");
assert.match(home,/>タスク一覧<\/h2>/,"独立したタスク一覧");
assert.match(home,/data-home-filter="open" aria-pressed="true"/,"未完了が初期表示");
assert.match(js,/homeTaskFilter="open"/,"未完了がデータ取得時の初期値");
assert.match(home,/data-home-filter="done"/,"対応済み一覧が別タブ");
assert.match(home,/id="home-task-completed-heading" hidden/,"完了日時の見出し");
assert.match(js,/completed_at\?new Intl\.DateTimeFormat/,"完了時刻の日本時間表示");
assert.match(js,/timeZone:"Asia\/Tokyo"/,"日時はJSTで出す");
assert.match(js,/homeTaskFilter==="done"\?'<td><time>'/,"対応済み一覧に完了時刻表示");
assert.match(js,/API\.listTasks\("mine"\)/,"作業タスクを本人の専用APIから取得");
assert.doesNotMatch(home,/src="js\/home-own-schedule\.js"/,"業務予定の一覧JSを読み込まない");
assert.match(js,/API\.updateTask\(/,"既存タスクAPIにより履歴を保って更新");
assert.match(api,/if \(out.status === "done"\) out.completed_at = new Date\(\)\.toISOString\(\)/,"対応済み操作を行った時間をサーバで記録");
assert.match(calendar,/function selectDate\(s,hour\)/,"日付クリックで日別予定の詳細へ");
assert.match(calendar,/const rows=eventsOn\(s\)\.filter/,"日別一覧はその日の全件を対象にする");
assert.match(calendar,/trigger.closest\("\.cal-month,\.oc-day-cards"\)/,"予定名クリックでも日別一覧");
const fn=js.match(/  function homeTaskList\(filter,today\)\{[\s\S]*?\n  \}/)?.[0];
assert(fn,"実際の分類ロジック");
const items=[
 {id:"a",status:"todo",due_on:"2026-11-04"},
 {id:"b",status:"doing",due_on:"2026-11-06"},
 {id:"c",status:"done",due_on:"2026-11-04",completed_at:"2026-11-04T08:34:00Z"},
 {id:"d",status:"cancelled",due_on:"2026-11-04"},
];
const list=new Function("homeTasks","homeTaskOpen","homeWeekEnd",fn+"\nreturn homeTaskList;")(items,t=>t.status==="todo"||t.status==="doing",()=> "2026-11-08");
assert.deepEqual(list("open","2026-11-04").map(x=>x.id),["a","b"],"既定の未完了一覧に完了タスクはない");
assert.deepEqual(list("today","2026-11-04").map(x=>x.id),["a"],"今日も完了したタスクを除く");
assert.deepEqual(list("week","2026-11-04").map(x=>x.id),["a","b"],"今週も完了したタスクを除く");
assert.deepEqual(list("done","2026-11-04").map(x=>x.id),["c"],"対応済み一覧にのみ完了タスクを載せる");
console.log("PASS ホーム：未完了タスク既定・完了日時・対応済み履歴・日別全件");
