// メンバー管理（GET /api/employees）の access・4つのボタンが、「誰が見ても」「本人の /api/me」と同じになること。
//
// ■ 起きていた不具合
//   同じ社員について、経営者でログインすると「人事・労務／経理・事務／月末月初」が ON なのに、
//   本人（人事）でログインすると「Office内の権限が未設定です」と出た。
//   gw_role_grants の RLS（is_tenant_staff）は、会計側の管理者でない人には行を返さず「空」になる。
//   api/employees/index.js はそれを userClient で読み、空配列を accessForMember に渡していたため、
//   本人（canManageHr を通る人事）だけ「内部ロールが0件」として計算されていた。
//
// ■ 守るもの
//   1. 管理権限（canManageHr）を通った人は、認可後に admin() で内部ロールを読む（RLS で空になった値から access を作らない）
//   2. 経営者から見た社員Aの access・4つのボタン・roles と、本人（A）でログインして見たものが一致する
//   3. それが、本人の /api/me（gwContext → accessOf）の officeHr / officeFinance / office と一致する（SSOT）
//   4. hr / finance / manager どれでも同じ。Office ON で実際にロールがある人には「未設定」の判定が出ない
//   5. 本当に内部ロールが0件の社員だけ「未設定」になる（経営者から見ても、本人から見ても）
//   6. 管理権限の無い人（一般メンバー等）には access を返さない（従来どおり。読めない値から推測しない）
//   7. 内部ロールが読めなかったら、空として扱わずエラー
//   8. 自分自身の権限変更は禁止のまま（roles・apps とも 403 self_change）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, absent: new Set(), broken: new Set() };
const logged = [];
let current = { userId: "u-emp-o", memberships: [] };
const reads = { user: [], admin: [], adminCount: 0 };      // どちらの道具で gw_role_grants を読んだか

const BROKEN = { code: "XX000", message: "boom" };

function table(name, via) {
  const f = [];
  // db.failNth：gw_role_grants を admin() で読む N 回目だけ失敗させる（1回目は gwContext。ハンドラが読む2回目だけを壊す）
  const nth = name === "gw_role_grants" && via === "admin" ? ++reads.adminCount : 0;
  const fail = () => (db.failNth && nth === db.failNth ? BROKEN : db.broken.has(`${name}:${via}`) || db.broken.has(name) ? BROKEN : null);
  // RLS（gw_role_grants_select = is_tenant_staff）：会計側の管理者（memberships の admin / staff）でない人が userClient で読むと空
  const rlsHidden = () => via === "user" && name === "gw_role_grants" && !current.memberships.some((m) => m.role === "admin" || m.role === "staff");
  const rows = () => (rlsHidden() ? [] : (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : Array.isArray(v) && v.includes(r[k])))));
  const copy = (r) => (r ? { ...r } : null);
  const q = {
    select() { if (name === "gw_role_grants") reads[via].push(current.userId); return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve(fail() ? { data: null, error: fail() } : { data: copy(rows()[0]), error: null }),
    then: (fn, rej) => Promise.resolve(fail() ? { data: null, error: fail() } : { data: rows().map(copy), error: null }).then(fn, rej),
    upsert(rowsIn, opts = {}) {
      const keyOf = (r) => (opts.onConflict || "id").split(",").map((k) => r[k]).join("|");
      for (const r of [].concat(rowsIn)) {
        const list = (db.rows[name] = db.rows[name] || []);
        const i = list.findIndex((x) => keyOf(x) === keyOf(r));
        if (i >= 0) { if (!opts.ignoreDuplicates) Object.assign(list[i], r); } else list.push({ id: `${name}-${list.length + 1}`, ...r });
      }
      return Promise.resolve({ data: null, error: null });
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        then: (fn, rej) => { db.rows[name] = (db.rows[name] || []).filter((x) => !g.every(([k, v]) => x[k] === v)); return Promise.resolve({ error: null }).then(fn, rej); },
      };
      return r2;
    },
  };
  return q;
}
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: (n) => table(n, "admin") }), userClient: () => ({ from: (n) => table(n, "user") }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: current.userId }), getMemberships: async (uid) => (uid === current.userId ? current.memberships : []) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/accounts.js"), { namedExports: {
  SYSTEMS: [], readAccounts: async () => new Map(), setAccountsActive: async () => ({}), removeAccountingAccess: async () => ({}),
  attachAccount: async () => ({ ok: true }), setSystemAccess: async () => ({ ok: true }), randomPassword: () => "pw", findUserByEmail: async () => null,
} });

const { gwContext, accessOf } = await import(atRoot("lib/gw.js"));
const { default: employeesApi } = await import(atRoot("api/employees/index.js"));
const { default: rolesApi } = await import(atRoot("api/employees/roles.js"));
const { default: appsApi } = await import(atRoot("api/employees/apps.js"));

const res = () => { const r = { statusCode: 0, body: null }; r.setHeader = () => {}; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const list = () => call(employeesApi, { method: "GET", url: "/api/employees" });
const rowOf = (r, id) => (r.body.employees || []).find((e) => e.id === id);

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

const as = (id, memberships = []) => { current = { userId: `u-${id}`, memberships }; };
const staff = () => [{ role: "staff", tenant_id: "t1" }];
// 画面（admin-members.html）の officeEmpty と同じ判定：Office ON なのに、中で使える業務が無い
const officeEmpty = (e) => Boolean(e.apps?.office && e.access && !(e.access.office || e.access.officeHr || e.access.officeFinance));

function setup() {
  db.broken = new Set(); db.failNth = 0; logged.length = 0; reads.user.length = 0; reads.admin.length = 0; reads.adminCount = 0;
  const e = (id, name) => ({ id, tenant_id: "t1", user_id: `u-${id}`, display_name: name, email: `${id}@x`, status: "active" });
  db.rows = {
    gw_employees: [e("emp-o", "社長"), e("emp-a", "社員A 人事"), e("emp-f", "経理"), e("emp-m", "責任者"), e("emp-f2", "経理（会計管理者）"), e("emp-m2", "責任者（会計管理者）"), e("emp-z", "ロール0件"), e("emp-g", "一般")],
    gw_role_grants: [
      { id: "g1", tenant_id: "t1", employee_id: "emp-o", role: "owner" },
      { id: "g2", tenant_id: "t1", employee_id: "emp-a", role: "hr" },
      { id: "g3", tenant_id: "t1", employee_id: "emp-f", role: "finance" },
      { id: "g4", tenant_id: "t1", employee_id: "emp-m", role: "manager" },
      { id: "g5", tenant_id: "t1", employee_id: "emp-f2", role: "finance" },
      { id: "g6", tenant_id: "t1", employee_id: "emp-m2", role: "manager" },
    ],
    // db/119：入口。Office ON のロール0件の人（emp-z）も作る
    gw_app_grants: [
      ...["hr", "office"].map((k) => ({ tenant_id: "t1", employee_id: "emp-a", app_key: k })),
      { tenant_id: "t1", employee_id: "emp-f", app_key: "office" },
      ...["hr", "sales", "office"].map((k) => ({ tenant_id: "t1", employee_id: "emp-m", app_key: k })),
      { tenant_id: "t1", employee_id: "emp-f2", app_key: "office" },
      ...["hr", "sales", "office"].map((k) => ({ tenant_id: "t1", employee_id: "emp-m2", app_key: k })),
      { tenant_id: "t1", employee_id: "emp-z", app_key: "office" },
    ],
    // 経営者・会計の管理者は memberships の staff（RLS で gw_role_grants を読める人）。社員A（人事）は読めない
    memberships: [{ user_id: "u-emp-o", tenant_id: "t1", role: "staff" }, { user_id: "u-emp-f2", tenant_id: "t1", role: "staff" }, { user_id: "u-emp-m2", tenant_id: "t1", role: "staff" }],
  };
}
const asOwner = () => as("emp-o", staff());
const same = (a, b, msg) => assert.deepEqual(a, b, msg);
const view = (e) => ({ roles: [...(e.roles || [])].sort(), access: e.access, accessMeta: e.accessMeta, apps: e.apps, appLocks: e.appLocks });

console.log("\n=== 経営者から見た社員Aと、本人でログインして見た社員Aが一致する ===\n");

await ok("経営者から見た社員A：Office ON・hr ON（人事・労務）。「未設定」ではない", async () => {
  setup(); asOwner();
  const r = await list();
  assert.equal(r.statusCode, 200);
  const a = rowOf(r, "emp-a");
  assert.deepEqual(a.roles, ["hr"]);
  assert.equal(a.apps.office, true);
  assert.equal(a.access.officeHr, true);
  assert.equal(officeEmpty(a), false);
});

await ok("社員A本人でログイン：人事・労務が ON として判定される。経営者から見たものと完全に一致", async () => {
  setup(); asOwner(); const owner = rowOf(await list(), "emp-a");
  as("emp-a");                                         // 会計の管理者ではない（RLS で gw_role_grants は空になる立場）
  const r = await list();
  assert.equal(r.statusCode, 200);
  const self = rowOf(r, "emp-a");
  assert.deepEqual(self.roles, ["hr"], "内部ロールが空にならない");
  assert.equal(self.access.officeHr, true, "人事・労務が ON");
  assert.equal(self.apps.office, true);
  same(view(self), view(owner), "access・accessMeta・apps・appLocks・roles が、経営者の画面と同じ");
});

await ok("警告「Office内の権限が未設定」が出ない（本人でも、経営者でも）", async () => {
  setup(); as("emp-a");
  const self = await list();
  assert.equal((self.body.employees || []).filter(officeEmpty).map((e) => e.display_name).includes("社員A 人事"), false);
  asOwner();
  const owner = await list();
  assert.equal((owner.body.employees || []).filter(officeEmpty).map((e) => e.display_name).includes("社員A 人事"), false);
});

await ok("本人の /api/me（gwContext → accessOf）の officeHr / officeFinance / office と一致する（SSOT）", async () => {
  setup();
  for (const [id, viewerAs] of [["emp-a", () => as("emp-a")], ["emp-f2", () => as("emp-f2", staff())], ["emp-m2", () => as("emp-m2", staff())], ["emp-z", null]]) {
    asOwner();
    const row = rowOf(await list(), id);
    as(id, id === "emp-f2" || id === "emp-m2" ? staff() : []);
    const me = accessOf(await gwContext(`u-${id}`));
    for (const k of ["officeHr", "officeFinance", "office", "recruit", "sell"]) assert.equal(row.access[k], me[k], `${id} の ${k}：メンバー管理 ${row.access[k]} ／ 本人の /api/me ${me[k]}`);
    void viewerAs;
  }
});

console.log("\n=== finance・manager も同じ ===\n");

for (const [label, id, key] of [["経理（finance）", "emp-f2", "officeFinance"], ["責任者（manager）", "emp-m2", "office"]]) {
  await ok(`${label}：経営者から見た行と、本人（会計の管理者として管理画面を開ける）から見た行が一致。「未設定」は出ない`, async () => {
    setup(); asOwner(); const owner = rowOf(await list(), id);
    as(id, staff()); const self = rowOf(await list(), id);
    assert.equal(owner.access[key], true);
    same(view(self), view(owner));
    assert.equal(officeEmpty(self), false);
    assert.equal(officeEmpty(owner), false);
  });
}
await ok("経理・責任者（管理画面に入れない立場）には、access・4つのボタンを返さない。空の値から推測した表示も作らない", async () => {
  setup();
  for (const id of ["emp-f", "emp-m", "emp-g"]) {
    as(id);
    const r = await list();
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.canManage, false);
    for (const e of r.body.employees) {
      assert.equal(e.access, undefined, `${id} が見る ${e.display_name} に access が入っている`);
      assert.equal(e.apps, undefined);
      assert.equal(officeEmpty(e), false, "「未設定」は判定されない");
    }
  }
});

console.log("\n=== 本当に内部ロールが0件の社員だけ、警告が出る ===\n");

await ok("Office ON・内部ロール0件の社員（emp-z）は「未設定」。経営者から見ても、人事（本人でない人）から見ても同じ", async () => {
  setup(); asOwner();
  const owner = await list();
  assert.deepEqual(owner.body.employees.filter(officeEmpty).map((e) => e.id), ["emp-z"]);
  as("emp-a");
  const hr = await list();
  assert.deepEqual(hr.body.employees.filter(officeEmpty).map((e) => e.id), ["emp-z"], "実際にロールがある人（A・経理・責任者）には出ない");
  same(view(rowOf(hr, "emp-z")), view(rowOf(owner, "emp-z")));
});

await ok("ロールを付けた直後は、その人の「未設定」が消える（付けた内容がそのまま access に出る）", async () => {
  setup();
  db.rows.gw_role_grants.push({ id: "g9", tenant_id: "t1", employee_id: "emp-z", role: "finance" });
  as("emp-a");
  const z = rowOf(await list(), "emp-z");
  assert.equal(z.access.officeFinance, true);
  assert.equal(officeEmpty(z), false);
});

console.log("\n=== 読み方：認可したあとだけ admin()。読めなかったら空にせずエラー ===\n");

await ok("管理権限を通った人（人事）は admin() で、通らない人（一般）は userClient で読む", async () => {
  setup(); as("emp-a"); await list();
  assert.deepEqual([reads.admin.length >= 2, reads.user.length], [true, 0], "人事：gwContext と一覧の両方が admin()。userClient では読まない");
  reads.user.length = 0; reads.admin.length = 0;
  as("emp-g"); await list();
  assert.deepEqual([reads.user.length, reads.admin.length], [1, 1], "一般メンバー：一覧は userClient（RLS が許す範囲）。admin() は本人の gwContext だけ");
});

await ok("管理権限が無い人には、他人の内部ロールを広げて見せない（RLS のまま：空）", async () => {
  setup(); as("emp-g");
  const r = await list();
  assert.ok(r.body.employees.every((e) => e.roles.length === 0), "一般メンバーには、他人の内部ロールは返らない");
});

await ok("内部ロールを読めなかったら、空として扱わず 500（access を誤って計算しない）", async () => {
  setup(); as("emp-a");
  db.failNth = 2;
  const r = await list();
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error, "db_query_failed");
  assert.equal(r.body.employees, undefined);
});

await ok("画面（admin-members.html）の officeEmpty は、サーバの access だけで決める（役割名で作り直さない）", () => {
  const src = readFileSync(atRoot("admin-members.html"), "utf8");
  assert.match(src, /return !\(ac\.office \|\| ac\.officeHr \|\| ac\.officeFinance\);/);
  assert.match(src, /if \(!e\.access\) return false;/);
});

console.log("\n=== 自分自身の権限変更は禁止のまま ===\n");

await ok("社員A（人事）が自分の内部ロールを付けようとしても 403 self_change。何も変わらない", async () => {
  setup(); as("emp-a");
  const before = JSON.stringify(db.rows.gw_role_grants);
  for (const role of ["manager", "finance", "owner"]) {
    const r = await call(rolesApi, { method: "POST", url: "/api/employees/roles", body: { employeeId: "emp-a", role, grant: true } });
    assert.equal(r.statusCode, 403, role);
    assert.ok(["self_change", "owner_only"].includes(r.body.error), r.body.error);
  }
  const r2 = await call(rolesApi, { method: "POST", url: "/api/employees/roles", body: { employeeId: "emp-a", role: "hr", grant: false } });
  assert.equal(r2.statusCode, 403);
  assert.equal(r2.body.error, "self_change");
  assert.equal(JSON.stringify(db.rows.gw_role_grants), before, "gw_role_grants は変わらない");
});

await ok("社員A（人事）が自分のアプリ利用権限（Sales など）を付けようとしても 403。何も変わらない", async () => {
  setup(); as("emp-a");
  const before = JSON.stringify(db.rows.gw_app_grants);
  const r = await call(appsApi, { method: "POST", url: "/api/employees/apps", body: { employeeId: "emp-a", app: "sales", grant: true } });
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.stringify(db.rows.gw_app_grants), before);
});

await ok("管理画面に入れる人が、他人（経理）の権限を変える動作は、これまでどおり通る（本人だけが禁止）", async () => {
  setup(); asOwner();
  const r = await call(rolesApi, { method: "POST", url: "/api/employees/roles", body: { employeeId: "emp-z", role: "finance", grant: true } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.access?.officeFinance, true);
});

console.log(`\n${pass} ok / ${fail} NG`);
process.exit(fail ? 1 : 0);
