// 経営者（owner）の保護：付与・剥奪・名簿の変更・ログインの乗っ取りを、owner 以外に許さない。
//
// ■ 何を守るテストか
//
//   経営（/keiei）に入れるのは owner だけ。次のどれかが開いていると、その約束が崩れる。
//     1. owner の付与・剥奪                （api/employees/roles.js）
//     2. owner の名簿を退職にする・消す     （api/employees/index.js）
//     3. owner のメール・パスワードを書き換えてなりすます
//                                          （api/employees/account.js・link.js）
//   加えて、最後の（在籍中の）owner は、owner 自身でも外せない・消せない・退職にできない。
//   owner の付与・剥奪は履歴（gw_activity_log）に残る。
//
//   DB 側（RLS・トリガ）は db/099 が同じ内容を守る。こちらは API の入口の検査。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const authCalls = [];

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
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null, count: rows().length }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
    upsert(rowsIn, opts = {}) {
      const keyOf = (r) => (opts.onConflict || "id").split(",").map((k) => r[k]).join("|");
      for (const r of [].concat(rowsIn)) {
        const list = (db.rows[name] = db.rows[name] || []);
        const i = list.findIndex((x) => keyOf(x) === keyOf(r));
        if (i >= 0) { if (!opts.ignoreDuplicates) Object.assign(list[i], r); } else list.push({ id: `${name}-${list.length + 1}`, ...r });
      }
      return Promise.resolve({ data: null, error: null });
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        select: () => r2, single: () => apply(), maybeSingle: () => apply(),
        then: (fn) => apply().then(fn),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]), error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        then: (fn) => {
          db.rows[name] = (db.rows[name] || []).filter((x) => !g.every(([k, v]) => x[k] === v));
          return Promise.resolve({ error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  return q;
}

const client = () => ({
  from: table,
  auth: { admin: {
    updateUserById: async (id, patch) => { authCalls.push({ id, patch }); return { error: null }; },
    listUsers: async () => ({ data: { users: [] } }),
  } },
});
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-x" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/accounts.js"), { namedExports: {
  SYSTEMS: [], readAccounts: async () => new Map(),
  setAccountsActive: async () => ({}), removeAccountingAccess: async () => ({}),
  attachAccount: async () => ({ ok: true, userId: "u-new", createdPassword: null, membership: null, systems: {} }),
  setSystemAccess: async () => ({ ok: true, action: "on" }),
  randomPassword: () => "pw-generated-1", findUserByEmail: async () => null,
} });

// 判定は本物（lib/gw.js）。テストで条件を書き直すと、本番とずれても気づけない
const REAL_GW = await import(atRoot("lib/gw.js"));
let who;
mock.module(atRoot("lib/gw.js"), { namedExports: {
  gwContext: async () => who, canManageHr: REAL_GW.canManageHr, isOwner: REAL_GW.isOwner,
} });

const { default: rolesApi } = await import(atRoot("api/employees/roles.js"));
const { default: employeesApi } = await import(atRoot("api/employees/index.js"));
const { default: accountApi } = await import(atRoot("api/employees/account.js"));
const { default: linkApi } = await import(atRoot("api/employees/link.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const setRole = (employeeId, role, grant = true) => call(rolesApi, { method: "POST", url: "/api/employees/roles", body: { employeeId, role, grant } });
const patchEmp = (body) => call(employeesApi, { method: "PATCH", url: "/api/employees", body });
const delEmp = (id) => call(employeesApi, { method: "DELETE", url: `/api/employees?id=${id}` });
const patchAccount = (body) => call(accountApi, { method: "PATCH", url: "/api/employees/account", body });
const linkAccount = (body) => call(linkApi, { method: "POST", url: "/api/employees/link", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const ctxOf = (roles, extra = {}) => ({ tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), roles, employee: { id: "emp-x" }, ...extra });
const OWNER = ctxOf(["owner"], { employee: { id: "emp-a" } });
const HR = ctxOf(["hr"], { employee: { id: "emp-c" } });
const ADMIN = ctxOf([], { isAdmin: true, employee: { id: "emp-b" } });
const MANAGER = ctxOf(["manager"], { employee: { id: "emp-d" } });

function setup() {
  who = OWNER;
  logged.length = 0;
  authCalls.length = 0;
  const e = (id, name, status = "active") => ({ id, tenant_id: "t1", user_id: `u-${id}`, display_name: name, email: `${id}@x`, status });
  db.rows = {
    gw_employees: [e("emp-a", "社長"), e("emp-b", "事務"), e("emp-c", "人事"), e("emp-d", "責任者"), e("emp-e", "一般"), e("emp-l", "退職済み", "left")],
    gw_role_grants: [
      { id: "g1", tenant_id: "t1", employee_id: "emp-a", role: "owner" },
      { id: "g2", tenant_id: "t1", employee_id: "emp-c", role: "hr" },
      { id: "g3", tenant_id: "t1", employee_id: "emp-d", role: "manager" },
    ],
  };
}
const owners = () => db.rows.gw_role_grants.filter((g) => g.role === "owner").map((g) => g.employee_id).sort();
const hasEmployee = (id) => db.rows.gw_employees.some((x) => x.id === id);

console.log("\n=== owner の付与・剥奪（POST /api/employees/roles） ===\n");

await ok("人事は、owner を付けられない（自分にも他人にも）", async () => {
  setup(); who = HR;
  for (const target of ["emp-c", "emp-e"]) {
    const r = await setRole(target, "owner");
    assert.equal(r.statusCode, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "owner_only");
  }
  assert.deepEqual(owners(), ["emp-a"]);
});

await ok("会計の管理者も、owner を付けられない", async () => {
  setup(); who = ADMIN;
  const r = await setRole("emp-b", "owner");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
  assert.deepEqual(owners(), ["emp-a"]);
});

await ok("責任者・一般は、そもそもロールを触れない", async () => {
  setup();
  for (const c of [MANAGER, ctxOf([])]) {
    who = c;
    const r = await setRole("emp-e", "owner");
    assert.equal(r.statusCode, 403);
  }
  assert.deepEqual(owners(), ["emp-a"]);
});

await ok("人事は、owner を外せない", async () => {
  setup(); who = HR;
  const r = await setRole("emp-a", "owner", false);
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
  assert.deepEqual(owners(), ["emp-a"]);
});

await ok("人事は、これまでどおり owner 以外のロールを付け外しできる", async () => {
  setup(); who = HR;
  let r = await setRole("emp-e", "manager");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(db.rows.gw_role_grants.some((g) => g.employee_id === "emp-e" && g.role === "manager"));
  r = await setRole("emp-e", "manager", false);
  assert.equal(r.statusCode, 200);
  assert.ok(!db.rows.gw_role_grants.some((g) => g.employee_id === "emp-e" && g.role === "manager"));
});

await ok("owner は、ほかの人に owner を付けられる。履歴が残る", async () => {
  setup(); who = OWNER;
  const r = await setRole("emp-e", "owner");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(owners(), ["emp-a", "emp-e"]);
  const h = logged.find((l) => l.action === "owner.grant");
  assert.ok(h, "owner.grant が残る");
  assert.equal(h.target, "employee:emp-e");
  assert.equal(h.tenantId, "t1");
});

await ok("退職した人には、owner を付けられない", async () => {
  setup(); who = OWNER;
  const r = await setRole("emp-l", "owner");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "employee_inactive");
  assert.deepEqual(owners(), ["emp-a"]);
});

await ok("別のテナントの人・存在しない人には付けられない", async () => {
  setup(); who = OWNER;
  db.rows.gw_employees.push({ id: "emp-z", tenant_id: "t2", user_id: "u-z", display_name: "他社", status: "active" });
  assert.equal((await setRole("emp-z", "owner")).statusCode, 404);
  assert.equal((await setRole("emp-none", "owner")).statusCode, 404);
});

await ok("owner が2人いれば、owner は自分の owner を外せる。履歴が残る", async () => {
  setup(); who = OWNER;
  db.rows.gw_role_grants.push({ id: "g9", tenant_id: "t1", employee_id: "emp-e", role: "owner" });
  const r = await setRole("emp-a", "owner", false);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(owners(), ["emp-e"]);
  const h = logged.find((l) => l.action === "owner.revoke");
  assert.ok(h);
  assert.equal(h.detail.self, true);
});

await ok("最後の owner は、自分でも外せない（経営画面に誰も入れなくなる）", async () => {
  setup(); who = OWNER;
  const r = await setRole("emp-a", "owner", false);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "last_owner");
  assert.deepEqual(owners(), ["emp-a"]);
  assert.ok(!logged.some((l) => l.action === "owner.revoke"), "外せていないので履歴も残さない");
});

await ok("退職済みの owner は人数に数えない（在籍中が1人なら、その人は外せない）", async () => {
  setup(); who = OWNER;
  db.rows.gw_role_grants.push({ id: "g8", tenant_id: "t1", employee_id: "emp-l", role: "owner" });
  const r = await setRole("emp-a", "owner", false);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "last_owner");
});

await ok("退職済みの owner なら、外しても在籍中の人数は減らないので外せる", async () => {
  setup(); who = OWNER;
  db.rows.gw_role_grants.push({ id: "g8", tenant_id: "t1", employee_id: "emp-l", role: "owner" });
  const r = await setRole("emp-l", "owner", false);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(owners(), ["emp-a"]);
});

console.log("\n=== owner の名簿（PATCH / DELETE /api/employees） ===\n");

await ok("人事は、owner を退職にできない（アカウントごと締め出せてしまう）", async () => {
  setup(); who = HR;
  const r = await patchEmp({ id: "emp-a", status: "left" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
  assert.equal(db.rows.gw_employees.find((x) => x.id === "emp-a").status, "active");
});

await ok("管理者は、owner の名簿を削除できない", async () => {
  setup(); who = ADMIN;
  const r = await delEmp("emp-a");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
  assert.ok(hasEmployee("emp-a"));
});

await ok("人事は、これまでどおり owner 以外の名簿を編集・退職・削除できる", async () => {
  setup(); who = HR;
  let r = await patchEmp({ id: "emp-e", position: "主任" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await patchEmp({ id: "emp-e", status: "left" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await delEmp("emp-l");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(!hasEmployee("emp-l"));
});

await ok("最後の owner は、owner 自身でも退職にできない", async () => {
  setup(); who = OWNER;
  const r = await patchEmp({ id: "emp-a", status: "leaving" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "last_owner");
  assert.equal(db.rows.gw_employees.find((x) => x.id === "emp-a").status, "active");
});

await ok("最後の owner は、名簿から削除できない（別の owner でも、自分の行以外は）", async () => {
  setup(); who = ctxOf(["owner"], { employee: { id: "emp-e" } });
  db.rows.gw_role_grants.push({ id: "g9", tenant_id: "t1", employee_id: "emp-e", role: "owner" });
  // owner が2人いる間は、片方がもう片方を消せる。1人になったら消せない
  let r = await delEmp("emp-a");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(!hasEmployee("emp-a"));
  db.rows.gw_role_grants = db.rows.gw_role_grants.filter((g) => g.employee_id !== "emp-a");
  who = ctxOf(["owner"], { employee: { id: "emp-x" } });
  r = await delEmp("emp-e");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "last_owner");
  assert.ok(hasEmployee("emp-e"));
});

await ok("owner が2人いれば、owner は他の owner を退職にできる", async () => {
  setup(); who = OWNER;
  db.rows.gw_role_grants.push({ id: "g9", tenant_id: "t1", employee_id: "emp-e", role: "owner" });
  const r = await patchEmp({ id: "emp-e", status: "left" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("一覧は、いまの利用者が owner を付け外しできるかを返す（画面の出し分け用）", async () => {
  setup();
  who = OWNER;
  let r = await call(employeesApi, { method: "GET", url: "/api/employees" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.canGrantOwner, true);
  who = HR;
  r = await call(employeesApi, { method: "GET", url: "/api/employees" });
  assert.equal(r.body.canGrantOwner, false);
  assert.equal(r.body.canGrantRoles, true, "ほかのロールは、これまでどおり付け外しできる");
});

console.log("\n=== owner のログイン（PATCH account / POST link） ===\n");

await ok("人事・管理者は、owner のパスワードを変えられない（変えるとなりすませる）", async () => {
  for (const c of [HR, ADMIN]) {
    setup(); who = c;
    const r = await patchAccount({ employeeId: "emp-a", password: "hacked-pass-1" });
    assert.equal(r.statusCode, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "owner_only");
    assert.equal(authCalls.length, 0, "認証側のパスワードは触られていない");
  }
});

await ok("人事は、owner のメールアドレスも変えられない", async () => {
  setup(); who = HR;
  const r = await patchAccount({ employeeId: "emp-a", email: "evil@example.com" });
  assert.equal(r.statusCode, 403);
  assert.equal(authCalls.length, 0);
  assert.equal(db.rows.gw_employees.find((x) => x.id === "emp-a").email, "emp-a@x");
});

await ok("人事は、owner のアカウントを別のログインに紐づけ直せない", async () => {
  setup(); who = HR;
  const r = await linkAccount({ employeeId: "emp-a", email: "evil@example.com" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "owner_only");
});

await ok("人事は、これまでどおり owner 以外のログインを変えられる", async () => {
  setup(); who = HR;
  const r = await patchAccount({ employeeId: "emp-e", password: "new-password-1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].id, "u-emp-e");
});

await ok("owner は、owner 自身のログインを変えられる", async () => {
  setup(); who = OWNER;
  const r = await patchAccount({ employeeId: "emp-a", password: "new-password-2" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(authCalls.length, 1);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
