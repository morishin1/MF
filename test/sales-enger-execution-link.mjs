import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nav = readFileSync("js/sales-layout.js", "utf8");
const dashboard = readFileSync("sales/index.html", "utf8");
const url = "https://dx.enger.jp/workboard";
assert.ok(nav.includes("今日の営業判断") && nav.includes("企業・提案"), "Sales has the compact three-tab navigation");
assert.ok(dashboard.includes(url), "Sales dashboard must expose the same execution link");
assert.match(nav, /label: "成果分析"/, "Sales analytics remains a primary menu");
assert.match(nav, /key: "proposals"/, "Sales proposals remain in the second-level workflow menu");
assert.match(dashboard, /営業実行はENGER、成果分析はSales/, "Do not confuse Sales analytics with ENGER execution");
console.log("PASS Sales analysis and ENGER execution links");
