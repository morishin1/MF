import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nav = readFileSync("js/sales-layout.js", "utf8");
const dashboard = readFileSync("sales/index.html", "utf8");
const url = "https://dx.enger.jp/workboard";
assert.doesNotMatch(nav, /key: "enger"/, "Execution link is in the dashboard; primary Sales navigation stays company-led");
assert.ok(dashboard.includes(url), "Sales dashboard must expose the same execution link");
assert.match(nav, /label: "分析"/, "Existing Sales analytics must remain available");
assert.match(nav, /label: "提案"/, "Existing Sales proposals remain during migration");
assert.match(dashboard, /人材・案件の確認とマッチングはENGER DX、商談・企業対応はSales/, "Do not confuse Sales analytics with ENGER execution");
console.log("PASS Sales analysis and ENGER execution links");
