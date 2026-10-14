// アプリ利用権限（gw_app_grants, db/119）の API。メンバー一覧の4ボタン（採用HR / Sales / Office / 経営）。
//
// ■ 何を守るテストか
//   1. gwContext が、アプリ利用権限（入口）と内部ロール（中身）を別に読む
//        表がある→行どおり / 表が無い（db/119 未適用）→内部ロールから移行の規則どおりに導出（権限は変わらない）
//        表が読めなかった（障害）→入口なし（権限を広げない）
//   2. POST /api/employees/apps
//        hr / sales / office … gw_app_grants の付け外し。経営（keiei）… 経営者（owner）の付け外し（経営者だけ・最後の1人は外せない）
//        人事・管理者だけ。他社の社員は触れない。経営者は変更できない（owner_locked）。表が無ければ 409
//        変更直後の応答に、4つのボタン・内部ロール・access・accessMeta が入る（画面はその場で同じ行を直す）
//   3. GET /api/employees が、人事・管理者だけに 4つのボタン（apps）・変更できない理由（appLocks）・access・accessMeta・appsState を返す
//   4. 内部ロールを付けても、入口は開かない（POST /api/employees/roles の応答でも同じ）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, absent: new Set(), broken: new Set() };
const logged = [];
let current = { userId: "u-emp-a", memberships: [] };

const ABSENT = { code: "PGRST205", message: "Could not find the table in the schema cache" };
const BROKEN = { code: "XX000", message: "boom" };

function table(name) {
  const f = [];
  const fail = () => (db.absent.has(name) ? ABSENT : db.broken.has(name) ? BROKEN : null);
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : Array.isArray(v) && v.includes(r[k]))));
  const copy = (r) => (r ? { ...r } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve(fail() ? { data: null, error: fail() } : { data: copy(rows()[0]), error: null }),
    then: (fn, rej) => Promise.resolve(fail() ? { data: null, error: fail() } : { data: rows().map(copy), error: null }).then(fn, rej),
    upsert(rowsIn, opts = {}) {
      if (fail()) return Promise.resolve({ data: null, error: fail() });
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
        then: (fn, rej) => {
          if (fail()) return Promise.resolve({ error: fail() }).then(fn, rej);
          db.rows[name] = (db.rows[name] || []).filter((x) => !g.every(([k, v]) => x[k] === v));
          return Promise.resolve({ error: null }).then(fn, rej);
        },
      };
      return r2;
    },
  };
  return q;
}
const client = () => ({ from: table });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: current.userId }), getMemberships: async (uid) => (uid === current.userId ? current.memberships : []) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/accounts.js"), { namedExports: {
  SYSTEMS: [], readAccounts: async () => new Map(), setAccountsActive: async () => ({}), removeAccountingAccess: async () => ({}),
  attachAccount: async () => ({ ok: true }), setSystemAccess: async () => ({ ok: true }), randomPassword: () => "pw", findUserByEmail: async () => null,
} });

const { gwContext, accessOf } = await import(atRoot("lib/gw.js"));
const { default: appsApi } = await import(atRoot("api/employees/apps.js"));
const { default: rolesApi } = await import(atRoot("api/employees/roles.js"));
const { default: employeesApi } = await import(atRoot("api/employees/index.js"));

const res = () => { const r = { statusCode: 0, body: null }; r.setHeader = () => {}; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const setApp = (employeeId, app, grant = true) => call(appsApi, { method: "POST", url: "/api/employees/apps", body: { employeeId, app, grant } });
const setRole = (employeeId, role, grant = true) => call(rolesApi, { method: "POST", url: "/api/employees/roles", body: { employeeId, role, grant } });
const list = () => call(employeesApi, { method: "GET", url: "/api/employees" });

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

// 登場人物：社長(owner)・人事(hr+hr/office)・責任者(manager)・経理(finance)・一般・会計の管理者（名簿に行あり・内部ロールなし）・他社
const as = (id, memberships = []) => { current = { userId: `u-${id}`, memberships }; };
const staff = (tenant = "t1") => [{ role: "staff", tenant_id: tenant }];
function setup() {
  db.absent = new Set(); db.broken = new Set(); logged.length = 0;
  as("emp-a");
  const e = (id, name, tenant = "t1", status = "active") => ({ id, tenant_id: tenant, user_id: `u-${id}`, display_name: name, email: `${id}@x`, status });
  db.rows = {
    gw_employees: [e("emp-a", "社長"), e("emp-c", "人事"), e("emp-d", "責任者"), e("emp-f", "経理"), e("emp-e", "一般"), e("emp-b", "会計管理者"), e("emp-x", "他社", "t2")],
    gw_role_grants: [
      { id: "g1", tenant_id: "t1", employee_id: "emp-a", role: "owner" },
      { id: "g2", tenant_id: "t1", employee_id: "emp-c", role: "hr" },
      { id: "g3", tenant_id: "t1", employee_id: "emp-d", role: "manager" },
      { id: "g4", tenant_id: "t1", employee_id: "emp-f", role: "finance" },
    ],
    // db/119 の移行どおり（manager→hr,sales,office / hr→hr,office / finance→office）
    gw_app_grants: [
      ...["hr", "sales", "office"].map((k) => ({ tenant_id: "t1", employee_id: "emp-d", app_key: k })),
      ...["hr", "office"].map((k) => ({ tenant_id: "t1", employee_id: "emp-c", app_key: k })),
      { tenant_id: "t1", employee_id: "emp-f", app_key: "office" },
    ],
    memberships: [{ user_id: "u-emp-b", tenant_id: "t1", role: "staff" }],
  };
}
const appRows = (id) => (db.rows.gw_app_grants || []).filter((g) => g.employee_id === id).map((g) => g.app_key).sort();

console.log("\n=== gwContext：入口（アプリ利用権限）と中身（内部ロール）を別に読む ===\n");

await ok("表がある：入口は行どおり。isHr は「hr かつ Office の入口」（Office OFF の hr は人事の管理権限を持たない）", async () => {
  setup();
  as("emp-c"); let c = await gwContext("u-emp-c");
  assert.deepEqual(c.apps, ["hr", "office"]); assert.equal(c.appsState, "table"); assert.equal(c.isHr, true);
  db.rows.gw_app_grants = db.rows.gw_app_grants.filter((g) => !(g.employee_id === "emp-c" && g.app_key === "office"));
  c = await gwContext("u-emp-c");
  assert.deepEqual(c.apps, ["hr"]); assert.equal(c.isHr, false, "Office を OFF にした hr は、人事の管理権限を持たない");
  assert.equal(accessOf(c).officeHr, false); assert.equal(accessOf(c).recruit, true, "採用HR（入口 hr）は残る");
});

await ok("表がある：内部ロールを持っているだけでは、入口は開かない（経理に finance があっても、Office を外せば何も開かない）", async () => {
  setup();
  db.rows.gw_app_grants = db.rows.gw_app_grants.filter((g) => g.employee_id !== "emp-f");
  as("emp-f"); const c = await gwContext("u-emp-f");
  assert.deepEqual(c.apps, []);
  const a = accessOf(c);
  assert.deepEqual([a.office, a.officeFinance, a.officeApp, a.recruit, a.sell], [false, false, false, false, false]);
});

await ok("表が無い（db/119 未適用）：内部ロールから移行の規則どおりに導出。権限は移行前と同じ", async () => {
  setup(); db.absent.add("gw_app_grants");
  as("emp-d"); const m = await gwContext("u-emp-d");
  assert.equal(m.appsState, "derived"); assert.deepEqual(m.apps, ["hr", "sales", "office"]);
  assert.deepEqual([accessOf(m).recruit, accessOf(m).sell, accessOf(m).office, accessOf(m).officeHr], [true, true, true, false]);
  as("emp-c"); const h = await gwContext("u-emp-c");
  assert.deepEqual([accessOf(h).recruit, accessOf(h).officeHr, accessOf(h).office, h.isHr], [true, true, false, true], "hr：採用HR・人事・労務。月末月初は使えない（移行前と同じ）");
});

await ok("表が読めなかった（障害）：入口なし。権限を広げない（経営者・会計の管理者の暗黙の入口は残る）", async () => {
  setup(); db.broken.add("gw_app_grants");
  as("emp-d"); const m = await gwContext("u-emp-d");
  assert.equal(m.appsState, "error"); assert.deepEqual(m.apps, []);
  assert.deepEqual([accessOf(m).recruit, accessOf(m).sell, accessOf(m).office], [false, false, false]);
  as("emp-a"); const o = await gwContext("u-emp-a");
  assert.deepEqual([accessOf(o).recruit, accessOf(o).sell, accessOf(o).officeApp, accessOf(o).keiei], [true, true, true, true]);
});

console.log("\n=== POST /api/employees/apps ===\n");

await ok("hr / sales / office を付ける・外す。行ができる・消える。履歴（app.grant / app.revoke）に残る", async () => {
  setup();
  const on = await setApp("emp-e", "sales");
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  assert.deepEqual(appRows("emp-e"), ["sales"]);
  assert.equal(on.body.granted, true); assert.equal(on.body.app, "sales");
  assert.equal(logged.at(-1).action, "app.grant"); assert.deepEqual(logged.at(-1).detail, { app: "sales" });
  const off = await setApp("emp-e", "sales", false);
  assert.equal(off.statusCode, 200); assert.deepEqual(appRows("emp-e"), []);
  assert.equal(logged.at(-1).action, "app.revoke");
});

await ok("同じものを2回付けても、行は1つ（二重にならない）", async () => {
  setup();
  await setApp("emp-e", "hr"); await setApp("emp-e", "hr");
  assert.deepEqual(appRows("emp-e"), ["hr"]);
});

await ok("応答に、4つのボタン・内部ロール・access・accessMeta が入る（画面はその場で同じ行を直す）", async () => {
  setup();
  const r = await setApp("emp-e", "office");
  assert.deepEqual(r.body.apps, { hr: false, sales: false, office: true, keiei: false });
  assert.deepEqual(r.body.roles, []); assert.equal(r.body.appsState, "table");
  assert.equal(r.body.accessMeta.accountingAdmin, false);
  assert.equal(r.body.access.officeApp, true, "Office に入れる");
  assert.deepEqual([r.body.access.officeHr, r.body.access.officeFinance, r.body.access.office], [false, false, false], "Office ON だけでは、中身は使えない");
});

await ok("Office を ON にする ＋ 内部ロール hr ＝ 人事・労務（ボタンと詳細設定の組合せ）", async () => {
  setup();
  await setApp("emp-e", "office");
  const r = await setRole("emp-e", "hr");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.access.officeHr, true); assert.equal(r.body.access.office, false, "hr に月末月初は付かない");
  assert.deepEqual(r.body.apps, { hr: false, sales: false, office: true, keiei: false }, "hr（内部ロール）は、採用HRのボタンを ON にしない");
});

await ok("内部ロールを付けても、入口は開かない（finance を付けても、Office を ON にするまで何も使えない）", async () => {
  setup();
  const r = await setRole("emp-e", "finance");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.roles, ["finance"]);
  assert.deepEqual([r.body.access.officeFinance, r.body.access.office, r.body.access.officeApp], [false, false, false]);
  assert.deepEqual(r.body.apps, { hr: false, sales: false, office: false, keiei: false });
});

await ok("経営者（owner）は変更できない（全部のアプリを使える。行を作らない）", async () => {
  setup();
  const r = await setApp("emp-a", "sales", false);
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "owner_locked");
  assert.deepEqual(appRows("emp-a"), []);
});

await ok("人事・管理者だけ。一般・責任者は403。他社の社員は404", async () => {
  setup();
  as("emp-e"); assert.equal((await setApp("emp-c", "sales")).statusCode, 403);
  as("emp-d"); assert.equal((await setApp("emp-c", "sales")).statusCode, 403, "責任者は人事の管理権限ではない");
  as("emp-c"); assert.equal((await setApp("emp-e", "sales")).statusCode, 200, "人事は付けられる");
  as("emp-b", staff()); assert.equal((await setApp("emp-e", "hr")).statusCode, 200, "会計の管理者は付けられる");
  assert.equal((await setApp("emp-x", "sales")).statusCode, 404, "他社の社員");
  assert.deepEqual(appRows("emp-x"), []);
});

await ok("経営者でない人は、自分のアプリを変えられない（403 self_change・何も書かない・履歴も無い。2026-10-07 固定ルール）", async () => {
  setup(); as("emp-c");
  const before = appRows("emp-c");
  for (const [app, grant] of [["office", false], ["sales", true], ["hr", true]]) {
    const r = await setApp("emp-c", app, grant);
    assert.equal(r.statusCode, 403, `${app}`); assert.equal(r.body.error, "self_change");
  }
  assert.deepEqual(appRows("emp-c"), before);
  assert.equal(logged.length, 0);
  // ほかの人のアプリは、これまでどおり変えられる
  assert.equal((await setApp("emp-e", "sales")).statusCode, 200);
  // 管理者（会計の staff）も同じ
  as("emp-b", staff());
  const b = await setApp("emp-b", "hr");
  assert.equal(b.statusCode, 403); assert.equal(b.body.error, "self_change");
});

await ok("経営者は、自分のアプリも変えられる（経営者は全部のアプリ＝ owner_locked。自分の行を作る必要が無い）", async () => {
  setup(); as("emp-a");
  const r = await setApp("emp-a", "sales");
  assert.notEqual(r.body.error, "self_change");
});

await ok("入力チェック：app が無い・知らない app は400。メソッドは POST だけ", async () => {
  setup();
  assert.equal((await call(appsApi, { method: "POST", url: "/x", body: { employeeId: "emp-e" } })).statusCode, 400);
  const bad = await setApp("emp-e", "finance");
  assert.equal(bad.statusCode, 400); assert.equal(bad.body.error, "invalid_app");
  assert.equal((await call(appsApi, { method: "GET", url: "/x" })).statusCode, 405);
});

await ok("表が無い（db/119 未適用）：409 app_grants_unavailable。何も書かない", async () => {
  setup(); db.absent.add("gw_app_grants");
  const r = await setApp("emp-e", "sales");
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "app_grants_unavailable");
  assert.equal(logged.length, 0, "履歴にも残さない");
});

console.log("\n=== 経営（keiei）＝ 経営者（owner）の付け外し ===\n");

await ok("経営者だけが付けられる。保存先は内部ロール owner（gw_app_grants には保存しない）", async () => {
  setup();
  const r = await setApp("emp-e", "keiei");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(db.rows.gw_role_grants.some((g) => g.employee_id === "emp-e" && g.role === "owner"));
  assert.deepEqual(appRows("emp-e"), [], "経営は表に保存しない");
  assert.deepEqual(r.body.apps, { hr: true, sales: true, office: true, keiei: true }, "owner は4つとも ON");
  assert.equal(r.body.appLocks.keiei, "owner");
  assert.ok(logged.some((l) => l.action === "owner.grant"), "経営者の付与は履歴に残る");
});

await ok("経営者でない人（人事・管理者）は、経営を変えられない（403 owner_only）", async () => {
  setup();
  as("emp-c"); let r = await setApp("emp-e", "keiei");
  assert.equal(r.statusCode, 403); assert.equal(r.body.error, "owner_only");
  as("emp-b", staff()); r = await setApp("emp-e", "keiei");
  assert.equal(r.statusCode, 403); assert.equal(r.body.error, "owner_only");
  assert.ok(!db.rows.gw_role_grants.some((g) => g.employee_id === "emp-e"));
});

await ok("最後の経営者は外せない。2人目がいれば外せる（履歴に残る）", async () => {
  setup();
  const sole = await setApp("emp-a", "keiei", false);
  assert.notEqual(sole.statusCode, 200, "最後の経営者は外せない");
  assert.ok(db.rows.gw_role_grants.some((g) => g.employee_id === "emp-a" && g.role === "owner"));
  await setApp("emp-e", "keiei");
  const two = await setApp("emp-e", "keiei", false);
  assert.equal(two.statusCode, 200, JSON.stringify(two.body));
  assert.ok(logged.some((l) => l.action === "owner.revoke"));
});

console.log("\n=== GET /api/employees：一覧に返す、4つのボタン・理由・access ===\n");

await ok("人事・管理者には、各人の4つのボタン（apps）・変更できない理由（appLocks）・access・accessMeta・appsState を返す", async () => {
  setup(); as("emp-c");
  const r = await list();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.appsState, "table");
  const by = Object.fromEntries(r.body.employees.map((e) => [e.id, e]));
  assert.deepEqual(by["emp-a"].apps, { hr: true, sales: true, office: true, keiei: true }); assert.equal(by["emp-a"].appLocks.keiei, "owner");
  assert.deepEqual(by["emp-d"].apps, { hr: true, sales: true, office: true, keiei: false });
  assert.deepEqual(by["emp-c"].apps, { hr: true, sales: false, office: true, keiei: false });
  assert.deepEqual(by["emp-f"].apps, { hr: false, sales: false, office: true, keiei: false });
  assert.deepEqual(by["emp-e"].apps, { hr: false, sales: false, office: false, keiei: false });
  assert.deepEqual(by["emp-b"].apps, { hr: false, sales: false, office: true, keiei: false }); assert.equal(by["emp-b"].appLocks.office, "accountingAdmin");
  assert.equal(by["emp-b"].accessMeta.accountingAdmin, true);
  assert.equal(by["emp-d"].access.office, true, "責任者：月末月初"); assert.equal(by["emp-d"].access.officeHr, false);
  assert.deepEqual(by["emp-c"].roles, ["hr"], "内部ロールは roles に残る（詳細設定で使う）");
  assert.equal(by["emp-e"].access.recruit, false);
});

await ok("一覧の access は、本人が /api/me で受け取る access（gwContext → accessOf）と同じ（全員）", async () => {
  setup(); as("emp-a");
  const r = await list();
  for (const e of r.body.employees.filter((x) => x.tenant_id === "t1")) {
    as(e.id.replace(/^/, ""), e.id === "emp-b" ? staff() : []);
    const mine = accessOf({ ...(await gwContext(`u-${e.id}`)) });
    for (const k of ["recruit", "sell", "office", "officeApp", "officeHr", "officeFinance", "keiei"]) assert.equal(Boolean(e.access[k]), Boolean(mine[k]), `${e.display_name}: ${k}`);
  }
});

await ok("表が無い間（db/119 未適用）：appsState=derived。ボタンは内部ロールからの導出（変更はできない）", async () => {
  setup(); db.absent.add("gw_app_grants"); as("emp-c");
  const r = await list();
  assert.equal(r.body.appsState, "derived");
  const by = Object.fromEntries(r.body.employees.map((e) => [e.id, e]));
  assert.deepEqual(by["emp-d"].apps, { hr: true, sales: true, office: true, keiei: false });
  assert.deepEqual(by["emp-f"].apps, { hr: false, sales: false, office: true, keiei: false });
});

await ok("表が読めない間：appsState=error（画面は「確認できません」）。入口は出さない", async () => {
  setup(); db.broken.add("gw_app_grants"); as("emp-b", staff());   // 会計の管理者（暗黙の権限）で見る。hr は Office の入口が読めないので管理権限を持たない（権限を広げない）
  const r = await list();
  assert.equal(r.body.appsState, "error");
  assert.deepEqual(r.body.employees.find((e) => e.id === "emp-d").apps, { hr: false, sales: false, office: false, keiei: false });
});

await ok("人事・管理者でない人（一般・責任者）には、apps・access・appsState を返さない", async () => {
  setup(); as("emp-e");
  const r = await list();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.appsState, null);
  for (const e of r.body.employees) for (const k of ["apps", "appLocks", "access", "accessMeta"]) assert.ok(!(k in e), `${e.display_name}: ${k}`);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
