// 経営（/api/keiei）：経営者だけ・二段階認証・「データ未連携」を0にしない・集計の正しさ。
//
// ■ 何を守るテストか
//
//   1. 経営者（owner）だけが開ける。会計の管理者・人事・責任者・採用担当・経理・IT・営業・
//      社労士・一般メンバーは 403（ヘッダー・画面・API・DB のうち、API の入口）
//   2. 二段階認証（aal2）が済んでいない経営者も、開けない。強制日（2026-10-01）を待たない
//   3. 権限のない人には、二段階認証の案内より先に断る（登録を促さない）
//   4. 取れないもの（売上・粗利・入金・キャッシュ残高など）は「データ未連携」。value を持たず、0 にしない
//   5. 取れるもの（経費・請求進捗・契約更新・在籍・成約件数）は正確に数える。人件費は「暫定」と明示
//   6. 元データの表が未作成でも、落とさない。その項目だけ「データ未連携」になり、0 にはならない
//   7. 全員の給与を返す人件費の閲覧は、履歴に残る（金額は残さない）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, missing: new Set() };
const logged = [];

function table(name) {
  const f = [];
  let wantCount = false;
  const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  const err = () => (db.missing.has(name) ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    if (op === "gte") return r[k] != null && r[k] >= v;
    return true;
  }));
  const q = {
    select(_cols, opts) { wantCount = Boolean(opts?.count); return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    then: (fn, rej) => Promise.resolve(
      wantCount ? { data: null, count: err() ? null : rows().length, error: err() }
        : { data: err() ? null : rows().map(copy), error: err() },
    ).then(fn, rej),
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-x", factors: userFactors }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
let userFactors = [];
let who;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: keiei } = await import(atRoot("api/keiei/index.js"));
const K = await import(atRoot("lib/keiei.js"));

const jwt = (aal) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (view = "dashboard", { aal = "aal2", method = "GET", extra = "" } = {}) => {
  const r = res();
  await keiei({ method, url: `/api/keiei?view=${view}${extra}`, headers: { authorization: `Bearer ${jwt(aal)}` } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const ctxOf = (roles, extra = {}) => ({
  tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: roles.includes("labor_advisor"),
  roles, employee: { id: "emp-x" }, ...extra,
});
const OWNER = ctxOf(["owner"]);

const MONTH = "2026-09";
function setup() {
  who = OWNER; userFactors = [{ status: "verified", factor_type: "totp" }];
  logged.length = 0; db.missing = new Set();
  const line = (spent_on, category, amount) => ({ spent_on, category, amount });
  db.rows = {
    gw_expense_reports: [
      { id: "r1", tenant_id: "t1", status: "approved", payment_method: "personal", total_amount: 5000, created_at: "2026-09-05T00:00:00Z",
        gw_expense_lines: [line("2026-09-03", "旅費交通費", 3000), line("2026-09-04", "会議費", 2000)] },
      { id: "r2", tenant_id: "t1", status: "paid", payment_method: "personal", total_amount: 10000, created_at: "2026-09-06T00:00:00Z",
        gw_expense_lines: [line("2026-09-05", "旅費交通費", 10000)] },
      { id: "r3", tenant_id: "t1", status: "approved", payment_method: "corporate_card", total_amount: 7000, created_at: "2026-09-07T00:00:00Z",
        gw_expense_lines: [line("2026-09-06", "通信費", 7000)] },
      { id: "r4", tenant_id: "t1", status: "pending", payment_method: "personal", total_amount: 4000, created_at: "2026-09-08T00:00:00Z",
        gw_expense_lines: [line("2026-09-07", "消耗品費", 4000)] },
      { id: "r5", tenant_id: "t1", status: "rejected", payment_method: "personal", total_amount: 99999, created_at: "2026-09-09T00:00:00Z",
        gw_expense_lines: [line("2026-09-08", "交際費", 99999)] },
      // 前月
      { id: "r6", tenant_id: "t1", status: "paid", payment_method: "personal", total_amount: 12000, created_at: "2026-08-10T00:00:00Z",
        gw_expense_lines: [line("2026-08-09", "旅費交通費", 12000)] },
      // 古い承認済み・未払い（期間で絞ると漏れる）
      { id: "r7", tenant_id: "t1", status: "approved", payment_method: "personal", total_amount: 3000, created_at: "2024-01-10T00:00:00Z",
        gw_expense_lines: [line("2024-01-09", "旅費交通費", 3000)] },
      // 他社
      { id: "rx", tenant_id: "t2", status: "approved", payment_method: "personal", total_amount: 777777, created_at: "2026-09-05T00:00:00Z",
        gw_expense_lines: [line("2026-09-03", "旅費交通費", 777777)] },
    ],
    gw_employees: [
      { id: "e1", tenant_id: "t1", display_name: "月給 太郎", status: "active", employee_kind: "proper" },
      { id: "e2", tenant_id: "t1", display_name: "年俸 花子", status: "active", employee_kind: "proper" },
      { id: "e3", tenant_id: "t1", display_name: "時給 次郎", status: "active", employee_kind: "proper" },
      { id: "e4", tenant_id: "t1", display_name: "契約なし", status: "active", employee_kind: "proper" },
      { id: "e5", tenant_id: "t1", display_name: "BP 三郎", status: "active", employee_kind: "bp" },
      { id: "e6", tenant_id: "t1", display_name: "退職済み", status: "left", employee_kind: "proper" },
      { id: "e7", tenant_id: "t1", display_name: "入社準備", status: "invited", employee_kind: "proper" },
    ],
    gw_contracts: [
      { employee_id: "e1", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 300000, created_at: "2026-04-01" },
      { employee_id: "e2", tenant_id: "t1", status: "active", wage_type: "年俸", wage_amount: 6000000, created_at: "2026-04-01" },
      { employee_id: "e3", tenant_id: "t1", status: "active", wage_type: "時給", wage_amount: 2000, created_at: "2026-04-01" },
      { employee_id: "e6", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 999999, created_at: "2026-04-01" },
    ],
    gw_billing_progress: [
      { id: "b1", tenant_id: "t1", billing_month: MONTH, timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true },
      { id: "b2", tenant_id: "t1", billing_month: MONTH, timesheet_received: true, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
      { id: "b3", tenant_id: "t1", billing_month: "2026-08", timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true },
    ],
    gw_site_contracts: [
      { id: "s1", tenant_id: "t1", period_from: "2026-01-01", period_to: "2099-12-31", renewal_status: "confirmed", engagement_kind: "bp" },
      { id: "s2", tenant_id: "t1", period_from: "2026-01-01", period_to: new Date(Date.now() + 9 * 3600000 + 20 * 86400000).toISOString().slice(0, 10), renewal_status: "pending", engagement_kind: "pp" },
      { id: "s3", tenant_id: "t1", period_from: "2026-01-01", period_to: new Date(Date.now() + 9 * 3600000 + 20 * 86400000).toISOString().slice(0, 10), renewal_status: "renewed", engagement_kind: "pp" },
    ],
    gw_sales_companies: [
      { id: "c1", tenant_id: "t1", status: "won" }, { id: "c2", tenant_id: "t1", status: "won" },
      { id: "c3", tenant_id: "t1", status: "meeting" }, { id: "c4", tenant_id: "t1", status: "proposal" }, { id: "c5", tenant_id: "t1", status: "lost" },
      { id: "cx", tenant_id: "t2", status: "won" },
    ],
    journals: [
      { tenant_id: "t1", status: "approved", txn_date: "2026-08-31" }, { tenant_id: "t1", status: "approved", txn_date: "2026-09-10" },
      { tenant_id: "t1", status: "draft", txn_date: "2026-09-12" },
    ],
  };
}

console.log("\n=== 経営者だけ（3層のうち API の入口） ===\n");

await ok("経営者は開ける", async () => {
  setup();
  const r = await call();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("経営者以外は、すべて 403。データは一切返らない", async () => {
  const others = [
    ["会計の管理者だけ", ctxOf([], { isAdmin: true })],
    ["管理者＋人事", ctxOf(["hr"], { isAdmin: true })],
    ["人事", ctxOf(["hr"])],
    ["責任者", ctxOf(["manager"])],
    ["採用担当", ctxOf(["recruiter"])],
    ["経理", ctxOf(["finance"])],
    ["IT・管理", ctxOf(["it"])],
    ["営業担当", ctxOf(["sales"])],
    ["社労士", ctxOf(["labor_advisor"])],
    ["一般メンバー", ctxOf([])],
    ["責任者＋経理＋人事＋採用担当＋営業＋管理者", ctxOf(["manager", "finance", "hr", "recruiter", "sales"], { isAdmin: true })],
  ];
  for (const view of ["dashboard", "expenses", "payroll", "revenue", "cash", "accounting", "onboarding"]) {
    for (const [label, c] of others) {
      setup(); who = c;
      const r = await call(view);
      assert.equal(r.statusCode, 403, `${label} / ${view}`);
      assert.equal(r.body.error, "forbidden", `${label} / ${view}: 二段階認証の案内ではなく、権限で断る`);
      assert.ok(!JSON.stringify(r.body).includes("300000"), "給与が漏れていない");
    }
  }
});

await ok("所属（テナント）が無い人は、403", async () => {
  setup(); who = ctxOf(["owner"], { tenantId: null });
  assert.equal((await call()).statusCode, 403);
});

await ok("GET 以外は 405。知らない view は 400", async () => {
  setup();
  assert.equal((await call("dashboard", { method: "POST" })).statusCode, 405);
  const r = await call("nope");
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_view");
});

console.log("\n=== 二段階認証（強制日を待たない） ===\n");

await ok("経営者でも、二段階認証（aal2）が済んでいなければ開けない。未登録なら登録へ案内する", async () => {
  setup(); userFactors = [];
  const r = await call("dashboard", { aal: "aal1" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "mfa_required");
  assert.equal(r.body.enrolled, false);
  assert.match(r.body.hint, /登録/);
  assert.ok(!JSON.stringify(r.body).includes("cards"));
});

await ok("登録済みで今回 aal1（6桁を確かめていない）なら、6桁の確認へ案内する", async () => {
  setup();
  const r = await call("payroll", { aal: "aal1" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.enrolled, true);
  assert.match(r.body.hint, /6桁/);
});

await ok("強制日より前でも要る（requireMfa と違い、日付で緩めない）", async () => {
  const M = await import(atRoot("lib/mfa.js"));
  assert.ok(M.todayJst() < M.ENFORCE_FROM || true);
  setup();
  process.env.MFA_ENFORCE_FROM = "2999-01-01";
  try {
    const r = await call("dashboard", { aal: "aal1" });
    assert.equal(r.statusCode, 403, "強制日が遠い先でも、経営は止める");
  } finally { delete process.env.MFA_ENFORCE_FROM; }
});

console.log("\n=== 「データ未連携」を0にしない ===\n");

const cards = (r) => Object.fromEntries(r.body.cards.map((c) => [c.key, c]));

await ok("売上・粗利・営業利益・入金・BP支払・キャッシュ残高は、値を持たない（0円と出さない）", async () => {
  setup();
  const r = await call();
  const c = cards(r);
  for (const k of ["revenue", "gross", "profit", "receivable", "payable_bp", "cash"]) {
    assert.equal(c[k].status, "missing", k);
    assert.ok(!("value" in c[k]), `${k} は value を持たない`);
    assert.ok(c[k].reason && c[k].reason.length > 5, `${k} に理由がある`);
  }
  assert.equal(r.body.missingLabel, "データ未連携");
});

await ok("数値カードは、正確に出せるものだけ（経費・請求進捗・契約更新・在籍・成約）。人件費は暫定", async () => {
  setup();
  const c = cards(await call());
  assert.equal(c.expense.status, "exact");
  assert.equal(c.payroll.status, "provisional");
  assert.match(c.payroll.sub, /暫定/);
  for (const k of ["billing", "renewals", "headcount", "sales", "payable"]) assert.equal(c[k].status, "exact", k);
});

await ok("元データの表が未作成でも落ちない。その項目だけ消え、0 にはならない", async () => {
  setup();
  db.missing = new Set(["gw_billing_progress", "gw_site_contracts", "gw_sales_companies", "gw_expense_reports"]);
  const r = await call();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = cards(r);
  assert.ok(!c.billing && !c.renewals && !c.sales, "取れない項目のカードを、0件で出さない");
  assert.equal(c.expense.status, "missing", "経費の表が無いときは、0円ではなく未連携");
  assert.ok(!("value" in c.expense));
  assert.ok(!c.payable, "支払予定（立替）も、取れなければ出さない");
});

console.log("\n=== 集計の正しさ ===\n");

await ok("経費: 確定＝承認済み＋支払済み。承認待ちは別。却下・他社は含めない。前月比・科目別・支払方法別", async () => {
  setup();
  const r = await call("expenses");
  const e = r.body.expense;
  assert.equal(e.status, "exact");
  assert.equal(e.confirmed.thisMonth, 3000 + 2000 + 10000 + 7000);
  assert.equal(e.confirmed.prevMonth, 12000);
  assert.equal(e.confirmed.diff, 22000 - 12000);
  assert.equal(e.confirmed.diffPct, Math.round(((22000 - 12000) / 12000) * 1000) / 10);
  assert.equal(e.pending.thisMonth, 4000);
  assert.equal(e.pending.count, 1);
  assert.deepEqual(e.byCategory.map((x) => [x.category, x.amount]), [["旅費交通費", 13000], ["通信費", 7000], ["会議費", 2000]]);
  assert.equal(e.byMethod.personal, 15000);
  assert.equal(e.byMethod.corporate_card, 7000);
  assert.ok(!JSON.stringify(e).includes("99999") && !JSON.stringify(e).includes("777777"));
  assert.equal(e.monthly.length, 12);
  assert.equal(e.monthly.at(-1).month, MONTH);
});

await ok("支払予定（立替）: 承認済みで未払いの立替。古いものも漏らさない。法人カード・支払済みは含めない", async () => {
  setup();
  const e = (await call("expenses")).body.expense;
  assert.equal(e.payable.amount, 5000 + 3000);
  assert.equal(e.payable.count, 2);
});

await ok("人件費（暫定）: 月給はそのまま、年俸は12で割る。時給・契約なしは含めず理由を出す。BP・退職者は対象外", async () => {
  setup();
  const r = await call("payroll");
  const p = r.body.payroll;
  assert.equal(p.status, "provisional");
  assert.equal(p.monthlyTotal, 300000 + 500000);
  assert.equal(p.counted, 2);
  assert.equal(p.employeeCount, 4, "在籍のプロパー（BP・退職者を除く）。入社準備中は含む");
  const byName = Object.fromEntries(p.rows.map((x) => [x.name, x]));
  assert.equal(byName["月給 太郎"].monthly, 300000);
  assert.equal(byName["年俸 花子"].monthly, 500000);
  assert.equal(byName["時給 次郎"].included, false);
  assert.match(byName["時給 次郎"].reason, /実稼働/);
  assert.equal(byName["契約なし"].included, false);
  assert.match(byName["契約なし"].reason, /未登録/);
  assert.ok(!byName["BP 三郎"] && !byName["退職済み"]);
  assert.match(p.note, /社会保険料・賞与・残業割増/);
});

await ok("人件費の閲覧は履歴に残る（誰が・いつ。金額は残さない）", async () => {
  setup();
  await call("payroll");
  const l = logged.find((x) => x.action === "keiei.view");
  assert.ok(l, "keiei.view が残る");
  assert.equal(l.target, "payroll");
  assert.ok(!JSON.stringify(l).includes("300000"));
  logged.length = 0;
  await call("dashboard");
  assert.ok(!logged.some((x) => x.action === "keiei.view"), "件数中心のダッシュボードでは残さない（人件費の詳細だけ）");
});

await ok("請求進捗・契約更新・在籍・成約は、件数で正確に", async () => {
  setup();
  const c = cards(await call());
  assert.equal(c.billing.value, "1/2", "今月の対象2件のうち、5段階すべて完了は1件（前月の行は数えない）");
  assert.equal(c.renewals.value, 1, "45日以内に終わる未更新は1件（更新済みは数えない）");
  assert.equal(c.headcount.value, 5, "在籍＝退職者を除く（BP・入社準備中を含む）");
  assert.match(c.headcount.sub, /プロパー 4・BP 1／入社準備中 1/);
  assert.equal(c.sales.value, 2);
  assert.match(c.sales.sub, /商談中 2/);
});

await ok("売上・利益の画面は、金額を返さず「データ未連携」と、進み具合・更新期限・成約件数だけ", async () => {
  setup();
  const r = await call("revenue");
  assert.equal(r.statusCode, 200);
  for (const m of r.body.money) { assert.equal(m.status, "missing"); assert.ok(!("value" in m)); }
  assert.equal(r.body.billing.complete, 1);
  assert.equal(r.body.renewals.upcoming.length, 1);
  assert.equal(r.body.sales.won, 2);
});

await ok("入金・支払の画面は、立替経費の支払待ちだけ正確。ほかは未連携", async () => {
  setup();
  const r = await call("cash");
  assert.equal(r.body.payable.amount, 8000);
  for (const it of r.body.items) { assert.equal(it.status, "missing"); assert.ok(!("value" in it)); }
});

await ok("会計の画面は、このアプリの承認済み仕訳だけ（暫定）と明示し、既存の会計画面へ入口を出す", async () => {
  setup();
  const r = await call("accounting");
  assert.equal(r.body.status, "provisional");
  assert.equal(r.body.journals.total, 3);
  assert.equal(r.body.journals.approved, 2);
  assert.equal(r.body.journals.latestApprovedOn, "2026-09-10");
  assert.match(r.body.note, /このアプリで承認した仕訳だけ/);
  assert.equal(r.body.links.accounting, "/admin.html");
});

console.log("\n=== 部品（lib/keiei.js） ===\n");

await ok("lastMonths は、今月を含む古い順の12か月", async () => {
  assert.deepEqual(K.lastMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
  assert.equal(K.lastMonths("2026-09", 12).length, 12);
});

await ok("経費が無い月は前月比を出さない（0で割らない）", async () => {
  const e = K.summarizeExpenses([], { month: "2026-09" });
  assert.equal(e.confirmed.thisMonth, 0);
  assert.equal(e.confirmed.diffPct, null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
