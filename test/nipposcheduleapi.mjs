// API-level calendar → report boundary tests. All identities/data are synthetic;
// no network, live auth, database, external calendar, AI, or notification calls.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const at = path => fileURLToPath(new URL("../" + path, import.meta.url));
const DAY = "2026-10-28";
const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "10000000-0000-4000-8000-000000000002";
const E1 = "20000000-0000-4000-8000-000000000001";
const E2 = "20000000-0000-4000-8000-000000000002";
const U1 = "30000000-0000-4000-8000-000000000001";
const U2 = "30000000-0000-4000-8000-000000000002";
const id = n => "40000000-0000-4000-8000-" + String(n).padStart(12, "0");
const clone = value => JSON.parse(JSON.stringify(value));
let signedIn = true, context, rows = {}, reads = [], writes = [], failures = {}, throws = {}, beforeUpdate = null;
const numeric = (key, value) => /_at$/.test(key) && typeof value === "string" ? Date.parse(value) : value;
function client(role) {
  return { from(table) {
    const filters = [], sorts = [];
    let columns = "*", limit = Infinity, one = false, op = "select", data;
    const q = {
      select(value = "*") { columns = value; return q; },
      eq(key, value) { filters.push(["eq", key, value]); return q; },
      is(key, value) { filters.push(["is", key, value]); return q; },
      neq(key, value) { filters.push(["neq", key, value]); return q; },
      in(key, value) { filters.push(["in", key, value]); return q; },
      lt(key, value) { filters.push(["lt", key, value]); return q; },
      lte(key, value) { filters.push(["lte", key, value]); return q; },
      gt(key, value) { filters.push(["gt", key, value]); return q; },
      gte(key, value) { filters.push(["gte", key, value]); return q; },
      or() { assert.notEqual(table, "gw_calendar_events", "calendar filter must not be silently ignored"); return q; },
      order(key, opts) { sorts.push([key, opts?.ascending !== false]); return q; },
      limit(value) { limit = value; return q; },
      single() { one = true; return q; }, maybeSingle() { one = true; return q; },
      insert(value) { assert.equal(role, "admin", "calendar userClient is read-only in this feature"); op = "insert"; data = clone(value); return q; },
      update(value) { assert.equal(role, "admin"); op = "update"; data = clone(value); return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        const trace = { table, role, columns, filters: clone(filters), op, limit };
        (op === "select" ? reads : writes).push(trace);
        if (throws[table]) throw Error("synthetic read failure");
        if (failures[table]) return { data: null, error: { code: "42501", message: "synthetic access failure" } };
        const matches = row => filters.every(([kind, key, expected]) => {
          const value = row[key], left = numeric(key, value), right = numeric(key, expected);
          if (kind === "eq") return value === expected;
          if (kind === "is") return expected === null ? value == null : value === expected;
          if (kind === "neq") return value !== expected;
          if (kind === "in") return expected.includes(value);
          if (kind === "lt") return left < right;
          if (kind === "lte") return left <= right;
          if (kind === "gt") return left > right;
          if (kind === "gte") return left >= right;
          throw Error("unsupported test filter");
        });
        if (op === "update" && beforeUpdate) beforeUpdate(trace);
        let result = (rows[table] || []).filter(matches);
        trace.affected = result.length;
        if (op === "insert") { result = [].concat(data).map((r, i) => ({ id: "saved-" + i, ...r })); (rows[table] ||= []).push(...result); }
        if (op === "update") for (const row of result) Object.assign(row, data);
        if (op === "select") {
          result = [...result].sort((a, b) => { for (const [key, asc] of sorts) { const diff = numeric(key, a[key]) < numeric(key, b[key]) ? -1 : numeric(key, a[key]) > numeric(key, b[key]) ? 1 : 0; if (diff) return asc ? diff : -diff; } return 0; }).slice(0, limit);
        }
        const projected = result.map(row => columns === "*" ? clone(row) : Object.fromEntries(columns.split(",").map(s => s.trim()).map(key => [key, clone(row[key] ?? null)])));
        return { data: one ? projected[0] || null : projected, error: null };
      }).then(resolve, reject); },
    };
    return q;
  } };
}
mock.module(at("lib/supabase.js"), { namedExports: { admin: () => client("admin"), userClient: () => client("user") } });
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async (_req, res) => {
  if (signedIn) return { id: U1 };
  res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return null;
} } });
mock.module(at("lib/gw.js"), { namedExports: { gwContext: async () => context } });
mock.module(at("lib/actions.js"), { namedExports: { closeItems: async () => 0, shapeItem: value => value } });
mock.module(at("lib/nippo-eval.js"), { namedExports: { isConfigured: () => false } });
mock.module(at("api/nippo/evaluate.js"), { namedExports: { shape: value => value } });
mock.module(at("lib/week-plan.js"), { namedExports: { aiConfigured: () => false, nextDayPlan: async () => { throw Error("AI must not run in API boundary tests"); } } });
mock.module(at("lib/schedule-gate.js"), { namedExports: { checkNextWorkSchedule: async () => ({ ready: true }) } });
const realNippo = await import(at("lib/nippo.js"));
mock.module(at("lib/nippo.js"), { namedExports: { ...realNippo,
  jstDate: (days = 0) => new Date(Date.parse(DAY + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10),
} });
const { default: handler } = await import(at("api/nippo/index.js"));
const { default: planHandler } = await import(at("api/nippo/plan.js"));
const event = (n, over = {}) => ({ id: id(n), tenant_id: T1, employee_id: E1, title: "予定 " + n,
  source: "self", visibility: "shared", category: "work", all_day: false,
  starts_at: DAY + "T09:00:00+09:00", ends_at: DAY + "T10:00:00+09:00",
  body: "PRIVATE_MEMO_DO_NOT_RETURN", gcal_event_id: "EXTERNAL_LINK_DO_NOT_RETURN", ...over });
function setup() {
  signedIn = true; reads = []; writes = []; failures = {}; throws = {}; beforeUpdate = null;
  context = { tenantId: T1, employee: { id: E1, display_name: "合成メンバー", status: "active" }, roles: [], isAdmin: false };
  rows = { gw_employees: [{ id: E1, tenant_id: T1, user_id: U1, display_name: "合成メンバー", status: "active" }],
    tc_nippo: [], gw_calendar_events: [event(1)], gw_action_items: [], gw_tasks: [], gw_focus_days: [],
    tc_thanks: [], tc_weekly_review: [], gw_daily_kpis: [], gw_nippo_ai_evals: [], tc_nippo_replies: [], gw_reminder_prefs: [] };
}
async function call(method, body, query = "", api = handler) {
  const response = { statusCode: 0, body: null, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await api({ method, url: "/api/nippo?date=" + DAY + query, body, headers: { authorization: "Bearer synthetic" } }, response);
  return response;
}
const startPlan = body => call("POST", { date: DAY, ...body }, "", planHandler);
const postBody = (items = [], extra = {}) => ({ date: DAY, consultNote: "合成データで保存境界を確認", workItems: items, ...extra });
const linked = (n = 1, extra = {}) => ({ task: "ブラウザ上の草案", schedule_event_id: id(n), actual: 8, actual_minutes: 75, ...extra });
const savedRow = () => rows.tc_nippo.find(row => row.user_id === U1);
const noWrites = () => assert.equal(writes.length, 0, "rejected read/reference must not write anything");
let pass = 0;
async function test(name, fn) { setup(); await fn(); pass++; console.log("ok " + name); }

await test("GET uses userClient and scopes tenant, owner, self, shared, work categories", async () => {
  rows.gw_calendar_events.push(event(2, { tenant_id: T2 }), event(3, { employee_id: E2 }),
    event(4, { source: "leave" }), event(5, { source: "google" }), event(6, { category: "private" }), event(7, { visibility: "private" }), event(8, { visibility: "busy" }));
  const r = await call("GET"); assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.scheduledWork.items.map(r => r.schedule_event_id), [id(1)]);
  const q = reads.filter(r => r.table === "gw_calendar_events"); assert.equal(q.length, 1); assert.equal(q[0].role, "user");
  for (const f of [["eq", "tenant_id", T1], ["eq", "employee_id", E1], ["eq", "source", "self"], ["eq", "visibility", "shared"]]) assert.ok(q[0].filters.some(x => JSON.stringify(x) === JSON.stringify(f)));
  assert.ok(q[0].filters.some(f => f[0] === "in" && f[1] === "category" && !f[2].includes("private")));
  noWrites();
});
await test("GET overlaps JST day including previous-day and all-day plans, excluding exact boundaries", async () => {
  rows.gw_calendar_events.push(event(2, { starts_at: "2026-10-27T14:00:00Z", ends_at: "2026-10-27T16:00:00Z" }),
    event(3, { starts_at: "2026-10-26T15:00:00Z", ends_at: "2026-10-28T14:59:00Z", all_day: true }),
    event(4, { starts_at: "2026-10-27T14:00:00Z", ends_at: "2026-10-27T15:00:00Z" }),
    event(5, { starts_at: "2026-10-28T15:00:00Z", ends_at: "2026-10-28T16:00:00Z" }));
  const r = await call("GET"); assert.equal(r.body.scheduledWork.status, "available");
  assert.deepEqual(r.body.scheduledWork.items.map(r => r.schedule_event_id).sort(), [id(1), id(2), id(3)].sort());
  assert.equal(r.body.scheduledWork.items.find(r => r.schedule_event_id === id(3)).planned_all_day, true);
});
await test("GET returns only plan snapshots, no memo, external IDs, duration actuals or invented counts", async () => {
  const r = await call("GET"); const item = r.body.scheduledWork.items[0];
  assert.deepEqual(Object.keys(item).sort(), ["task", "schedule_event_id", "planned_starts_at", "planned_ends_at", "planned_all_day", "target", "unit"].sort());
  assert.equal(item.target, null); assert.equal(item.actual_minutes, undefined); assert.equal(item.actual, undefined);
  assert.deepEqual(r.body.systemWork, { status: "unconnected", count: null });
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE_MEMO_DO_NOT_RETURN|EXTERNAL_LINK_DO_NOT_RETURN/);
  assert.ok(reads.filter(r => r.table === "gw_calendar_events").every(q => !/\bbody\b|gcal|employee_id|tenant_id/.test(q.columns)));
});
await test("GET auth/membership/employee failures return before calendar reads", async () => {
  signedIn = false; assert.equal((await call("GET")).statusCode, 401);
  signedIn = true; context.tenantId = null; assert.equal((await call("GET")).statusCode, 403);
  context.tenantId = T1; context.employee = null; assert.equal((await call("GET")).statusCode, 403);
  assert.equal(reads.length, 0); noWrites();
});
await test("GET denied or thrown calendar read is unavailable, not available-zero", async () => {
  for (const mode of ["error", "throw"]) {
    failures = mode === "error" ? { gw_calendar_events: true } : {}; throws = mode === "throw" ? { gw_calendar_events: true } : {};
    const r = await call("GET"); assert.equal(r.statusCode, 200); assert.equal(r.body.scheduledWork.status, "unavailable");
    assert.deepEqual(r.body.systemWork, { status: "unconnected", count: null });
  }
  noWrites();
});
await test("GET empty success differs from failure; >100 rows is explicitly incomplete", async () => {
  rows.gw_calendar_events = []; let r = await call("GET"); assert.deepEqual(r.body.scheduledWork, { status: "available", items: [], quantityAvailable: true });
  rows.gw_calendar_events = Array.from({ length: 101 }, (_, i) => event(i + 1)); r = await call("GET");
  assert.equal(r.body.scheduledWork.status, "incomplete"); assert.equal(r.body.scheduledWork.items.length, 100);
});
await test("calendar quantity reaches the report target, never the measured count", async () => {
  rows.gw_calendar_events[0].planned_quantity = 10; rows.gw_calendar_events[0].planned_quantity_unit = "件";
  let r = await call("GET"); const plan = r.body.scheduledWork.items[0];
  assert.equal(plan.target, 10); assert.equal(plan.unit, "件"); assert.equal(plan.actual, undefined);
  r = await call("POST", postBody([linked(1, { target: 999, unit: "社", actual: 8, actual_minutes: 75 })]));
  assert.equal(r.statusCode, 200); const saved = savedRow().work_items[0];
  assert.equal(saved.target, 10); assert.equal(saved.unit, "件"); assert.equal(saved.actual, 8); assert.equal(saved.actual_minutes, 75);
  rows.gw_calendar_events[0].planned_quantity = 20;
  r = await call("POST", postBody([linked(1, { target: 20, actual: 9 })]));
  assert.equal(r.statusCode, 200); assert.equal(savedRow().work_items[0].target, 10); assert.equal(savedRow().work_items[0].actual, 9);
});
await test("explicit planned zero is kept distinct from an absent target", async () => {
  rows.gw_calendar_events[0].planned_quantity = 0;
  let r = await call("GET"); assert.equal(r.body.scheduledWork.items[0].target, 0);
  rows.gw_calendar_events[0].planned_quantity = null;
  r = await call("GET"); assert.equal(r.body.scheduledWork.items[0].target, null);
});
await test("POST binds new snapshot from authorized calendar and strips client-supplied system evidence", async () => {
  const r = await call("POST", postBody([linked(1, { task: "forged title", target: 999, unit: "件", planned_starts_at: "1900-01-01", planned_ends_at: "2099-01-01", planned_all_day: true,
    task_id: id(90), action_id: id(91), system_count: 888, system_evidence: [{ verified: true }], actor_verified: true, source: "system" })],
    { user_id: U2, employee_id: E2, tenant_id: T2, systemWork: { status: "verified", count: 888 } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const report = savedRow(), item = report.work_items[0]; assert.equal(report.user_id, U1);
  assert.equal(item.task, "予定 1"); assert.equal(item.planned_starts_at, "2026-10-28T00:00:00.000Z");
  assert.equal(item.planned_ends_at, "2026-10-28T01:00:00.000Z"); assert.equal(item.planned_all_day, false);
  assert.equal(item.target, null); assert.equal(item.unit, "件", "only the self-reported actual unit survives"); assert.equal(item.actual, 8); assert.equal(item.actual_minutes, 75);
  for (const key of ["task_id", "action_id", "system_count", "system_evidence", "actor_verified", "source"]) assert.equal(item[key], undefined);
  assert.equal(report.systemWork, undefined); assert.ok(writes.every(w => w.table === "tc_nippo"));
});
await test("POST zero actual remains zero, unknown actual is not replaced with planned duration", async () => {
  let r = await call("POST", postBody([linked(1, { actual: 0, actual_minutes: 0 })])); assert.equal(r.statusCode, 200);
  assert.equal(savedRow().work_items[0].actual, 0); assert.equal(savedRow().work_items[0].actual_minutes, 0);
  r = await call("POST", postBody([linked(1, { actual: null, actual_minutes: "" })])); assert.equal(r.statusCode, 200);
  assert.equal(savedRow().work_items[0].actual, null); assert.equal(savedRow().work_items[0].actual_minutes, null);
});
await test("POST forged foreign-owner/foreign-tenant/private/out-of-day IDs are rejected without writes", async () => {
  rows.gw_calendar_events.push(event(2, { employee_id: E2 }), event(3, { tenant_id: T2 }), event(4, { category: "private" }), event(5, { visibility: "private" }),
    event(6, { starts_at: "2026-10-27T09:00:00+09:00", ends_at: "2026-10-27T10:00:00+09:00" }));
  for (const n of [2, 3, 4, 5, 6, 99]) { const r = await call("POST", postBody([linked(n)])); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "schedule_reference_not_found"); }
  noWrites(); assert.deepEqual(rows.tc_nippo, []);
});
await test("POST malformed, duplicate and silently truncated reference lists are rejected", async () => {
  let r = await call("POST", postBody([linked(1, { schedule_event_id: "not-a-uuid" })])); assert.equal(r.statusCode, 400); assert.equal(r.body.error, "invalid_schedule_reference");
  r = await call("POST", postBody([linked(1), linked(1)])); assert.equal(r.statusCode, 400);
  r = await call("POST", postBody(Array.from({ length: 11 }, (_, i) => linked(i + 1)))); assert.equal(r.statusCode, 400); noWrites();
});
await test("POST unavailable source or saved-report read fails closed without creating a report", async () => {
  failures.gw_calendar_events = true; let r = await call("POST", postBody([linked(1)])); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "schedule_reference_unavailable");
  failures = { tc_nippo: true }; r = await call("POST", postBody([linked(1)])); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "report_read_unavailable"); noWrites();
});
await test("POST keeps saved snapshot even if source moved/deleted; only self-reported measurements change", async () => {
  const first = await call("POST", postBody([linked(1)])); assert.equal(first.statusCode, 200);
  savedRow().work_items[0].target = 10; savedRow().work_items[0].unit = "件";
  const original = clone(savedRow().work_items[0]); rows.gw_calendar_events = [];
  const r = await call("POST", postBody([linked(1, { task: "replacement", planned_starts_at: "2099", planned_ends_at: "2100", planned_all_day: true, target: 999, unit: "社", actual: 9, actual_minutes: 80 })]));
  assert.equal(r.statusCode, 200); const item = savedRow().work_items[0];
  for (const key of ["task", "target", "unit", "schedule_event_id", "planned_starts_at", "planned_ends_at", "planned_all_day"]) assert.deepEqual(item[key], original[key], key);
  assert.equal(item.actual, 9); assert.equal(item.actual_minutes, 80); assert.equal(rows.tc_nippo.length, 1);
});
await test("POST old client omission retains saved schedule snapshot and actuals without calendar read", async () => {
  const first = await call("POST", postBody([linked(1)])); assert.equal(first.statusCode, 200); const original = clone(savedRow().work_items[0]);
  failures.gw_calendar_events = true; reads = [];
  const r = await call("POST", postBody([{ task: "既存形式の別作業", result: "確認済み" }])); assert.equal(r.statusCode, 200);
  assert.deepEqual(savedRow().work_items.find(w => w.schedule_event_id === id(1)), original);
  assert.equal(reads.filter(q => q.table === "gw_calendar_events").length, 0);
});
await test("POST auth/membership/employee failures do not read or write", async () => {
  signedIn = false; assert.equal((await call("POST", postBody([linked(1)]))).statusCode, 401);
  signedIn = true; context.tenantId = null; assert.equal((await call("POST", postBody([linked(1)]))).statusCode, 403);
  context.tenantId = T1; context.employee = null; assert.equal((await call("POST", postBody([linked(1)]))).statusCode, 403);
  assert.equal(reads.length, 0); noWrites();
});
await test("POST minimal measurements alone count as report content without claiming completion", async () => {
  const r = await call("POST", { date: DAY, workItems: [linked(1)] }); assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const item = savedRow().work_items[0]; assert.equal(item.actual, 8); assert.equal(item.actual_minutes, 75);
  assert.equal(item.done, false); assert.equal(item.result, ""); assert.equal(item.undone_reason, "");
});
await test("POST old-client omission retains only allowed saved fields, not stale external evidence", async () => {
  const first = await call("POST", postBody([linked(1)])); assert.equal(first.statusCode, 200);
  const saved = savedRow().work_items[0]; Object.assign(saved, { system_count: 123, system_evidence: [{ verified: true }], actor_verified: true, task_id: id(90), action_id: id(91), measurement_note: "既存の本人補足" });
  const r = await call("POST", postBody()); assert.equal(r.statusCode, 200); const item = savedRow().work_items[0];
  for (const key of ["system_count", "system_evidence", "actor_verified", "task_id", "action_id"]) assert.equal(item[key], undefined, key);
  assert.equal(item.measurement_note, "既存の本人補足"); assert.equal(item.actual, 8); assert.equal(item.actual_minutes, 75);
});
await test("POST explicit zero-only measurements save without auto-completing or scoring the plan", async () => {
  const r = await call("POST", { date: DAY, workItems: [linked(1, { actual: 0, actual_minutes: 0 })] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); const report = savedRow(), item = report.work_items[0];
  assert.equal(item.actual, 0); assert.equal(item.actual_minutes, 0); assert.equal(item.done, false); assert.equal(item.result, "");
  for (const key of ["quantity", "results", "action"]) assert.equal(report.daily_flags[key], "-", key);
  assert.equal(realNippo.isDone(item), false); assert.equal(rows.gw_nippo_ai_evals.length, 0);
});
await test("POST negative, nonfinite, boolean and over-limit measurements are rejected without writes", async () => {
  for (const patch of [{ actual_minutes: -1 }, { actual_minutes: 1441 }, { actual_minutes: "NaN" }, { actual_minutes: "Infinity" }, { actual_minutes: false },
    { actual: -1 }, { actual: 1000000001 }, { actual: "NaN" }, { actual: true }]) {
    const r = await call("POST", postBody([linked(1, patch)])); assert.equal(r.statusCode, 400, JSON.stringify(patch));
    assert.equal(r.body.error, "invalid_report_measurement"); noWrites();
  }
});
await test("self-reported time/count do not become AI input completion receipts", async () => {
  const r = await call("POST", { date: DAY, workItems: [linked(1)] }); assert.equal(r.statusCode, 200);
  const report = savedRow();
  // Evaluate only the actual pure metrics function, without loading AI clients,
  // reading model/key configuration, or invoking an AI endpoint.
  const text = readFileSync(at("lib/nippo-eval.js"), "utf8");
  const metricsSource = text.slice(text.indexOf("export function systemMetrics("), text.indexOf("// 2) AI へ渡す文章"));
  const vm = { isDone: realNippo.isDone, report };
  runInNewContext(metricsSource.replace("export function", "function") + "\nmetrics = systemMetrics(report);", vm);
  assert.equal(vm.metrics.resultCount, 0); assert.equal(vm.metrics.undoneCount, 0);
  assert.equal(vm.metrics.kgiActual, null); assert.equal(vm.metrics.kgiRate, null);
  for (const key of ["quantity", "results", "action"]) assert.equal(report.daily_flags[key], "-");
});
const morningBody = () => ({ kind: "morning", date: DAY, topPriority: "合成の朝計画", actions: [{ task: "朝の作業" }] });
function seedMorning(updated = "2026-10-28T00:01:00.000Z") {
  rows.tc_nippo = [{ id: "existing-report", user_id: U1, user_name: "合成メンバー", work_date: DAY,
    morning_at: "2026-10-28T00:00:00.000Z", submitted_at: null, updated_at: updated, work_items: [{ task: "旧朝計画" }] }];
}
function seedPlan() {
  rows.gw_day_plans = [{ id: "day-plan", employee_id: E1, tenant_id: T1, work_date: DAY,
    top_priority: "行動案の優先作業", actions: [{ task: "行動案の作業", target: 10, unit: "件" }], started_at: null }];
}
function raceToSavedSnapshot(trace) {
  if (trace.table !== "tc_nippo") return;
  beforeUpdate = null;
  Object.assign(savedRow(), { updated_at: "2026-10-28T10:00:00.999Z", submitted_at: "2026-10-28T10:00:00.999Z",
    work_items: [{ task: "先に保存された予定", schedule_event_id: id(1), planned_starts_at: "2026-10-28T00:00:00.000Z",
      planned_ends_at: "2026-10-28T01:00:00.000Z", planned_all_day: false, target: null, unit: "件", actual: 8, actual_minutes: 75, done: false, result: "" }] });
}
function assertRaceRetained(response) {
  assert.equal(response.statusCode, 409, JSON.stringify(response.body)); assert.equal(response.body.error, "report_changed");
  const row = savedRow(); assert.equal(row.updated_at, "2026-10-28T10:00:00.999Z");
  assert.equal(row.work_items[0].schedule_event_id, id(1)); assert.equal(row.work_items[0].actual, 8); assert.equal(row.work_items[0].actual_minutes, 75);
  assert.ok(writes.filter(w => w.table === "tc_nippo").every(w => w.affected === 0), "stale update affects no rows");
  assert.ok(writes.every(w => w.table === "tc_nippo"), "conflict must stop all post-save effects");
}
await test("POST old-client submit racing a newer schedule snapshot returns 409 and retains newest actuals", async () => {
  seedMorning(); beforeUpdate = raceToSavedSnapshot;
  assertRaceRetained(await call("POST", postBody([{ task: "古い画面の作業", result: "完了" }])));
  const q = writes.find(w => w.table === "tc_nippo");
  assert.ok(q.filters.some(f => f[0] === "eq" && f[1] === "updated_at" && f[2] === "2026-10-28T00:01:00.000Z"));
  assert.ok(q.filters.some(f => f[0] === "eq" && f[1] === "user_id" && f[2] === U1));
});
await test("CAS supports a legacy null timestamp without skipping the version condition", async () => {
  seedMorning(null); let r = await call("POST", postBody([{ task: "本人の更新", result: "確認" }]));
  assert.equal(r.statusCode, 200); assert.ok(writes.find(w => w.table === "tc_nippo").filters.some(f => f[0] === "is" && f[1] === "updated_at" && f[2] === null));
  seedMorning(null); writes = []; beforeUpdate = raceToSavedSnapshot;
  r = await call("POST", postBody([{ task: "旧クライアント", result: "確認" }])); assertRaceRetained(r);
});
await test("morning update uses CAS, preserves first morning timestamp and rejects a newer saved snapshot", async () => {
  seedMorning(); const firstMorning = savedRow().morning_at;
  let r = await call("POST", morningBody()); assert.equal(r.statusCode, 200); assert.equal(savedRow().morning_at, firstMorning);
  seedMorning(); writes = []; beforeUpdate = raceToSavedSnapshot;
  r = await call("POST", morningBody()); assertRaceRetained(r);
});
await test("morning cannot overwrite submitted or schedule-linked report; read error is 503", async () => {
  seedMorning(); savedRow().submitted_at = "2026-10-28T01:00:00Z";
  assert.equal((await call("POST", morningBody())).statusCode, 409); noWrites();
  seedMorning(); savedRow().work_items = [linked(1)];
  assert.equal((await call("POST", morningBody())).statusCode, 409); noWrites();
  seedMorning(); failures.tc_nippo = true;
  const r = await call("POST", morningBody()); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "report_read_unavailable"); noWrites();
});
await test("plan.start creates a morning plan and updates unchanged existing rows with CAS", async () => {
  seedPlan(); let r = await startPlan(); assert.equal(r.statusCode, 200); assert.equal(savedRow().work_items[0].task, "行動案の作業");
  assert.ok(rows.gw_day_plans[0].started_at);
  seedMorning(); seedPlan(); writes = []; const original = savedRow().morning_at;
  r = await startPlan(); assert.equal(r.statusCode, 200); assert.equal(savedRow().morning_at, original);
  assert.ok(writes.find(w => w.table === "tc_nippo").filters.some(f => f[0] === "eq" && f[1] === "updated_at"));
});
await test("plan.start refuses submitted and schedule-linked report snapshots without side effects", async () => {
  seedPlan(); seedMorning(); savedRow().submitted_at = "2026-10-28T01:00:00Z";
  let r = await startPlan(); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "already_reported"); noWrites();
  seedMorning(); savedRow().work_items = [linked(1)];
  r = await startPlan(); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "already_reported"); noWrites();
  assert.equal(rows.gw_day_plans[0].started_at, null);
});
await test("plan.start report-read failure is 503 rather than creating a replacement", async () => {
  seedPlan(); seedMorning(); failures.tc_nippo = true;
  const r = await startPlan(); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "report_read_unavailable"); noWrites();
});
await test("plan.start interleaved after night save returns 409 and never replaces snapshot or starts plan", async () => {
  seedPlan(); seedMorning(); beforeUpdate = raceToSavedSnapshot;
  assertRaceRetained(await startPlan()); assert.equal(rows.gw_day_plans[0].started_at, null);
});
await test("CAS advances the version by at least 1 ms even when the previous timestamp is ahead of the clock", async () => {
  const prior = "2099-01-01T00:00:00.000Z", expected = "2099-01-01T00:00:00.001Z";
  for (const mode of ["submit", "morning", "plan.start"]) {
    setup(); seedMorning(prior); seedPlan();
    const r = mode === "plan.start" ? await startPlan() : await call("POST", mode === "morning" ? morningBody() : postBody([linked(1)], { reportVersion: prior }));
    assert.equal(r.statusCode, 200, mode + ": " + JSON.stringify(r.body));
    assert.equal(savedRow().updated_at, expected, mode);
    assert.ok(writes.find(w => w.table === "tc_nippo").filters.some(f => f[0] === "eq" && f[1] === "updated_at" && f[2] === prior), mode);
  }
});
await test("POST stale reportVersion refuses an old draft before calendar reads or any writes", async () => {
  seedMorning(); const original = clone(savedRow());
  const r = await call("POST", postBody([linked(1)], { reportVersion: "2026-10-28T00:00:00.000Z" }));
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "report_changed");
  assert.deepEqual(savedRow(), original); noWrites();
  assert.equal(reads.filter(q => q.table === "gw_calendar_events").length, 0);
});
await test("POST matching reportVersion saves the actuals and advances the report version", async () => {
  seedMorning(); const version = savedRow().updated_at;
  const r = await call("POST", postBody([linked(1, { actual: 4, actual_minutes: 30 })], { reportVersion: version }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(savedRow().work_items[0].actual, 4); assert.equal(savedRow().work_items[0].actual_minutes, 30);
  assert.ok(Date.parse(savedRow().updated_at) > Date.parse(version));
});
await test("POST null reportVersion permits an initial report but cannot replace a subsequently saved report", async () => {
  let r = await call("POST", postBody([linked(1)], { reportVersion: null }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); const original = clone(savedRow());
  assert.ok(original.updated_at); writes = []; reads = [];
  r = await call("POST", postBody([linked(1, { actual: 99, actual_minutes: 999 })], { reportVersion: null }));
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "report_changed");
  assert.deepEqual(savedRow(), original); assert.equal(rows.tc_nippo.length, 1); noWrites();
  assert.equal(reads.filter(q => q.table === "gw_calendar_events").length, 0);
});
await test("POST long non-array workItems does not throw or invent schedule references", async () => {
  const r = await call("POST", postBody("not-an-array-schedule-input"));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(savedRow().work_items, null);
  assert.equal(reads.filter(q => q.table === "gw_calendar_events").length, 0);
});
console.log(`${pass} nippo schedule API checks passed (mock auth/DB; no real RLS or browser verification)`);
