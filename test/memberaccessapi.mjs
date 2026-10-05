// メンバー管理の「利用できる業務」: 表示と実効権限が一致しているか。
//
// ■ 何を守るのか
//   名簿の各行に出す「利用できる業務」（採用HR・Sales・Office（人事・労務／経理・事務／月末月初）・経営）は、
//   その人が画面を再読込したあとに /api/me で受け取る access と同じ。画面で条件を書き直さない。
//     ・/api/employees（名簿）が、各行に access を付ける。判定は lib/gw.js の accessOf そのもの
//     ・/api/employees/roles（社内権限のチェック）が、変更後のその人の roles と access を返す
//       → 画面は同じ行をその場で直せる（名簿を取り直さない）
//     ・そのあと本人が /api/me を読むと、同じ access が返る（再読込で最新の access が反映される）
//   権限の判定・DB・SQL は変えていない。足したのは、表示のための応答の項目だけ。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, fail: new Set() };
const jwt = { id: "u-x" };

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    return true;
  }));
  const copy = (r) => (r ? { ...r } : null);
  const err = () => (db.fail.has(name) ? { message: `${name} を読めません` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: err() ? null : copy(rows()[0]), error: err() }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: err() }),
    then: (fn) => Promise.resolve({ data: err() ? null : rows().map(copy), error: err() }).then(fn),
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

const client = () => ({ from: table });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(atRoot("lib/auth.js"), {
  namedExports: {
    requireUser: async () => ({ id: jwt.id, email: `${jwt.id}@example.com` }),
    getMemberships: async (uid) => (db.rows.memberships || []).filter((m) => m.user_id === uid),
  },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true, mfaState: () => ({ required: false, enrolled: false }) } });
// 「利用中のシステム」の読み取り（readAccounts）。access の元には使わない（access の元は memberships）。
//   db.accountsFail … 読めなかった（例外）
//   db.accountsView … 読めたときの見え方（user_id → { accounting: { role } }）。memberships とわざとずらして、混ざらないことを見る
mock.module(atRoot("lib/accounts.js"), { namedExports: {
  SYSTEMS: [], readAccounts: async (_sb, ids) => {
    if (db.accountsFail) throw new Error("accounts を読めません");
    return new Map((ids || []).filter(Boolean).map((id) => [id, db.accountsView?.[id] || {}]));
  },
  setAccountsActive: async () => ({}), removeAccountingAccess: async () => ({}),
  attachAccount: async () => ({ ok: true }), setSystemAccess: async () => ({ ok: true }),
  randomPassword: () => "pw", findUserByEmail: async () => null,
} });

// 判定は本物。ログインしている人（gwContext）は、本物の gwContext が（上の偽の DB から）組み立てる
const GW = await import(atRoot("lib/gw.js"));

const { default: employeesApi } = await import(atRoot("api/employees/index.js"));
const { default: rolesApi } = await import(atRoot("api/employees/roles.js"));
const { default: meApi } = await import(atRoot("api/me.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req, as) => {
  if (as) jwt.id = as;
  const r = res();
  await h({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const list = (as) => call(employeesApi, { method: "GET", url: "/api/employees" }, as);
const setRole = (employeeId, role, grant, as = "u-own") => call(rolesApi, { method: "POST", url: "/api/employees/roles", body: { employeeId, role, grant } }, as);
const me = (as) => call(meApi, { method: "GET", url: "/api/me" }, as);

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const emp = (id, name, user, extra = {}) => ({ id, tenant_id: "t1", user_id: user, display_name: name, email: user ? `${user}@example.com` : null,
  department: "開発", position: null, employment_type: "正社員", joined_on: "2025-04-01", status: "active", created_at: "2025-04-01", ...extra });

function setup() {
  db.fail = new Set();
  db.accountsFail = false;
  db.accountsView = {};
  jwt.id = "u-own";
  db.rows = {
    gw_employees: [
      emp("e-own", "経営 太郎", "u-own"), emp("e-hr", "人事 花子", "u-hr"), emp("e-fin", "経理 一郎", "u-fin"),
      emp("e-mgr", "責任 二郎", "u-mgr"), emp("e-rec", "採用 三郎", "u-rec"), emp("e-sales", "営業 四郎", "u-sales"),
      emp("e-it", "IT 五郎", "u-it"), emp("e-adm", "管理 六郎", "u-adm"), emp("e-none", "一般 七郎", "u-none"),
      emp("e-nouser", "未連携 八郎", null),
    ],
    gw_role_grants: [
      { tenant_id: "t1", employee_id: "e-own", role: "owner" }, { tenant_id: "t1", employee_id: "e-hr", role: "hr" },
      { tenant_id: "t1", employee_id: "e-fin", role: "finance" }, { tenant_id: "t1", employee_id: "e-mgr", role: "manager" },
      { tenant_id: "t1", employee_id: "e-rec", role: "recruiter" }, { tenant_id: "t1", employee_id: "e-sales", role: "sales" },
      { tenant_id: "t1", employee_id: "e-it", role: "it" }, { tenant_id: "t1", employee_id: "e-nouser", role: "hr" },
    ],
    // 会計側の権限（memberships）。社内権限（gw_role_grants）とは別軸。管理者（admin）だけが isAdmin
    memberships: [
      { user_id: "u-own", tenant_id: "t1", role: "client" }, { user_id: "u-adm", tenant_id: "t1", role: "admin" },
      { user_id: "u-hr", tenant_id: "t1", role: "client" }, { user_id: "u-fin", tenant_id: "t1", role: "client" },
    ],
  };
}

const KEYS = ["recruit", "sell", "office", "officeHr", "officeFinance", "keiei"];
const only = (...on) => Object.fromEntries(KEYS.map((k) => [k, on.includes(k)]));
const EXPECT = {
  "e-own": only("recruit", "sell", "office", "officeHr", "officeFinance", "keiei"),
  "e-hr": only("recruit", "officeHr"),
  "e-fin": only("office", "officeFinance"),
  "e-mgr": only("recruit", "sell", "office"),
  "e-rec": only("recruit"),
  "e-sales": only("sell"),
  "e-it": only(),
  "e-adm": only("officeHr", "officeFinance"),
  "e-none": only(),
  "e-nouser": only("recruit", "officeHr"),
};
const pick = (a) => Object.fromEntries(KEYS.map((k) => [k, a[k]]));
const byId = (r) => Object.fromEntries(r.body.employees.map((e) => [e.id, e]));

console.log("\n=== 名簿（/api/employees）: 各行の access ===\n");

await ok("各行に、その人の「利用できる業務」（accessOf）が付く。社内権限（gw_role_grants）と会計側の管理者（memberships）を合わせた結果", async () => {
  setup();
  const r = await list("u-own");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const m = byId(r);
  for (const [id, want] of Object.entries(EXPECT)) assert.deepEqual(pick(m[id].access), want, id);
  // 会計の管理者の注記の元（accessOf に渡した isAdmin）。memberships の admin / staff の判定結果
  for (const id of Object.keys(EXPECT)) assert.equal(m[id].accessMeta.accountingAdmin, id === "e-adm", `${id}: accessMeta.accountingAdmin`);
});

await ok("Office は、人事・労務／経理・事務／月末月初のどれか1つでも入れれば officeAny（ヘッダーに Office が出る条件と同じ）", async () => {
  setup();
  const m = byId(await list("u-own"));
  const any = Object.fromEntries(Object.entries(m).map(([id, e]) => [id, e.access.officeAny]));
  assert.deepEqual(any, {
    "e-own": true, "e-hr": true, "e-fin": true, "e-mgr": true /* 月末月初 */, "e-rec": false, "e-sales": false,
    "e-it": false, "e-adm": true, "e-none": false, "e-nouser": true,
  });
});

await ok("人事の説明と実装が合う: 人事（hr）は 人事・労務 ○ ／ 経理・事務 × ／ 月末月初 ×、責任者は 月末月初 ○ だけ（人事・労務・経理・事務は ×）", async () => {
  setup();
  const m = byId(await list("u-own"));
  assert.deepEqual([m["e-hr"].access.officeHr, m["e-hr"].access.officeFinance, m["e-hr"].access.office], [true, false, false]);
  assert.deepEqual([m["e-mgr"].access.officeHr, m["e-mgr"].access.officeFinance, m["e-mgr"].access.office], [false, false, true]);
  assert.deepEqual([m["e-fin"].access.officeHr, m["e-fin"].access.officeFinance, m["e-fin"].access.office], [false, true, true]);
});

await ok("名簿の access は、本人が /api/me で受け取る access と同じ（全員）", async () => {
  setup();
  const m = byId(await list("u-own"));
  for (const e of Object.values(m)) {
    if (!e.user_id) continue;
    const mine = (await me(e.user_id)).body;
    assert.deepEqual(pick(mine.access), pick(e.access), `${e.id}: 名簿の access と /api/me の access`);
    assert.equal(mine.isAdmin, e.accessMeta.accountingAdmin, `${e.id}: 注記の元（accessMeta.accountingAdmin）は、/api/me の isAdmin と同じ`);
    assert.equal(mine.access.officeHr, e.access.officeHr);
  }
});

await ok("名簿を読める立場でない人（一般メンバー）には access を返さない", async () => {
  setup();
  const r = await list("u-none");
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.employees.every((e) => !("access" in e)), "access が漏れている");
});

await ok("会計側の管理者かどうか（memberships）が読めなかった人は、access = null（「×」と言い切らない）。ログイン未連携の人は社内権限だけで出る", async () => {
  setup();
  db.fail.add("memberships");
  const m = byId(await list("u-own"));
  assert.equal(m["e-adm"].access, null);
  assert.equal(m["e-hr"].access, null);
  // 管理者かどうかも「分からない」（false と言い切らない）。注記の元も null
  assert.equal(m["e-adm"].accessMeta.accountingAdmin, null);
  assert.equal(m["e-hr"].accessMeta.accountingAdmin, null);
  assert.deepEqual(pick(m["e-nouser"].access), EXPECT["e-nouser"], "ログイン未連携の人は memberships が要らない");
  assert.equal(m["e-nouser"].accessMeta.accountingAdmin, false, "ログイン未連携の人は、会計の管理者ではない（accessOf に false を渡している）");
});

await ok("「利用中のシステム」（accounts）の取得に失敗しても、memberships が admin / staff なら access も注記の元（accountingAdmin）も出る", async () => {
  setup();
  db.accountsFail = true;     // readAccounts が例外
  const r = await list("u-own");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const m = byId(r);
  assert.deepEqual(pick(m["e-adm"].access), EXPECT["e-adm"], "管理者の access は accounts に左右されない");
  assert.equal(m["e-adm"].accessMeta.accountingAdmin, true, "accounts が読めなくても、memberships の admin を使う");
  assert.equal(m["e-hr"].accessMeta.accountingAdmin, false);
});

await ok("accounts の見え方が memberships と食い違っても、access と注記は memberships（accessOf に渡した isAdmin）だけで決まる", async () => {
  setup();
  // accounts では「管理者」に見えるが、memberships では管理者ではない / 逆
  db.accountsView = { "u-none": { accounting: { exists: true, active: true, role: "admin" } }, "u-adm": { accounting: { exists: true, active: true, role: "client" } } };
  const m = byId(await list("u-own"));
  assert.equal(m["e-none"].accessMeta.accountingAdmin, false);
  assert.deepEqual(pick(m["e-none"].access), only(), "accounts が admin に見えても、access は変わらない");
  assert.equal(m["e-adm"].accessMeta.accountingAdmin, true);
  assert.deepEqual(pick(m["e-adm"].access), EXPECT["e-adm"]);
  // 本人の /api/me とも一致
  assert.equal((await me("u-none")).body.isAdmin, false);
  assert.equal((await me("u-adm")).body.isAdmin, true);
});

console.log("\n=== 社内権限のチェック変更（/api/employees/roles）: 変更後の access を、その場で返す ===\n");

await ok("経理を付けると、その応答で 経理・事務 ○（月末月初 ○）、人事・労務 ×。外すと元に戻る", async () => {
  setup();
  let r = await setRole("e-none", "finance", true);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.roles, ["finance"]);
  assert.deepEqual(pick(r.body.access), only("office", "officeFinance"));
  assert.equal(r.body.access.officeAny, true);
  r = await setRole("e-none", "finance", false);
  assert.deepEqual(r.body.roles, []);
  assert.deepEqual(pick(r.body.access), only());
  assert.equal(r.body.access.officeAny, false);
});

await ok("人事を付けると 採用HR ○・人事・労務 ○（経理・事務は ×）。応答の access は、次に読む名簿・/api/me と同じ", async () => {
  setup();
  const r = await setRole("e-none", "hr", true);
  assert.deepEqual(pick(r.body.access), only("recruit", "officeHr"));
  const listed = byId(await list("u-own"))["e-none"];
  assert.deepEqual(pick(listed.access), pick(r.body.access));
  const mine = (await me("u-none")).body;
  assert.deepEqual(pick(mine.access), pick(r.body.access), "本人が画面を再読込すると、/api/me の access が最新になる");
});

await ok("責任者を付けると 採用HR・Sales・月末月初 ○（人事・労務・経理・事務は ×）。経営者を付けると全部 ○", async () => {
  setup();
  let r = await setRole("e-none", "manager", true);
  assert.deepEqual(pick(r.body.access), only("recruit", "sell", "office"));
  assert.deepEqual(pick((await me("u-none")).body.access), pick(r.body.access));
  r = await setRole("e-none", "owner", true);
  assert.deepEqual(pick(r.body.access), only("recruit", "sell", "office", "officeHr", "officeFinance", "keiei"));
  assert.deepEqual(pick((await me("u-none")).body.access), pick(r.body.access));
});

await ok("複数の権限（人事＋経理）は、足し合わさる。1つ外すと、その分だけ減る。全ての組み合わせで /api/me と一致する", async () => {
  setup();
  const roles = ["owner", "hr", "finance", "manager", "recruiter", "sales", "it"];
  // 全ての組み合わせ（2^7）を、付け外しの応答 → /api/me で突き合わせる
  const have = new Set();
  for (let mask = 0; mask < 1 << roles.length; mask++) {
    // グレイコード順に1つずつ付け外しして、毎回の応答を見る（owner の付与は、経営者本人（u-own）が行う）
    const gray = mask ^ (mask >> 1);
    const prev = (mask - 1) ^ ((mask - 1) >> 1);
    const bit = mask === 0 ? -1 : Math.log2(gray ^ prev);
    if (bit >= 0) {
      const role = roles[bit];
      const grant = Boolean(gray & (1 << bit));
      const r = await setRole("e-none", role, grant);
      assert.equal(r.statusCode, 200, `${role} ${grant}: ${JSON.stringify(r.body)}`);
      if (grant) have.add(role); else have.delete(role);
      assert.deepEqual([...r.body.roles].sort(), [...have].sort());
      const want = GW.memberAccessOf({ roles: [...have], isAdmin: false });
      assert.deepEqual(r.body.access, want, `応答の access（${[...have]}）`);
      assert.deepEqual(pick((await me("u-none")).body.access), pick(want), `/api/me の access（${[...have]}）`);
    }
  }
});

await ok("会計側の管理者（memberships admin）の人は、社内権限が無くても 人事・労務 ○・経理・事務 ○。社内権限を付けても管理者の分は消えない", async () => {
  setup();
  const r = await setRole("e-adm", "sales", true);
  assert.deepEqual(pick(r.body.access), only("sell", "officeHr", "officeFinance"));
  assert.equal(r.body.accessMeta.accountingAdmin, true, "応答の accessMeta も、accessOf に渡した isAdmin");
  assert.deepEqual(pick((await me("u-adm")).body.access), pick(r.body.access));
});

await ok("ログイン未連携の人も、社内権限だけで access が返る（会計側の管理者ではない扱い）", async () => {
  setup();
  const r = await setRole("e-nouser", "finance", true);
  assert.deepEqual(pick(r.body.access), only("recruit", "office", "officeHr", "officeFinance"));
  assert.equal(r.body.accessMeta.accountingAdmin, false);
});

await ok("権限変更の応答でも、accounts の取得失敗は access・注記に影響しない", async () => {
  setup();
  db.accountsFail = true;
  const r = await setRole("e-adm", "sales", true);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.accessMeta.accountingAdmin, true);
  assert.deepEqual(pick(r.body.access), only("sell", "officeHr", "officeFinance"));
});

await ok("memberships が読めなかったとき、権限の付け外しは成功し、access は返さない（画面は名簿を読み直す）", async () => {
  setup();
  db.fail.add("memberships");
  const r = await setRole("e-none", "finance", true);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.granted, true);
  assert.equal(r.body.access, null, "読めないときは null（×と言い切らない）");
  assert.equal(r.body.accessMeta.accountingAdmin, null, "注記の元も null（会計の管理者かどうか分からない）");
  assert.ok(db.rows.gw_role_grants.some((g) => g.employee_id === "e-none" && g.role === "finance"), "付け外し自体は行われている");
});

await ok("権限の判定は変えていない: 人事（hr）は経営者（owner）を付けられない・一般メンバーは付け外しできない（従来どおり 403）", async () => {
  setup();
  const asHr = await setRole("e-none", "owner", true, "u-hr");
  assert.equal(asHr.statusCode, 403);
  const asNone = await setRole("e-none", "finance", true, "u-none");
  assert.equal(asNone.statusCode, 403);
  assert.ok(!db.rows.gw_role_grants.some((g) => g.employee_id === "e-none"), "何も付いていない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
