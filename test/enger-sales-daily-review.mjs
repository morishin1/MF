import assert from "node:assert/strict";
import { runSalesDailyReview } from "../api/sales/proposals/daily-review.js";
import { reviewAccess, reviewDay } from "../lib/enger-sales-review.js";

const tenantId = "4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac";
const id = "22222222-2222-4222-8222-222222222222";
const today = "2026-11-22";
const proposal = { tenant_id: tenantId, id, title: "提案", company_name: "テスト企業", source_id: id, status: "reproposal", sent_at: today };
const records = new Map();
const daily = "gw_enger_daily_reviews", checks = "gw_enger_office_checks", queue = "gw_enger_office_review_queue";
const tables = new Map([[daily, []], [checks, []]]);
const clone = (value) => structuredClone(value);

function query(table) {
  let method = "select", values;
  const equal = {};
  const q = {
    select() { return q; }, eq(k,v) { equal[k]=v; return q; }, lt() { return q; },
    gte() { return q; }, or() { return q; }, order() { return q; }, limit() { return q; },
    update(v) { method = "update"; values = v; return q; },
    insert(v) { method = "insert"; values = v; return q; },
    async maybeSingle() { const r = execute(); return r.error ? r : { data:r.data[0] ?? null }; },
    then(resolve) { return Promise.resolve(execute()).then(resolve); },
  };
  function execute() {
    const rows = table === queue ? [{ ...proposal, ...tables.get(checks)[0] }] : tables.get(table);
    const matches = rows.filter(row => Object.entries(equal).every(([k,v])=>row[k]===v));
    if (method === "update") for (const row of matches) Object.assign(row, values);
    if (method !== "insert") return { data: clone(matches) };
    if (rows.length) return { error:{code:"23505"} };
    rows.push(clone(values));
    return {data:[clone(values)]};
  }
  return q;
}
const sb = { from: query };
const sales = { sales: true, enger: false };
const officeOnly = { sales: false, enger: false };
const enger = { sales: false, enger: true };
const dual = { sales: true, enger: true };
async function send(roles, userId, body, method = "POST") {
  const res = { setHeader() {}, end(raw) { this.value = JSON.parse(raw); } };
  await runSalesDailyReview({ method, body, url:"/api/sales/proposals/daily-review" },res,{
    sb, tenantId, user:{id:userId}, roles, today,
  });
  records.set(userId,res.value);
  return res.statusCode;
}
assert.equal(reviewDay("2026-11-33", today),null);
assert.deepEqual(await reviewAccess({}, { tenantId:"different" }, {}), { sales:false, enger:false });
const check = { day:today, action:"check", id, revision:0, outcome:"discuss",reason:"terms",fact:"希望単価と先方予算に差" };
assert.deepEqual(await reviewAccess({}, { tenantId, employee: { status: "active" }, apps: ["office"] }, {}), officeOnly);
assert.deepEqual(await reviewAccess({}, { tenantId, employee: { status: "active" }, apps: ["sales"] }, {}), sales);
assert.equal(await send(officeOnly,"admin",check),403);
assert.equal(await send(enger,"dx",check),403);
assert.equal(await send(sales,"of",{...check,fact:""}),400);
assert.equal(await send(sales,"of",check),200);
assert.equal(tables.get(checks)[0].checked_side,"sales");
const save = {day:today, action:"save_meeting", revision:0, note:"双方で単価条件を確認",nextStep:"ENGERが明日までに候補者に再確認"};
assert.equal(await send(enger,"dx",save),200);
const confirm = (side, revision)=>({day:today,action:"confirm_meeting",side,revision});
assert.equal(await send(dual,"of",confirm("sales",1)),200);
assert.equal(await send(dual,"of",confirm("enger",2)),409);
assert.equal(await send(enger,"dx",{...save,revision:2}),200);
assert.equal(records.get("dx").revision,2);
assert.equal(await send(sales,"of",{...check,fact:"回答期限も再確認",revision:1}),200);
assert.equal(await send(enger,"dx",null,"GET"),200);
assert.equal(records.get("dx").agendaChanged,true);
assert.equal(await send(enger,"dx",confirm("enger",2)),409);
assert.equal(await send(enger,"dx",{...save,revision:2}),200);
assert.equal(await send(enger,"dx",confirm("enger",2)),409);
assert.equal(await send(enger,"dx",confirm("enger",3)),200);
assert.equal(await send(sales,"of",confirm("sales",4)),200);
assert.equal(await send(sales,"of",{...save,revision:5}),409);
assert.equal(await send(enger,"dx",null,"GET"),200);
assert.ok(records.get("dx").meeting.sales_confirmed_at && records.get("dx").meeting.enger_confirmed_at);
assert.equal(records.get("dx").meeting.agenda[0].fact,"回答期限も再確認");
assert.equal("sales_confirmed_by" in records.get("dx").meeting,false);

tables.get(daily).length = 0;
const agenda = [{ id, reason: "単価・条件", fact: "回答期限も再確認" }];
const saveAndConfirm = { ...save, side: "sales", agenda };
assert.equal(await send(enger,"dx",saveAndConfirm),403);
assert.equal(await send(sales,"of",{...saveAndConfirm,agenda:[]}),409);
assert.equal(await send(sales,"of",saveAndConfirm),200);
assert.equal(tables.get(daily)[0].revision,1);
assert.equal(tables.get(daily)[0].sales_confirmed_by,"of");
assert.equal(tables.get(daily)[0].enger_confirmed_at,null);
assert.equal(await send(dual,"of",{...saveAndConfirm,side:"enger",revision:1}),409);
assert.equal(await send(enger,"dx",confirm("enger",1)),200);
assert.equal(tables.get(daily)[0].sales_confirmed_by,"of");
assert.equal(tables.get(daily)[0].enger_confirmed_by,"dx");

tables.get(daily)[0].office_confirmed_at = "earlier";
delete tables.get(daily)[0].sales_confirmed_at;
delete tables.get(daily)[0].sales_confirmed_by;
tables.get(checks)[0].checked_side = "office";
tables.get(checks)[0].outcome = "checked";
assert.equal(await send(sales,"of",null,"GET"),200);
assert.equal(records.get("of").rows[0].outcome,null);
assert.equal(records.get("of").rows[0].checkedSide,"office");
assert.equal(records.get("of").meeting.office_confirmed_at,"earlier");
assert.equal(records.get("of").meeting.sales_confirmed_at,undefined);
assert.equal(await send(dual,"dx",confirm("sales",2)),409);
console.log("ENGER / Sales: checked proposals, one daily agenda, distinct confirmations, changed agenda and stale writes PASS");
