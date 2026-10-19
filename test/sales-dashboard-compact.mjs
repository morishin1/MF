// Salesダッシュボードは初期画面をコンパクトにし、従来の各機能をタブ内に残す。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "sales/index.html"), "utf8");
const js = readFileSync(resolve(ROOT, "js/sales-performance-calendar.js"), "utf8");
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline, "ダッシュボードのスクリプトがある");
new Script(inline[1], { filename:"sales/index.html" });
new Script(js, { filename:"sales-performance-calendar.js" });
const layout = html.split('<div class="wrap">')[1]?.split('</div>\n\n<script src=')[0];
assert.ok(layout, "画面の主要領域");
assert.equal((html.match(/<!DOCTYPE html>/g) || []).length, 1, "文書が二重になっていない");
assert.equal((layout.match(/<div\b/g) || []).length, (layout.match(/<\/div>/g) || []).length, "主要領域のdiv対応");
assert.equal((layout.match(/<section\b/g) || []).length, (layout.match(/<\/section>/g) || []).length, "主要領域のsection対応");
for (const id of [
  "sum", "db-tabs", "db-tasks-pane", "db-performance-pane", "db-history-pane",
  "sec-click", "sec-replied", "sec-follow", "sec-attack", "sec-history",
  "list-click", "list-replied", "list-follow", "list-attack", "history",
  "sp-mini-tiles", "sp-mini-members", "sp-tiles", "sp-calendar", "sp-member", "sp-day",
]) {
  // id=db-tabs is actually a class; check separately
  if (id === "db-tabs") { assert.ok(layout.includes('class="db-tabs"'), "tab navigation"); continue; }
  assert.equal((layout.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id + " is unique");
}
assert.ok(layout.indexOf('id="db-tasks-pane"') < layout.indexOf('id="db-performance-pane"'), "初期表示は今日の対応");
assert.ok(layout.includes('id="db-performance-pane" role="tabpanel" aria-labelledby="db-tab-performance" hidden'), "実績は必要時に開く");
assert.ok(layout.includes('id="db-history-pane" role="tabpanel" aria-labelledby="db-tab-history" hidden'), "履歴は必要時に開く");
assert.ok(inline[1].includes("rows.slice(0, 5)"), "企業は上位5件だけで縦の長さを抑える");
assert.ok(inline[1].includes("dashboardCategory(activeCategory, false)"), "画面更新時に選択タブを維持する");
assert.ok(inline[1].includes('API.salesDashboard()'), "既存の営業サマリーAPIを継続");
assert.ok(inline[1].includes('API.listSalesApproaches(14, 15)'), "既存の履歴APIを継続");
assert.ok(inline[1].includes("onclick=\"dashboardCategory("), "サマリーカードから既存の対応先へ行ける");
assert.ok(js.includes("function renderCompact()"), "初期画面の数字とメンバー比較");
assert.ok(js.includes('["attacks", "sent", "connected", "won"]'), "主要KPIは4つ");
assert.ok(js.includes("members.slice(0, 5)"), "メンバーの表示は最大5名");
assert.ok(js.includes("cellCount = Math.ceil"), "カレンダーは月に必要な週数だけ");
console.log("PASS Sales compact dashboard structure, navigation, actions and script syntax");
