import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { normalizeNippo, normalizeMorning, hasContent, evaluateDaily } from "../lib/nippo.js";
import { systemMetrics } from "../lib/nippo-eval.js";
import { publicSource } from "../lib/nippo-share.js";

const source = fs.readFileSync(new URL("../js/nippo-schedule.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../nippo.html", import.meta.url), "utf8");
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const ui = context.window.NippoSchedule;
const copy = value => JSON.parse(JSON.stringify(value));
const id = n => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan = (n = 1, extra = {}) => ({ task: "同じ内容", schedule_event_id: id(n),
  planned_starts_at: "2026-10-28T00:00:00Z", planned_ends_at: "2026-10-28T01:00:00Z", planned_all_day: false, target: null, unit: "", ...extra });
const schedule = (...items) => ({ status: "available", items });
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

test("calendar reference, not title, identifies two separate plans", () => {
  const r = ui.inherit([], schedule(plan(1), plan(2))); assert.equal(r.items.length, 2); assert.equal(r.added, 2);
});
test("repeated inheritance does not duplicate or overwrite actuals and notes", () => {
  const before = [plan(1, { actual: 0, actual_minutes: 30, measurement_note: "保存する" })];
  const r = ui.inherit(before, schedule(plan(1, { task: "後で変わった" }), plan(1)));
  assert.equal(r.items.length, 1); assert.deepEqual(copy(r.items), before); assert.notEqual(r.items[0], before[0]);
});
test("saved plan snapshots survive changed calendar source", () => {
  const old = plan(1, { planned_starts_at: "2026-10-27T00:00:00Z" });
  assert.deepEqual(copy(ui.inherit([old], schedule(plan(1))).items[0]), old);
});
test("restored drafts and submitted reports get no newly added plans", () => {
  assert.equal(ui.inherit([plan(1)], schedule(plan(2)), { includeNew: false }).items.length, 1);
});
test("unavailable and incomplete never mean zero work or fabricate imported plans", () => {
  for (const state of ["unavailable", "incomplete"]) {
    const r = ui.inherit([plan(1)], { status: state, items: [plan(2)] });
    assert.equal(r.items.length, 1); assert.equal(r.added, 0); assert.match(ui.notice(r), /保持/);
  }
  assert.match(ui.notice(ui.inherit([], undefined)), /0件とは扱いません/);
});
test("ten-row cap is visible, without deleting existing rows", () => {
  const before = Array.from({ length: 10 }, (_, n) => plan(n + 1));
  const r = ui.inherit(before, schedule(plan(11), plan(12))); assert.equal(r.items.length, 10);
  assert.equal(r.omitted, 2); assert.match(ui.notice(r), /2件.*まだ/);
});
test("slot duration, all-day and target never become actual work or completion", () => {
  const r = ui.inherit([], schedule(plan(1, { planned_all_day: true, target: 10, actual: 10, done: true })));
  assert.equal(r.items[0].actual, null); assert.equal(r.items[0].actual_minutes, null); assert.equal(r.items[0].done, false);
});
test("JST label handles midnight, multi-day, all-day and malformed timestamp", () => {
  assert.equal(ui.timeLabel(plan()), "10-28 09:00 ～ 10-28 10:00");
  assert.equal(ui.timeLabel(plan(1, { planned_starts_at: "2026-10-27T15:00:00Z", planned_all_day: true })), "終日 10-28 ～ 10-28");
  assert.match(ui.timeLabel(plan(1, { planned_starts_at: "bad" })), /未確認/);
});
test("rendering distinguishes empty and explicit zero, with no required numeric input", () => {
  const empty = ui.rowHtml(plan(), esc), zero = ui.rowHtml(plan(1, { actual: 0, actual_minutes: 0 }), esc);
  assert.match(empty, /placeholder="未計測" value=""/); assert.match(zero, /placeholder="未計測" value="0"/);
  assert.match(zero, /placeholder="未記録" value="0"/); assert.doesNotMatch(empty, /\brequired\b/);
  assert.match(empty, /システム実績：未接続・未確認/); assert.match(empty, /<details>/);
});
test("all display and hidden input data are escaped", () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const rendered = ui.rowHtml(plan(1, { task: attack, unit: attack, measurement_note: attack, actual: attack, result: attack }), esc);
  assert.doesNotMatch(rendered, /<img/); assert.ok(rendered.includes("&lt;img"));
});
test("presentation helper has no API, persistence or evidence-writing side effects", () => {
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|sendBeacon|\.API\b/);
  assert.doesNotMatch(ui.rowHtml(plan(), esc), /data-k="(?:system|evidence|verified|actor)/);
});
test("normalization keeps reference and self-report, discards forged system and lifecycle fields", () => {
  const row = normalizeNippo({ workItems: [plan(1, { actual: "0", actual_minutes: "0", measurement_note: " note ", system_count: 99, verified: true, employee_id: id(2) })] }).work_items[0];
  assert.equal(row.actual, 0); assert.equal(row.actual_minutes, 0); assert.equal(row.measurement_note, "note");
  assert.equal(row.system_count, undefined); assert.equal(row.verified, undefined); assert.equal(row.employee_id, undefined);
});
test("empty measurements stay null and never turn into zero or completed", () => {
  const row = normalizeNippo({ workItems: [plan(1, { actual: "", actual_minutes: "" })] }).work_items[0];
  assert.equal(row.actual, null); assert.equal(row.actual_minutes, null); assert.equal(row.done, false);
  assert.equal(hasContent({ work_items: [row], kgi_actual: null }), false);
});
test("zero measurements alone constitute a report, not proof of completion", () => {
  for (const values of [{ actual: 0 }, { actual_minutes: 0 }]) {
    const n = normalizeNippo({ workItems: [plan(1, values)] });
    assert.equal(hasContent(n), true); assert.equal(n.work_items[0].done, false);
  }
});
test("legacy morning entry cannot create measured work or forged evidence", () => {
  const row = normalizeMorning({ actions: [plan(1, { actual: 10, actual_minutes: 60, verified: true })] }).work_items[0];
  assert.deepEqual(row, { task: "同じ内容" });
});
test("calendar self-report does not enter evaluation denominator or public AI summary", () => {
  const base = { work_items: [{ task: "legacy", result: "done" }] };
  const withSchedule = { work_items: [...base.work_items, plan(1, { actual: 50, actual_minutes: 50, done: true, result: "forged completed" })] };
  assert.deepEqual(systemMetrics(withSchedule), systemMetrics(base));
  assert.deepEqual(evaluateDaily(withSchedule), evaluateDaily(base));
  assert.deepEqual(publicSource(withSchedule), publicSource(base));
});
test("legacy title matching never marks a same-title calendar plan completed", () => {
  const start = html.indexOf("  function mergeWork("), end = html.indexOf("  function fillForm(", start);
  const c = vm.createContext({}); vm.runInContext(html.slice(start, end), c);
  const input = [plan(1), plan(2)];
  const out = c.mergeWork(input, [{ id: "action", title: "同じ内容", status: "done" }], {
    focusToday: [{ id: "task", title: "同じ内容", status: "done" }],
  });
  for (const row of out.filter(r => r.schedule_event_id)) {
    assert.equal(row.done, undefined); assert.equal(row.action_id, undefined); assert.equal(row.task_id, undefined);
  }
  assert.deepEqual(input, [plan(1), plan(2)]);
});
test("all inline scripts compile; schedule self-report adds no new mandatory done vote", () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.match(html, /!w\.schedule_event_id && w\.task/);
  assert.match(html, /includeNew: !data\?\.today\?\.submitted_at && \(!n \|\| n === data.today\)/);
});
test("restored draft retains the original report version, rather than silently adopting a newer saved report", () => {
  const nodes = new Map();
  const c = vm.createContext({ data: { today: { updated_at: "new-version" } }, formReportVersion: null,
    el: key => { if (!nodes.has(key)) nodes.set(key, { value: "", textContent: "", innerHTML: "", classList: { toggle() {} } }); return nodes.get(key); },
    syncTomorrowPlanField() {}, setConsult() {}, mergeWork: () => [], addWork() {}, fillMet() {}, fillWins() {}, fillImprove() {}, NippoSchedule: ui,
  });
  const a = html.indexOf("  function fillForm("), b = html.indexOf("  // --- ③", a);
  vm.runInContext(html.slice(a, b), c);
  c.fillForm({ draft_report_version: "old-version" }); assert.equal(c.formReportVersion, "old-version");
  c.fillForm({ draft_report_version: null }); assert.equal(c.formReportVersion, null);
  c.fillForm(c.data.today); assert.equal(c.formReportVersion, "new-version");
});
test("locally saved draft restores reference, measurements and expected version without changing 0", () => {
  const draft = { workItems: [plan(1, { actual: 0, actual_minutes: 0 })], reportVersion: "old-version" };
  const c = vm.createContext({ draftKey: () => "owned-key", localStorage: { getItem: key => key === "owned-key" ? JSON.stringify(draft) : null } });
  const a = html.indexOf("  function loadDraft("), b = html.indexOf("  const clearDraft", a);
  vm.runInContext(html.slice(a, b), c);
  const restored = c.loadDraft("2026-10-28"); assert.equal(restored.draft_report_version, "old-version");
  assert.equal(restored.work_items[0].actual, 0); assert.equal(restored.work_items[0].actual_minutes, 0);
});
