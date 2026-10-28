// Synthetic auth/DB only. Never uses a live calendar, database, Google or notifications.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCalendarQuantity, readCalendarQuantity, isCalendarQuantityMissing } from "../lib/calendar-quantity.js";

const at = file => fileURLToPath(new URL("../" + file, import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));
const missing = { code: "42703", message: "column gw_calendar_events.planned_quantity does not exist" };
let rows, reads, writes, schema, readError, writeError, signedIn, ctx, externalWrites;
const userId = "30000000-0000-4000-8000-000000000001";
const tenantId = "10000000-0000-4000-8000-000000000001";
const employeeId = "20000000-0000-4000-8000-000000000001";
function client() {
  return { from(table) {
    let columns = "*", op = "select", payload, one = false, limit = Infinity;
    const filters = [];
    const q = {
      select(value = "*") { columns = value; return q; },
      eq(key, value) { filters.push(["eq", key, value]); return q; },
      in(key, value) { filters.push(["in", key, value]); return q; },
      gte(key, value) { filters.push(["gte", key, value]); return q; },
      lte(key, value) { filters.push(["lte", key, value]); return q; },
      lt(key, value) { filters.push(["lt", key, value]); return q; },
      order() { return q; }, limit(value) { limit = value; return q; },
      single() { one = true; return q; }, maybeSingle() { one = true; return q; },
      insert(value) { op = "insert"; payload = clone(value); return q; },
      update(value) { op = "update"; payload = clone(value); return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        const trace = { table, op, columns, filters: clone(filters), payload };
        (op === "select" ? reads : writes).push(trace);
        if (table !== "gw_calendar_events") { assert.equal(op, "select"); return { data: [], error: null }; }
        if (op === "select" && readError) return { data: null, error: readError };
        if (op !== "select" && writeError) return { data: null, error: writeError };
        if (!schema && (columns.includes("planned_quantity") || JSON.stringify(payload || {}).includes("planned_quantity"))) return { data: null, error: missing };
        const match = row => filters.every(([kind, key, value]) => {
          if (kind === "eq") return row[key] === value;
          if (kind === "in") return value.includes(row[key]);
          const a = key.endsWith("_at") ? Date.parse(row[key]) : row[key];
          const b = key.endsWith("_at") ? Date.parse(value) : value;
          return kind === "lt" ? a < b : kind === "gte" ? a >= b : a <= b;
        });
        let result = rows.filter(match);
        if (op === "insert") {
          result = [].concat(payload).map((r, i) => ({ id: "created-" + i, source: "self", ...r })); rows.push(...result);
        } else if (op === "update") for (const row of result) Object.assign(row, payload);
        result = result.slice(0, limit).map(row => columns === "*" ? clone(row)
          : Object.fromEntries(columns.split(",").map(s => s.trim()).map(key => [key, row[key] ?? null])));
        return { data: one ? result[0] || null : result, error: null };
      }).then(resolve, reject); },
    };
    return q;
  } };
}
mock.module(at("lib/supabase.js"), { namedExports: { userClient: () => client(), admin: () => { throw Error("service role must not be used"); } } });
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async (_req, res) => {
  if (signedIn) return { id: userId };
  res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return null;
} } });
mock.module(at("lib/gw.js"), { namedExports: { gwContext: async () => ctx } });
mock.module(at("lib/google-link.js"), { namedExports: {
  fetchExternalEvents: async () => ({ events: [] }), linkStatus: async () => ({ connected: false }),
  pushEvent: async () => { externalWrites++; throw Error("no external writes"); },
  unpushEvent: async () => { externalWrites++; throw Error("no external writes"); },
} });
const { default: handler } = await import(at("api/schedule/index.js"));
const event = (extra = {}) => ({ title: "合成予定", startsAt: "2026-10-28T09:00:00+09:00", endsAt: "2026-10-28T10:00:00+09:00", category: "work", ...extra });
function setup() {
  schema = true; readError = writeError = null; signedIn = true; externalWrites = 0; reads = []; writes = [];
  ctx = { tenantId, employee: { id: employeeId } };
  rows = [{ id: "existing", tenant_id: tenantId, employee_id: employeeId, title: "元予定", category: "work", source: "self", visibility: "shared",
    starts_at: "2026-10-28T00:00:00Z", ends_at: "2026-10-28T01:00:00Z", planned_quantity: 8, planned_quantity_unit: "件" }];
}
async function call(method, body) {
  const res = { statusCode: 0, body: null, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await handler({ method, url: "/api/schedule?from=2026-10-28T00:00:00%2B09:00&to=2026-10-29T00:00:00%2B09:00", headers: {}, body }, res);
  return res;
}
let pass = 0;
async function test(name, fn) { setup(); await fn(); assert.equal(externalWrites, 0); pass++; console.log("ok " + name); }

await test("quantity normalization preserves omission and explicit zero; clear removes unit", () => {
  assert.deepEqual(normalizeCalendarQuantity({}).value, {});
  assert.deepEqual(normalizeCalendarQuantity({ plannedQuantity: "0", plannedQuantityUnit: " 件 " }).value, { planned_quantity: 0, planned_quantity_unit: "件" });
  assert.deepEqual(normalizeCalendarQuantity({ plannedQuantity: " ", plannedQuantityUnit: "件" }).value, { planned_quantity: null, planned_quantity_unit: null });
  assert.deepEqual(normalizeCalendarQuantity({ plannedQuantity: "1.25" }).value, { planned_quantity: 1.25 });
});
await test("invalid quantities and overlong units fail normalization", () => {
  for (const value of [-1, 1e9 + 1, Infinity, NaN, true, false, [], {}, "NaN", "Infinity", "0x10"]) assert.equal(normalizeCalendarQuantity({ plannedQuantity: value }).error, "invalid_planned_quantity");
  for (const value of ["12345678901", 1, true, []]) assert.equal(normalizeCalendarQuantity({ plannedQuantityUnit: value }).error, "invalid_planned_quantity_unit");
  assert.equal(normalizeCalendarQuantity({ plannedQuantity: 1e9, plannedQuantityUnit: "1234567890" }).error, undefined);
});
await test("optional schema fallback is narrowly classified", async () => {
  for (const code of ["42703", "PGRST204"]) assert.equal(isCalendarQuantityMissing({ code, message: "planned_quantity_unit" }), true);
  for (const error of [{ code: "42501", message: "planned_quantity" }, { code: "42703", message: "column title missing" }, { code: "42P01", message: "table missing" }]) {
    const calls = []; const result = await readCalendarQuantity(columns => { calls.push(columns); return { data: null, error }; }, "id");
    assert.equal(calls.length, 1); assert.equal(result.error, error);
  }
  const result = await readCalendarQuantity(() => { throw Error("network failure"); }, "id");
  assert.ok(result.error); assert.equal(result.quantityAvailable, false);
});
await test("GET returns quantity zero/null without expanding ownership scope", async () => {
  rows[0].planned_quantity = 0;
  rows.push({ ...rows[0], id: "other-owner", employee_id: "another" }, { ...rows[0], id: "other-tenant", tenant_id: "another" });
  const r = await call("GET"); assert.equal(r.statusCode, 200); assert.equal(r.body.quantityAvailable, true);
  assert.equal(r.body.eventsStatus, "available"); assert.equal(r.body.events.length, 1); assert.equal(r.body.events[0].planned_quantity, 0);
  assert.equal(writes.length, 0);
});
await test("GET old schema returns base rows and explicit quantityAvailable false", async () => {
  schema = false; const r = await call("GET"); assert.equal(r.statusCode, 200); assert.equal(r.body.quantityAvailable, false);
  assert.equal(r.body.eventsStatus, "available"); assert.equal(r.body.events[0].title, "元予定");
  assert.equal(r.body.events[0].planned_quantity, undefined);
  assert.equal(reads.filter(r => r.table === "gw_calendar_events").length, 2);
});
await test("GET permission/other-column failure is unavailable, not available-zero", async () => {
  for (const error of [{ code: "42501", message: "denied" }, { code: "42703", message: "column title missing" }]) {
    reads = []; readError = error; const r = await call("GET");
    assert.equal(r.body.events, null); assert.equal(r.body.eventsStatus, "unavailable");
    assert.equal(reads.filter(r => r.table === "gw_calendar_events").length, 1);
  }
});
await test("POST saves only allowed planned number fields with server ownership", async () => {
  const r = await call("POST", event({ plannedQuantity: 8, plannedQuantityUnit: "件", employee_id: "another", tenant_id: "another", planned_quantity: 99, verified: true, system_count: 99 }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.quantityAvailable, true);
  const row = rows.at(-1); assert.equal(row.planned_quantity, 8); assert.equal(row.planned_quantity_unit, "件");
  assert.equal(row.employee_id, employeeId); assert.equal(row.tenant_id, tenantId); assert.equal(row.verified, undefined); assert.equal(row.system_count, undefined);
  assert.equal(writes.length, 1);
});
await test("PATCH legacy omission retains quantity; clear sets quantity and unit null", async () => {
  let r = await call("PATCH", { id: "existing", title: "変更" }); assert.equal(r.statusCode, 200);
  assert.equal(rows[0].planned_quantity, 8); assert.equal(rows[0].planned_quantity_unit, "件");
  r = await call("PATCH", { id: "existing", plannedQuantity: "" }); assert.equal(r.statusCode, 200);
  assert.equal(rows[0].planned_quantity, null); assert.equal(rows[0].planned_quantity_unit, null);
});
await test("PATCH quantity zero and unit-only updates preserve omitted companions", async () => {
  let r = await call("PATCH", { id: "existing", plannedQuantity: 0 }); assert.equal(r.statusCode, 200);
  assert.equal(rows[0].planned_quantity, 0); assert.equal(rows[0].planned_quantity_unit, "件");
  r = await call("PATCH", { id: "existing", plannedQuantityUnit: "社" }); assert.equal(r.statusCode, 200);
  assert.equal(rows[0].planned_quantity, 0); assert.equal(rows[0].planned_quantity_unit, "社");
});
await test("quantity-only PATCH never pushes an already linked event to Google", async () => {
  rows[0].gcal_event_id = "synthetic-external-id";
  const r = await call("PATCH", { id: "existing", plannedQuantity: 9, plannedQuantityUnit: "件" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.google, null);
  assert.equal(rows[0].planned_quantity, 9); assert.equal(rows[0].gcal_event_id, "synthetic-external-id");
});
await test("PATCH cannot modify another employee or tenant; auto-generated events refuse", async () => {
  rows.push({ ...rows[0], id: "other-owner", employee_id: "another" }, { ...rows[0], id: "other-tenant", tenant_id: "another" }, { ...rows[0], id: "auto", source: "leave" });
  for (const id of ["other-owner", "other-tenant"]) assert.equal((await call("PATCH", { id, plannedQuantity: 9 })).statusCode, 404);
  assert.equal((await call("PATCH", { id: "auto", plannedQuantity: 9 })).statusCode, 409);
  assert.ok(rows.every(row => row.planned_quantity === 8));
});
await test("batch quantities are validated before a single atomic insert", async () => {
  const r = await call("POST", { action: "batch_create", events: [event({ title: "A", plannedQuantity: 0, plannedQuantityUnit: "件" }), event({ title: "B", plannedQuantity: 2.5, plannedQuantityUnit: "時間" })] });
  assert.equal(r.statusCode, 200); assert.equal(r.body.events.length, 2); assert.equal(r.body.events[0].planned_quantity, 0);
  assert.equal(writes.length, 1); assert.ok(Array.isArray(writes[0].payload));
});
await test("one invalid number rejects all batch rows before reads or writes", async () => {
  const r = await call("POST", { action: "batch_create", events: [event({ title: "A", plannedQuantity: 8 }), event({ title: "B", plannedQuantity: -1 })] });
  assert.equal(r.statusCode, 400); assert.equal(reads.length, 0); assert.equal(writes.length, 0);
});
await test("schema missing blocks nonempty numbers including zero for POST/PATCH/batch", async () => {
  schema = false;
  for (const [method, body] of [["POST", event({ plannedQuantity: 0 })], ["PATCH", { id: "existing", plannedQuantity: 8 }],
    ["POST", { action: "batch_create", events: [event({ plannedQuantity: 8 })] }], ["PATCH", { id: "existing", plannedQuantityUnit: "件" }]]) {
    const r = await call(method, body); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "calendar_quantity_unavailable");
    assert.equal(r.body.quantityAvailable, false); assert.equal(writes.length, 0);
  }
});
await test("schema missing permits legacy no-number create and explicit clear without invented persistence", async () => {
  schema = false;
  for (const body of [event(), event({ plannedQuantity: "", plannedQuantityUnit: "" })]) {
    const r = await call("POST", body); assert.equal(r.statusCode, 200); assert.equal(r.body.quantityAvailable, false);
    assert.equal(r.body.event.planned_quantity, undefined); assert.ok(!Object.hasOwn(writes.at(-1).payload, "planned_quantity"));
  }
});
await test("capability permission failure never falls back or writes", async () => {
  readError = { code: "42501", message: "denied" };
  const r = await call("POST", event({ plannedQuantity: 8 })); assert.equal(r.statusCode, 503); assert.equal(r.body.error, "calendar_read_unavailable");
  assert.equal(reads.length, 1); assert.equal(writes.length, 0);
});
await test("schema race after capability check never retries a mutating request", async () => {
  writeError = missing;
  const r = await call("POST", event({ plannedQuantity: 8 })); assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "calendar_quantity_unavailable"); assert.equal(writes.length, 1); assert.equal(rows.length, 1);
});
await test("authentication/membership failures never query or write", async () => {
  signedIn = false; assert.equal((await call("POST", event())).statusCode, 401);
  signedIn = true; ctx.tenantId = null; assert.equal((await call("POST", event())).statusCode, 403);
  ctx.tenantId = tenantId; ctx.employee = null; assert.equal((await call("POST", event())).statusCode, 403);
  assert.equal(reads.length, 0); assert.equal(writes.length, 0);
});
await test("operator DDL stops before any ALTER when quantity columns or named constraints already exist", async () => {
  const sql=readFileSync(at("db/proposal_calendar_plan_quantity.sql"),"utf8");
  const guard=sql.slice(0,sql.indexOf("alter table"));
  assert.match(guard,/information_schema.columns/);assert.match(guard,/pg_constraint/);
  assert.match(guard,/raise exception/);assert.match(guard,/planned_quantity_unit/);
  assert.match(guard,/gw_calendar_events_planned_quantity_range/);
  assert.match(guard,/gw_calendar_events_planned_quantity_unit_length/);
  assert.doesNotMatch(sql,/add column if not exists/i);
});
console.log(`${pass} calendar quantity API/helper checks passed (mock-only, SQL not applied)`);
