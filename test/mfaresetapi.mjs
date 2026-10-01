// 二段階認証のリセット（POST /api/mfa {action:"reset"}）：経営者（owner）の認証を、管理者・人事に外させない。
//
// ■ 何を守るテストか
//
//   経営者 → 一般ユーザー    可
//   経営者 → ほかの経営者    可（二段階認証は任意。実行する経営者に aal2 は要らない）
//   管理者・人事 → 経営者    不可（403 owner_only）。認証は1つも外れず、試みたことが記録に残る
//   管理者・人事 → 一般ユーザー 可（いままでどおり）
//   誰でも → 自分            不可
//   経営者のリセットは、ほかの在籍中の経営者に通知が届く（なりすましに気づけるように）
//
//   管理者が経営者の認証を外せると、パスワードを知っている人が、管理者を経由して自分の
//   認証アプリに差し替えられる。経営の画面は認証を通れば開くため、これを塞ぐ。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const notices = [];
const deleted = [];

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    return true;
  }));
  const copy = (r) => (r ? { ...r } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is() { return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      (db.rows[name] = db.rows[name] || []).push(...[].concat(row));
      return Promise.resolve({ error: null });
    },
  };
  return q;
}

const client = () => ({
  from: table,
  auth: { admin: { mfa: {
    listFactors: async ({ userId }) => ({ data: { factors: [{ id: `f-${userId}`, factor_type: "totp", status: "verified" }] }, error: null }),
    deleteFactor: async ({ id, userId }) => { deleted.push({ id, userId }); return { error: null }; },
  } } },
});
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.employee.user_id, factors: [] }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => { notices.push(...rows); return { created: rows.length }; } } });

// lib/mfa.js は本物のまま使う（二段階認証は任意。requireMfa は何も止めない）

const REAL_GW = await import(atRoot("lib/gw.js"));
let who;
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: mfa } = await import(atRoot("api/mfa.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const reset = async (employeeId) => {
  const r = res();
  await mfa({ method: "POST", url: "/api/mfa", headers: { authorization: "Bearer x" }, body: { action: "reset", employeeId } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const ctxOf = (id, roles, extra = {}) => ({
  tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: false,
  roles, employee: { id, display_name: `人${id}`, user_id: `u-${id}` }, ...extra,
});

function setup() {
  logged.length = 0; notices.length = 0; deleted.length = 0;
  const emp = (id, name, status = "active") => ({ id, tenant_id: "t1", display_name: name, user_id: `u-${id}`, status });
  db.rows = {
    gw_employees: [emp("own1", "経営者A"), emp("own2", "経営者B"), emp("adm", "管理者"), emp("hr1", "人事"), emp("mem", "一般"),
      emp("ownx", "退職した経営者", "left"), { ...emp("nolink", "未連携"), user_id: null }],
    gw_role_grants: [
      { tenant_id: "t1", employee_id: "own1", role: "owner" }, { tenant_id: "t1", employee_id: "own2", role: "owner" },
      { tenant_id: "t1", employee_id: "ownx", role: "owner" }, { tenant_id: "t1", employee_id: "hr1", role: "hr" },
    ],
    gw_mfa_resets: [],
  };
}

console.log("\n=== owner の二段階認証リセット ===\n");

await ok("経営者は、一般ユーザーの認証をリセットできる", async () => {
  setup(); who = ctxOf("own1", ["owner"]);
  const r = await reset("mem");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(deleted.map((d) => d.userId), ["u-mem"]);
  assert.equal(db.rows.gw_mfa_resets.length, 1);
  assert.equal(logged.at(-1).detail.ownerTarget, false);
});

await ok("経営者は、ほかの経営者の認証をリセットできる（二段階認証は任意。実行する経営者に aal2 は要らない）", async () => {
  setup(); who = ctxOf("own1", ["owner"]);
  const r = await reset("own2");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.error, "mfa_required");
  assert.deepEqual(deleted.map((d) => d.userId), ["u-own2"]);
  assert.equal(logged.at(-1).action, "mfa.reset");
  assert.equal(logged.at(-1).detail.ownerTarget, true);
});

await ok("経営者どうしのリセットに、二段階認証の確認（mfa_required）は付かない。権限（owner）の判定だけ", async () => {
  setup(); who = ctxOf("own1", ["owner"]);
  const r = await reset("own2");
  assert.equal(r.statusCode, 200);
  assert.ok(!JSON.stringify(r.body).includes("mfa_required"));
  assert.equal(db.rows.gw_mfa_resets.length, 1);
});

await ok("管理者は、経営者の認証をリセットできない（403 owner_only）。何も外れず、試みが記録に残る", async () => {
  setup(); who = ctxOf("adm", [], { isAdmin: true });
  const r = await reset("own1");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
  assert.equal(deleted.length, 0, "認証が外れていない");
  assert.equal(db.rows.gw_mfa_resets.length, 0, "再登録の窓も開かない");
  assert.equal(notices.length, 0);
  const l = logged.at(-1);
  assert.equal(l.action, "mfa.reset_denied");
  assert.equal(l.actorId, "u-adm");
  assert.equal(l.target, "employee:own1");
});

await ok("人事も、経営者の認証をリセットできない", async () => {
  setup(); who = ctxOf("hr1", ["hr"]);
  const r = await reset("own2");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
  assert.equal(deleted.length, 0);
});

await ok("管理者・人事は、一般ユーザーの認証を、いままでどおりリセットできる", async () => {
  for (const c of [ctxOf("adm", [], { isAdmin: true }), ctxOf("hr1", ["hr"])]) {
    setup(); who = c;
    const r = await reset("mem");
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(deleted.map((d) => d.userId), ["u-mem"]);
  }
});

await ok("退職した経営者のロール行が残っていても、その人を経営者として扱う（管理者は触れない）", async () => {
  setup(); who = ctxOf("adm", [], { isAdmin: true });
  const r = await reset("ownx");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
});

await ok("自分の認証は、経営者でも自分ではリセットできない。ほかの経営者か緊急復旧の案内が出る", async () => {
  setup(); who = ctxOf("own1", ["owner"]);
  const r = await reset("own1");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "self_reset");
  assert.match(r.body.hint, /ほかの経営者/);
  assert.match(r.body.hint, /keiei-owner-recovery/);
  assert.equal(deleted.length, 0);
});

await ok("経営者のリセットは、対象本人と、ほかの在籍中の経営者に通知する（退職者・実行者には送らない）", async () => {
  setup();
  db.rows.gw_role_grants.push({ tenant_id: "t1", employee_id: "own3", role: "owner" });
  db.rows.gw_employees.push({ id: "own3", tenant_id: "t1", display_name: "経営者C", user_id: "u-own3", status: "active" });
  who = ctxOf("own1", ["owner"]);
  const r = await reset("own2");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const to = notices.map((n) => n.employeeId).sort();
  assert.deepEqual(to, ["own2", "own3"], "対象（own2）と、第三の経営者（own3）だけ");
  assert.match(notices.find((n) => n.employeeId === "own3").body, /経営者B さんの二段階認証/);
  assert.match(notices.find((n) => n.employeeId === "own2").body, /心当たりがない/);
});

await ok("一般ユーザーのリセットでは、経営者への通知は出ない", async () => {
  setup(); who = ctxOf("own1", ["owner"]);
  await reset("mem");
  assert.deepEqual(notices.map((n) => n.employeeId), ["mem"]);
});

await ok("権限のない人・未連携・別テナントは、いままでどおり断る", async () => {
  setup(); who = ctxOf("mem", []);
  assert.equal((await reset("own1")).statusCode, 403);
  who = ctxOf("own1", ["owner"]);
  assert.equal((await reset("nolink")).statusCode, 400);
  assert.equal((await reset("nobody")).statusCode, 404);
  assert.equal(deleted.length, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
