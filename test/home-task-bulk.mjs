// ホームの本人タスクと一括選択を守る。外部サービス・DBへは接続しない。
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=p=>readFileSync(join(root,p),"utf8");
const home=read("home.html");
const api=read("api/tasks/index.js");
const script=[...home.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
assert.ok(script,"ホームの画面スクリプト");
new Function(script); // JSの構文チェック

assert.ok(home.indexOf('id="home-calendar-frame"')<home.indexOf('id="home-tasks"'),"上が予定、下がタスク");
assert.match(home,/<h2 class="home-task-title">[\s\S]*?自分のタスク<\/h2>/,"本人のタスクと明記");
assert.match(script,/homeTaskFilter="open"/,"初期表示は全ての未完了タスク（未来や期日なしを含む）");
assert.match(script,/API\.listTasks\("mine"\)/,"本人専用API");
assert.match(script,/String\(t\.assignee_id\)===String\(homeEmployeeId\)/,"ログイン本人の担当のみ");
assert.match(api,/q = q\.eq\("assignee_id", ctx\.employee\.id\)/,"API側でも本人に絞り込む");
assert.ok(!/requested\s*=\s*data\.requested/.test(script),"他人に依頼しているタスクを本人の作業に混ぜない");
assert.match(home,/id="home-task-select-all"/,"表示中の一括選択");
assert.match(home,/id="home-task-bulk"[^>]*hidden/,"未選択では操作欄を隠す");
for(const id of ["home-task-selected-count","home-task-bulk-status","home-task-bulk-apply","home-task-bulk-done","home-task-bulk-clear"])
  assert.ok(home.includes('id="'+id+'"'),id+" を表示");
assert.match(script,/const homeSelectedIds=new Set\(\)/,"選択状態を保存");
assert.match(script,/homeSelectedIds\.add\(id\)/,"チェックで選択に追加");
assert.match(script,/homeSelectedIds\.delete\(id\)/,"チェック解除で選択を外す");
assert.match(script,/homeSelectedIds\.clear\(\)/,"タブ変更と解除時に選択を空にする");
assert.doesNotMatch(script,/function homeToggleTask\(/,"チェックだけで保存しない");
assert.match(script,/async function homeBulkUpdate\(status\)/,"一括更新はボタンからのみ実行");
assert.match(script,/if\(requiringNote\.length&&!note\)/,"依頼タスク完了に対応内容を求める");
assert.match(script,/await API\.updateTask\(\{id:t\.id,status,/,"既存タスク更新APIを順次呼ぶ");
assert.match(script,/for\(const t of selected\)/,"大量同時送信を行わずに処理");
assert.match(script,/const failed=\[\]/,"部分失敗を報告する");
assert.match(script,/homeSelectedIds\.delete\(String\(t\.id\)\)/,"成功したタスクだけ選択を解除");
assert.match(script,/homeTaskSaving=true/,"二重送信を防ぐ");

// 純粋なフィルタを画面の実コードから抜き出し、日付のない仕事も落ちないか確認する。
const filterSource=script.match(/  const homeTaskOpen=t=>[\s\S]*?(?=  \/\/ チェックは選択専用)/)?.[0];
assert.ok(filterSource,"本人タスクの抽出関数");
const data=[
  {id:"today",due_on:"2026-11-04",status:"todo"},
  {id:"future",due_on:"2026-11-21",status:"doing"},
  {id:"no-due",due_on:null,status:"todo"},
  {id:"done",due_on:"2026-11-03",status:"done"},
];
const filter=new Function("homeTasks","homeWeekEnd",filterSource+"\nreturn homeTaskList;")(data,()=>"2026-11-08");
assert.deepEqual(filter("open","2026-11-04").map(t=>t.id),["today","future","no-due"],"本人の未完了は期限に関係なく表示");
assert.deepEqual(filter("today","2026-11-04").map(t=>t.id),["today"],"今日を選んだ時だけ今日期限で絞る");
assert.deepEqual(filter("all","2026-11-04").map(t=>t.id),["today","future","no-due","done"],"完了を含む全件表示");

console.log("PASS ホーム本人タスク：期限なし表示、複数選択、一括更新、依頼結果、更新失敗時の保持");
