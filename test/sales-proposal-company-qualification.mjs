import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { qualificationGrade, companyQualifications } from "../lib/sales-company-qualification.js";

assert.equal(qualificationGrade(9, 0), "review", "10件未満は評価中");
assert.equal(qualificationGrade(10, 0), "C", "10件面談0は改善");
assert.equal(qualificationGrade(15, 0), "blast", "15件面談0はブラスト候補");
assert.equal(qualificationGrade(10, 1), "B", "10件に1件面談は10%");
assert.equal(qualificationGrade(10, 2), "A", "10件に2件面談は20%");
assert.equal(qualificationGrade(15, 1), "C", "面談済み企業を誤ってブラストにしない");
const rows=Array.from({length:15},(_,i)=>({
  id:"proposal"+i,company_id:"company-1",company_name:"テスト企業",sent_at:"2026-10-01",
  status:i===0?"lost":"reply_wait",close_reason:i===0?"client_declined":null,
}));
const noMeet=companyQualifications(rows,[]);
assert.equal(noMeet.companies[0].sent,15);
assert.equal(noMeet.companies[0].grade,"blast");
assert.equal(noMeet.companies[0].unknownReasons,1);
const met=companyQualifications(rows,[{proposal_id:"proposal0",kind:"meeting",result:"done"}]);
assert.equal(met.companies[0].meetings,1,"失注後でも過去の実施済み面談はカウント");
assert.equal(met.companies[0].grade,"C");
rows.push({id:"not-sent",company_id:"company-1",company_name:"テスト企業",sent_at:null,status:"proposal_wait"});
assert.equal(companyQualifications(rows,[]).companies[0].sent,15,"提案待ちは分母に入れない");

const html=readFileSync(new URL("../sales/analytics.html",import.meta.url),"utf8");
assert.match(html,/id="an-tab-proposal"/);
assert.match(html,/id="an-tab-attack"/);
assert.match(html,/else \{ SalesProposalAnalysis\.load\(days\); SalesProposalAnalysis\.loadDaily\(\); \}/,"デフォルトは提案分析と選択日実績");
assert.match(html,/type="date" id="an-daily-date"/,"提案分析に日付選択カレンダーがある");
assert.match(html,/sales-proposal-analysis\.js/);
const ui=readFileSync(new URL("../js/sales-proposal-analysis.js",import.meta.url),"utf8");
assert.match(ui,/CSVダウンロード/);
assert.match(ui,/ブラスト限定/);
console.log("sales proposal qualification and tabs: OK");
