import assert from "node:assert/strict";
import { verificationConfig, verifyOneLead, notificationIdFor } from "../lib/hr-lead-verification.js";

const env = { VERCEL_ENV: "production", MUGENDOJO_VERIFY_RUN_ID: "11111111-1111-4111-a111-111111111111",
  MUGENDOJO_VERIFY_OWNER_USER_ID: "22222222-2222-4222-a222-222222222222",
  HR_LEAD_TENANT_ID: "33333333-3333-4333-a333-333333333333",
  MUGENDOJO_VERIFY_RECIPIENT: "approved@example.invalid", MUGENDOJO_LEAD_SECRET: "x".repeat(40) };
const cfg = verificationConfig(env);
const body = { verification: true, runId: cfg.runId, ownerUserId: cfg.ownerUserId, recipient: cfg.recipient };
const employeeId = "44444444-4444-4444-a444-444444444444";

function database() {
  const rows = { gw_employees: [{ id: employeeId, tenant_id: cfg.tenantId, user_id: cfg.ownerUserId, status: "active" }],
    gw_role_grants: [{ employee_id: employeeId, tenant_id: cfg.tenantId, role: "owner" }], gw_hr_applicants: [], gw_notifications: [] };
  const writes = []; const reads = [];
  const db = { rows, writes, reads, fail: null, beforeInsert: null, from(table) {
    let op = "select", payload, single = false, limit = Infinity;
    const filters = [];
    const q = {
      select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      ilike(k, v) { filters.push(r => r[k]?.toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()); return q; },
      limit(n) { limit = n; return q; }, maybeSingle() { single = true; return q; },
      insert(p) { op = "insert"; payload = p; return q; },
      // Intentionally no update/upsert methods: a regression must fail.
      async then(resolve, reject) { try {
        if (db.fail?.(table, op)) return resolve({ data: null, error: { code: "XX", message: "SECRET must not leak" } });
        if (op === "insert") {
          await db.beforeInsert?.(table, payload);
          if (rows[table].some(r => r.id === payload.id || (table === "gw_hr_applicants"
              && r.tenant_id === payload.tenant_id && r.lead_category === "mugendojo"
              && r.email.toLowerCase() === payload.email.toLowerCase()))) {
            return resolve({ data: null, error: { code: "23505" } });
          }
          writes.push({ table, payload }); rows[table].push(structuredClone(payload));
          return resolve({ data: null, error: null });
        }
        reads.push(table);
        const found = rows[table].filter(r => filters.every(f => f(r))).slice(0, limit);
        return resolve({ data: single ? found[0] || null : found, error: single && found.length > 1 ? { code: "multiple" } : null });
      } catch(e) { reject(e); } },
    }; return q;
  } }; return db;
}

let n = 0;
async function test(name, fn) { await fn(); n++; console.log(`ok ${n} - ${name}`); }
await test("disabled unless explicit production and every fixed approval is valid", async () => {
  for (const key of Object.keys(env)) assert.equal(verificationConfig({ ...env, [key]: "" }), null, key);
  for (const value of ["preview", "development", undefined]) assert.equal(verificationConfig({ ...env, VERCEL_ENV: value }), null);
  for (const value of ["a@b.com,c@d.com", "A@example.invalid", " x@example.invalid", "x\n@example.invalid"])
    assert.equal(verificationConfig({ ...env, MUGENDOJO_VERIFY_RECIPIENT: value }), null);
});
await test("body cannot choose recipient, owner, run, fields or disable test marker", async () => {
  for (const bad of [null, {}, { ...body, recipient: "other@example.invalid" }, { ...body, ownerUserId: "other" },
    { ...body, runId: "other" }, { ...body, verification: false }, { ...body, name: "attacker" }]) {
    const db = database(); assert.equal((await verifyOneLead(db, cfg, bad)).ok, false); assert.equal(db.reads.length, 0); assert.equal(db.writes.length, 0);
  }
});
await test("owner role, exact tenant and current employment are required", async () => {
  for (const mutate of [db => db.rows.gw_role_grants.splice(0), db => db.rows.gw_role_grants[0].role = "hr",
    db => db.rows.gw_role_grants[0].tenant_id = "other", db => db.rows.gw_employees[0].status = "left",
    db => Object.assign(db.rows.gw_employees[0], { status: "leaving", left_on: "2000-01-01" }),
    db => db.rows.gw_employees[0].status = null, db => db.rows.gw_employees[0].user_id = "other"]) {
    const db = database(); mutate(db); assert.equal((await verifyOneLead(db, cfg, body)).error, "forbidden"); assert.equal(db.writes.length, 0);
  }
});
await test("creates one marked synthetic applicant and only owner GW notification", async () => {
  const db = database(); const out = await verifyOneLead(db, cfg, body);
  assert.deepEqual(out, { ok: true, verification: true, runId: cfg.runId, applicantId: cfg.runId,
    notificationIds: [notificationIdFor(cfg.runId)], result: "created" });
  assert.deepEqual(db.writes.map(w => w.table), ["gw_hr_applicants", "gw_notifications"]);
  assert.equal(db.rows.gw_hr_applicants[0].attribution.synthetic, true);
  assert.match(db.rows.gw_hr_applicants[0].name, /^\[TEST\]/);
  assert.equal(db.rows.gw_notifications[0].employee_id, employeeId);
  const snapshot = structuredClone(db.rows);
  assert.equal((await verifyOneLead(db, cfg, body)).result, "replayed");
  assert.deepEqual(db.rows, snapshot); assert.equal(db.writes.length, 2);
});
await test("existing applicant email or ID cannot be overwritten", async () => {
  for (const row of [{ id: "real", tenant_id: cfg.tenantId, email: cfg.recipient.toUpperCase(), lead_category: "recruitment" },
    { id: cfg.runId, tenant_id: cfg.tenantId, email: cfg.recipient, lead_category: "mugendojo" }]) {
    const db = database(); db.rows.gw_hr_applicants.push(row); const before = structuredClone(db.rows);
    assert.equal((await verifyOneLead(db, cfg, body)).ok, false); assert.deepEqual(db.rows, before); assert.equal(db.writes.length, 0);
  }
});
await test("concurrent calls insert at most one applicant and one notification", async () => {
  const db = database(); const results = await Promise.all(Array.from({ length: 8 }, () => verifyOneLead(db, cfg, body)));
  assert.equal(db.rows.gw_hr_applicants.length, 1); assert.equal(db.rows.gw_notifications.length, 1); assert.equal(db.writes.length, 2);
  assert.ok(results.some(r => r.ok)); assert.ok(results.every(r => r.ok || r.error === "notification_unconfirmed"));
});
await test("concurrent real email collision cannot be merged", async () => {
  const db = database(); db.beforeInsert = async (table) => {
    if (table === "gw_hr_applicants") db.rows.gw_hr_applicants.push({ id: "real", tenant_id: cfg.tenantId, email: cfg.recipient, lead_category: "mugendojo" });
  };
  assert.equal((await verifyOneLead(db, cfg, body)).error, "applicant_conflict"); assert.equal(db.writes.length, 0);
});
await test("partial notification failure is not success and replay never sends", async () => {
  const db = database(); db.fail = (table, op) => table === "gw_notifications" && op === "insert";
  assert.equal((await verifyOneLead(db, cfg, body)).error, "notification_write_unconfirmed");
  db.fail = null; assert.equal((await verifyOneLead(db, cfg, body)).error, "notification_unconfirmed");
  assert.equal(db.writes.length, 1); assert.equal(db.rows.gw_notifications.length, 0);
});
await test("DB failure and thrown exceptions are sanitized, never success", async () => {
  for (const table of ["gw_employees", "gw_role_grants", "gw_hr_applicants", "gw_notifications"]) {
    const db = database(); db.fail = t => t === table;
    const out = await verifyOneLead(db, cfg, body); assert.equal(out.ok, false); assert.ok(!JSON.stringify(out).includes("SECRET"));
  }
  assert.equal((await verifyOneLead({ from() { throw Error("SECRET"); } }, cfg, body)).error, "verification_unconfirmed");
});
console.log(`${n} focused checks passed (mock DB only, no network)`);
