import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("../js/sales-visuals.js",import.meta.url),"utf8");
const win={};
new vm.Script(source,{filename:"sales-visuals.js"}).runInNewContext({window:win,Number,String,Math});
const vis=win.SalesVisuals;
assert.equal(typeof vis.bars,"function");
assert.equal(typeof vis.line,"function");
assert.equal(typeof vis.donut,"function");
const bars=vis.bars([{label:'<img onerror="alert(1)">',value:3,detail:'<script>evil</script>'},
 {label:"第2候補",value:-4}],{title:"テスト企業",maxRows:2});
assert.match(bars,/&lt;img/);assert.doesNotMatch(bars,/<img/);
assert.match(bars,/&lt;script&gt;/);assert.doesNotMatch(bars,/<script>/);
assert.match(bars,/100.00%/);assert.ok(!bars.includes("NaN"));
const donut=vis.donut([{label:"企業側見送り",value:3},{label:"無回答",value:1}],{title:"失注内訳"});
assert.match(donut,/conic-gradient/);assert.match(donut,/75.0%/);
assert.match(donut,/role="img"/);
assert.match(vis.donut([]),/記録がありません/);
const chart=vis.line([{date:"2026-11-01",sent:2,meetings:0},{date:"2026-11-02",sent:3,meetings:1}],
 {title:"日別"});
assert.match(chart,/<svg/);assert.match(chart,/11\/01/);
assert.match(chart,/提案送信/);
assert.doesNotMatch(chart,/NaN|Infinity|undefined/);
assert.match(vis.line([]),/記録がありません/);
console.log("PASS Supabase Sales visualizations: safe SVG/donut/bars and empty-state handling");