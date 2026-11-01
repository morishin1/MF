// Salesの営業ホームとPDCA導線: 実データを書き換えずに最小のUI契約を検証。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(base, path), "utf8");
const layout = read("js/sales-layout.js");
const dashboard = read("sales/proposals.html");
const rootPage = read("sales/index.html");
const analytics = read("sales/analytics.html");

assert.match(layout, /href: "\/sales\/", label: "ダッシュボード"/);
assert.match(layout, /href: "\/sales\/analytics\.html", label: "分析"/);
assert.doesNotMatch(layout, /key: "companies", href:/);
assert.doesNotMatch(layout, /key: "attack", href:/);
assert.doesNotMatch(layout, /key: "leads", href:/);
assert.match(layout, /canOpenLegacySales/);
assert.match(rootPage, /location\.replace\(next\.href\)/);
assert.match(rootPage, /next\.search = location\.search/);
assert.match(dashboard, /<h1 class="sl-title">営業ダッシュボード<\/h1>/);
assert.match(dashboard, /pp-tab-kpi[^>]*hidden>/);
assert.match(dashboard, /id="pp-view-list"/);
assert.match(dashboard, /pp-analysis-link/);
assert.match(analytics, /id="sales-pdca"/);
assert.match(analytics, /id="an-full-report"/);
assert.match(analytics, /SalesDashboardReport\.load\(\)/);
assert.match(analytics, /sales-pdca\.js\?v=20261101focus1/);

const root = { innerHTML:"", querySelectorAll:()=>[] };
let calls = [];
let fail = false;
const response = {
  metrics:{matchingCount:17,unsubmittedMatchedCount:2,proposalSentCount:20,
    meetingCohortCount:1,conversionRate:5,blastCompanies:[]},
  previousMetrics:{conversionRate:10},
  dataStatus:{note:"未確認\u003cscript\u003e",sourceState:"partial"}
};
const sandbox = {
  window:{},
  document:{getElementById:(id)=>id==="sales-pdca"?root:null},
  API:{api:async(path)=>{calls.push(path);if(fail)throw new Error("test unavailable");return response;}},
};
runInNewContext(read("js/sales-pdca.js"),sandbox);
const pdca=sandbox.window.SalesPDCA;
assert.ok(pdca);
await pdca.load("last_30");
pdca.observeProposals({proposals:[],counts:{no_call:4,overdue:2},truncated:false});
assert.deepEqual(calls, ["/api/sales/dashboard-analysis?period=last_30"]);
assert.match(root.innerHTML,/電話が未実施/);
assert.match(root.innerHTML,/現在のSales閲覧可能な提案/);
assert.match(root.innerHTML,/filter=no_call/);
assert.match(root.innerHTML,/前の同日数期間と比較/);
assert.match(root.innerHTML,/10\.0%/);
assert.match(root.innerHTML,/5\.0%/);
assert.doesNotMatch(root.innerHTML,/<script>/);
assert.match(root.innerHTML,/未確認&amp;lt;script/);

fail=true;
await pdca.load("last_7");
assert.match(root.innerHTML,/分析データを取得できません/);
assert.doesNotMatch(root.innerHTML,/提案後の電話が未実施/);
console.log("Sales dashboard/analytics PDCA source contracts and read-only evidence PASS");
