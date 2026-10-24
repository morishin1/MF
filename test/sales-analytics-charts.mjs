// 分析グラフの部品（js/sales-analytics-charts.js）：文字でも数字を出す・エスケープ・0件・状態表示。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const window = {};
vm.runInNewContext(readFileSync(new URL("../js/sales-analytics-charts.js", import.meta.url), "utf8"), { window, Number, String, Math, Array });
const C = window.SalesCharts;

// 横棒：値は文字でも出す。ラベルはエスケープ。押せる行は data-chart-key
const html = C.bars([
  { key: "a", label: "<img src=x onerror=1>", value: 10, unit: "社" },
  { key: "b\"x", label: "クリック", value: 0, unit: "社", tone: "warn" },
  { key: "c", label: "返信", value: 1, unit: "社" },
], { clickable: true, title: "テスト<b>", max: 1000 });
assert.doesNotMatch(html, /<img|<b>/, "ラベル・題名をエスケープ");
assert.match(html, /&lt;img src=x onerror=1&gt;/);
assert.equal((html.match(/<button /g) || []).length, 3);
assert.match(html, /data-chart-key="b&quot;x"/, "キーもエスケープ");
assert.match(html, /class="sc-row sc-warn"/);
assert.match(html, />10<small>社<\/small>/, "値を文字で出す");
assert.match(html, /aria-label="テスト&lt;b&gt;：&lt;img src=x onerror=1&gt; 10社、クリック 0社、返信 1社"/);
// 0件は棒を描かない。小さすぎる値は最低1%で描く
const fills = [...html.matchAll(/class="sc-fill"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
assert.deepEqual(fills, [1, 1], "10/1000=1%、1/1000→最低1%、0件は描かない");
assert.doesNotMatch(C.bars([{ key: "x", label: "x", value: 3 }]), /<button/, "押せない設定ではボタンにしない");

// ドーナツ：割合を文字で出す。合計0なら円を描かない
const d = C.donut([{ key: "s1", label: "反応待ち", value: 3 }, { key: "s2", label: "成約", value: 1 }], { clickable: true, unit: "社", title: "内訳" });
assert.match(d, /role="img" aria-label="内訳：反応待ち 3社（75%）、成約 1社（25%）"/);
assert.equal((d.match(/class="sc-arc"/g) || []).length, 2);
assert.equal((d.match(/<button /g) || []).length, 2);
assert.match(d, /stroke-dasharray="75\.000 25\.000"/);
const empty = C.donut([{ key: "s", label: "x", value: 0 }], { empty: "まだありません" });
assert.doesNotMatch(empty, /<svg|sc-arc/);
assert.match(empty, /まだありません/);

// 状態：失敗は alert、それ以外は status。読込中は aria-busy
assert.match(C.state("error", "取得できませんでした<script>", { retry: true }), /role="alert"[\s\S]*&lt;script&gt;[\s\S]*data-chart-retry/);
assert.match(C.state("loading", "読込中"), /data-state="loading" role="status" aria-busy="true"/);
assert.match(C.state("empty", "0件"), /data-state="empty" role="status"/);
console.log("PASS sales analytics charts: text values, escaping, zero bars, donut shares, state roles");
