// 現行Salesダッシュボード（4件数・4対応キュー・履歴）の回帰テスト。
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Script} from "node:vm";
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const html=readFileSync(resolve(ROOT,"sales/index.html"),"utf8");
const layout=html.split('<div class="wrap">')[1]?.split('</div>\n\n<script src=')[0];
assert.ok(layout,"Salesの本文は存在する");
assert.equal((html.match(/<!DOCTYPE html>/g)||[]).length,1,"HTML重複がない");
const inline=html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline,"Sales画面のJS");
new Script(inline[1],{filename:"sales/index.html"});
assert.ok(layout.includes('class="db-sum" id="sum"'),"KPIの4列サマリー");
const sections=["click","replied","follow","attack","history"];
for(const id of sections){
  assert.equal((layout.match(new RegExp('id="sec-'+id+'"','g'))||[]).length,1,id+" セクションが1つ");
}
for(const id of ["list-click","list-replied","list-follow","list-attack","history"])
  assert.equal((layout.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id+" の出力先が1つ");
assert.ok(layout.indexOf('id="sec-click"')<layout.indexOf('id="sec-attack"'),"優先対応を先に表示");
for(const expr of ["API.salesDashboard()","API.listSalesApproaches(14, 15)","API.morph(","render()"])
  assert.ok(inline[1].includes(expr),expr+" が有効");
assert.ok(html.includes("db-click")&&html.includes("grid-template-columns:repeat(4"),"重要対応と件数を強調");
console.log("PASS 現行Salesのダッシュボード4件数・5セクション・API・JS構文");
