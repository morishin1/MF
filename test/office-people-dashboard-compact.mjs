// Officeトップの申請・日報・勤怠サマリーと、長い画面の折りたたみ。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root,path), "utf8");
const office = read("office/index.html");
const nippo = read("admin-nippo.html");
const source = read("js/office-people-pulse.js");
assert.match(office,/KPLayout\.hasAccess\(me, "officeHr"\)/);
assert.match(office,/can\.hr \? window\.OfficePeoplePulse\.load\(\{ integrated: true \}\)/,"HR以外には情報を取得しない");
assert.match(office,/id="peoplePulse"[^>]+hidden/,"読み込み前は空カードを出さない");
assert.match(office,/<details class="oh-sec oh-fold" id="calBox"/,"月カレンダー初期折りたたみ");
assert.match(office,/<details class="oh-sec oh-fold" id="weekBox"/,"今週のOffice予定を初期折りたたみ");
assert.match(office,/itemRows\.length > 5/,"今日やることは5件を先に出す");
assert.match(office,/grouped\.append\(\.\.\.itemRows\.slice\(5\)\)/,"残りの行は削除せず開ける");
assert.match(nippo,/id="week-detail"/);
assert.match(nippo,/id="unsubmitted-detail"/);
assert.match(nippo,/id="overview-detail"/);
assert.match(nippo,/id="daily-reports-detail"/);
assert.match(nippo,/foldExtraCards\("follow-list", 3/,"今日の要フォローを3件に短縮");
assert.match(nippo,/foldExtraCards\("blk-body", 3/,"停滞も3件に短縮");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
}[c]));
const els = {};
const document = { getElementById(id) { return els[id] ||= { hidden: true, textContent: "", innerHTML:"" }; } };
const window = { OfficeLayout: { esc } };
let requestCalls = 0, nippoCalls = 0;
const API = {
  listRequests: async () => { requestCalls++; return {requests:[
    {kind:"leave",status:"pending",applicant:{display_name:'<img onerror="bad()">' }},
    {kind:"ringi",status:"pending_owner",applicant:{display_name:"代表確認待ち"}},
  ]}; },
  nippoWeek: async () => {nippoCalls++;return {kpi:{missing:3,timeCheck:2,today:{submitted:8,expected:10}}};},
};
runInNewContext(source,{window,document,API});
await window.OfficePeoplePulse.load();
assert.equal(requestCalls,1);
assert.equal(nippoCalls,1);
assert.equal(els.peoplePulse.hidden,false);
assert.equal((els.peopleMetrics.innerHTML.match(/oh-pulse-tile/g) || []).length,4);
assert.match(els.peopleMetrics.innerHTML,/Office承認待ち/);
assert.match(els.peopleMetrics.innerHTML,/3<small>件/);
assert.match(els.peopleMetrics.innerHTML,/2<small>件/);
assert.match(els.peopleRequests.innerHTML,/&lt;img/,"申請者名はHTMLとして実行しない");
assert.doesNotMatch(els.peopleRequests.innerHTML,/代表確認待ち/,"KEIEI承認待ちをOfficeの要承認として出さない");
assert.match(els.peopleNote.textContent,/KEIEI最終承認待ち：1件/);
const integrated = await window.OfficePeoplePulse.load({ integrated: true });
assert.equal(integrated.requests.length, 2);
assert.equal(els.peopleRequests.innerHTML, "", "統合時は申請の重複行なし");
assert.equal(els.peopleRequests.hidden, true);
API.nippoWeek = async () => {throw new Error("unavailable");};
await window.OfficePeoplePulse.load();
assert.match(els.peopleMetrics.innerHTML,/—/,"取得失敗を0件と見せない");
// An unavailable weekly report must not stall requests for the unified action list.
API.nippoWeek = () => new Promise(() => {});
const ready = await Promise.race([
  window.OfficePeoplePulse.load({ integrated: true }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("weekly report blocked actions")), 150)),
]);
assert.equal(ready.requests.length, 2);
assert.equal(ready.requestsOk, true);
assert.equal(els.peopleRequests.hidden, true);
// A delayed prior refresh must not replace a newer KPI snapshot.
let finishOld;
API.nippoWeek = () => new Promise(resolve => { finishOld = resolve; });
const oldLoad = window.OfficePeoplePulse.load();
await Promise.resolve();
API.nippoWeek = async () => ({kpi:{missing:9,timeCheck:1,today:{submitted:4,expected:5}}});
await window.OfficePeoplePulse.load();
finishOld({kpi:{missing:99,timeCheck:99,today:{submitted:99,expected:99}}});
await oldLoad;
assert.match(els.peopleMetrics.innerHTML,/9<small>件/);
assert.doesNotMatch(els.peopleMetrics.innerHTML,/99<small>/,"late old response cannot overwrite latest display");
console.log("Office dashboard compact people pulse: pass");
