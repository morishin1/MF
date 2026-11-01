import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSalesDashboardWork, WORK_CATEGORY } from "../lib/sales-dashboard-work.js";

const now="2026-11-01T01:00:00.000Z";
const todayEnd="2026-11-01T14:59:59.999Z";
const person=id=>id==="p1"?"池永":id==="p2"?"野澤":null;
const p=(id,patch={})=>({
 id,companyName:"企業"+id,title:"案件"+id, status:"call_wait",statusLabel:"電話待ち",
 sentAt:"2026-10-30T03:00:00Z",call:null,closed:false,archived:false,
 salesOwnerId:"s1",salesOwnerName:"営業担当",...patch,
});
const t=(id,proposal_id,kind,due_at,patch={})=>({
 id,proposal_id,kind,due_at,title:"タスク"+id,assignee_id:"p1",status:"open",...patch,
});
const proposals=[
 p("a"),
 p("b",{call:{label:"通話済み"}}),
 p("c",{status:"proposal_wait",sentAt:null,salesOwnerId:null}),
 p("d",{closed:true}),
 p("e",{archived:true}),
 p("f",{call:{label:"通話済み"}}),
];
const tasks=[
 t("1","a","call","2026-10-31T14:00:00Z"),
 t("2","a","reply_check","2026-10-31T15:00:00Z"), // 同一提案の遅延2タスクは期限超過1件
 t("3","b","meeting_fix","2026-11-01T08:00:00Z",{assignee_id:"p2"}),
 t("4","c","prepare","2026-11-01T09:00:00Z",{assignee_id:null}),
 t("5","d","call","2026-10-30T07:00:00Z"), // 完了提案は除外
 t("6","e","call","2026-10-30T07:00:00Z"), // アーカイブは除外
 t("7","f","manual","2026-11-01T10:00:00Z"),
 t("8","a","call","2026-11-03T00:00:00Z"), // 未到来の電話タスクは本日分ではない
];
const result=buildSalesDashboardWork(proposals,tasks,{now,todayEnd,nameOf:person});
assert.equal(result.counts.overdue,1);
assert.equal(result.counts.no_call,1);
assert.equal(result.counts.today_all,4); // a/b/c/f、同一提案は重複させない
assert.equal(result.counts.call_today,1);
assert.equal(result.counts.reply_check,1);
assert.equal(result.counts.meeting_today,1);
assert.equal(result.counts.proposal_wait,1);
assert.equal(result.counts.unassigned,1);
assert.equal(result.groups.overdue[0].proposalId,"a");
assert.equal(result.groups.overdue[0].taskId,"1","期限が最も早い未完タスクを表示");
assert.equal(result.groups.overdue[0].assigneeName,"池永");
assert.equal(result.groups.proposal_wait[0].assigneeName,"担当未割当");
assert.equal(result.groups.today_all.at(-1).proposalId,"f","手動タスクも今日の仕事として表示");
for(const [category,rows] of Object.entries(result.groups)){
 assert.equal(result.counts[category],rows.length,"同一データを集計: "+category);
 assert.equal(new Set(rows.map(r=>r.proposalId)).size,rows.length,"同一カテゴリの提案は重複しない: "+category);
 for(const row of rows){
   assert.ok(Object.hasOwn(WORK_CATEGORY,category));
   assert.ok(row.companyName&&row.action&&row.assigneeName);
 }
}
const html=readFileSync(new URL("../sales/proposals.html",import.meta.url),"utf8");
assert.match(html,/id="pp-work-evidence"/);
assert.match(html,/data-work-key/);
assert.match(html,/ppDashboardFocus/);
assert.match(html,/提案詳細を開く/);
const api=readFileSync(new URL("../api/sales/proposals/index.js",import.meta.url),"utf8");
assert.match(api,/dashboardWork = buildSalesDashboardWork\(eligible, tks\.data \|\| \[\]/);
assert.match(api,/proposals: visible, counts, today, dashboardWork/);
console.log("Sales dashboard work evidence: category counts, assignee, due, deep links, no inferred owner OK");
