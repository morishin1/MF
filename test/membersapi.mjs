// メンバー管理（api/employees/index.js・roles.js・account.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか（2026-10-01 P0：メンバー管理が使えなくなった不具合の修正）
//
//   原因A：MFA強制開始（2026-10-01〜）で、対象ロールが aal2 でないと 403 mfa_required。
//          → db/110 ではなく lib/mfa.js の MFA_ENABLED キルスイッチ（PR #54）で一時停止ずみ。
//            ここでは「キルスイッチが切れている今は、誰も MFA では止まらない」ことと、
//            「キルスイッチを入れ直せば、今までどおり保護が効く」ことの両方を確かめる
//   原因B：画面（roles:["admin","owner"]）とAPI（canManageHr＝管理者・人事）の不一致で、
//          人事だけの人が画面に入れなかった。→ lib/gw.js の access.hr・js/layout.js の
//          access オプション・admin-members.html の修正で直した（この回帰は test/navcheck.mjs と
//          test/ui/membersui.mjs で見る。ここでは API 側の権限だけを見る）
//
//   1. 管理者・経営者・人事は 一覧・追加・編集・在籍状態変更・削除 ができる
//   2. 一般メンバー・採用担当だけ・営業担当だけはできない（403）
//   3. 他テナントの社員は取得・更新・削除できない
//   4. 社内権限の付け外し（roles.js）・ログインアカウント管理（account.js）も、同じ3人だけ
//   5. MFA_ENABLED を戻せば、今までどおり強制日以降は aal2 必須に戻る（キルスイッチの効き）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// 本番のデフォルト（PR #54）と同じ状態で始める。他のテストが残していても必ず切る
delete process.env.MFA_ENABLED;

// ---- 偽の DB ----------------------------------------------------------------
const db = { rows: {} };
const logged = [];
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return v.includes(r[k]);
    return true;
  });
}
function table(name) {
  const f = [];
  let order = null;
  let countOnly = false;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? "") < (b[col] ?? "") ? (asc ? -1 : 1) : (a[col] ?? "") > (b[col] ?? "") ? (asc ? 1 : -1) : 0));
    }
    return out;
  };
  const q = {
    select(_cols, opts) { if (opts?.count) countOnly = true; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve(countOnly
      ? { data: null, count: rows().length, error: null }
      : { data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }) };
      return r2;
    },
    upsert(row, opts = {}) {
      const cols = String(opts.onConflict || "").split(",").map((s) => s.trim()).filter(Boolean);
      const rows = [].concat(row);
      const made = [];
      for (const r of rows) {
        const existing = cols.length
          ? (db.rows[name] || []).find((x) => cols.every((c) => x[c] === r[c])) : null;
        if (existing) {
          if (!opts.ignoreDuplicates) Object.assign(existing, r);
          made.push(existing);
          continue;
        }
        const row2 = { id: r.id || uuid(), created_at: new Date().toISOString(), ...r };
        (db.rows[name] = db.rows[name] || []).push(row2);
        made.push(row2);
      }
      return Promise.resolve({ data: made.map(copy), error: null });
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply(),
        single: () => apply(),
        then: (fn, rej) => apply().then(fn, rej),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        then: (fn, rej) => {
          const hit = (db.rows[name] || []).filter(matcher(g));
          db.rows[name] = (db.rows[name] || []).filter((r) => !hit.includes(r));
          return Promise.resolve({ error: null }).then(fn, rej);
        },
      };
      return r2;
    },
  };
  return q;
}

const fakeSb = {
  from: table,
  auth: { admin: { updateUserById: async () => ({ error: null }) } },
};

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => fakeSb, userClient: () => fakeSb },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => (who ? { id: who.userId } : null), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
// アカウント管理（lib/accounts.js）の中身はここでは見ない。メンバー管理APIの権限・MFA・テナント分離が主題
mock.module(atRoot("lib/accounts.js"), {
  namedExports: {
    SYSTEMS: ["lms", "timecard", "accounting"],
    readAccounts: async () => new Map(),
    setAccountsActive: async () => ({ lms: { ok: true }, timecard: { ok: true } }),
    removeAccountingAccess: async () => ({ ok: true }),
    attachAccount: async (sb, { employee }) => ({ ok: true, userId: `u-${employee.id}`, createdPassword: "temp12345" }),
    randomPassword: () => "generated123",
    findUserByEmail: async () => null,
    setSystemAccess: async (sb, { system, on }) => ({ ok: true, action: on ? "on" : "off" }),
  },
});

const emp = (id, over = {}) => ({
  id, tenant_id: "t1", user_id: `u-${id}`, display_name: id, status: "active",
  department: null, position: null, employment_type: "正社員", joined_on: "2026-04-01", ...over,
});
const ADMIN = { userId: "u-admin", tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: emp("e-admin") };
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], employee: emp("e-owner") };
const HR = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], employee: emp("e-hr") };
const MEMBER = { userId: "u-member", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: emp("e-member") };
const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: emp("e-rec") };
const SALES = { userId: "u-sales", tenantId: "t1", isAdmin: false, isHr: false, roles: ["sales"], employee: emp("e-sales") };
const OTHER_TENANT = { userId: "u-o2", tenantId: "t2", isAdmin: false, isHr: true, roles: ["owner"], employee: emp("e-o2", { tenant_id: "t2" }) };
let who = ADMIN;

mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (ctx) => Boolean(ctx.isAdmin || ctx.isHr),
  },
});

const { default: employeesApi } = await import(atRoot("api/employees/index.js"));
const { default: rolesApi } = await import(atRoot("api/employees/roles.js"));
const { default: accountApi } = await import(atRoot("api/employees/account.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = () => call(employeesApi, { method: "GET", url: "/api/employees" });
const post = (body) => call(employeesApi, { method: "POST", url: "/api/employees", body });
const patch = (body) => call(employeesApi, { method: "PATCH", url: "/api/employees", body });
const del = (id) => call(employeesApi, { method: "DELETE", url: `/api/employees?id=${id}` });
const grantRole = (body) => call(rolesApi, { method: "POST", url: "/api/employees/roles", body });
const updateAccount = (body) => call(accountApi, { method: "PATCH", url: "/api/employees/account", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  delete process.env.MFA_ENABLED;
  who = ADMIN;
  logged.length = 0;
  db.rows = {
    gw_employees: [
      emp("e-admin"), emp("e-owner"), emp("e-hr"), emp("e-member"), emp("e-rec"), emp("e-sales"),
      emp("e-taro", { department: "開発" }),
      emp("e-o2", { tenant_id: "t2" }),
    ],
    gw_role_grants: [],
  };
}

console.log("\n=== 社員名簿（api/employees）：管理者・経営者・人事はできる ===\n");

for (const [label, persona] of [["管理者", ADMIN], ["経営者", OWNER], ["人事", HR]]) {
  await ok(`${label}：一覧を取得できる`, async () => {
    setup();
    who = persona;
    const r = await get();
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.employees.length >= 3);
    assert.equal(r.body.canManage, true);
  });

  await ok(`${label}：社員を追加できる`, async () => {
    setup();
    who = persona;
    const r = await post({ display_name: "新人 花子", department: "営業部" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.employee.display_name, "新人 花子");
  });

  await ok(`${label}：社員情報（部署・役職・勤務地・雇用区分）を編集できる`, async () => {
    setup();
    who = persona;
    const r = await patch({
      id: "e-taro", department: "製造部", position: "主任", work_location: "本社", employment_type: "契約社員",
    });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.employee.department, "製造部");
    assert.equal(r.body.employee.position, "主任");
    assert.equal(r.body.employee.employment_type, "契約社員");
  });

  await ok(`${label}：入社日・在籍状態を編集できる`, async () => {
    setup();
    who = persona;
    const r = await patch({ id: "e-taro", joined_on: "2026-05-01", status: "leaving" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.employee.status, "leaving");
  });

  await ok(`${label}：社内権限を付け外しできる`, async () => {
    setup();
    who = persona;
    const g = await grantRole({ employeeId: "e-taro", role: "it" });
    assert.equal(g.statusCode, 200, JSON.stringify(g.body));
    assert.equal(db.rows.gw_role_grants.some((r) => r.employee_id === "e-taro" && r.role === "it"), true);
    const rv = await grantRole({ employeeId: "e-taro", role: "it", grant: false });
    assert.equal(rv.statusCode, 200);
    assert.equal(db.rows.gw_role_grants.some((r) => r.employee_id === "e-taro" && r.role === "it"), false);
  });

  await ok(`${label}：ログインアカウント状態を確認・必要な操作ができる`, async () => {
    setup();
    who = persona;
    const r = await updateAccount({ employeeId: "e-taro", generatePassword: true });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.password);
  });
}

console.log("\n=== 一般メンバー・採用担当だけ・営業担当だけはできない ===\n");

for (const [label, persona] of [["一般メンバー", MEMBER], ["採用担当だけ", RECRUITER], ["営業担当だけ", SALES]]) {
  await ok(`${label}：一覧は見られる（雇用区分は返らない）が、追加・編集・削除はできない`, async () => {
    setup();
    who = persona;
    const r = await get();
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.canManage, false);
    assert.equal(JSON.stringify(r.body).includes("employment_type"), false, "雇用区分を返さない");

    assert.equal((await post({ display_name: "勝手に追加" })).statusCode, 403);
    assert.equal((await patch({ id: "e-taro", department: "勝手に変更" })).statusCode, 403);
    assert.equal((await del("e-taro")).statusCode, 403);
  });

  await ok(`${label}：社内権限の変更もアカウント管理もできない（403）`, async () => {
    setup();
    who = persona;
    assert.equal((await grantRole({ employeeId: "e-taro", role: "it" })).statusCode, 403);
    assert.equal((await updateAccount({ employeeId: "e-taro", generatePassword: true })).statusCode, 403);
  });
}

console.log("\n=== テナント分離 ===\n");

await ok("他テナントの社員は一覧に出ない・取得も更新も削除もできない", async () => {
  setup();
  who = OWNER; // t1
  const list = await get();
  assert.equal(list.body.employees.some((e) => e.id === "e-o2"), false);

  const p = await patch({ id: "e-o2", department: "乗っ取り" });
  assert.equal(p.statusCode, 404, JSON.stringify(p.body));
  assert.notEqual(db.rows.gw_employees.find((e) => e.id === "e-o2").department, "乗っ取り");

  const d = await del("e-o2");
  assert.equal(d.statusCode, 404);
  assert.ok(db.rows.gw_employees.some((e) => e.id === "e-o2"), "他テナントの社員は消えない");
});

await ok("他テナントの経営者が来ても、自分のテナント以外は触れない", async () => {
  setup();
  who = OTHER_TENANT; // t2、経営者
  const list = await get();
  assert.deepEqual(list.body.employees.map((e) => e.id), ["e-o2"]);
  assert.equal((await patch({ id: "e-taro", department: "乗っ取り" })).statusCode, 404);
});

console.log("\n=== MFA_ENABLED キルスイッチ（PR #54）の効き ===\n");

await ok("キルスイッチが切れている今は、未登録（二段階認証なし）でも管理者・人事がメンバー管理を使える", async () => {
  setup();
  // MFA_ENABLED は setup() で明示的に外してある。aal2 のトークンも付けない
  for (const persona of [ADMIN, OWNER, HR]) {
    who = persona;
    const r = await get();
    assert.equal(r.statusCode, 200, `${JSON.stringify(persona.roles)}: ${JSON.stringify(r.body)}`);
  }
});

await ok("MFA_ENABLED=true に戻すと、今までどおり対象ロール・強制日以降は aal2 必須に戻る（保護は消えていない）", async () => {
  setup();
  const { requireMfa } = await import(atRoot("lib/mfa.js"));
  process.env.MFA_ENABLED = "true";
  try {
    const r = res();
    // ENFORCE_FROM は既定の 2026-10-01。このテストを走らせている「今日」はそれ以降なので、
    // 管理者・未登録・aal1 なら止まるはず（止まらなければ、キルスイッチを戻しても保護が効いていない）
    const allowed = await requireMfa(
      { headers: { authorization: "Bearer x" } }, r,
      { isAdmin: true, roles: [] }, { factors: [] },
    );
    assert.equal(allowed, false, "管理者・未登録・aal1 は本来 403 のはず");
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "mfa_required");
  } finally {
    delete process.env.MFA_ENABLED;
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
