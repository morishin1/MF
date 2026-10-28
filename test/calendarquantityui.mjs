import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
const read = path => fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
const helper = read("js/calendar-quantity.js"), html = read("calendar.html");
const base = vm.createContext({ window: {} }); vm.runInContext(helper, base);
const Quantity = base.window.CalendarQuantity;
const clean = value => JSON.parse(JSON.stringify(value));
test("one optional number field parses count, unit, full-width and zero", () => {
  for (const [input, number, unit] of [["10件",10,"件"],["３社",3,"社"],["0",0,null],[" 0件 ",0,"件"],[".5時間",.5,"時間"],["",null,null]]) {
    assert.deepEqual(clean(Quantity.parse(input)), { plannedQuantity: number, plannedQuantityUnit: unit });
  }
});
test("invalid numbers and long units do not silently become zero", () => {
  for (const bad of ["-1件","NaN","Infinity","1000000001件","1e3","1.2.3件","3 abcdefghijk","1件\n個"]) assert.throws(() => Quantity.parse(bad), undefined, bad);
});
test("format keeps null and zero separate without inventing unit", () => {
  assert.equal(Quantity.format(null, "件"), ""); assert.equal(Quantity.format(0, "件"), "0件");
  assert.equal(Quantity.format(8, null), "8");
});
const day = "2026-10-28", event = extra => ({ id:"ev1", title:"合成作業", starts_at:day+"T09:00:00+09:00", ends_at:day+"T10:00:00+09:00", category:"meeting", all_day:false, planned_quantity:10, planned_quantity_unit:"件", ...extra });
function harness(extra = {}) {
  const nodes = new Map(), sent = [];
  const c = vm.createContext({
    CalendarQuantity:Quantity, scope:"mine", events:[event()], selected:day, quantityAvailable:true, editing:null,busy:false,batchSaving:false,calendarWriteUncertain:false,
    el: key => { if (!nodes.has(key)) nodes.set(key,{value:"",textContent:"",hidden:false,disabled:false,inert:false,focus(){}}); return nodes.get(key); },
    pad:n=>String(n).padStart(2,"0"), hm:t=>new Date(Date.parse(t)+9*3600000).toISOString().slice(11,16),
    jstDay:t=>new Date(Date.parse(t)+9*3600000).toISOString().slice(0,10),at:(d,t)=>d+"T"+t+":00+09:00",
    API:{updateEvent:async fields=>{sent.push(clean(fields));}, createEvent:async fields=>{sent.push(clean(fields));}}, load:async()=>{},message(){}, ...extra,
  });
  const a=html.indexOf("  function openForm("),b=html.indexOf("  async function deleteEvent(",a);
  vm.runInContext(html.slice(a,b),c); return {c,sent};
}
test("edit reloads planned number and saves it without changing category", async () => {
  const {c,sent}=harness();c.openForm("ev1");assert.equal(c.el("f-quantity").value,"10件");
  c.el("f-quantity").value="8社";await c.saveEvent({});assert.equal(sent[0].plannedQuantity,8);assert.equal(sent[0].plannedQuantityUnit,"社");assert.equal(sent[0].category,"meeting");
});
test("number is optional and clear is explicit null", async () => {
  const {c,sent}=harness();c.openForm("ev1");c.el("f-quantity").value="";await c.saveEvent({});assert.equal(sent[0].plannedQuantity,null);
});
test("unapplied schema disables number input and leaves existing number omitted", async () => {
  const {c,sent}=harness({quantityAvailable:false});c.openForm("ev1");assert.equal(c.el("f-quantity").disabled,true);
  await c.saveEvent({});assert.equal("plannedQuantity" in sent[0],false);assert.match(c.el("cal-quantity-note").textContent,/準備/);
});
test("invalid number retains the draft and makes no API call", async () => {
  const {c,sent}=harness();c.openForm("ev1");c.el("f-quantity").value="-3件";await c.saveEvent({});assert.equal(sent.length,0);assert.equal(c.el("f-quantity").value,"-3件");
});
test("all-day and multi-day quantity edits preserve original dates", async () => {
  for (const ev of [event({all_day:true,starts_at:day+"T00:00:00+09:00",ends_at:day+"T23:59:00+09:00"}),event({ends_at:"2026-10-29T01:00:00+09:00"})]) {
    const {c,sent}=harness({events:[ev]});c.openForm("ev1");assert.equal(c.el("f-start").disabled,true);await c.saveEvent({});assert.equal(sent[0].startsAt,ev.starts_at);assert.equal(sent[0].endsAt,ev.ends_at);
  }
});
test("repeated click is locked until save response; form cannot be edited meanwhile", async () => {
  let resolve,calls=0;const {c}=harness({API:{updateEvent:()=>{calls++;return new Promise(r=>resolve=r)}}});c.openForm("ev1");const pending=c.saveEvent({});assert.equal(c.el("cal-edit").inert,true);await c.saveEvent({});assert.equal(calls,1);resolve();await pending;assert.equal(c.el("cal-edit").inert,false);
});
test("unknown write outcome retains form and blocks resend; known schema error remains editable", async () => {
  for (const known of [true,false]) {
    let calls=0;const {c}=harness({API:{updateEvent:async()=>{calls++;throw Object.assign(Error("synthetic"),known?{status:503,code:"calendar_quantity_unavailable"}:{})}}});
    c.openForm("ev1");await c.saveEvent({});assert.equal(c.calendarWriteUncertain,!known);assert.equal(c.el("cal-edit").hidden,false);assert.equal(c.el("f-quantity").value,"10件");
    await c.saveEvent({});assert.equal(calls,known?2:1);
  }
});
test("calendar scripts compile and all primary editors retain three groups and optional details", () => {
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  assert.match(html,/label for="f-quantity">数字（任意）/);assert.match(html,/details class="cal-optional"/);
  assert.match(html,/if\(!title&&!location&&!quantity\)continue/);
});
