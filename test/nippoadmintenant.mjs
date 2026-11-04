// Synthetic tenant-boundary regression tests. No live DB, AI, or private-data calls.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMemDb } from "./_memdb.mjs";

const atRoot = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const mem = createMemDb();
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const DATE = "2026-10-27";
const OWNER = { tenantId: T1, isAdmin: false, isHr: false, roles: ["owner"], employee: { id: "e1" } };
let who, authenticated, queries, rosterFailure, sideEffects;

// Track queries and their actual selected rows, not only the final response.
// Filtering after a LIMIT would still load foreign data and can hide our own rows.
const db = () => {
  const client = mem.admin();
  return { from(table) {
    const q = client.from(table);
    const entry = { table, filters: [], columns: null, rows: [] };
    queries.push(entry);
    for (const name of ["eq", "in", "gte", "lte", "lt", "neq"]) {
      const original = q[name];
      q[name] = (...args) => { entry.filters.push([name, ...args]); return original(...args); };
    }
    const select = q.select;
    q.select = (...args) => { entry.columns = args[0]; return select(...args); };
    const then = q.then;
    q.then = (resolve, reject) => then((result) => {
      if (table === "gw_employees" && rosterFailure) result = { ...result, error: { message: "synthetic roster unavailable" } };
      entry.rows = result.data;
      return resolve(result);
    }, reject);
    return q;
  } };
};

globalThis.fetch = async () => { throw Error("Network calls are forbidden in this synthetic test"); };
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: db, userClient: db } });
mock.module(atRoot("lib/auth.js"), { namedExports: {
  requireUser: async (_req, res) => {
    if (authenticated) return { id: "u-owner" };
    res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return null;
  }, getMemberships: async () => [],
} });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => { sideEffects++; } } });
mock.module(atRoot("lib/ai.js"), { namedExports: { analyzeNippo: async () => { sideEffects++; throw Error("AI must not run on GET"); } } });
const realGw = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...realGw, gwContext: async () => who } });
const { default: api } = await import(atRoot("api/nippo/admin.js"));

const report = (id, user, date = DATE, submitted = true) => ({
  id, user_id: user, user_name: "同じ表示名", work_date: date,
  submitted_at: submitted ? `${date}T09:00:00Z` : null,
  work_items: [], tomorrow_plan: "", consult_note: "", morning_note: "",
});
function setup() {
  mem.reset(); who = { ...OWNER }; authenticated = true; queries = []; rosterFailure = false; sideEffects = 0;
  mem.rows.gw_employees = [
    { id: "e1", tenant_id: T1, user_id: "u1", display_name: "同じ表示名", status: "active" },
    { id: "e2", tenant_id: T1, user_id: "u2", display_name: "退職予定", status: "leaving" },
    { id: "e-null", tenant_id: T1, user_id: null, display_name: "未連携", status: "active" },
    { id: "e-left", tenant_id: T1, user_id: "u-left", display_name: "退職済み", status: "left" },
    // Same display name and even a synthetic colliding employee ID must not select another tenant's user.
    { id: "e1", tenant_id: T2, user_id: "u-foreign", display_name: "同じ表示名", status: "active" },
  ];
  mem.rows.tc_nippo = [
    report("n-foreign", "u-foreign"), report("n-orphan", "u-orphan"), report("n-left", "u-left"),
    report("n1", "u1"), report("n2", "u2"), report("n-draft", "u1", DATE, false),
    report("n-prior", "u1", "2026-09-24"), report("n-prior-foreign", "u-foreign", "2026-09-24"),
  ];
  mem.rows.tc_nippo_replies = ["n-foreign", "n-orphan", "n-left", "n1", "n2", "n-draft"].map((id) => ({
    id: `reply-${id}`, nippo_id: id, kind: "admin", body: `reply ${id}`, draft_only: true, created_at: `${DATE}T10:00:00Z`,
  }));
  mem.rows.gw_nippo_ai_evals = [
    ...[["n-foreign", "u-foreign"], ["n-orphan", "u-orphan"], ["n-left", "u-left"], ["n1", "u1"], ["n2", "u2"], ["n-draft", "u1"]].map(([id, user]) => ({
      id: `eval-${id}`, nippo_id: id, user_id: user, work_date: DATE, status: "completed", scores: {}, created_at: `${DATE}T10:00:00Z`,
    })),
  ];
  mem.rows.tc_settings = [{ key: "nippo_ai_auto_reply", value: false }];
  mem.rows.gw_daily_kpis = []; mem.rows.gw_blockers = []; mem.rows.gw_action_items = [];
  mem.rows.gw_time_entries = []; mem.rows.gw_time_fixes = [];
}
async function get(query = `date=${DATE}`) {
  const res = { statusCode: 0, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await api({ method: "GET", url: `/api/nippo/admin?${query}`, headers: {} }, res);
  assert.equal(sideEffects, 0, "GET must not call AI or log mutations");
  assert.deepEqual(mem.state.log, [], "GET must not mutate stored records");
  return res;
}
const userQueries = () => queries.filter((q) => ["tc_nippo", "gw_nippo_ai_evals", "gw_daily_kpis", "gw_blockers", "gw_action_items"].includes(q.table));

test("daily response contains only active/leaving linked users and their submitted reports, replies and evaluations", async () => {
  setup(); const r = await get(); assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.nippos.map((n) => n.id).sort(), ["n1", "n2"]);
  assert.deepEqual(r.body.replies.map((n) => n.nippo_id).sort(), ["n1", "n2"]);
  assert.deepEqual(r.body.evals.map((n) => n.nippoId).sort(), ["n1", "n2"]);
  assert.deepEqual(r.body.members.map((m) => m.userId).sort(), ["u1", "u2"]);
  assert.equal(r.body.trend.at(-1).submitted, 2); assert.equal(r.body.trend.at(-1).total, 2);
  assert.deepEqual(r.body.notSubmitted, []); assert.equal(r.body.aiAutoReply, false);
});

test("all four daily source queries are user-filtered before reading (today, trend, previous period, scores)", async () => {
  setup(); await get();
  const sources = userQueries().filter((q) => !q.filters.some(([op, key]) => op === "in" && key === "nippo_id"));
  assert.ok(sources.some((q) => q.table === "tc_nippo" && q.columns === "*"));
  assert.ok(sources.some((q) => q.columns === "user_id, work_date, submitted_at"));
  assert.ok(sources.some((q) => q.columns === "user_id, work_date, work_items, submitted_at"));
  assert.ok(sources.some((q) => q.table === "gw_nippo_ai_evals" && q.columns === "user_id, work_date, scores"));
  for (const q of sources) {
    assert.ok(q.filters.some(([op, key, ids]) => op === "in" && key === "user_id" && ids.length && ids.every((id) => ["u1", "u2"].includes(id))), `${q.table}/${q.columns} must use the tenant roster`);
    assert.ok((q.rows || []).every((row) => ["u1", "u2"].includes(row.user_id)), "foreign rows must not reach the handler");
  }
});

test("linked replies/evaluations are queried only by submitted report IDs from the scoped daily result", async () => {
  setup(); await get();
  const joins = queries.filter((q) => q.table === "tc_nippo_replies" || q.table === "gw_nippo_ai_evals" && q.columns === "*");
  assert.equal(joins.length, 2);
  for (const q of joins) assert.deepEqual(q.filters.find(([op, key]) => op === "in" && key === "nippo_id")?.[2].sort(), ["n1", "n2"]);
});

test("foreign rows cannot consume the daily 300-row limit and hide this tenant's report", async () => {
  setup(); mem.rows.tc_nippo = [...Array.from({ length: 350 }, (_, i) => report(`foreign-${i}`, "u-foreign")), report("n1", "u1")];
  const r = await get(); assert.deepEqual(r.body.nippos.map((n) => n.id), ["n1"]);
});

test("large tenant rosters read all four sources in bounded 100-user batches", async () => {
  setup();
  const ids = Array.from({ length: 201 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  mem.rows.gw_employees = ids.map((id, i) => ({ id: `e-${i}`, user_id: id, tenant_id: T1, display_name: `社員-${i}`, status: "active" }));
  mem.rows.tc_nippo = ids.map((id, i) => report(`n-${i}`, id));
  const r = await get(); assert.equal(r.statusCode, 200); assert.equal(r.body.nippos.length, 201);
  for (const columns of ["*", "user_id, work_date, submitted_at", "user_id, work_date, work_items, submitted_at", "user_id, work_date, scores"]) {
    const table = columns === "user_id, work_date, scores" ? "gw_nippo_ai_evals" : "tc_nippo";
    const reads = userQueries().filter((q) => q.table === table && q.columns === columns && q.filters.some(([op, key]) => op === "in" && key === "user_id"));
    assert.equal(reads.length, 3, columns);
    const batches = reads.map((q) => q.filters.find(([op, key]) => op === "in" && key === "user_id")[2]);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 1]);
    assert.deepEqual([...new Set(batches.flat())].sort(), [...ids].sort());
  }
});

for (const kind of ["empty", "unlinked", "other-tenant-only"]) test(`${kind} roster performs no personal-data queries`, async () => {
  setup(); mem.rows.gw_employees = kind === "empty" ? [] : kind === "unlinked" ? mem.rows.gw_employees.filter((e) => !e.user_id) : mem.rows.gw_employees.filter((e) => e.tenant_id === T2);
  const r = await get(); assert.equal(r.statusCode, 200);
  for (const field of ["nippos", "replies", "evals", "members", "notSubmitted", "followUps", "blockers"]) assert.deepEqual(r.body[field], []);
  assert.equal(userQueries().length, 0); assert.equal(queries.filter((q) => q.table === "tc_nippo_replies").length, 0);
  assert.ok(r.body.trend.every((t) => t.submitted === 0 && t.total === 0));
});

test("roster read error fails closed even if the DB response also contains rows", async () => {
  setup(); rosterFailure = true; const r = await get();
  assert.equal(r.statusCode, 500); assert.equal(r.body.error, "employees_query_failed");
  assert.deepEqual(queries.map((q) => q.table), ["gw_employees"]);
  assert.equal(r.body.nippos, undefined);
});

test("existing weekly report source still uses the same tenant-scoped user roster", async () => {
  setup(); const r = await get(`view=week&date=${DATE}`); assert.equal(r.statusCode, 200);
  for (const q of queries.filter((q) => q.table === "tc_nippo")) {
    assert.ok(q.filters.some(([op, key, ids]) => op === "in" && key === "user_id" && ids.every((id) => ["u1", "u2"].includes(id))));
    assert.ok((q.rows || []).every((row) => row.user_id !== "u-foreign"));
  }
});

for (const denied of ["anonymous", "no-membership", "ordinary-member"]) test(`${denied} cannot query daily reports`, async () => {
  setup();
  if (denied === "anonymous") authenticated = false;
  if (denied === "no-membership") who = { ...OWNER, tenantId: null };
  if (denied === "ordinary-member") who = { ...OWNER, roles: [] };
  const r = await get(); assert.equal(r.statusCode, denied === "anonymous" ? 401 : 403); assert.deepEqual(queries, []);
});

for (const role of ["admin", "hr"]) test(`existing ${role} access is preserved without expanding its tenant`, async () => {
  setup(); who = { ...OWNER, roles: [], isAdmin: role === "admin", isHr: role === "hr" };
  const r = await get(); assert.equal(r.statusCode, 200); assert.deepEqual(r.body.nippos.map((n) => n.id).sort(), ["n1", "n2"]);
});
