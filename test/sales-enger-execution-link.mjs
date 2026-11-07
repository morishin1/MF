import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nav = readFileSync("js/sales-layout.js", "utf8");
const dashboard = readFileSync("sales/index.html", "utf8");
const url = "https://dx.enger.jp/workboard";
// ENGER execution is contextual to the dashboard, not a competing primary menu.
assert.doesNotMatch(nav, /key: "enger"/, "ENGER must not duplicate Sales primary navigation");
assert.ok(dashboard.includes(url), "Sales dashboard must expose the ENGER execution board");
assert.match(nav, /label: "分析"/, "Existing Sales analytics must remain available");
assert.match(nav, /label: "提案"/, "Existing Sales proposals remain during migration");
assert.match(dashboard, /営業実行はENGER、成果分析はSales/, "Do not confuse Sales analytics with ENGER execution");
console.log("PASS Sales analysis and ENGER execution links");
