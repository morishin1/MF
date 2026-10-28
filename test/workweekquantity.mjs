// Weekly plan quantity and interrupted-save regression checks. Fake DOM/API only;
// no browser, auth, database, network, notifications, or storage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInContext, createContext } from "node:vm";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("work-week.html", root), "utf8");
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).filter(x => x.trim()).join("\n");
const quantity = readFileSync(new URL("js/calendar-quantity.js", root), "utf8");
const DAY = "2026-10-28";
const clone = x => JSON.parse(JSON.stringify(x));
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const event = (id = "saved-1", changes = {}) => ({ id, source: "self", category: "work", visibility: "shared", title: "合成の資料作成", all_day: false,
  starts_at: DAY + "T00:00:00.000Z", ends_at: DAY + "T01:00:00.000Z", location: "合成の場所", planned_quantity: 10, planned_quantity_unit: "件", ...changes });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(events = [], available = true) {
  const nodes = new Map(), calls = [], listeners = {}, confirmations = [];
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.attrs = {}; this.value = ""; this.disabled = false; this.inert = false; this.textContent = ""; this._html = ""; }
    set innerHTML(text) {
      this._html = text; this.children = []; this.inputs = [];
      for (const match of text.matchAll(/<input\b([^>]*)>/g)) {
        const n = new Node(), attrs = match[1]; n.className = attrs.match(/class="([^"]*)"/)?.[1] || "";
        n.value = decode(attrs.match(/value="([^"]*)"/)?.[1] || ""); n.disabled = /\bdisabled\b/.test(attrs);
        this.inputs.push(n);
      }
      this.removeButton = new Node();
    }
    get innerHTML() { return this._html; }
    querySelector(selector) { if (selector === ".wk-remove") return this.removeButton; return this.inputs.find(n => n.className.split(" ").includes(selector.slice(1))); }
    querySelectorAll(selector) { return selector === "input" ? this.inputs : []; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attrs[name] = value; }
    appendChild(node) { this.children.push(node); node.parent = this; }
    remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
  }
  const el = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  let response = { events: clone(events), quantityAvailable: available, eventsStatus: "available" };
  const api = {
    schedule: async (...args) => { calls.push({ op: "read", args }); return clone(response); },
    createEvent: async fields => { calls.push({ op: "create", fields: clone(fields) }); return { event: fromFields("new-" + calls.filter(c => c.op === "create").length, fields) }; },
    updateEvent: async fields => { calls.push({ op: "update", fields: clone(fields) }); return { event: fromFields(fields.id, fields) }; },
    deleteEvent: async id => { calls.push({ op: "delete", id }); return { ok: true }; },
    api: async () => { throw Error("AI review not called by quantity tests"); },
  };
  function fromFields(id, fields) { return event(id, { title: fields.title, location: fields.location, category: fields.category,
    starts_at: new Date(fields.startsAt).toISOString(), ends_at: new Date(fields.endsAt).toISOString(),
    planned_quantity: fields.plannedQuantity ?? null, planned_quantity_unit: fields.plannedQuantityUnit ?? null }); }
  const ctx = createContext({ URLSearchParams, console, location: { search: "?date=" + DAY },
    document: { getElementById: el, createElement: () => new Node(), querySelectorAll: selector => selector === ".wk-row" ? el("wk-edit-rows").children : [] },
    API: api, KPLayout: { esc, init: async () => null }, confirm: message => { confirmations.push(message); return true; },
    addEventListener: (name, fn) => { listeners[name] = fn; },
  });
  ctx.window = ctx; runInContext(quantity, ctx); runInContext(script, ctx);
  return { ctx, el, calls, api, listeners, confirmations, setResponse: value => { response = value; },
    rows: () => el("wk-edit-rows").children, get: name => runInContext(name, ctx),
    load: () => ctx.loadWeek(), save: () => ctx.saveDay(el("wk-save")), reload: () => ctx.reloadWeek() };
}
let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log("ok " + name); }
function fill(row, values) { for (const [key, value] of Object.entries(values)) { const input = row.querySelector(".wk-" + key); input.value = value; input.listeners.input?.(); } }

await test("three input groups and optional collapsed location preserve loaded quantity and location", async () => {
  const h = harness([event()]); await h.load(); const row = h.rows()[0];
  assert.match(row.innerHTML, /class="wk-time"/); assert.match(row.innerHTML, /class="wk-content"/); assert.match(row.innerHTML, /数字（任意）/);
  assert.match(row.innerHTML, /<details class="wk-optional"><summary>場所（任意）/);
  assert.equal(row.querySelector(".wk-quantity").value, "10件"); assert.equal(row.querySelector(".wk-place").value, "合成の場所");
  assert.match(h.el("wk-calendar").innerHTML, /10件/); assert.equal(row.querySelector(".wk-quantity").disabled, false);
  fill(row, { title: "内容だけ変更" }); await h.save();
  const p = h.calls.find(c => c.op === "update").fields;
  assert.equal(p.plannedQuantity, 10); assert.equal(p.plannedQuantityUnit, "件"); assert.equal(p.location, "合成の場所"); assert.equal(p.id, "saved-1");
});
await test("POST supports number with unit, unitless zero and blank without inventing zero", async () => {
  for (const [input, amount, unit] of [["3社", 3, "社"], ["0", 0, null], ["", null, null], ["12.5", 12.5, null]]) {
    const h = harness(); await h.load(); fill(h.rows()[0], { title: "合成の新予定", quantity: input }); await h.save();
    const p = h.calls.find(c => c.op === "create").fields;
    assert.equal(p.plannedQuantity, amount); assert.equal(p.plannedQuantityUnit, unit); assert.equal(h.rows()[0].dataset.id, "new-1");
    assert.equal(p.startsAt, DAY + "T09:00:00+09:00"); assert.equal(p.visibility, "shared");
  }
});
await test("explicit quantityAvailable false disables number and omits both quantity fields from POST/PATCH", async () => {
  for (const existing of [[], [event()]]) {
    const h = harness(existing, false); await h.load(); assert.match(h.el("wk-quantity-note").textContent, /数字未準備/);
    assert.equal(h.rows()[0].querySelector(".wk-quantity").disabled, true);
    fill(h.rows()[0], { title: "内容を保存", quantity: "99件" }); await h.save();
    const p = h.calls.find(c => ["create", "update"].includes(c.op)).fields;
    assert.equal(Object.hasOwn(p, "plannedQuantity"), false); assert.equal(Object.hasOwn(p, "plannedQuantityUnit"), false);
  }
});
await test("legacy response without availability flag does not enable unsupported number writes", async () => {
  const h = harness(); h.setResponse({ events: [] }); await h.load();
  assert.equal(h.rows()[0].querySelector(".wk-quantity").disabled, true);
  fill(h.rows()[0], { title: "旧API互換" }); await h.save(); assert.equal(Object.hasOwn(h.calls.find(c => c.op === "create").fields, "plannedQuantity"), false);
});
await test("invalid quantity and missing content fail before any writes", async () => {
  for (const quantity of ["-1件", "1000000001", "NaN", "1e3", "会社"]) {
    const h = harness(); await h.load(); fill(h.rows()[0], { title: "入力検証", quantity }); await h.save();
    assert.equal(h.calls.filter(c => c.op !== "read").length, 0); assert.equal(h.el("wk-save").disabled, false);
  }
  const h = harness(); await h.load(); fill(h.rows()[0], { quantity: "1件" }); await h.save();
  assert.match(h.el("wk-message").textContent, /業務内容/); assert.equal(h.calls.filter(c => c.op !== "read").length, 0);
});
await test("reloading zero and blank preserves their different meanings and escapes strings", async () => {
  const h = harness([event("zero", { planned_quantity: 0, planned_quantity_unit: null, title: '<img onerror="bad">' }), event("unknown", { planned_quantity: null, planned_quantity_unit: null })]);
  await h.load(); assert.equal(h.rows()[0].querySelector(".wk-quantity").value, "0"); assert.equal(h.rows()[1].querySelector(".wk-quantity").value, "");
  assert.match(h.el("wk-calendar").innerHTML, /&lt;img/); assert.doesNotMatch(h.el("wk-calendar").innerHTML, /<img/);
});
await test("busy guard blocks double save, changing date/week, adding and deleting while a write is pending", async () => {
  const h = harness(); await h.load(); fill(h.rows()[0], { title: "送信中", quantity: "10件" }); const pending = defer();
  h.api.createEvent = async fields => { h.calls.push({ op: "create", fields: clone(fields) }); return pending.promise; };
  const saving = h.save(); assert.equal(h.el("wk-save").disabled, true); assert.equal(h.el("wk-edit-rows").inert, true); assert.equal(h.el("wk-actions").inert, true);
  await h.save(); h.ctx.selectDay("2026-10-29"); h.ctx.moveWeek(1); h.ctx.addRow(); h.rows()[0].removeButton.listeners.click();
  assert.equal(h.calls.filter(c => c.op === "create").length, 1); assert.equal(h.get("selected"), DAY); assert.equal(h.rows().length, 1);
  pending.resolve({ event: event("confirmed") }); await saving;
  assert.equal(h.rows()[0].dataset.id, "confirmed"); assert.equal(h.el("wk-save").disabled, false); assert.equal(h.el("wk-edit-rows").inert, false);
});
await test("partial create failure preserves confirmed IDs and input; uncertain create is never resent", async () => {
  const h = harness(); await h.load(); fill(h.rows()[0], { title: "先行成功", quantity: "3社" }); h.ctx.addRow(); fill(h.rows()[1], { title: "応答不明", quantity: "5件" });
  let count = 0; h.api.createEvent = async fields => { h.calls.push({ op: "create", fields: clone(fields) }); if (++count === 1) return { event: event("confirmed", { title: fields.title }) }; throw Error("synthetic lost response"); };
  await h.save(); assert.equal(h.rows()[0].dataset.id, "confirmed"); assert.equal(h.rows()[1].dataset.id, ""); assert.equal(h.rows()[1].querySelector(".wk-quantity").value, "5件");
  assert.equal(h.get("saved").length, 1); assert.equal(h.get("dirty"), true); assert.equal(h.el("wk-save").disabled, true); assert.match(h.el("wk-message").textContent, /再送を止め/);
  assert.equal(h.el("wk-edit-rows").inert, false, "uncertain inputs remain readable/selectable for copying");
  assert.equal(h.rows()[1].querySelector(".wk-quantity").readOnly, true); assert.equal(h.rows()[1].removeButton.disabled, true);
  await h.save(); h.ctx.selectDay("2026-10-29"); assert.equal(count, 2); assert.equal(h.get("selected"), DAY);
  h.ctx.confirm = () => false; await h.reload(); assert.equal(h.rows().length, 2); assert.equal(h.get("uncertainWrite"), true);
  h.ctx.confirm = () => true; h.setResponse({ events: [event("confirmed"), event("lost-but-saved")], eventsStatus: "available", quantityAvailable: true }); await h.reload();
  assert.equal(count, 2); assert.equal(h.get("uncertainWrite"), false); assert.deepEqual(h.rows().map(r => r.dataset.id), ["confirmed", "lost-but-saved"]);
});
await test("known validation failure may retry but confirmed creates are updated rather than duplicated", async () => {
  const h = harness(); await h.load(); fill(h.rows()[0], { title: "先行成功" }); h.ctx.addRow(); fill(h.rows()[1], { title: "入力拒否" });
  let count = 0; h.api.createEvent = async fields => { h.calls.push({ op: "create", fields: clone(fields) }); if (++count === 2) throw Object.assign(Error("validation"), { status: 400 }); return { event: event("confirmed-" + count, { title: fields.title }) }; };
  await h.save(); assert.equal(h.el("wk-save").disabled, false); assert.equal(h.rows()[0].dataset.id, "confirmed-1");
  await h.save(); assert.equal(count, 3); assert.equal(h.calls.filter(c => c.op === "update").length, 1); assert.equal(h.calls.find(c => c.op === "update").fields.id, "confirmed-1");
});
await test("confirmed deletions are retained when a later write fails and unknown results block retry", async () => {
  const h = harness([event("remove-me")]); await h.load(); h.rows()[0].removeButton.listeners.click(); h.ctx.addRow(); fill(h.rows()[0], { title: "新規" });
  h.api.createEvent = async () => { throw Object.assign(Error("timeout"), { status: 408 }); }; await h.save();
  assert.equal(h.calls.filter(c => c.op === "delete").length, 1); assert.equal(h.get("removed.size"), 0); assert.equal(h.get("saved.length"), 0); assert.equal(h.get("uncertainWrite"), true);
  await h.save(); assert.equal(h.calls.filter(c => c.op === "delete").length, 1);
});
await test("malformed successful create response also locks retry until a fresh read", async () => {
  const h = harness(); await h.load(); fill(h.rows()[0], { title: "結果不明" }); h.api.createEvent = async () => ({}); await h.save();
  assert.equal(h.get("uncertainWrite"), true); assert.equal(h.rows()[0].dataset.id, ""); assert.equal(h.el("wk-save").disabled, true);
});
await test("unavailable or rejected schedule reads do not become empty plans or unlock saving", async () => {
  for (const response of [{ eventsStatus: "unavailable", events: null, quantityAvailable: false }, { eventsStatus: "available", events: null }]) {
    const h = harness([event()]); await h.load(); const before = h.rows()[0]; h.setResponse(response); await h.reload();
    assert.equal(h.get("ready"), false); assert.equal(h.rows()[0], before); assert.match(h.el("wk-message").textContent, /未確認/); assert.equal(h.el("wk-save").disabled, true);
    assert.equal(h.get("saved.length"), 1); await h.save(); assert.equal(h.calls.filter(c => c.op !== "read").length, 0);
  }
});
await test("failed re-read after unknown save keeps the unknown state and prevents replay", async () => {
  const h = harness(); await h.load(); fill(h.rows()[0], { title: "未確認" }); h.api.createEvent = async () => { throw Error("lost"); }; await h.save();
  h.api.schedule = async () => { throw Error("read failed"); }; await h.reload(); assert.equal(h.get("uncertainWrite"), true); assert.equal(h.el("wk-save").disabled, true);
});
await test("leaving with dirty or in-flight writes requests the standard browser confirmation", async () => {
  const h = harness(); await h.load(); let warned = false; const e = { preventDefault() { warned = true; } };
  h.listeners.beforeunload(e); assert.equal(warned, false); fill(h.rows()[0], { title: "未保存" }); h.listeners.beforeunload(e); assert.equal(warned, true); assert.equal(e.returnValue, "");
});
await test("multi-day edits preserve original date span; all-day entries are not rewritten by weekly editor", async () => {
  const multi=event("multi",{starts_at:DAY+"T23:00:00+09:00",ends_at:"2026-10-29T01:00:00+09:00"});
  const allDay=event("all",{all_day:true});
  const h=harness([multi,allDay]);await h.load();assert.equal(h.rows().length,1);
  assert.equal(h.rows()[0].querySelector(".wk-start").disabled,true);
  fill(h.rows()[0],{quantity:"4件"});await h.save();const p=h.calls.find(c=>c.op==="update").fields;
  assert.equal(p.startsAt,multi.starts_at);assert.equal(p.endsAt,multi.ends_at);
  assert.equal(h.calls.filter(c=>c.op==="update").length,1);assert.equal(h.get("saved.length"),2);
});
console.log(`${pass} weekly quantity VM checks passed (no browser/network/live data)`);
