// 入社手続きの「共通の進み具合」API（api/onboarding/status.js）を、
// 偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 自分のぶんは、いつでも開ける。全部そろって見える
//   2. 管理者・社労士は、他人のぶんを開ける。一般メンバーは開けない
//   3. メールアドレスは、社労士には渡さない（RLSではなくAPI側の決め）
//   4. 給与・契約条件は、gw_contracts が読めない相手（社労士）には出ない
//      （RLSが返さない状況を、テストでは「行が無い」として模す）
//   5. 他人のぶんを開いたときだけ、閲覧ログに残る
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
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) => {
    if (k.startsWith("!")) return r[k.slice(1)] !== v;
    return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
  }));
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: copy(made[0]), error: null }),
                  then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn) };
      return r;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });

const SELF = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: false,
               employee: { id: "emp-1", display_name: "山田 太郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: false, isAdvisor: false,
                employee: { id: "emp-hr", display_name: "事務 花子" } };
const ADVISOR = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: true,
                   employee: { id: "emp-sr", display_name: "社労士 次郎" } };
const OTHER_MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: false,
                        employee: { id: "emp-2", display_name: "鈴木 花子" } };
let who = SELF;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});

const { default: status } = await import(atRoot("api/onboarding/status.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (qs = "") => {
  const r = res();
  await status({ method: "GET", url: `/api/onboarding/status${qs}`, headers: { authorization: "Bearer x" } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = SELF;
  db.rows = {
    gw_employees: [
      { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", email: "yamada@8grp.co.jp",
        employment_type: "正社員", status: "active", joined_on: "2026-09-07" },
    ],
    gw_procedures: [
      { id: "proc-1", tenant_id: "t1", employee_id: "emp-1", kind: "onboarding",
        status: "in_progress", target_on: "2026-09-07", stage: "intake", mynumber_status: "not_submitted" },
    ],
    gw_onboard_profiles: [{ employee_id: "emp-1", status: "submitted" }],
    gw_onboard_consents: [],
    gw_sign_requests: [{ id: "s1", tenant_id: "t1", employee_id: "emp-1", title: "労働条件通知書",
      doc_kind: "employment", status: "signed", signed_at: "2026-09-01T00:00:00Z", sent_at: "2026-08-20T00:00:00Z" }],
    gw_orientation_items: [],
    gw_orientation_checks: [],
    gw_contracts: [{ employee_id: "emp-1", status: "active", wage_type: "月給", wage_amount: 300000,
      fixed_term: false }],
    gw_procedure_items: [],
    gw_consent_docs: [],
    gw_sensitive_access_log: [],
  };
}

console.log("\n=== 入社手続きの共通API ===\n");

console.log("— 誰が開けるか —");

await ok("自分のぶんを開ける", async () => {
  setup();
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.role, "self");
  assert.equal(r.body.known.name, "山田 太郎");
});

await ok("管理者は他人のぶんを開ける", async () => {
  setup();
  who = ADMIN;
  const r = await call("?employeeId=emp-1");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.role, "admin");
});

await ok("社労士は他人のぶんを開ける", async () => {
  setup();
  who = ADVISOR;
  const r = await call("?employeeId=emp-1");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.role, "advisor");
});

await ok("一般メンバーは他人のぶんを開けない", async () => {
  setup();
  who = OTHER_MEMBER;
  const r = await call("?employeeId=emp-1");
  assert.equal(r.statusCode, 403);
});

console.log("— 見えるもの・見えないもの —");

await ok("本人・管理者にはメールが見える", async () => {
  setup();
  const r1 = await call();
  assert.equal(r1.body.known.email, "yamada@8grp.co.jp");
  who = ADMIN;
  const r2 = await call("?employeeId=emp-1");
  assert.equal(r2.body.known.email, "yamada@8grp.co.jp");
});

await ok("社労士にはメールを渡さない", async () => {
  setup();
  who = ADVISOR;
  const r = await call("?employeeId=emp-1");
  assert.equal(r.body.known.email, null);
});

await ok("給与・契約条件は、gw_contracts が読めない相手には出ない（RLSが返さない想定）", async () => {
  setup();
  db.rows.gw_contracts = []; // 社労士セッションでは RLS がここを空で返す、を模す
  who = ADVISOR;
  const r = await call("?employeeId=emp-1");
  assert.equal(r.body.known.wage, null);
  assert.equal(r.body.known.contractPeriod, null);
});

await ok("本人には給与が出る（自分のことなので）", async () => {
  setup();
  const r = await call();
  assert.match(r.body.known.wage, /300,000円/);
});

console.log("— 進み具合 —");

await ok("STEPが計算されて返る", async () => {
  setup();
  const r = await call();
  assert.ok(Array.isArray(r.body.steps.steps));
  assert.equal(r.body.steps.steps.length, 6);
});

await ok("届出が読めない相手には、入力が終わっていないように見える（危険側に倒す）", async () => {
  setup();
  db.rows.gw_onboard_profiles = []; // 社労士には見えない、を模す
  who = ADVISOR;
  const r = await call("?employeeId=emp-1");
  const profileStep = r.body.steps.steps.find((s) => s.key === "profile");
  assert.equal(profileStep.done, false);
});

console.log("— 閲覧ログ —");

await ok("他人のぶんを開くと、閲覧ログに残る", async () => {
  setup();
  who = ADMIN;
  await call("?employeeId=emp-1");
  const rows = db.rows.gw_sensitive_access_log || [];
  assert.ok(rows.some((r) => r.subject_id === "emp-1" && r.actor_id === "u-1" && r.action === "view"));
});

await ok("自分のぶんを開いても、ログには残らない", async () => {
  setup();
  await call();
  assert.equal((db.rows.gw_sensitive_access_log || []).length, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
