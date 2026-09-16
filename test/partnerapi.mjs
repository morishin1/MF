// BP企業（gw_partner_companies）と、名簿側の区分（employee_kind）を、
// 偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. BP企業の追加・編集・削除ができる。属している人がいれば削除を止める
//   2. 一般メンバーは追加・編集・削除できない（人事・管理者だけ）
//   3. 名簿にBPを追加するには、所属先（BP企業）が要る
//   4. プロパーに所属先を付けようとしても、無視される
//   5. よそのテナントのBP企業は指定できない
//   6. 075（BP）が未適用でも、名簿の一覧そのものは出す
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, missingCols: new Set() };

/** 無い列を SELECT したときの、PostgREST のエラー（test/tasktest.mjs と同じ考え方） */
const colErr = (spec) => {
  for (const c of db.missingCols) {
    if (String(spec || "").includes(c)) return { code: "42703", message: `column does not exist: ${c}` };
  }
  return null;
};

function table(name) {
  const f = [];
  let selectSpec = "";
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) => {
    if (k.startsWith("!")) return r[k.slice(1)] !== v;
    return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
  }));
  const e = () => err(name) || colErr(selectSpec);
  const q = {
    select(spec) { selectSpec = spec || ""; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    then: (fn) => Promise.resolve({
      data: e() ? null : rows().map(copy), error: e(), count: rows().length,
    }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
                  maybeSingle: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
                  then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn) };
      return r;
    },
    update(patch) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        select: () => r,
        single: () => {
          const hit = match(name, g);
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: copy(hit[0]), error: null });
        },
        maybeSingle: () => r.single(),
      };
      return r;
    },
    delete() {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        then: (fn) => {
          const hit = new Set(match(name, g).map((x) => x.id));
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.has(x.id));
          return Promise.resolve({ data: [], error: null }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || [])
  .filter((r) => filters.every(([k, v]) => r[k] === v));
const copy = (r) => (r ? { ...r } : null);
const err = (name) => (db.missing === name ? { code: "PGRST205", message: "Could not find the table" } : null);

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
                 employee: { id: "emp-1", display_name: "山田 太郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
                employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = ADMIN;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/accounts.js"), {
  namedExports: {
    readAccounts: async () => new Map(), setAccountsActive: async () => ({}),
    removeAccountingAccess: async () => ({}), attachAccount: async () => ({ ok: false }),
    SYSTEMS: {},
  },
});

const { default: partners } = await import(atRoot("api/partners/index.js"));
const { default: employees } = await import(atRoot("api/employees/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const callP = async (req) => { const r = res(); await partners({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const callE = async (req) => { const r = res(); await employees({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getP = () => callP({ method: "GET", url: "/api/partners" });
const postP = (body) => callP({ method: "POST", url: "/api/partners", body });
const patchP = (body) => callP({ method: "PATCH", url: "/api/partners", body });
const delP = (id) => callP({ method: "DELETE", url: `/api/partners?id=${id}` });
const getE = () => callE({ method: "GET", url: "/api/employees" });
const postE = (body) => callE({ method: "POST", url: "/api/employees", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  db.missing = null;
  db.missingCols = new Set();
  db.rows = {
    gw_partner_companies: [],
    gw_employees: [
      { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", status: "active",
        employment_type: "正社員", employee_kind: "proper", partner_company_id: null },
    ],
    gw_role_grants: [],
  };
}

console.log("\n=== BP企業（gw_partner_companies） ===\n");

console.log("— 追加・一覧 —");

await ok("追加できる", async () => {
  setup();
  const r = await postP({ company_name: "株式会社サンプル", invoice_registration_number: "T1234567890123" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.company.company_name, "株式会社サンプル");
});

await ok("会社名がなければ拒否する", async () => {
  setup();
  const r = await postP({ company_name: "  " });
  assert.equal(r.statusCode, 400);
});

await ok("一般メンバーは追加できない", async () => {
  setup();
  who = MEMBER;
  const r = await postP({ company_name: "X社" });
  assert.equal(r.statusCode, 403);
});

await ok("表がまだ無くても、名簿は落ちない", async () => {
  setup();
  db.missing = "gw_partner_companies";
  const r = await getP();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log("— 削除 —");

await ok("誰も属していなければ削除できる", async () => {
  setup();
  const add = await postP({ company_name: "空の会社" });
  const r = await delP(add.body.company.id);
  assert.equal(r.statusCode, 200);
});

await ok("BPが1人でもいれば、削除を止める", async () => {
  setup();
  const add = await postP({ company_name: "在籍あり" });
  db.rows.gw_employees.push({ id: "emp-2", tenant_id: "t1", display_name: "BP太郎",
    status: "active", employee_kind: "bp", partner_company_id: add.body.company.id });
  const r = await delP(add.body.company.id);
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /1名/);
});

console.log("\n=== 名簿のBP区分（gw_employees） ===\n");

console.log("— 追加 —");

await ok("BPには所属先が要る", async () => {
  setup();
  const r = await postE({ display_name: "BP次郎", employee_kind: "bp" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_kind");
});

await ok("所属先を指定すれば、BPとして追加できる", async () => {
  setup();
  const co = await postP({ company_name: "株式会社サンプル" });
  const r = await postE({ display_name: "BP次郎", employee_kind: "bp",
    partner_company_id: co.body.company.id });
  assert.equal(r.statusCode, 200);
});

await ok("よそのテナントのBP企業は指定できない", async () => {
  setup();
  db.rows.gw_partner_companies.push({ id: "co-x", tenant_id: "t9", company_name: "他社" });
  const r = await postE({ display_name: "BP次郎", employee_kind: "bp", partner_company_id: "co-x" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "unknown_partner");
});

await ok("プロパーに所属先を送っても、無視されて null になる", async () => {
  setup();
  const co = await postP({ company_name: "株式会社サンプル" });
  const r = await postE({ display_name: "山田 花子", employee_kind: "proper",
    partner_company_id: co.body.company.id });
  assert.equal(r.statusCode, 200);
  const saved = db.rows.gw_employees.find((e) => e.display_name === "山田 花子");
  assert.equal(saved.partner_company_id, null);
});

await ok("区分を送らなければ、これまでどおり追加できる（既定で触らない）", async () => {
  setup();
  const r = await postE({ display_name: "従来どおり" });
  assert.equal(r.statusCode, 200);
});

console.log("— 一覧 —");

await ok("BPの所属先まで一覧に出る", async () => {
  setup();
  const co = await postP({ company_name: "株式会社サンプル" });
  await postE({ display_name: "BP次郎", employee_kind: "bp", partner_company_id: co.body.company.id });
  const r = await getE();
  const bp = r.body.employees.find((e) => e.display_name === "BP次郎");
  assert.equal(bp.employee_kind, "bp");
  assert.equal(bp.partner_company_id, co.body.company.id);
  assert.equal(r.body.kindReady, true);
});

await ok("075が未適用でも、名簿の一覧は出る（区分は付かない）", async () => {
  setup();
  // employee_kind 列がまだ無い環境を模す（075未適用）
  db.missingCols = new Set(["employee_kind"]);
  const r = await getE();
  assert.equal(r.statusCode, 200, "落ちずに、これまでどおりの一覧が出る");
  assert.equal(r.body.kindReady, false, "区分は出せなかったと伝える");
  assert.ok(r.body.employees.length >= 1, "一覧そのものは出る");
  db.missingCols = new Set();
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
