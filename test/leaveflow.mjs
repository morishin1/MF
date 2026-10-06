// 退職の流れ（A1）。leaving（退職予定・引継ぎ中）は退職日まで通常どおり、left（退職）で止める。
//
// ■ 何を守るテストか
//   1. PATCH /api/employees
//        leaving にしても、無限道場・タイムカード・会計は止めない（これまでは止めていた）
//        left にしたときだけ、止める（無限道場・タイムカード）／会計のメンバーシップを外す
//        left から在籍に戻したら、開け直す
//        left にして退職日が空なら、今日（日本時間）を退職日にする。入れてあればそのまま
//        権限の行（内部ロール・アプリ権限）は、退職にしても消さない
//   2. GET /api/cron/leave
//        退職日を過ぎた leaving だけを left に確定し、systems を止める。退職日の当日・前・退職日なしは触らない
//        最後の在籍中の経営者は、確定しない（skipped）
//        CRON_SECRET があれば、合わない呼び出しは 401
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const ymdOffset = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const TODAY = ymdOffset(0), YESTERDAY = ymdOffset(-1), TOMORROW = ymdOffset(1);

const db = { rows: {} };
const calls = { active: [], accounting: [], logs: [] };
let current = { userId: "u-hr" };

function table(name) {
  const f = []; let upd = null;
  const match = (r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : op === "lt" ? String(r[k] ?? "9999") < v : false));
  const rows = () => (db.rows[name] || []).filter(match);
  const apply = () => { for (const r of rows()) Object.assign(r, upd); return rows().map((r) => ({ ...r })); };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    lt(k, v) { f.push(["lt", k, v]); return q; },
    in() { return q; }, order() { return q; }, limit() { return q; }, neq() { return q; },
    update(v) { upd = v; return q; },
    maybeSingle: () => Promise.resolve({ data: upd ? (apply()[0] || null) : (rows()[0] ? { ...rows()[0] } : null), error: null }),
    then: (fn, rej) => Promise.resolve(upd ? (apply(), { data: null, error: null }) : { data: rows().map((r) => ({ ...r })), error: null }).then(fn, rej),
    insert() { return Promise.resolve({ data: null, error: null }); },
  };
  return q;
}
const client = () => ({ from: table });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(atRoot("lib/auth.js"), { namedExports: {
  requireUser: async () => ({ id: current.userId }), requireUserAllowLeft: async () => ({ id: current.userId }),
  leftStateOf: async () => ({ left: false }), getMemberships: async () => [{ role: "staff", tenant_id: "t1" }],
} });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { calls.logs.push(e); } } });
mock.module(atRoot("lib/accounts.js"), { namedExports: {
  SYSTEMS: [], readAccounts: async () => new Map(), attachAccount: async () => ({ ok: true }), setSystemAccess: async () => ({ ok: true }),
  setAccountsActive: async (_sb, userId, active) => { calls.active.push({ userId, active }); return { lms: { ok: true }, timecard: { ok: true } }; },
  removeAccountingAccess: async (_sb, tenantId, userId) => { calls.accounting.push({ tenantId, userId }); return { ok: true }; },
} });
mock.module(atRoot("lib/owner-guard.js"), { namedExports: {
  INACTIVE: ["leaving", "left"],
  guardOwnerTarget: async () => null,
  guardLastOwner: async (_sb, _t, id) => (id === "e-lastowner" ? { status: 409, body: { error: "last_owner" } } : null),
} });

const { default: employeesApi } = await import(atRoot("api/employees/index.js"));
const { default: leaveCron } = await import(atRoot("api/cron/leave.js"));

const res = () => { const r = { statusCode: 0, body: null }; r.setHeader = () => {}; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const patch = (body) => call(employeesApi, { method: "PATCH", url: "/api/employees", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

const emp = (id, status, left_on = null) => ({ id, tenant_id: "t1", user_id: `u-${id}`, display_name: `名前${id}`, email: `${id}@x`, status, left_on, department: "開発", position: "社員", employment_type: "正社員", joined_on: "2025-04-01", work_location: null, created_at: "2025-04-01" });
function setup() {
  calls.active.length = 0; calls.accounting.length = 0; calls.logs.length = 0;
  current = { userId: "u-hr" };
  db.rows = {
    gw_employees: [emp("hr", "active"), emp("a", "active"), emp("b", "active"), emp("c", "active"),
      emp("due1", "leaving", YESTERDAY), emp("due2", "leaving", ymdOffset(-30)), emp("today", "leaving", TODAY),
      emp("future", "leaving", TOMORROW), emp("nodate", "leaving"), emp("left0", "left", YESTERDAY), emp("lastowner", "leaving", YESTERDAY)],
    gw_role_grants: [{ id: "g1", tenant_id: "t1", employee_id: "e-hr", role: "hr" }, { id: "g2", tenant_id: "t1", employee_id: "e-a", role: "manager" }],
    gw_app_grants: [{ tenant_id: "t1", employee_id: "e-a", app_key: "hr" }],
  };
  // 実装は id で引く（e- 付きの id にそろえる）
  for (const e of db.rows.gw_employees) { e.id = `e-${e.id}`.replace("e-e-", "e-"); e.user_id = `u-${e.id.slice(2)}`; }
}

console.log("[1] PATCH /api/employees");
setup();
await ok("leaving にしても、社内システムは止めない（退職日まで通常どおり）", async () => {
  const r = await patch({ id: "e-a", status: "leaving", left_on: TOMORROW });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(calls.active, []); assert.deepEqual(calls.accounting, []);
  assert.equal(db.rows.gw_employees.find((e) => e.id === "e-a").status, "leaving");
});
await ok("leaving から left にすると、止める（無限道場・タイムカード）／会計のメンバーシップを外す", async () => {
  const r = await patch({ id: "e-a", status: "left" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(calls.active, [{ userId: "u-a", active: false }]);
  assert.deepEqual(calls.accounting, [{ tenantId: "t1", userId: "u-a" }]);
  assert.ok(r.body.systems);
});
await ok("退職日が入っていれば、そのまま（今日で上書きしない）", async () => {
  const e = db.rows.gw_employees.find((x) => x.id === "e-a"); assert.equal(e.left_on, TOMORROW);
});
await ok("権限の行（内部ロール・アプリ権限）は、退職にしても消さない", async () => {
  assert.equal(db.rows.gw_role_grants.filter((g) => g.employee_id === "e-a").length, 1);
  assert.equal(db.rows.gw_app_grants.filter((g) => g.employee_id === "e-a").length, 1);
});
await ok("left にして退職日が空なら、今日（日本時間）を退職日にする", async () => {
  const r = await patch({ id: "e-b", status: "left" });
  assert.equal(r.statusCode, 200); assert.equal(db.rows.gw_employees.find((e) => e.id === "e-b").left_on, TODAY);
});
await ok("left に戻して在籍にすると、開け直す", async () => {
  calls.active.length = 0;
  const r = await patch({ id: "e-a", status: "active" });
  assert.equal(r.statusCode, 200); assert.deepEqual(calls.active, [{ userId: "u-a", active: true }]);
});
await ok("active → leaving → active は、止めも開けもしない", async () => {
  calls.active.length = 0; calls.accounting.length = 0;
  await patch({ id: "e-c", status: "leaving", left_on: TOMORROW }); await patch({ id: "e-c", status: "active" });
  assert.deepEqual(calls.active, []); assert.deepEqual(calls.accounting, []);
});
await ok("状態の変更は、操作ログに残る", async () => {
  assert.ok(calls.logs.some((l) => l.action === "employee.status" && l.detail.status === "left"));
  assert.ok(calls.logs.some((l) => l.action === "account.suspend"));
});

console.log("[2] GET /api/cron/leave");
setup(); delete process.env.CRON_SECRET;
await ok("退職日を過ぎた leaving だけを left にする（当日・前・退職日なし・すでに left は触らない）", async () => {
  const r = await call(leaveCron, { method: "GET", url: "/api/cron/leave" });
  assert.equal(r.statusCode, 200);
  const st = (id) => db.rows.gw_employees.find((e) => e.id === id).status;
  assert.equal(st("e-due1"), "left"); assert.equal(st("e-due2"), "left");
  assert.equal(st("e-today"), "leaving"); assert.equal(st("e-future"), "leaving"); assert.equal(st("e-nodate"), "leaving");
  assert.equal(st("e-left0"), "left");
  assert.equal(r.body.finalized, 2);
});
await ok("確定した人は、社内システムを止め、会計のメンバーシップを外す。権限の行は消さない", async () => {
  assert.deepEqual(calls.active.map((c) => c.userId).sort(), ["u-due1", "u-due2"]);
  assert.ok(calls.active.every((c) => c.active === false));
  assert.deepEqual(calls.accounting.map((c) => c.userId).sort(), ["u-due1", "u-due2"]);
  assert.equal(db.rows.gw_role_grants.length, 2);
});
await ok("最後の在籍中の経営者は、確定しない（skipped）", async () => {
  assert.equal(db.rows.gw_employees.find((e) => e.id === "e-lastowner").status, "leaving");
});
await ok("操作ログに auto: true で残る", async () => {
  assert.ok(calls.logs.some((l) => l.detail?.auto === true && l.detail.status === "left"));
});
await ok("2回回しても、同じ（確定済みは触らない）", async () => {
  calls.active.length = 0;
  const r = await call(leaveCron, { method: "GET", url: "/api/cron/leave" });
  assert.equal(r.body.finalized, 0); assert.deepEqual(calls.active, []);
});
await ok("CRON_SECRET があれば、合わない呼び出しは 401", async () => {
  process.env.CRON_SECRET = "s3"; setup();
  const bad = await call(leaveCron, { method: "GET", url: "/api/cron/leave", headers: { authorization: "Bearer nope" } });
  assert.equal(bad.statusCode, 401);
  const good = await call(leaveCron, { method: "GET", url: "/api/cron/leave", headers: { authorization: "Bearer s3" } });
  assert.equal(good.statusCode, 200); delete process.env.CRON_SECRET;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
