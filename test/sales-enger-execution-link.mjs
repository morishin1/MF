import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const nav = readFileSync("js/sales-layout.js", "utf8");
const dashboard = readFileSync("sales/index.html", "utf8");
const url = "https://dx.enger.jp/workboard";
// 左メニューは「ダッシュボード〜分析」の6つに整理し、ENGERは7つ目の項目にしない（7099a748 / #258、
// test/sales-priority-period-company-modal.mjs と同じ決まり）。ENGERの案件進行へはダッシュボードから入る。
assert.ok(!nav.includes(url), "ENGER execution board is not a Sales primary menu item");
assert.match(dashboard, new RegExp(`<a href="${url}" rel="noopener noreferrer">ENGERで案件進行を開く</a>`), "Sales dashboard must expose the ENGER execution link");
assert.match(nav, /label: "分析"/, "Existing Sales analytics must remain available");
assert.match(nav, /label: "提案"/, "Existing Sales proposals remain during migration");
// 役割の書き分け（b4521bb で文言を更新）：人材・案件のマッチングはENGER DX、商談・企業対応はSales
assert.match(dashboard, /人材・案件の確認とマッチングはENGER DX、商談・企業対応はSalesで行います/, "Do not confuse Sales with ENGER execution");
console.log("PASS Sales analysis and ENGER execution links");
