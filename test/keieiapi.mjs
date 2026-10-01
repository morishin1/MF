// 経営（/api/keiei）：経営者だけ（二段階認証は要らない）・「データ未連携」を0にしない・集計の正しさ。
//
// ■ 何を守るテストか
//
//   1. 経営者（owner）だけが開ける。会計の管理者・人事・責任者・採用担当・経理・IT・営業・
//      社労士・一般メンバーは 403（ヘッダー・画面・API・DB のうち、API の入口）
//   2. 二段階認証（aal2）は要らない。経営者なら、通常ログイン（aal1）だけで開ける（2026-10-01 の方針変更。二段階認証は任意）
//   3. 権限のない人は、二段階認証の有無に関わらず 403
//   4. 取れないもの（売上・粗利・入金・キャッシュ残高など）は「データ未連携」。value を持たず、0 にしない
//   5. 取れるもの（経費・請求進捗・契約更新・在籍・成約件数）は正確に数える。人件費は「暫定」と明示
//   6. 元データの表が未作成でも、落とさない。その項目だけ「データ未連携」になり、0 にはならない
//   7. 全員の給与を返す人件費の閲覧は、履歴に残る（金額は残さない）
//   8. 入社準備は、既存の入社手続きの段階を6ステップに並べたもの（金額は返さない・読めない表は「データ未連携」）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// payLinked … 給与管理（db/105）の表を「ある」ことにする。既定は未適用（表が無い）
const db = { rows: {}, missing: new Set(), reads: [], firstPages: [], payLinked: false, failInsert: null };
const MAX_ROWS = 1000;        // Supabase の応答の行数の上限（max-rows）。.limit(5000) と書いても、ここで切られる
const logged = [];

function table(name) {
  db.reads.push(name);
  const f = [];
  let wantCount = false;
  const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  const gone = () => db.missing.has(name) || (!db.payLinked && (name === "gw_compensations" || name === "gw_pay_audit"));
  const err = () => (gone() ? { code: "PGRST205", message: `Could not find the table '${name}'` }
    : db.readFail?.has(name) ? { code: "XX000", message: "boom" } : null);
  let inserting = null;
  let span = null;      // range(from, to)
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    if (op === "neq") return r[k] !== v;
    if (op === "gte") return r[k] != null && r[k] >= v;
    return true;
  }));
  const q = {
    select(_cols, opts) { wantCount = Boolean(opts?.count); return q; },
    insert(v) { inserting = v; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    range(a, b) { span = [a, b]; if (a === 0) db.firstPages.push(name); return q; },
    then: (fn, rej) => Promise.resolve(
      inserting ? (err() || db.failInsert ? { data: null, error: err() || db.failInsert }
        : ((db.rows[name] ||= []).push(...[].concat(inserting)), { data: null, error: null })) :
      wantCount ? { data: null, count: err() ? null : rows().length, error: err() }
        : { data: err() ? null : (span ? rows().slice(span[0], Math.min(span[1] + 1, span[0] + MAX_ROWS)) : rows().slice(0, MAX_ROWS)).map(copy), error: err() },
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
  // 試験データは 2026-09。月を渡さないと「今月」（実行した日）になり、月が替わった日に落ちる。既定で、試験データの月を見る
  const q = /month=/.test(extra) ? extra : `${extra}&month=${MONTH}`;
  await keiei({ method, url: `/api/keiei?view=${view}${q}`, headers: { authorization: `Bearer ${jwt(aal)}` } }, r);
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
  logged.length = 0; db.missing = new Set(); db.payLinked = false; db.failInsert = null; db.readFail = new Set();
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
      assert.equal(r.body.error, "forbidden", `${label} / ${view}: 権限で断る`);
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

console.log("\n=== 二段階認証は要らない（任意のセキュリティ設定） ===\n");

await ok("経営者なら、二段階認証が未登録で、パスワードだけ（aal1）でも開ける。mfa_required は返らない", async () => {
  setup(); userFactors = [];
  for (const view of ["hub", "dashboard", "payroll", "security", "onboarding"]) {
    const r = await call(view, { aal: "aal1" });
    assert.equal(r.statusCode, 200, `${view}: 経営者は、通常ログイン（aal1）だけで入れる`);
    assert.notEqual(r.body.error, "mfa_required");
  }
});

await ok("登録済みで今回 aal1（6桁を確かめていない）でも、経営者なら開ける", async () => {
  setup();
  const r = await call("payroll", { aal: "aal1" });
  assert.equal(r.statusCode, 200);
  assert.ok(!("enrolled" in r.body) || r.body.error !== "mfa_required");
});

await ok("トークンから aal が読めなくても（aal なし）、経営者なら開ける", async () => {
  setup();
  const r = await call("dashboard", { aal: undefined });
  assert.equal(r.statusCode, 200);
});

await ok("2026-10-01 以降のMFA強制もない（強制日をどう変えても、経営は止まらない）", async () => {
  setup(); userFactors = [];
  for (const d of ["2000-01-01", "2026-10-01", "2999-01-01"]) {
    process.env.MFA_ENFORCE_FROM = d;
    try {
      const r = await call("dashboard", { aal: "aal1" });
      assert.equal(r.statusCode, 200, `MFA_ENFORCE_FROM=${d}`);
    } finally { delete process.env.MFA_ENFORCE_FROM; }
  }
});

await ok("権限（経営者）は、二段階認証の有無に関わらない。経営者でない人は、aal2 でも 403", async () => {
  setup(); who = ctxOf(["hr"]);
  for (const aal of ["aal1", "aal2"]) {
    const r = await call("payroll", { aal });
    assert.equal(r.statusCode, 403, aal);
    assert.equal(r.body.error, "forbidden");
  }
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

console.log("\n=== 人件費と給与管理（db/105）の接続 ===\n");

const compRow = (id, employee, extra = {}) => ({ id, tenant_id: "t1", employee_id: employee, effective_from: "2026-04-01", revision: 1, kind: "change",
  source: "owner", wage_type: "月給", base_amount: 250000, allowances: [], commute_amount: null, ...extra });
function linkPay() {
  setup(); db.payLinked = true;
  db.rows.gw_pay_audit = [];
  db.rows.gw_compensations = [
    compRow("c1", "e1", { base_amount: 320000, allowances: [{ name: "役職手当", amount: 20000 }], commute_amount: 10000 }),   // 契約は 300000
    compRow("c2", "e4", { base_amount: 250000 }),                                                                            // 契約なし
    compRow("c3", "e3", { wage_type: "時給", base_amount: 2500 }),
    compRow("c4", "e2", { effective_from: "2099-01-01", wage_type: "年俸", base_amount: 9000000 }),                            // まだ適用前 → 契約
    { ...compRow("cx", "e1", { base_amount: 999999 }), tenant_id: "t2" },                                                     // 他社
  ];
}

await ok("給与管理に記録がある人は、その記録（基本給＋手当＋通勤手当）で数える。記録がない人・適用前は契約。二重に足さない", async () => {
  linkPay();
  const p = (await call("payroll")).body.payroll;
  const by = Object.fromEntries(p.rows.map((x) => [x.name, x]));
  assert.equal(by["月給 太郎"].monthly, 350000, "320000＋手当20000＋通勤10000（契約の300000は使わない）");
  assert.equal(by["月給 太郎"].source, "pay");
  assert.equal(by["契約なし"].monthly, 250000, "契約が無くても、記録があれば数える");
  assert.equal(by["契約なし"].source, "pay");
  assert.equal(by["年俸 花子"].monthly, 500000, "適用が始まっていない記録は使わない（契約の年俸÷12）");
  assert.equal(by["年俸 花子"].source, "contract");
  assert.equal(by["時給 次郎"].included, false);
  assert.match(by["時給 次郎"].reason, /実稼働/);
  assert.equal(p.monthlyTotal, 350000 + 250000 + 500000);
  assert.equal(p.counted, 3); assert.equal(p.countedFromPay, 2); assert.equal(p.countedFromContract, 1);
  assert.equal(p.employeeCount, 4);
  assert.match(p.note, /給与管理に記録がある人/);
  assert.ok(!("payLinked" in p), "内部の印は返さない");
  assert.ok(!JSON.stringify(p).includes("999999"), "他社の記録は混ざらない");
});

await ok("給与管理の記録を含めて返す閲覧は、給与管理の監査ログに残る（金額は残さない）。ダッシュボード（合計だけ）は残さない", async () => {
  linkPay();
  await call("dashboard");
  assert.equal(db.rows.gw_pay_audit.length, 0, "合計だけのダッシュボードは、監査の対象にしない");
  await call("payroll");
  assert.equal(db.rows.gw_pay_audit.length, 1);
  const a = db.rows.gw_pay_audit[0];
  assert.deepEqual([a.tenant_id, a.actor_id, a.action, a.detail.via], ["t1", "u-x", "view_list", "payroll"]);
  assert.ok(!/\d{5,}/.test(JSON.stringify(a.detail)), "金額は残さない");
  assert.ok(logged.some((x) => x.action === "keiei.view"), "従来の閲覧の履歴も残る");
});

await ok("監査ログを残せなければ、人件費（全員の給与）は返さない", async () => {
  linkPay(); db.failInsert = { code: "XX000", message: "boom" };
  const r = await call("payroll");
  assert.equal(r.statusCode, 503); assert.equal(r.body.error, "audit_unavailable");
  assert.ok(!/350000|320000|250000/.test(JSON.stringify(r.body)));
});

await ok("給与管理の表があるのに読めないときは、契約だけに黙って切り替えず「データ未連携」", async () => {
  linkPay(); db.readFail = new Set(["gw_compensations"]);
  const r = await call("payroll");
  assert.equal(r.statusCode, 200); assert.equal(r.body.payroll, null);
  assert.match(r.body.reason, /給与管理/);
  const d = (await call("dashboard")).body;
  const card = d.cards.find((c) => c.key === "payroll");
  assert.equal(card.status, "missing", "ダッシュボードの人件費も、未連携（違う合計を出さない）");
});

await ok("給与管理の表が無い（db/105 未適用）ときは、これまでどおり契約だけ。監査ログにも触れない", async () => {
  setup();
  const r = await call("payroll");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.payroll.monthlyTotal, 800000);
  assert.equal(r.body.payroll.countedFromPay, 0);
  assert.match(r.body.payroll.note, /契約に登録された基本給ベース/);
  assert.equal((db.rows.gw_pay_audit || []).length, 0);
});

await ok("ダッシュボードのカードは、何ベースかを出す（給与管理＋契約 / 契約）", async () => {
  linkPay();
  const c1 = (await call("dashboard")).body.cards.find((c) => c.key === "payroll");
  assert.equal(c1.value, 1100000);
  assert.match(c1.sub, /給与管理＋契約ベース（暫定）・3\/4人分/);
  setup();
  const c2 = (await call("dashboard")).body.cards.find((c) => c.key === "payroll");
  assert.match(c2.sub, /^契約ベース（暫定）/);
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

console.log("\n=== 入社準備（6ステップ。既存の段階の写像） ===\n");

function setupOnboarding() {
  setup();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const emp = (id, name, status = "invited") => ({ id, tenant_id: "t1", display_name: name, department: "開発", position: "エンジニア", employment_type: "正社員", status, employee_kind: "proper", joined_on: null });
  db.rows.gw_employees.push(
    emp("e10", "山田 依頼前"), emp("e11", "佐藤 書類待ち", "active"), emp("e12", "鈴木 完了", "active"),
    emp("e13", "高橋 昔に完了", "active"), emp("e14", "退職 者", "left"), emp("e15", "取消 者"),
    { ...emp("e20", "他社 人"), tenant_id: "t2" },
  );
  const proc = (id, employee_id, extra = {}) => ({ id, tenant_id: "t1", employee_id, kind: "onboarding", status: "in_progress",
    target_on: null, stage: null, stage_at: null, updated_at: daysAgo(1), created_at: daysAgo(10), ...extra });
  db.rows.gw_procedures = [
    proc("p10", "e10", { target_on: "2026-10-01" }),
    proc("p11", "e11", { target_on: "2026-10-15" }),
    proc("p12", "e12", { status: "done", stage_at: daysAgo(5) }),
    proc("p13", "e13", { status: "done", stage_at: daysAgo(100), updated_at: daysAgo(100) }),
    proc("p14", "e14"), proc("p15", "e15", { status: "cancelled" }),
    { ...proc("p20", "e20"), tenant_id: "t2" },
  ];
  db.rows.gw_procedure_items = [
    { id: "i1", procedure_id: "p11", item_key: "doc_id", owner: "employee", required: true, status: "todo" },
    { id: "i2", procedure_id: "p11", item_key: "pc", owner: "hr", required: true, status: "todo" },
  ];
  // 金額は、どの表にあっても返らない（6ステップは状態だけ）
  db.rows.gw_doc_orders = [
    { employee_id: "e11", doc_kind: "employment", status: "signed", updated_at: daysAgo(3), wage_amount: 777777 },
    { employee_id: "e12", doc_kind: "employment", status: "signed", updated_at: daysAgo(30), wage_amount: 777777 },
  ];
  db.rows.gw_sign_requests = [
    { employee_id: "e11", doc_kind: "employment", status: "signed", sent_at: daysAgo(4) },
    { employee_id: "e12", doc_kind: "employment", status: "signed", sent_at: daysAgo(30) },
  ];
  db.rows.gw_consent_docs = [{ id: "d1", tenant_id: "t1", doc_key: "pledge", title: "誓約書", version: "1.0", status: "active", major: true }];
  db.rows.gw_onboard_consents = [
    { employee_id: "e11", kind: "pledge", version: "1.0", agreed_at: daysAgo(3) },
    { employee_id: "e12", kind: "pledge", version: "1.0", agreed_at: daysAgo(20) },
  ];
  db.rows.gw_onboard_profiles = [{ employee_id: "e11", status: "draft" }, { employee_id: "e12", status: "submitted" }];
  db.rows.gw_orientation_items = [];
  db.rows.gw_orientation_checks = [];
  const career = (employee_id) => ({ employee_id, tenant_id: "t1", is_active: true, track_id: "t", current_level_id: "l",
    one_year_target_note: "a", three_year_target_note: "b", next_review_on: "2027-04-01", agreed_at: daysAgo(2) });
  // e13（昔に完了）はキャリアも済んでいる。済んでいなければ、⑤ が残っているので「完了」ではない
  db.rows.gw_employee_careers = [career("e12"), career("e13")];
  db.rows.gw_contracts.push({ employee_id: "e11", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 777777, created_at: "2026-09-01" });
}
const row = (d, id) => d.rows.find((r) => r.employeeId === id);
const stepOfRow = (r, key) => r.six.steps.find((s) => s.key === key);

await ok("入社準備: 6ステップを、既存の段階から並べる（依頼前・本人の書類待ち・完了）", async () => {
  setupOnboarding();
  const r = await call("onboarding");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.status, "exact");
  assert.deepEqual(d.steps.map((s) => s.label), ["入社案内確認", "雇用契約", "入社情報入力", "必要書類提出", "会社確認", "入社準備完了"]);

  const a = row(d, "e10");
  assert.equal(stepOfRow(a, "contract").state, "current");
  assert.equal(stepOfRow(a, "contract").actor, "owner");
  assert.equal(a.six.next.label, "労働条件の作成依頼待ち");
  assert.equal(a.joinOn, "2026-10-01");

  const b = row(d, "e11");
  assert.equal(stepOfRow(b, "contract").state, "done");
  assert.equal(stepOfRow(b, "info").state, "current");
  assert.equal(stepOfRow(b, "docs").state, "current");
  assert.equal(stepOfRow(b, "company").state, "current");
  assert.equal(b.six.next.actor, "employee");
  assert.equal(b.six.needsCompany, true);

  const c = row(d, "e12");
  assert.equal(c.six.complete, true);
  assert.equal(stepOfRow(c, "complete").state, "done");
  assert.equal(c.six.next.label, "入社準備完了");
});

await ok("入社準備: ① 入社案内確認は、案内が無ければ「対象外」・発行済みで未確認なら本人の番・確認済みなら完了", async () => {
  setupOnboarding();
  db.rows.gw_onboarding_guides = [
    { employee_id: "e10", tenant_id: "t1", version: 0, confirmed_version: null, confirmed_at: null },              // 下書き
    { employee_id: "e11", tenant_id: "t1", version: 1, confirmed_version: null, confirmed_at: null },              // 発行済み・未確認
    { employee_id: "e12", tenant_id: "t1", version: 1, confirmed_version: 1, confirmed_at: "2026-09-20T01:00:00Z" }, // 確認済み
  ];
  const d = (await call("onboarding")).body;
  assert.equal(stepOfRow(row(d, "e10"), "guide").state, "na");
  assert.match(stepOfRow(row(d, "e10"), "guide").note, /下書き/);
  const g11 = stepOfRow(row(d, "e11"), "guide");
  assert.equal(g11.state, "current");
  assert.equal(g11.actor, "employee");
  assert.equal(g11.href, "#onboarding/e11", "案内の押す先は、経営の詳細画面");
  assert.equal(stepOfRow(row(d, "e12"), "guide").state, "done");
  assert.equal(row(d, "e12").six.complete, true);
  // 案内が無い人は、案内なしで進められる
  db.rows.gw_onboarding_guides = [];
  const d2 = (await call("onboarding")).body;
  assert.equal(stepOfRow(row(d2, "e12"), "guide").state, "na");
  assert.equal(stepOfRow(row(d2, "e12"), "guide").href, "#onboarding/e12", "案内が無い人は、作る画面へ");
  assert.equal(row(d2, "e12").six.complete, true);
});

await ok("入社準備: 案内の表（db/104）が無ければ、① だけ「データ未連携」。ほかは止まらない", async () => {
  setupOnboarding();
  db.missing = new Set(["gw_onboarding_guides"]);
  const d = (await call("onboarding")).body;
  assert.equal(d.status, "exact");
  for (const rw of d.rows) assert.equal(stepOfRow(rw, "guide").state, "unlinked");
  assert.equal(row(d, "e12").six.complete, true, "案内が読めなくても、手続きが終われば完了");
  assert.equal(stepOfRow(row(d, "e11"), "info").state, "current");
});

await ok("入社準備: 退職者・取り消し・他社は出ない。完了して30日を過ぎた人は外し、数だけ返す", async () => {
  setupOnboarding();
  const d = (await call("onboarding")).body;
  assert.deepEqual(d.rows.map((x) => x.employeeId).sort(), ["e10", "e11", "e12"]);
  assert.equal(d.hiddenComplete, 1);
  assert.deepEqual(d.summary, { total: 3, inProgress: 2, company: 2, employee: 1, advisor: 0, complete: 1 });
});

await ok("入社準備: 手続きは昔に完了でも、キャリアが未設定（上長の番）なら残す", async () => {
  setupOnboarding();
  db.rows.gw_employee_careers = db.rows.gw_employee_careers.filter((c) => c.employee_id !== "e13");
  const d = (await call("onboarding")).body;
  const r = row(d, "e13");
  assert.ok(r, "外さない");
  assert.equal(r.six.complete, true, "キャリアは入社準備の完了を止めない");
  assert.equal(r.six.after.key, "career");
  assert.equal(r.six.after.actor, "manager");
  assert.match(r.six.after.href, /^\/admin-career\.html\?employeeId=e13$/);
  assert.equal(d.hiddenComplete, 0);
});

await ok("入社準備: 完了した人は最後。入社日の近い順", async () => {
  setupOnboarding();
  const d = (await call("onboarding")).body;
  assert.deepEqual(d.rows.map((x) => x.employeeId), ["e10", "e11", "e12"]);
});

await ok("入社準備: 各ステップの「開く」は、要対応のときだけ。既存の画面へ（作り直さない）", async () => {
  setupOnboarding();
  const d = (await call("onboarding")).body;
  const a = stepOfRow(row(d, "e10"), "contract");
  assert.match(a.href, /^\/admin-esign\.html\?tab=order&employeeId=e10$/);
  const b = stepOfRow(row(d, "e11"), "info");
  assert.match(b.href, /^\/admin-hr\.html\?id=p11$/);
  assert.equal(stepOfRow(row(d, "e11"), "contract").href, null, "完了したステップに押す先は出さない");
  assert.equal(stepOfRow(row(d, "e12"), "docs").href, null);
});

await ok("入社準備: 給与・手当の金額は、どこにも返らない", async () => {
  setupOnboarding();
  const text = JSON.stringify((await call("onboarding")).body);
  assert.ok(!text.includes("777777"), "金額が漏れている");
  assert.ok(!/wage|salary/i.test(text), "賃金の項目が漏れている");
});

await ok("入社準備: 入社手続きの表が読めなければ「データ未連携」。空の一覧を「完了」とは言わない", async () => {
  setupOnboarding();
  db.missing = new Set(["gw_procedures"]);
  const d = (await call("onboarding")).body;
  assert.equal(d.status, "missing");
  assert.equal(d.missingLabel, "データ未連携");
  assert.equal(d.rows, undefined);
});

await ok("入社準備: キャリアの表が読めなければ、次の一手（after）を出さない。未設定とは言わない", async () => {
  setupOnboarding();
  db.missing = new Set(["gw_employee_careers"]);
  const d = (await call("onboarding")).body;
  const c = row(d, "e12");
  assert.equal(c.six.after, null);
  assert.equal(c.six.complete, true, "入社準備そのものは読めている");
});

await ok("入社準備: 入社準備中の人がいなければ、空の一覧（エラーにしない）", async () => {
  setup();
  db.rows.gw_procedures = [];
  const d = (await call("onboarding")).body;
  assert.equal(d.status, "exact");
  assert.deepEqual(d.rows, []);
  assert.equal(d.summary.total, 0);
});

await ok("入社準備: 経営者以外は 403（他の view と同じ入口）", async () => {
  setupOnboarding();
  who = ctxOf(["hr"], { isHr: true });
  const r = await call("onboarding");
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.rows, undefined);
});

console.log("\n=== 1000件を超えても切り捨てない・読めないものを 0 や空にしない ===\n");

await ok("経費: 応答の上限（1000件）を超えても、切り捨てずに全件を数える", async () => {
  setup();
  db.rows.gw_expense_reports = db.rows.gw_expense_reports.filter((r) => r.tenant_id === "t1");
  const line = (n) => [{ spent_on: "2026-09-03", category: "旅費交通費", amount: 100 + (n % 3) }];
  for (let i = 0; i < 2500; i++) {
    db.rows.gw_expense_reports.push({ id: `bulk${i}`, tenant_id: "t1", status: "approved", payment_method: "corporate_card", total_amount: 100,
      created_at: "2026-09-05T00:00:00Z", gw_expense_lines: line(i) });
  }
  const want = 2500 * 100 + [...Array(2500).keys()].reduce((a, i) => a + (i % 3), 0);
  const r = await call("expenses");
  const before = 5000 + 10000 + 7000 - 0;      // setup の確定分（r1・r2・r3。却下・承認待ち・古いものを除く）
  assert.equal(r.body.expense.confirmed.thisMonth, before + want, "2500件ぶんを全部数えている");
});

await ok("仕訳: 承認した仕訳は MF へ送ると sent になる。承認済み＝approved と sent の合計。1000件を超えても数える", async () => {
  setup();
  db.rows.journals = [];
  for (let i = 0; i < 1200; i++) db.rows.journals.push({ tenant_id: "t1", status: i % 2 ? "sent" : "approved", txn_date: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}` });
  db.rows.journals.push({ tenant_id: "t1", status: "sent", txn_date: "2026-09-20" }, { tenant_id: "t1", status: "draft", txn_date: "2026-09-25" });
  const j = (await call("accounting")).body.journals;
  assert.equal(j.total, 1202, "1000件で切れていない");
  assert.equal(j.approved, 600);
  assert.equal(j.sent, 601);
  assert.equal(j.approvedTotal, 1201, "承認済み＝approved と sent の合計");
  assert.equal(j.latestApprovedOn, "2026-09-20", "送信済みの仕訳の日付も、直近に数える");
  assert.equal(j.draft, 1);
});

await ok("経費: 元の表が読めないときは、経費全体を「データ未連携」にする（一部だけの合計・支払待ち 0円 を出さない）", async () => {
  setup();
  const orig = db.rows.gw_expense_reports;
  // 1回目（確定・承認待ち）は読め、2回目（支払待ち）だけ失敗する状況を、列名の違いで再現する
  db.rows.gw_expense_reports = orig;
  db.missing = new Set(["gw_expense_reports"]);
  const r = await call("expenses");
  assert.equal(r.body.expense, null);
  db.missing = new Set();
});

await ok("入社準備: 名簿が読めないときは「データ未連携」。「入社準備中の人はいません」にしない", async () => {
  setupOnboarding();
  db.missing = new Set(["gw_employees"]);
  const d = (await call("onboarding")).body;
  assert.equal(d.status, "missing");
  assert.equal(d.rows, undefined);
  assert.match(d.reason, /社員名簿/);
});

await ok("入社準備: チェックリストが読めないときは「データ未連携」。全部済んでいる（残り0件）にしない", async () => {
  setupOnboarding();
  db.missing = new Set(["gw_procedure_items"]);
  const d = (await call("onboarding")).body;
  assert.equal(d.status, "missing");
  assert.match(d.reason, /チェックリスト/);
  assert.equal(d.summary, undefined);
});

await ok("入社準備: チェックリストが1000件を超えても、切り捨てない（本人の残りを 0 件にしない）", async () => {
  setupOnboarding();
  // e11 の本人の書類（未提出）が、1000件のあとに1件ある
  db.rows.gw_procedure_items = [];
  for (let i = 0; i < 1100; i++) db.rows.gw_procedure_items.push({ id: `f${i}`, procedure_id: "p12", item_key: `k${i}`, owner: "employee", required: true, status: "done" });
  db.rows.gw_procedure_items.push({ id: "last", procedure_id: "p11", item_key: "doc_id", owner: "employee", required: true, status: "todo" });
  const d = (await call("onboarding")).body;
  const docs = row(d, "e11").six.steps.find((s) => s.key === "docs");
  assert.equal(docs.state, "current", "1100件のあとにある未提出の書類を、見落とさない");
});

await ok("ダッシュボード: 名簿は1回だけ読む（在籍数と人件費で使い回す）", async () => {
  setup();
  db.firstPages.length = 0;
  await call("dashboard");
  const n = db.firstPages.filter((x) => x === "gw_employees").length;
  assert.equal(n, 1, `gw_employees を頭から読んだ回数: ${n}回（ページ送りの2ページ目以降は数えない）`);
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
