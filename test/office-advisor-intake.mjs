import assert from "node:assert/strict";
import { onboardingAdvisorEmployeeId, syncOnboardingProfileTask } from "../lib/professional-tasks.js";
import { advisorBrief } from "../lib/onboard-brief.js";

const employeeId = "05a2e54d-e60c-4d55-9c9b-263ca1e218c9";
const tenantId = "3d567abd-30e8-4e1c-a71b-a293495a87b7";
const sourceKey = `onboard-profile:${employeeId}`;

assert.equal(onboardingAdvisorEmployeeId({ kind: "labor", source: "manual", source_key: sourceKey }), employeeId);
assert.equal(onboardingAdvisorEmployeeId({ kind: "tax", source: "manual", source_key: sourceKey }), null);
assert.equal(onboardingAdvisorEmployeeId({ kind: "labor", source: "recurring", source_key: sourceKey }), null);
assert.equal(onboardingAdvisorEmployeeId({ kind: "labor", source: "manual", source_key: "onboard-profile:bad" }), null);

// A minimal query double for the existing service-role table interface.
function fakeDb() {
  const data = {
    gw_onboard_profiles: [{ tenant_id: tenantId, employee_id: employeeId, status: "draft", submitted_at: null }],
    gw_employees: [{ tenant_id: tenantId, id: employeeId, joined_on: "2026-12-01" }],
    gw_role_grants: [], gw_professional_tasks: [],
    gw_professional_task_events: [], gw_professional_task_checklist: [],
  };
  const sb = { from(table) {
    assert.ok(table in data, `table ${table}`);
    const state = { table, op: "select", predicates: [], patch: null };
    const result = () => {
      const rows = data[table].filter((row) => state.predicates.every(([k, v]) => row[k] === v));
      if (state.op === "select") return { data: rows, error: null };
      if (state.op === "insert") {
        const inserted = (Array.isArray(state.patch) ? state.patch : [state.patch])
          .map((row, i) => ({ id: row.id || `generated-${table}-${data[table].length + i}`, ...row }));
        data[table].push(...inserted);
        return { data: inserted, error: null };
      }
      if (state.op === "update") {
        for (const row of rows) Object.assign(row, state.patch);
        return { data: rows, error: null };
      }
    };
    const q = {
      eq(k, v) { state.predicates.push([k, v]); return q; },
      select() { return q; },
      limit() { return q; },
      order() { return q; },
      in(k, values) { state.predicates.push([k, { values }]); return q; },
      insert(value) { state.op = "insert"; state.patch = value; return q; },
      update(value) { state.op = "update"; state.patch = value; return q; },
      async maybeSingle() { const r = result(); return { data: r.data[0] || null, error: r.error }; },
      async single() { const r = result(); return { data: r.data[0] || null, error: r.error }; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return q;
  } };
  return { sb, data };
}

const db = fakeDb();
assert.equal((await syncOnboardingProfileTask(db.sb, { tenantId, employeeId })).skipped, "not_submitted");
assert.equal(db.data.gw_professional_tasks.length, 0, "drafts never create advisor tasks");
db.data.gw_onboard_profiles[0].status = "submitted";
db.data.gw_onboard_profiles[0].submitted_at = "2026-11-17T00:00:00Z";
const first = await syncOnboardingProfileTask(db.sb, { tenantId, employeeId });
assert.equal(first.created, true);
assert.equal(first.assigned, false, "no advisor account means no notification recipient");
assert.equal(db.data.gw_professional_tasks.length, 1);
const task = db.data.gw_professional_tasks[0];
assert.equal(task.source_key, sourceKey);
assert.equal(task.source, "manual");
assert.ok(!JSON.stringify(task).includes("address"), "task does not copy personal data");
const second = await syncOnboardingProfileTask(db.sb, { tenantId, employeeId });
assert.equal(second.created, false, "repeat submission is idempotent");
assert.equal(db.data.gw_professional_tasks.length, 1);

const brief = advisorBrief({
  employee: { display_name: "確認者", joined_on: "2026-12-01", employment_type: "part_time" },
  contract: { weekly_hours: 25 },
  profile: { name_kana: "カクニンシャ", birth_date: "1990-01-01", address: "Test address",
    pension_number: "0000-000001", employment_ins_number: "0000-000001-1",
    bank_number: "SECRET_BANK_NUMBER", emg_phone: "SECRET_EMERGENCY_PHONE" },
});
assert.ok(brief.text.includes("Test address"));
assert.ok(!brief.text.includes("SECRET_BANK_NUMBER"), "bank account must not be in advisor summary");
assert.ok(!brief.text.includes("SECRET_EMERGENCY_PHONE"), "emergency contact must not be in advisor summary");
console.log("PASS Office advisor intake: submit-only, idempotency, role matching, minimal sharing");
