// 採用HR Stage 9：契約書作成依頼と、採用承諾条件の突き合わせ
// （lib/esign.js の純粋関数 + api/sign/orders.js の create()・GET reconcile）
// を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 比較の基準は必ず「本人が承諾したoffer」（gw_hr_offers、accepted_atあり）。
//      採用HR経由でない社員（gw_hr_applicantsに紐づきが無い）は比較しない
//   2. 一致していれば、そのまま契約書作成依頼を進められる
//   3. 食い違っていれば、契約書作成依頼（doc_kind=employment）は止まる
//      （409 offer_mismatch）。理由（overrideReason）が無ければ絶対に進めない
//   4. overrideReasonがあっても、owner・hr以外は進められない（403）
//   5. owner・hrがoverrideReasonつきで進めると、override_reason/by/atが記録され、
//      監査ログにも残る。通常の作成依頼とは別の監査アクション
//   6. 労働条件通知書（employment）以外の依頼種別は、突き合わせの対象にしない
//   7. 社労士はこの突き合わせ結果を見られない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const notified = [];

function table(name) {
  const f = [];
  let order = null;
  let lim = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "neq") return r[k] !== v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : a[order] > b[order] ? -1 : 0));
    if (lim != null) out = out.slice(0, lim);
    return out;
  };
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    order(col) { order = col; return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
        then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn),
      };
      return r2;
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
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (n) => { notified.push(...(n || [])); } },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
mock.module(atRoot("lib/onboard-advance.js"), { namedExports: { advanceFor: async () => {} } });
mock.module(atRoot("lib/sign-audit.js"), {
  namedExports: { signEvent: async () => {}, ipOf: () => "1.2.3.4", uaOf: () => "test" },
});
mock.module(atRoot("lib/pdf-jp.js"), {
  namedExports: { renderContractPdf: async () => Buffer.from("pdf"), sha256: (b) => "hash-" + String(b).length },
});

const HR = { tenantId: "t1", isAdmin: false, isHr: true, isAdvisor: false, roles: ["hr"], employee: { id: "emp-hr", display_name: "人事 太郎" } };
const ADMIN_NOT_HR = { tenantId: "t1", isAdmin: true, isHr: false, isAdvisor: false, roles: [], employee: { id: "emp-a", display_name: "管理 次郎" } };
const ADVISOR = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: true, roles: ["labor_advisor"], employee: { id: "emp-adv", display_name: "社労士" } };
let who = HR;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
  },
});

const { default: orders } = await import(atRoot("api/sign/orders.js"));
const {
  conditionsFromContract, reconcileOfferConditions,
} = await import(atRoot("lib/esign.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await orders({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const reconcile = (employeeId) =>
  call({ method: "GET", url: `/api/sign/orders?employeeId=${employeeId}&reconcile=1` });
const create = (body) => call({ method: "POST", url: "/api/sign/orders", body: { action: "create", ...body } });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = HR;
  db.missing = null;
  logged.length = 0;
  notified.length = 0;
  db.rows = {
    gw_employees: [{
      id: "e1", tenant_id: "t1", display_name: "山田 太郎", employment_type: "正社員",
      joined_on: "2026-11-01", position: "エンジニア",
    }],
    gw_contracts: [{
      id: "c1", tenant_id: "t1", employee_id: "e1", status: "active",
      fixed_term: false, period_from: "2026-11-01", period_to: null,
      probation_months: 3, weekly_hours: 40, job_content: "エンジニア",
      wage_type: "月給", wage_amount: 300000,
    }],
    gw_hr_applicants: [{ id: "a1", tenant_id: "t1", employee_id: "e1" }],
    gw_hr_offers: [{
      id: "of1", applicant_id: "a1", version: 1,
      employment_type: "正社員", job_title: "エンジニア",
      wage_type: "月給", wage_amount: 300000, weekly_hours: 40,
      join_date: "2026-11-01", probation_months: 3, contract_type: "無期", contract_end_date: null,
      accepted_at: "2026-09-25T00:00:00Z",
    }],
    gw_doc_orders: [], gw_sign_requests: [],
  };
}

console.log("\n=== 純粋関数（lib/esign.js） ===\n");

await ok("conditionsFromContract：現在の労働条件から、依頼欄の文字列を組み立てる", () => {
  const c = conditionsFromContract(
    { employment_type: "正社員" },
    { fixed_term: false, probation_months: 3, weekly_hours: 40, job_content: "エンジニア", wage_type: "月給", wage_amount: 300000 },
  );
  assert.equal(c["雇用区分"], "正社員");
  assert.equal(c["契約期間"], "期間の定めなし");
  assert.equal(c["試用期間"], "3か月");
  assert.equal(c["就業時間"], "週40時間");
  assert.equal(c["業務内容"], "エンジニア");
  assert.equal(c["賃金"], "月給 300,000円");
});

await ok("reconcileOfferConditions：offerが無ければ、比べない", () => {
  assert.deepEqual(reconcileOfferConditions(null, {}, {}), []);
});

await ok("reconcileOfferConditions：一致していれば空", () => {
  const offer = { employment_type: "正社員", job_title: "エンジニア", wage_type: "月給", wage_amount: 300000,
    weekly_hours: 40, join_date: "2026-11-01", probation_months: 3, contract_type: "無期", contract_end_date: null };
  const employee = { employment_type: "正社員", joined_on: "2026-11-01", position: "エンジニア" };
  const contract = { fixed_term: false, weekly_hours: 40, probation_months: 3, wage_type: "月給", wage_amount: 300000 };
  assert.deepEqual(reconcileOfferConditions(offer, employee, contract), []);
});

await ok("reconcileOfferConditions：給与・勤務時間の食い違いを検出する", () => {
  const offer = { wage_type: "月給", wage_amount: 300000, weekly_hours: 40, employment_type: "正社員" };
  const employee = { employment_type: "正社員" };
  const contract = { wage_type: "月給", wage_amount: 320000, weekly_hours: 45 };
  const diff = reconcileOfferConditions(offer, employee, contract);
  const byKey = Object.fromEntries(diff.map((d) => [d.key, d]));
  assert.equal(byKey.wage.offerValue, "月給 300,000円");
  assert.equal(byKey.wage.currentValue, "月給 320,000円");
  assert.equal(byKey.weeklyHours.offerValue, "週40時間");
  assert.equal(byKey.weeklyHours.currentValue, "週45時間");
});

await ok("reconcileOfferConditions：片方が無い項目は比べない", () => {
  const offer = { employment_type: "正社員" };
  const diff = reconcileOfferConditions(offer, {}, null);
  assert.deepEqual(diff, []);
});

console.log("\n=== 事前入力・突き合わせを取得する（GET reconcile） ===\n");

await ok("採用HR経由の社員：一致していれば mismatches は空", async () => {
  setup();
  const r = await reconcile("e1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.linked, true);
  assert.equal(r.body.hasAcceptedOffer, true);
  assert.deepEqual(r.body.mismatches, []);
  assert.equal(r.body.prefillConditions["賃金"], "月給 300,000円");
});

await ok("食い違いがあれば mismatches に入る", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  const r = await reconcile("e1");
  assert.equal(r.body.mismatches.length, 1);
  assert.equal(r.body.mismatches[0].key, "wage");
});

await ok("採用HR経由でない社員（gw_hr_applicantsに紐づきが無い）は比較しない", async () => {
  setup();
  db.rows.gw_hr_applicants = [];
  const r = await reconcile("e1");
  assert.equal(r.body.linked, false);
  assert.deepEqual(r.body.mismatches, []);
  assert.ok(r.body.prefillConditions["賃金"], "事前入力そのものは、紐づきが無くても出す");
});

await ok("承諾済みofferがまだ無ければ、比較しない", async () => {
  setup();
  db.rows.gw_hr_offers[0].accepted_at = null;
  const r = await reconcile("e1");
  assert.equal(r.body.linked, true);
  assert.equal(r.body.hasAcceptedOffer, false);
  assert.deepEqual(r.body.mismatches, []);
});

await ok("社労士は突き合わせ結果を見られない", async () => {
  setup();
  who = ADVISOR;
  const r = await reconcile("e1");
  assert.equal(r.statusCode, 403);
});

console.log("\n=== 契約書作成依頼の作成（POST create） ===\n");

await ok("一致していれば、そのまま作成できる", async () => {
  setup();
  const r = await create({ employeeId: "e1", conditions: { "雇用区分": "正社員" }, force: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_doc_orders.length, 1);
});

await ok("食い違っていれば、理由が無いと作成できない（409）", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  const r = await create({ employeeId: "e1", conditions: {}, force: true });
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "offer_mismatch");
  assert.equal(r.body.mismatches[0].key, "wage");
  assert.equal(db.rows.gw_doc_orders.length, 0, "作成されない");
});

await ok("理由があっても、owner・hr以外は進められない（403）", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  who = ADMIN_NOT_HR;
  const r = await create({ employeeId: "e1", conditions: {}, force: true, overrideReason: "候補者に確認済み" });
  assert.equal(r.statusCode, 403, JSON.stringify(r.body));
  assert.equal(db.rows.gw_doc_orders.length, 0);
});

await ok("hrが理由つきで進めると、作成できる。override情報が記録される", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  const r = await create({ employeeId: "e1", conditions: {}, force: true, overrideReason: "候補者と再確認し合意済み" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_doc_orders[0].override_reason, "候補者と再確認し合意済み");
  assert.equal(db.rows.gw_doc_orders[0].override_by, "u-1");
  assert.ok(db.rows.gw_doc_orders[0].override_at);
});

await ok("overrideは、通常の作成とは別の監査ログに残る", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  await create({ employeeId: "e1", conditions: {}, force: true, overrideReason: "合意済み" });
  assert.ok(logged.some((l) => l.action === "doc_order.create"));
  assert.ok(logged.some((l) => l.action === "doc_order.create_override_mismatch"));
});

await ok("空のoverrideReasonは、理由として認めない", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  const r = await create({ employeeId: "e1", conditions: {}, force: true, overrideReason: "   " });
  assert.equal(r.statusCode, 409);
});

await ok("労働条件通知書（employment）以外は、突き合わせの対象にしない", async () => {
  setup();
  db.rows.gw_contracts[0].wage_amount = 320000;
  const r = await create({ employeeId: "e1", docKind: "pledge", conditions: {}, force: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("採用HR経由でない社員は、通常どおり作成できる（比較自体をしない）", async () => {
  setup();
  db.rows.gw_hr_applicants = [];
  const r = await create({ employeeId: "e1", conditions: {}, force: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
