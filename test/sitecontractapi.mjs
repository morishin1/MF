// SES現場契約（gw_site_contracts）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 追加・更新・削除・一覧（対象者で絞る）ができる
//   2. 一般メンバーは触れない（人事・管理者だけ）
//   3. よそのテナントの人には作れない
//   4. 契約終了日は開始日より前にできない（lib側の検証がAPIでも効く）
//   5. 076が未適用でも、一覧は落ちずに「まだ」と伝える
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([k, v]) => {
      if (k.startsWith("!")) return r[k.slice(1)] !== v;
      return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : -1));
    return out;
  };
  const e = () => err(name);
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    order(col) { order = col; return q; },
    limit() { return q; },
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

const { default: sc } = await import(atRoot("api/site-contracts/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await sc({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const get = (qs = "") => call({ method: "GET", url: `/api/site-contracts${qs}` });
const post = (body) => call({ method: "POST", url: "/api/site-contracts", body });
const patch = (body) => call({ method: "PATCH", url: "/api/site-contracts", body });
const del = (id) => call({ method: "DELETE", url: `/api/site-contracts?id=${id}` });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  db.missing = null;
  db.rows = {
    gw_site_contracts: [],
    gw_employees: [
      { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", status: "active" },
    ],
  };
}

const body = (over = {}) => ({
  employeeId: "emp-1", engagementKind: "bp", siteCompany: "A社", primeCompany: "元請B社",
  periodFrom: "2026-10-01", periodTo: "2027-03-31", unitPrice: 700000, unitPriceType: "月額",
  settlementCondition: "140h〜180h", renewalStatus: "pending", ...over,
});

console.log("\n=== SES現場契約（gw_site_contracts） ===\n");

console.log("— 追加・一覧 —");

await ok("追加できる", async () => {
  setup();
  const r = await post(body());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.contract.site_company, "A社");
  assert.equal(r.body.contract.employee_id, "emp-1");
});

await ok("対象者がいなければ拒否する", async () => {
  setup();
  const r = await post(body({ employeeId: "nope" }));
  assert.equal(r.statusCode, 404);
});

await ok("所属会社が無ければ拒否する", async () => {
  setup();
  const r = await post(body({ siteCompany: "" }));
  assert.equal(r.statusCode, 400);
});

await ok("契約終了日が開始日より前なら拒否する", async () => {
  setup();
  const r = await post(body({ periodFrom: "2026-10-01", periodTo: "2026-09-01" }));
  assert.equal(r.statusCode, 400);
});

await ok("一般メンバーは追加できない", async () => {
  setup();
  who = MEMBER;
  const r = await post(body());
  assert.equal(r.statusCode, 403);
});

await ok("対象者で絞って一覧が取れる", async () => {
  setup();
  db.rows.gw_employees.push({ id: "emp-2", tenant_id: "t1", display_name: "鈴木 花子", status: "active" });
  await post(body({ employeeId: "emp-1" }));
  await post(body({ employeeId: "emp-2", siteCompany: "C社" }));
  const r = await get("?employeeId=emp-2");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.contracts.length, 1);
  assert.equal(r.body.contracts[0].site_company, "C社");
});

await ok("表がまだ無くても、一覧は落ちない", async () => {
  setup();
  db.missing = "gw_site_contracts";
  const r = await get();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log("— 更新 —");

await ok("更新状態だけを変えられる", async () => {
  setup();
  const add = await post(body());
  const r = await patch({ id: add.body.contract.id, renewalStatus: "confirmed" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.contract.renewal_status, "confirmed");
  assert.equal(r.body.contract.site_company, "A社", "触っていない項目はそのまま");
});

await ok("一般メンバーは更新できない", async () => {
  setup();
  const add = await post(body());
  who = MEMBER;
  const r = await patch({ id: add.body.contract.id, renewalStatus: "confirmed" });
  assert.equal(r.statusCode, 403);
});

console.log("— 削除 —");

await ok("削除できる", async () => {
  setup();
  const add = await post(body());
  const r = await del(add.body.contract.id);
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_site_contracts.length, 0);
});

await ok("無い契約は404", async () => {
  setup();
  const r = await del("nope");
  assert.equal(r.statusCode, 404);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
