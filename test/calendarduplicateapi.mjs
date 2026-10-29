// The duplication UI uses the existing POST. Verify that its server boundary
// ignores source identity and external links with in-memory dependencies only.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const at = path => new URL("../" + path, import.meta.url).pathname;
let user = { id: "user" }, ctx = { tenantId: "current-tenant", employee: { id: "current-member" } };
let inserted = [], googleCalls = 0, dbError = null, readError = null, schema = true, schemaRace = false;
mock.module(at("lib/http.js"), { namedExports: {
  json: (res, status, body) => Object.assign(res, { status, body }), readJson: async req => req.body,
  methodNotAllowed: res => { res.status = 405; },
} });
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async () => user } });
mock.module(at("lib/gw.js"), { namedExports: { gwContext: async () => ctx } });
mock.module(at("lib/supabase.js"), { namedExports: {
  admin: () => { assert.fail("duplication must not use service-role client"); },
  userClient: () => ({ from(table) {
    assert.equal(table, "gw_calendar_events");
    let columns = "", row = null;
    const query = { insert(value) { row = value; return query; }, select(value) { columns = value; return query; },
      eq() { return query; }, limit() { return query; }, single() { return query; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        const missing = { code: "42703", message: "column planned_quantity does not exist" };
        if (!row) return { data: [], error: readError || (!schema && columns.includes("planned_quantity") ? missing : null) };
        inserted.push(row);
        const error = dbError || (schemaRace ? missing : null);
        return { data: error ? null : { id: "new-id", ...row }, error };
      }).then(resolve, reject) } };
    return query;
  } }),
} });
mock.module(at("lib/google-link.js"), { namedExports: {
  fetchExternalEvents: async () => { assert.fail("creation must not fetch external events"); },
  linkStatus: async () => { assert.fail("creation must not access Google"); },
  pushEvent: async () => { googleCalls++; return { ok: true }; },
  unpushEvent: async () => { googleCalls++; return { ok: true }; },
} });
const { default: handler } = await import("../api/schedule/index.js");
const window = {};
runInNewContext(readFileSync(at("js/calendar-quantity.js"), "utf8"), { window });
runInNewContext(readFileSync(at("js/calendar-duplicate.js"), "utf8"), { window });
const original = { id: "old-id", source: "self", visibility: "shared", planned_quantity: 0, planned_quantity_unit: "件", category: "visit", title: "定例確認", location: "会議室",
  body: "本人用メモ", all_day: true, starts_at: "2026-10-28T00:00:00+09:00", ends_at: "2026-10-30T23:59:00+09:00",
  employee_id: "other-member", tenant_id: "other-tenant", gcal_event_id: "linked", source_id: "source", status: "done", attendees: ["external"] };
const before = structuredClone(original);
const body = window.CalendarDuplicate.payload({ ...window.CalendarDuplicate.draft(original), startDate: "2026-11-03", endDate: "2026-11-05" }, { quantityAvailable: true });
const post = async (input = body) => { const res = {}; await handler({ method: "POST", body: input }, res); return res; };
let response = await post();
assert.equal(response.status, 200);
assert.equal(inserted.length, 1);
assert.deepEqual(inserted[0], { title: "定例確認", body: "本人用メモ", location: "会議室", category: "visit", all_day: true,
  starts_at: "2026-11-02T15:00:00.000Z", ends_at: "2026-11-05T14:59:00.000Z", visibility: "shared",
  planned_quantity: 0, planned_quantity_unit: "件", tenant_id: "current-tenant", employee_id: "current-member" });
assert.notEqual(response.body.event.id, original.id);
assert.equal(googleCalls, 0);
assert.deepEqual(original, before);
console.log("ok copy payload creates a separate authenticated-owner record without Google calls");

// Even a crafted request cannot copy lifecycle or ownership fields through normalize.
response = await post({ ...original, ...body, id: "force-old-id", source: "leave", gcal_synced_at: "old", updated_at: "old" });
assert.equal(response.status, 200);
assert.equal(inserted[1].tenant_id, "current-tenant");
assert.equal(inserted[1].employee_id, "current-member");
for (const key of ["id", "source", "source_id", "gcal_event_id", "gcal_synced_at", "status", "updated_at", "attendees"]) assert.equal(Object.hasOwn(inserted[1], key), false, key);
assert.equal(googleCalls, 0);
console.log("ok server ignores source identity, completion, attendees and sync metadata");

let count = inserted.length;
ctx = { tenantId: null, employee: { id: "current-member" } };
assert.equal((await post()).status, 403);
ctx = { tenantId: "current-tenant", employee: null };
assert.equal((await post()).status, 403);
user = null; await post();
assert.equal(inserted.length, count);
console.log("ok missing membership, employee or authentication cannot create a copy");
user = { id: "user" }; ctx = { tenantId: "current-tenant", employee: { id: "current-member" } };
for (const change of [{ category: "private" }, { visibility: "private" }, { startsAt: "bad" }, { title: "" }]) {
  assert.equal((await post({ ...body, ...change })).status, 400);
}
assert.equal(inserted.length, count);
dbError = { code: "42501", message: "RLS rejection" };
assert.equal((await post()).status, 403);
assert.equal(googleCalls, 0);
console.log("ok invalid data and database permission denial remain blocked");
dbError = null;
schema = false; count = inserted.length;
response = await post();
assert.equal(response.status, 503); assert.equal(response.body.error, "calendar_quantity_unavailable");
assert.equal(inserted.length, count, "numeric copy including zero must not write without schema");
const legacy = window.CalendarDuplicate.payload({ ...window.CalendarDuplicate.draft({ ...original, planned_quantity: undefined, planned_quantity_unit: undefined }), startDate: "2026-11-03", endDate: "2026-11-05" });
response = await post(legacy); assert.equal(response.status, 200); assert.equal(response.body.quantityAvailable, false);
assert.equal(Object.hasOwn(inserted.at(-1), "planned_quantity"), false);
console.log("ok old schema permits no-number copy, rejects numeric copy before mutation");
schema = true; schemaRace = true; count = inserted.length;
response = await post(); assert.equal(response.status, 503); assert.equal(response.body.error, "calendar_quantity_unavailable");
assert.equal(inserted.length, count + 1, "schema race must never retry without numbers");
schemaRace = false; readError = { code:"42501", message:"denied" }; count = inserted.length;
response = await post(); assert.equal(response.status, 503); assert.equal(response.body.error, "calendar_read_unavailable");
assert.equal(inserted.length, count); assert.equal(googleCalls, 0);
console.log("ok schema race never retries and capability denial cannot create a copy");
console.log("6 calendar copy API boundary checks passed (mock DB/auth, not live RLS)");
