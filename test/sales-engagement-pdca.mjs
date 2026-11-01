// Sales六つの上部メニューとPDCA視点を、書き込みをせず検証する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const base=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>readFileSync(resolve(base,p),"utf8");
const layout=read("js/sales-layout.js");
const dashboard=read("sales/proposals.html");
const rootPage=read("sales/index.html");
const analytics=read("sales/analytics.html");
const accounts=read("sales/accounts.html");
const config=JSON.parse(read("vercel.json"));
const nav=[["dashboard","ダッシュボード"],["proposals","提案管理"],["accounts","企業・リード"],
           ["issue","課題"],["evidence","根拠"],["action","営業対応"],["result","成果検証"]];
for(const [key,label] of nav){
  assert.match(layout,new RegExp('key: "'+key+'".{0,100}label: "'+label+'"'));
}
assert.doesNotMatch(layout,/key: "companies", href:/);
assert.doesNotMatch(layout,/key: "attack", href:/);
assert.doesNotMatch(layout,/key: "leads", href:/);
assert.match(layout,/canOpenLegacySales/);
assert.match(accounts, /sales\/proposals\.html\?id=/);
assert.match(accounts, /会社ID未照合/);
assert.match(accounts, /data\.truncated/);
assert.ok(config.rewrites.some(x=>x.source==="/sales/accounts"&&x.destination==="/sales/accounts.html"));
assert.ok(config.rewrites.some(x=>x.source==="/sales"&&x.destination==="/sales/proposals.html"));
assert.match(rootPage,/location\.replace\(next\.href\)/);
assert.match(rootPage,/new URL\("\/sales\/proposals\.html"/);
assert.match(dashboard,/isDailyDashboard/);
assert.match(dashboard,/isDailyDashboard \? "open" : "all"/);
assert.match(layout,/href: "\/sales\/proposals\.html", label: "提案管理"/);
assert.match(layout,/href: "\/sales\/proposals\.html\?mode=dashboard", label: "ダッシュボード"/);
assert.match(dashboard,/<h1 class="sl-title" id="pp-page-title">営業ダッシュボード<\/h1>/);
assert.match(dashboard,/pp-tab-kpi[^>]*hidden>/);
assert.match(dashboard,/id="pp-view-list"/);
assert.match(analytics,/id="sales-pdca"/);
assert.match(analytics,/id="an-full-report"/);
assert.match(analytics,/sales-pdca\.js\?v=20261101focus3/);
assert.match(analytics,/SalesDashboardReport\.load\(\)/);

const response={
  metrics:{matchingCount:17,unsubmittedMatchedCount:2,proposalSentCount:20,
    meetingCohortCount:1,conversionRate:5,blastCompanies:[]},
  previousMetrics:{conversionRate:10},
  dataStatus:{note:"未確認<script>",sourceState:"partial"}
};
async function phaseTest(step,check) {
  const root={innerHTML:"",querySelectorAll:()=>[]};
  const title={textContent:""};
  let calls=[],fail=false;
  const sandbox={
    window:{location:{search:"?step="+step}},
    URLSearchParams,
    document:{getElementById:id=>id==="sales-pdca"?root:id==="an-main-title"?title:null},
    API:{api:async url=>{calls.push(url);if(fail)throw new Error("test unavailable");return response;}}
  };
  runInNewContext(read("js/sales-pdca.js"),sandbox);
  const pdca=sandbox.window.SalesPDCA;
  pdca.observeProposals({proposals:[],counts:{no_call:4,overdue:2},truncated:false});
  await pdca.load("last_30");
  assert.deepEqual(calls,["/api/sales/dashboard-analysis?period=last_30"]);
  assert.match(root.innerHTML,/未確認&lt;script&gt;/);
  assert.doesNotMatch(root.innerHTML,/<script>/);
  check(root.innerHTML);
  fail=true;
  await pdca.load("last_7");
  assert.match(root.innerHTML,/分析データを取得できません/);
}
await phaseTest("issue",s=>{assert.match(s,/電話が未実施/);assert.doesNotMatch(s,/pdca-outcome/);});
await phaseTest("evidence",s=>{assert.match(s,/現在のSales閲覧可能な提案/);assert.match(s,/面談実施到達/);assert.match(s,/pdca-measure-track/);});
await phaseTest("action",s=>{assert.match(s,/filter=no_call/);assert.match(s,/対象を開く/);});
await phaseTest("result",s=>{assert.match(s,/10\.0%/);assert.match(s,/5\.0%/);assert.match(s,/pdca-compare/);});
console.log("Sales six tabs, permissions, read-only company view and four focused PDCA phases PASS");
