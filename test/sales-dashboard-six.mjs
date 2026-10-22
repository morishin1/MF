// Salesダッシュボードの各カードは6件まで。総件数は実数を維持して一覧へ誘導。
import assert from "node:assert/strict";
import { DASHBOARD_LIMIT, DASHBOARD_KEYS, dashboardSections } from "../lib/sales-dashboard.js";

for (const key of DASHBOARD_KEYS) assert.equal(DASHBOARD_LIMIT[key], 6, key + " を6件表示");

const today="2026-10-21";
const companies=Array.from({length:10},(_,i)=>({
  id:"c"+i, name:"会社"+i, unhandledClick:true,
  lastClickAt:new Date(Date.UTC(2026,9,20,0,i)).toISOString(),
  clickCount:1, next:"確認", status:"untouched", statusLabel:"未対応",
  ownerName:"担当", overdue:false,
}));
const result=dashboardSections(companies,{today,now:Date.parse("2026-10-21T00:00:00Z")});
assert.equal(result.click.total,10,"元の10件という集計を維持");
assert.equal(result.click.rows.length,6,"カードは6件のみ");
assert.equal(result.click.rows[0].name,"会社9","優先順を維持");
assert.equal(new Set(result.click.rows.map(x=>x.id)).size,6);
console.log("PASS: 営業ダッシュボードは各カード6件、全体件数・優先順は不変");
