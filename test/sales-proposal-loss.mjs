// Sales見送りの分析回帰。通常一覧から見送りだけを外す（他の完了/継続は保持）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { buildLossReport, LOSS_PERIODS } from "../lib/sales-proposal-loss.js";
import { filterRows, countFilters, shapeProposal } from "../lib/sales-proposals.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const p = (id, status, day, reason, extras = {}) => ({
  id, status, closedAt: day ? day + "T12:00:00+09:00" : null, closeReason: reason,
  salesOwnerName: "中村", archived: false, ...extras,
});
const rows = [
  p("a","lost","2026-10-26","client_declined"),
  p("b","lost","2026-10-25","talent_declined",{salesOwnerName:"藤本"}),
  p("c","lost","2026-10-20","client_declined"),
  p("d","lost","2026-10-19",null),
  p("e","lost",null,"filled"),
  p("f","lost","2026-10-26","other",{archived:true}),
  p("g","closed_no_reply","2026-10-26","no_reply"),
  p("h","stopped","2026-10-26","contact_stop"),
  p("i","won","2026-10-26",null),
  p("j","considering",null,"client_considering"),
];
const now = "2026-10-26T08:31:00Z"; // 10/26 17:31 JST
const report = buildLossReport(rows,now);
assert.deepEqual(LOSS_PERIODS,[1,7,30,90,365,"all"]);
assert.equal(report.total,5,"アーカイブ・無回答クローズ・連絡停止・成約・検討中を見送りに含めない");
assert.equal(report.periods["1"].count,1,"当日だけ");
assert.equal(report.periods["7"].count,3,"10/20〜10/26 の7日");
assert.equal(report.periods["30"].count,4,"30日内の見送り日時がある案件");
assert.equal(report.periods.all.count,5,"見送り確定日が無くても全期間には含める");
assert.equal(report.periods.all.unknownDate,1,"日時未登録を明示");
assert.equal(report.periods["7"].reasons.find(r=>r.key==="client_declined")?.count,2);
assert.equal(report.periods["7"].owners.find(r=>r.name==="藤本")?.count,1);
assert.equal(report.periods.all.missingReason,1,"理由未入力を独立計数");
assert.equal(report.periods.all.reasons.reduce((sum,r)=>sum+r.count,0),report.total,"理由の合計は見送り件数");
assert.equal(buildLossReport([
  p("jst0","lost","2026-10-25","filled",{closedAt:"2026-10-25T14:59:59Z"}),
  p("jst1","lost","2026-10-26","filled",{closedAt:"2026-10-25T15:00:00Z"}),
],now).periods["1"].count,1,"日本時間0時で日付を切替");

const shaped=[
  shapeProposal({id:"a",status:"lost",company_name:"見送り社",title:"A",closed_at:"2026-10-20T01:00:00Z"}),
  shapeProposal({id:"b",status:"won",company_name:"成約社",title:"B"}),
  shapeProposal({id:"c",status:"considering",company_name:"継続検討社",title:"C"}),
  shapeProposal({id:"d",status:"closed_no_reply",company_name:"無回答社",title:"D"}),
  shapeProposal({id:"e",status:"lost",company_name:"保存済社",title:"E",archived_at:"2026-10-21T01:00:00Z"}),
];
assert.equal(shaped[0].closedAt,"2026-10-20T01:00:00Z");
assert.deepEqual(filterRows(shaped,{filter:"all"}).map(x=>x.id),["b","c","d"],"通常一覧で見送りを除外");
assert.deepEqual(filterRows(shaped,{filter:"closed"}).map(x=>x.id),["b","d"],"完了にも見送りを混ぜない");
assert.deepEqual(filterRows(shaped,{filter:"lost"}).map(x=>x.id),["a"],"見送り専用フィルターに隔離");
assert.equal(countFilters(shaped).lost,1,"別タブへ件数を表示できる");
assert.equal(countFilters(shaped).all,3);

const html=read("sales/proposals.html");
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(script);
new Script(script[1],{filename:"sales/proposals.html"});
assert.ok(html.includes('id="pp-tab-lost"'),"見送り専用タブがある");
assert.ok(html.includes('id="pp-loss-analysis"'),"理由と担当の分析領域がある");
assert.ok(script[1].includes("function ppRenderLoss(report)"),"実データでグラフを描画する");
assert.ok(script[1].includes("ppLossPeriod(value)"),"1/7/30/90/365/全期間で切替できる");
assert.ok(read("api/sales/proposals/index.js").includes("buildLossReport("),"分析は権限が確認されたサーバから返す");
console.log("PASS Sales proposal lost archive-free filter, reason/owner analytics, JST periods and UI syntax");
