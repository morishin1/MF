// Quick review UI: recorded reason vs unverified hypothesis; escaping; read-only detail loading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const src=readFileSync(new URL("../js/sales-dashboard-quick.js",import.meta.url),"utf8");
const item={innerHTML:"",querySelector:()=>({focus(){}})};
const listeners={};
let detailCount=0,original=true;
const windowObj={API:{api:async()=>({
 proposal:{statusLabel:"メール待ち",call:{label:"不通"},companyResponseLabel:"未回答"},
 activities:[{occurredAt:"2026-11-01T01:00:00.000Z",label:"電話：不通",note:"不通。<script>削除</script>"}],
})}};
const doc={
 getElementById:id=>id==="pp-quick-root"?item:null,
 addEventListener:(name,fn)=>{listeners[name]=fn;},
 activeElement:{isConnected:false},
};
runInNewContext(src,{window:windowObj,document:doc});
const app=windowObj.SalesDashboardQuick;
const row={proposalId:"00000000-0000-0000-0000-000000000001",companyName:"会社<123>",
 title:"システム開発",statusLabel:"電話待ち",assigneeName:"工藤",action:"電話をする",
 dueAt:"2026-10-31T08:00:00.000Z",category:"overdue",overdue:true};
assert.equal(app.knownReason({closeReason:"client_declined",closeReasonLabel:"企業見送り"},row).verified,false,
 "企業見送りの区分だけでは具体理由は確定しない");
assert.match(app.knownReason({call:null}, {...row,category:"no_call"}).note,/記録漏れかは未確認/);
app.open(row,{call:{label:"不通"}},()=>detailCount++,null);
await Promise.resolve();
await Promise.resolve();
assert.match(item.innerHTML,/role="dialog"/);
assert.match(item.innerHTML,/会社&lt;123&gt;/);
assert.doesNotMatch(item.innerHTML,/会社<123>/);
assert.match(item.innerHTML,/電話：不通/);
assert.match(item.innerHTML,/&lt;script&gt;削除&lt;\/script&gt;/);
assert.doesNotMatch(item.innerHTML,/<script>削除<\/script>/);
assert.match(item.innerHTML,/状況・理由の確認/);
assert.match(item.innerHTML,/最近の対応記録/);
app.showDetail();
assert.equal(detailCount,1,"詳細への操作はユーザークリック時だけ");
assert.equal(item.innerHTML,"","閉じたら背景のモーダルを残さない");
app.open(row,{},()=>{},null);
listeners.keydown({key:"Escape",preventDefault(){},stopPropagation(){}});
assert.equal(item.innerHTML,"","Escapeで閉じられる");
const html=readFileSync(new URL("../sales/proposals.html",import.meta.url),"utf8");
assert.match(html,/sales-dashboard-quick\.js/);
assert.match(html,/ppDashboardQuick/);
assert.match(html,/\.pp-dashboard-mode \.pp-sum.*repeat\(8,minmax\(0,1fr\)\)/);
assert.match(html,/\.pp-work-open/);
assert.match(html,/\.pp-dashboard-mode #pp-view-list/);
console.log("Sales compact dashboard reason modal, XSS, Escape, one-row KPI, detail action: PASS");
