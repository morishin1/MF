// ホーム下段は「本人が登録した業務予定」。入社対応の依頼タスクを混ぜず、チェックで一括更新できる。
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=p=>readFileSync(join(root,p),"utf8");

const home=read("home.html"),app=read("js/home-own-schedule.js");
const api=read("api/schedule/index.js"),ddl=read("db/158_home_schedule_work_status.sql");
new Function(app);
const homeScript=[...home.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
assert.ok(homeScript);
new Function(homeScript);
assert(home.indexOf('id="home-calendar-frame"')<home.indexOf('id="home-tasks"'),"カレンダーの下が自分の予定");
assert.match(home,/>自分の予定<\/h2>/,"表示タイトル");
assert.match(home,/src="js\/home-own-schedule\.js"/,"予定の専用ロジック");
assert.match(homeScript,/HomeSchedule\.init\(ctx\)/,"ログイン本人の情報を渡す");
assert.doesNotMatch(home,/id="home-task-rows"/,"依頼タスクの一覧をやめる");
assert.match(app,/items=\(data\.items\|\|\[\]\)\.filter\(e=>e\.source==="self"\)/,"本人のカレンダーから登録した予定のみ");
assert.match(app,/API\.api\("\/api\/schedule"\+q\)/,"軽量予定API");
assert.match(api,/\.eq\("employee_id", ctx\.employee\.id\)/,"サーバでも本人限定");
assert.match(api,/\.eq\("source", "self"\)/,"自動生成・他人の予定を混ぜない");
for(const id of ["home-event-rows","home-event-select-all","home-event-bulk","home-event-bulk-status","home-event-bulk-apply","home-event-bulk-done","home-event-bulk-clear"]){
  assert(home.includes('id="'+id+'"'),id);
}
assert.match(app,/class="home-event-picker"/,"選択用checkbox");
assert.doesNotMatch(app,/needsAccept/,"入社対応の未受諾フラグでチェックを無効にしない");
assert.match(app,/selected\.add\(id\)/,"選択時に候補へ追加");
assert.match(app,/selected\.delete\(id\)/,"解除時に候補から外す");
assert.match(app,/async function update\(status\)/,"選択してからのみ更新");
assert.match(app,/action:"bulk_work_status"/,"複数の予定を1回で保存");
assert.match(api,/ids\.length > 50/,"一括更新の上限");
assert.match(api,/\.eq\("tenant_id", ctx\.tenantId\)/,"テナントを固定");
assert.match(api,/\.eq\("source", "self"\)/,"本人が登録した予定だけ更新");
assert.match(ddl,/gw_calendar_events_work_status_check/,"許可されたステータスのみ");
assert.match(ddl,/work_status in \('todo','doing','done'\)/,"未着手・対応中・対応済み");
assert.match(ddl,/completed_at timestamptz/,"完了時刻を保持");
const pure=app.match(/  function shown\(kind, today\)\{[\s\S]*?\n  \}/)?.[0];
assert(pure,"フィルタの実コード");
const items=[
  {id:"today",starts_at:"2026-11-04T01:00:00Z",work_status:"todo"},
  {id:"week",starts_at:"2026-11-06T05:00:00Z",work_status:"doing"},
  {id:"done",starts_at:"2026-11-06T05:00:00Z",work_status:"done"},
  {id:"future",starts_at:"2026-11-20T05:00:00Z",work_status:"todo"},
];
const own=new Function("items","dateKey","weekBounds",pure+"\nreturn shown;")(items,
 d=>new Date(new Date(d).getTime()+9*3600000).toISOString().slice(0,10),()=>["2026-11-02","2026-11-08"]);
assert.deepEqual(own("today","2026-11-04").map(x=>x.id),["today"],"今日");
assert.deepEqual(own("week","2026-11-04").map(x=>x.id),["today","week","done"],"今週");
assert.deepEqual(own("open","2026-11-04").map(x=>x.id),["today","week","future"],"未対応");
console.log("PASS ホームは本人の予定のみ表示し、チェック選択から一括更新できる");
