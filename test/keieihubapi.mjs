// 経営ハブ（/api/keiei?view=hub|security）。
//
// ■ 何を守るテストか
//   1. 経営者（owner）だけ（ほかの view と同じ入口。二段階認証は要らない）
//   2. 4ブロックの数字が、元データから正しく出る。他社（別テナント）の行は数えない
//   3. 読み取りだけ。書き込み（insert / update / delete / upsert）は1回も起きない
//   4. 給与・手当・単価の表も列も読まない（応募者は id・段階・状態・期限だけ。契約・給与管理・給与の表に触れない）
//   5. 読めなかった元データは、0 にせず unreadable に出る（表が無い・読み込み失敗・認証の取得失敗）
//   6. 1000件を超えても切り捨てない
//   7. 旧 view（dashboard / expenses / revenue / cash / accounting）は、後方互換のためまだ動く
//   8. 経営設定・セキュリティ: 経営者の一覧・二段階認証の登録状況（参考。警告にしない）・変更の履歴（この会社の、経営者に関する記録だけ）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, missing: new Set(), readFail: new Set(), reads: [], selects: {}, writes: [], factors: {}, factorsFail: false };
const MAX_ROWS = 1000;        // Supabase の応答の行数の上限（max-rows）

function table(name) {
  db.reads.push(name);
  const f = [];
  let wantCount = false;
  let head = false;
  let span = null;
  let cap = null;
  let sort = null;
  const copy = (r) => JSON.parse(JSON.stringify(r));
  const err = () => (db.missing.has(name) ? { code: "PGRST205", message: `Could not find the table '${name}'` }
    : db.readFail.has(name) ? { code: "XX000", message: "boom" } : null);
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) && v.includes(r[k]);
      if (op === "neq") return r[k] !== v;
      if (op === "gte") return r[k] != null && r[k] >= v;
      return true;
    }));
    if (sort) out = [...out].sort((a, b) => (String(a[sort.k]) < String(b[sort.k]) ? -1 : 1) * (sort.asc ? 1 : -1));
    return out;
  };
  const write = (op) => () => { db.writes.push([name, op]); return q; };
  const q = {
    select(cols, opts) { (db.selects[name] ||= new Set()).add(String(cols)); wantCount = Boolean(opts?.count); head = Boolean(opts?.head); return q; },
    insert: write("insert"), update: write("update"), delete: write("delete"), upsert: write("upsert"),
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    order(k, o) { sort = { k, asc: o?.ascending !== false }; return q; },
    limit(n) { cap = n; return q; },
    range(a, b) { span = [a, b]; return q; },
    then: (fn, rej) => Promise.resolve(
      wantCount && head ? { data: null, count: err() ? null : rows().length, error: err() }
        : { data: err() ? null : (span ? rows().slice(span[0], Math.min(span[1] + 1, span[0] + MAX_ROWS)) : rows().slice(0, Math.min(cap ?? MAX_ROWS, MAX_ROWS))).map(copy), error: err() },
    ).then(fn, rej),
  };
  return q;
}

// 認証の管理用 API（他の経営者の二段階認証の登録状況）
const auth = { admin: { mfa: { listFactors: async ({ userId }) => {
  if (db.factorsFail) throw new Error("auth down");
  return { data: { factors: db.factors[userId] || [] }, error: null };
} } } };

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table, auth }), userClient: () => ({ from: table }) } });
let userFactors = [];
let who;
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u1", factors: userFactors }), getMemberships: async () => [] } });
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: keiei } = await import(atRoot("api/keiei/index.js"));

const jwt = (aal) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (view, { aal = "aal2" } = {}) => {
  const r = res();
  await keiei({ method: "GET", url: `/api/keiei?view=${view}`, headers: { authorization: `Bearer ${jwt(aal)}` } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const ctxOf = (roles) => ({ tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: false, roles, employee: { id: "e1" } });
const OWNER = ctxOf(["owner"]);

const dayOff = (n) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
const tsOff = (n) => new Date(Date.now() + n * 86400000).toISOString();
const thisMonth = dayOff(0).slice(0, 7);
const prevMonthOf = (m) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const lastMonth = prevMonthOf(thisMonth);

function setup() {
  who = OWNER; userFactors = [{ status: "verified", factor_type: "totp" }];
  logged.length = 0; db.missing = new Set(); db.readFail = new Set(); db.reads = []; db.selects = {}; db.writes = [];
  db.factors = { u1: [{ status: "verified", factor_type: "totp", id: "f1" }], u2: [] }; db.factorsFail = false;
  const emp = (id, name, extra = {}) => ({ id, tenant_id: "t1", user_id: `u${id.slice(1)}`, display_name: name, status: "active", employee_kind: "proper", ...extra });
  db.rows = {
    gw_employees: [
      emp("e1", "経営 一郎"), emp("e2", "経営 二郎"), emp("e3", "社員 三郎"), emp("e4", "BP 四郎", { employee_kind: "bp" }),
      emp("e5", "退職 五郎", { status: "left" }), emp("e6", "入社 六郎", { status: "invited" }),
      { id: "ex", tenant_id: "t2", user_id: "ux", display_name: "他社 太郎", status: "active", employee_kind: "proper" },
    ],
    gw_role_grants: [
      { id: "g1", tenant_id: "t1", employee_id: "e1", role: "owner" }, { id: "g2", tenant_id: "t1", employee_id: "e2", role: "owner" },
      { id: "g3", tenant_id: "t1", employee_id: "e3", role: "hr" }, { id: "gx", tenant_id: "t2", employee_id: "ex", role: "owner" },
    ],
    gw_expense_reports: [
      { id: "x1", tenant_id: "t1", status: "pending_owner", payment_method: "personal", total_amount: 60000 },
      { id: "x2", tenant_id: "t1", status: "pending", payment_method: "personal", total_amount: 10000 },
      { id: "x3", tenant_id: "t1", status: "approved", payment_method: "personal", total_amount: 5000 },
      { id: "x4", tenant_id: "t1", status: "paid", payment_method: "personal", total_amount: 99999 },
      { id: "x5", tenant_id: "t1", status: "approved", payment_method: "corporate_card", total_amount: 88888 },
      { id: "xx", tenant_id: "t2", status: "pending_owner", payment_method: "personal", total_amount: 777777 },
    ],
    gw_requests: [
      { id: "q1", tenant_id: "t1", status: "pending_owner" }, { id: "q2", tenant_id: "t1", status: "pending_owner" },
      { id: "q3", tenant_id: "t1", status: "pending" }, { id: "qx", tenant_id: "t2", status: "pending_owner" },
    ],
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", stage: "ceo_interview", status: "ceo_decision_pending", decision_due_on: null, wage_amount: 5000000, name: "応募 一" },
      { id: "a2", tenant_id: "t1", stage: "applied", status: "todo", decision_due_on: dayOff(-2), wage_amount: 4000000 },
      { id: "a3", tenant_id: "t1", stage: "offer", status: "offer_sent", decision_due_on: null },
      { id: "a4", tenant_id: "t1", stage: "offer", status: "declined", decision_due_on: null },
      { id: "a5", tenant_id: "t1", stage: "applied", status: "passed", decision_due_on: dayOff(-9) },
      { id: "ax", tenant_id: "t2", stage: "ceo_interview", status: "ceo_decision_pending", decision_due_on: null },
    ],
    gw_blockers: [
      { id: "b1", user_id: "u3", status: "open", escalation_level: 2, blocked_since: dayOff(-5) },
      { id: "b2", user_id: "u4", status: "open", escalation_level: 0, blocked_since: dayOff(-8) },
      { id: "b3", user_id: "ux", status: "open", escalation_level: 2, blocked_since: dayOff(-30) },      // 他社の人
      { id: "b4", user_id: "u3", status: "resolved", escalation_level: 2, blocked_since: dayOff(-30) },   // 外れた
    ],
    gw_site_contracts: [
      { id: "s1", tenant_id: "t1", period_to: dayOff(5), renewal_status: "pending" },
      { id: "s2", tenant_id: "t1", period_to: dayOff(30), renewal_status: "confirmed" },
      { id: "s3", tenant_id: "t1", period_to: dayOff(5), renewal_status: "renewed" },
      { id: "sx", tenant_id: "t2", period_to: dayOff(5), renewal_status: "pending" },
    ],
    gw_month_closings: [{ id: "c0", tenant_id: "t1", month: prevMonthOf(lastMonth), status: "closed" }],   // 前々月は締まっている。前月は未締め
    gw_billing_progress: [
      { id: "p1", tenant_id: "t1", billing_month: lastMonth, timesheet_received: true, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
      { id: "p2", tenant_id: "t1", billing_month: lastMonth, timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true },
    ],
    journals: [
      { id: "j1", tenant_id: "t1", status: "draft" }, { id: "j2", tenant_id: "t1", status: "draft" }, { id: "j3", tenant_id: "t1", status: "draft" },
      { id: "j4", tenant_id: "t1", status: "approved" }, { id: "jx", tenant_id: "t2", status: "draft" },
    ],
    gw_activity_log: [
      { id: 1, ts: tsOff(-1), tenant_id: "t1", actor_id: "u1", action: "owner.grant", target: "employee:e2", detail: { name: "経営 二郎" } },
      { id: 2, ts: tsOff(-2), tenant_id: "t1", actor_id: "u1", action: "role.grant", target: "employee:e3", detail: { role: "hr" } },     // owner の記録ではない
      { id: 3, ts: tsOff(-3), tenant_id: "t1", actor_id: "u3", action: "mfa.reset_denied", target: "employee:e1", detail: {} },
      { id: 4, ts: tsOff(-4), tenant_id: "t2", actor_id: "ux", action: "owner.grant", target: "employee:ex", detail: { name: "他社 太郎" } },  // 他社
      { id: 5, ts: tsOff(-5), tenant_id: "t1", actor_id: "u1", action: "mfa.reset", target: "employee:e3", detail: {} },
    ],
  };
}

const items = (d) => [...d.attention, ...d.risks];
const by = (d, key) => items(d).find((i) => i.key === key);
const tile = (d, key) => [...d.people.tiles, ...d.money.internal].find((t) => t.key === key);

console.log("\n=== 経営者だけ（二段階認証は要らない） ===\n");

for (const view of ["hub", "security"]) {
  await ok(`${view}: 経営者だけ。ほかの役割は 403`, async () => {
    setup();
    for (const roles of [[], ["hr"], ["manager"], ["recruiter"], ["finance"], ["it"], ["labor_advisor"], ["sales"]]) {
      who = ctxOf(roles);
      assert.equal((await call(view)).statusCode, 403, roles.join() || "一般メンバー");
    }
    who = { ...ctxOf(["hr"]), isAdmin: true };
    assert.equal((await call(view)).statusCode, 403, "会計の管理者");
    assert.equal(db.reads.length, 0, "断った人には、何も読まない");
  });

  await ok(`${view}: 経営者なら、二段階認証（aal2）が済んでいなくても（aal1）、開ける。mfa_required は返らない`, async () => {
    setup();
    const r = await call(view, { aal: "aal1" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.error, "mfa_required");
    assert.ok(db.reads.length > 0);
  });
}

console.log("\n=== ホーム: 4ブロックの数字 ===\n");

await ok("①今日の確認: 代表の承認待ち・稟議・社長判断・Blocker・契約更新・月次締め（他社の行は数えない）", async () => {
  setup();
  const r = await call("hub");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body;
  const exp = by(d, "expense_approval");
  assert.equal(exp.count, 1);
  assert.match(exp.detail, /60,000円/, "他社の 777,777円 は含まない");
  assert.equal(by(d, "request_approval").count, 2);
  assert.equal(by(d, "ceo_decision").count, 1, "他社の社長判断待ちは数えない");
  assert.equal(by(d, "blocker_owner").count, 1, "他社の人・外れたものは数えない");
  assert.equal(by(d, "renewal_soon").count, 1, "更新済み・他社は数えない");
  assert.equal(d.attention.find((i) => i.key === "closing").href, "/admin-closing.html");
  assert.ok(d.attention.every((i) => i.block === "today"));
});

await ok("④リスク・未処理: 長期Blocker・契約更新（先）・採用の期限超過・請求の滞留。二段階認証が未登録の経営者は、リスクに出さない", async () => {
  setup();
  const d = (await call("hub")).body;
  assert.equal(by(d, "blocker_long").count, 1);
  assert.equal(by(d, "renewal_watch").count, 1);
  assert.equal(by(d, "recruit_overdue").count, 1, "見送り済みの応募者の期限は数えない");
  assert.equal(by(d, "billing_stale").count, 1, "5段階が済んだ行は数えない");
  assert.equal(by(d, "mfa_missing"), undefined, "二段階認証は任意。経営 二郎 が未登録でも、リスクにしない");
  assert.ok(!JSON.stringify(d).includes("二段階認証が未登録"), "どこにも、未登録の警告が出ない");
  assert.equal(by(d, "owner_single"), undefined, "経営者は2人いる");
  assert.ok(d.risks.every((i) => i.block === "risk"));
  const rank = { high: 0, mid: 1, low: 2 };
  assert.deepEqual(d.risks.map((i) => rank[i.severity]), d.risks.map((i) => rank[i.severity]).sort((a, b) => a - b), "重要なものが先");
  assert.ok(d.risks.length >= 4);
  assert.deepEqual(d.unreadable, []);
});

await ok("②人・組織: 在籍（プロパー／BP）・採用選考中・内定（他社・見送り・辞退を除く）", async () => {
  setup();
  const d = (await call("hub")).body;
  assert.equal(tile(d, "headcount").value, 4, "在籍 = 在籍中（active・leaving）。入社準備中と退職者は含まない");
  assert.match(tile(d, "headcount").sub, /プロパー 3・BP 1/);
  assert.equal(tile(d, "recruiting").value, 2);
  assert.equal(tile(d, "offers").value, 1);
});

await ok("③お金: Board は未接続の1表示。社内は経費承認待ち（全件）・立替支払待ち・会計確認待ち", async () => {
  setup();
  const d = (await call("hub")).body;
  assert.deepEqual(d.money.board, { status: "unlinked", message: "売上・請求は Board 連携後に表示します" });
  assert.equal(tile(d, "expense_pending").value, 2, "管理部の承認待ちも含む");
  assert.match(tile(d, "expense_pending").sub, /70,000円/);
  assert.equal(tile(d, "payable").value, 1, "承認済みの立替だけ。法人カード・支払済みは含まない");
  assert.match(tile(d, "payable").sub, /5,000円/);
  assert.equal(tile(d, "journals").value, 3, "他社・承認済みは数えない");
});

await ok("何もない会社: ①も④も空。ただし読めない元データは無い", async () => {
  setup();
  db.rows.gw_expense_reports = []; db.rows.gw_requests = []; db.rows.gw_hr_applicants = []; db.rows.gw_blockers = [];
  db.rows.gw_site_contracts = []; db.rows.gw_billing_progress = []; db.rows.journals = [];
  db.rows.gw_month_closings = [{ id: "c1", tenant_id: "t1", month: lastMonth, status: "closed" }];
  db.factors.u2 = [{ status: "verified", factor_type: "totp", id: "f2" }];
  const d = (await call("hub")).body;
  assert.deepEqual(d.attention, []);
  assert.deepEqual(d.risks, []);
  assert.deepEqual(d.unreadable, []);
});

console.log("\n=== 読み取りだけ・給与に触れない ===\n");

await ok("ホームとセキュリティは、書き込みを1回もしない（監査ログの追記も、集計の保存もない）", async () => {
  setup();
  assert.equal((await call("hub")).statusCode, 200);
  assert.equal((await call("security")).statusCode, 200);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(logged, []);
});

await ok("給与・契約の表は読まない。応募者は id・段階・状態・期限だけを選ぶ", async () => {
  setup();
  db.rows.gw_contracts = [{ employee_id: "e3", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 777777 }];
  await call("hub");
  await call("security");
  for (const t of ["gw_contracts", "gw_compensations", "gw_hr_pay", "gw_pay_audit", "gw_hr_offers", "gw_onboard_profiles"]) {
    assert.ok(!db.reads.includes(t), `${t} を読んでいる`);
  }
  assert.deepEqual([...db.selects.gw_hr_applicants], ["id, stage, status, decision_due_on"]);
  for (const [t, cols] of Object.entries(db.selects)) {
    // 金額の列は、経費（合計）と営業の案件金額（受注額。2026-10 の Phase 1）だけ。給与・単価・手当の列はどの表からも読まない
    for (const c of cols) {
      assert.ok(!/wage|salary|unit_price|commute/.test(c), `${t}: ${c}`);
      assert.ok(!/amount/.test(c) || t === "gw_expense_reports" || t === "gw_sales_deals", `${t}: ${c}`);
    }
  }
});

await ok("応答のどこにも、給与・単価の語も値もない（応募者・契約の金額を仕込んでも出ない）", async () => {
  setup();
  const s = JSON.stringify((await call("hub")).body) + JSON.stringify((await call("security")).body);
  for (const w of ["wage", "salary", "unit_price", "commute", "5000000", "4000000", "777777", "基本給", "手当"]) assert.equal(s.includes(w), false, w);
});

console.log("\n=== 読めない元データを 0 にしない ===\n");

await ok("表が無い（未適用）: その判定は出ず、unreadable に出る。ほかのブロックは出る", async () => {
  setup();
  db.missing = new Set(["gw_hr_applicants", "gw_site_contracts", "gw_blockers"]);
  const d = (await call("hub")).body;
  assert.deepEqual(d.unreadable.sort(), ["採用", "止まっている仕事", "現場契約"]);
  assert.equal(tile(d, "recruiting").value, null);
  assert.equal(tile(d, "offers").value, null);
  assert.equal(by(d, "ceo_decision"), undefined);
  assert.equal(by(d, "renewal_soon"), undefined);
  assert.equal(by(d, "expense_approval").count, 1, "読めたものは出る");
  assert.equal(tile(d, "headcount").value, 4);
});

await ok("読み込みの失敗（表はあるが読めない）も、同じ。0 とは出さない", async () => {
  setup();
  db.readFail = new Set(["gw_expense_reports", "journals", "gw_employees"]);
  const d = (await call("hub")).body;
  assert.ok(["経費", "会計（仕訳）", "社員名簿"].every((l) => d.unreadable.includes(l)), d.unreadable.join());
  assert.equal(tile(d, "expense_pending").value, null);
  assert.equal(tile(d, "payable").value, null);
  assert.equal(tile(d, "journals").value, null);
  assert.equal(tile(d, "headcount").value, null);
  for (const t of [...d.people.tiles, ...d.money.internal].filter((x) => x.value === null)) assert.notEqual(t.value, 0);
  assert.equal(by(d, "blocker_owner"), undefined, "名簿が読めないので、Blocker を会社ごとに絞れない → 出さない");
  assert.ok(d.unreadable.includes("止まっている仕事"));
});

await ok("二段階認証の取得に失敗しても、ホームは何も警告せず、unreadable にも出さない（二段階認証は任意）", async () => {
  setup();
  db.factorsFail = true;
  const d = (await call("hub")).body;
  assert.ok(!d.unreadable.includes("二段階認証の登録状況"));
  assert.equal(by(d, "mfa_missing"), undefined);
});

await ok("入社準備が読めなくても、ホームは落ちない（入社準備だけ unreadable）", async () => {
  setup();
  db.readFail = new Set(["gw_procedures"]);
  const r = await call("hub");
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.unreadable.includes("入社準備"));
  assert.equal(tile(r.body, "joining").value, null);
});

await ok("1000件を超えても切り捨てない（応募者 2500 件・承認待ち経費 1500 件）", async () => {
  setup();
  for (let i = 0; i < 2500; i++) db.rows.gw_hr_applicants.push({ id: `bulk${i}`, tenant_id: "t1", stage: "applied", status: "todo", decision_due_on: null });
  for (let i = 0; i < 1500; i++) db.rows.gw_expense_reports.push({ id: `xb${i}`, tenant_id: "t1", status: "pending", payment_method: "personal", total_amount: 1 });
  const d = (await call("hub")).body;
  assert.equal(tile(d, "recruiting").value, 2502);
  assert.equal(tile(d, "expense_pending").value, 1502);
});

console.log("\n=== 入社準備との接続（既存の判定を使う）===\n");

await ok("入社準備: 会社の対応待ちは①、入社日が近く準備未完了の人は④。入社予定・未完了は②", async () => {
  setup();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  db.rows.gw_procedures = [
    { id: "p6", tenant_id: "t1", employee_id: "e6", kind: "onboarding", status: "in_progress", target_on: dayOff(3), stage: null, stage_at: null, updated_at: daysAgo(1), created_at: daysAgo(5) },
    { id: "p3", tenant_id: "t1", employee_id: "e3", kind: "onboarding", status: "in_progress", target_on: dayOff(20), stage: null, stage_at: null, updated_at: daysAgo(1), created_at: daysAgo(5) },
  ];
  db.rows.gw_procedure_items = [
    { id: "i1", procedure_id: "p3", item_key: "pc", owner: "hr", required: true, status: "todo" },
    { id: "i2", procedure_id: "p3", item_key: "doc_id", owner: "employee", required: true, status: "todo" },
  ];
  db.rows.gw_sign_requests = [{ employee_id: "e3", doc_kind: "employment", status: "signed", sent_at: daysAgo(4) }];
  db.rows.gw_doc_orders = [{ employee_id: "e3", doc_kind: "employment", status: "signed", updated_at: daysAgo(3), wage_amount: 777777 }];
  db.rows.gw_consent_docs = []; db.rows.gw_onboard_consents = []; db.rows.gw_onboard_profiles = []; db.rows.gw_orientation_items = []; db.rows.gw_orientation_checks = [];
  db.rows.gw_employee_careers = [];
  const r = await call("hub");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(tile(d, "onboarding_open").value, 2);
  assert.equal(tile(d, "joining").value, 2);
  const near = by(d, "join_near");
  assert.ok(near, "入社日が3日後で準備未完了の人");
  assert.match(near.detail, /入社 六郎/);
  assert.equal(near.severity, "high");
  assert.ok(!JSON.stringify(d).includes("777777"), "給与入りの書面の金額は出ない");
});

await ok("労働条件通知書: 未公開・本人未確認の人数だけが①に出る。電子署名の流れの人は数えない。ファイルの場所・名前・給与は読まない", async () => {
  setup();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const proc = (id, emp) => ({ id, tenant_id: "t1", employee_id: emp, kind: "onboarding", status: "in_progress", target_on: dayOff(30), stage: null, stage_at: null, updated_at: daysAgo(1), created_at: daysAgo(5) });
  db.rows.gw_employees.push(
    { id: "e7", tenant_id: "t1", user_id: "u7", display_name: "下書き 七郎", status: "invited", employee_kind: "proper" },
    { id: "e8", tenant_id: "t1", user_id: "u8", display_name: "未確認 八郎", status: "invited", employee_kind: "proper" },
    { id: "e9", tenant_id: "t1", user_id: "u9", display_name: "確認済 九郎", status: "invited", employee_kind: "proper" });
  // e6=通知書なし（未公開に数える）/ e3=電子署名済み（数えない）/ e7=下書きだけ（未公開）/ e8=公開済み・未確認 / e9=確認済み
  db.rows.gw_procedures = [proc("p6", "e6"), proc("p3", "e3"), proc("p7", "e7"), proc("p8", "e8"), proc("p9", "e9")];
  db.rows.gw_procedure_items = [];
  db.rows.gw_sign_requests = [{ employee_id: "e3", doc_kind: "employment", status: "signed", sent_at: daysAgo(4) }];
  db.rows.gw_doc_orders = [{ employee_id: "e3", doc_kind: "employment", status: "signed", updated_at: daysAgo(3) }];
  db.rows.gw_labor_notices = [
    { id: "n7", tenant_id: "t1", employee_id: "e7", version: 1, published_at: null, confirmed_at: null, filename: "秘密_七郎.pdf", storage_path: "t1/labor-notice/e7/a.pdf", sha256: "x" },
    { id: "n8", tenant_id: "t1", employee_id: "e8", version: 1, published_at: daysAgo(1), confirmed_at: null, filename: "秘密_八郎.pdf", storage_path: "t1/labor-notice/e8/a.pdf", sha256: "x" },
    { id: "n9", tenant_id: "t1", employee_id: "e9", version: 1, published_at: daysAgo(2), confirmed_at: daysAgo(1), filename: "秘密_九郎.pdf", storage_path: "t1/labor-notice/e9/a.pdf", sha256: "x" },
    { id: "nx", tenant_id: "t2", employee_id: "ex", version: 1, published_at: null, confirmed_at: null },
  ];
  db.rows.gw_consent_docs = []; db.rows.gw_onboard_consents = []; db.rows.gw_onboard_profiles = []; db.rows.gw_orientation_items = []; db.rows.gw_orientation_checks = [];
  db.rows.gw_employee_careers = [];
  const r = await call("hub");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body;
  const un = by(d, "notice_unpublished");
  const cf = by(d, "notice_unconfirmed");
  assert.equal(un.count, 2, "e6（通知書なし）と e7（下書きだけ）。e3 は電子署名の流れ");
  assert.equal(cf.count, 1, "e8 だけ");
  assert.equal(un.href, "/admin-hr.html");
  assert.equal(cf.href, "/admin-hr.html");
  assert.deepEqual([...db.selects.gw_labor_notices], ["employee_id, version, published_at, confirmed_at"], "読むのは、版・公開・確認の列だけ");
  const s = JSON.stringify(d);
  assert.ok(!/秘密_|storage_path|labor-notice\/|a\.pdf/.test(s), "ファイル名・置き場所は、ハブに出ない");
  assert.equal(db.writes.length, 0, "書き込み0回");
});

await ok("労働条件通知書の表が無い（未適用）: 0件とは出さず、未読込に「労働条件通知書」。入社準備ほかの項目は出る", async () => {
  setup();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  db.rows.gw_procedures = [{ id: "p6", tenant_id: "t1", employee_id: "e6", kind: "onboarding", status: "in_progress", target_on: dayOff(3), stage: null, stage_at: null, updated_at: daysAgo(1), created_at: daysAgo(5) }];
  db.rows.gw_procedure_items = []; db.rows.gw_sign_requests = []; db.rows.gw_doc_orders = [];
  db.rows.gw_consent_docs = []; db.rows.gw_onboard_consents = []; db.rows.gw_onboard_profiles = []; db.rows.gw_orientation_items = []; db.rows.gw_orientation_checks = [];
  db.rows.gw_employee_careers = [];
  db.missing.add("gw_labor_notices");
  const d = (await call("hub")).body;
  assert.ok(d.unreadable.includes("労働条件通知書"), d.unreadable.join());
  assert.equal(by(d, "notice_unpublished"), undefined);
  assert.equal(tile(d, "onboarding_open").value, 1, "入社準備の数は出る");
});

console.log("\n=== 旧 view は、後方互換のためまだ動く（画面は呼ばない）===\n");

await ok("dashboard / expenses / revenue / cash / accounting / payroll / onboarding は、これまでどおり 200", async () => {
  setup();
  db.payLinked = false;
  for (const v of ["dashboard", "expenses", "revenue", "cash", "accounting", "payroll", "onboarding"]) {
    const r = await call(v);
    assert.equal(r.statusCode, 200, `${v}: ${JSON.stringify(r.body).slice(0, 150)}`);
  }
});

await ok("知らない view は 400。views の一覧に hub・security が入っている", async () => {
  setup();
  const r = await call("nope");
  assert.equal(r.statusCode, 400);
  assert.ok(r.body.views.includes("hub") && r.body.views.includes("security"));
  assert.ok(["dashboard", "expenses", "revenue", "cash", "accounting"].every((v) => r.body.views.includes(v)), "旧 view は消していない");
});

console.log("\n=== 経営設定・セキュリティ ===\n");

await ok("経営者の一覧（在籍中のみ・他社を含まない）と、二段階認証の登録状況（参考。警告にしない）", async () => {
  setup();
  const d = (await call("security")).body;
  assert.equal(d.status, "exact");
  assert.deepEqual(d.owners.map((o) => [o.name, o.mfa]), [["経営 一郎", "enrolled"], ["経営 二郎", "none"]]);
  assert.equal(d.loginableCount, 2);
  assert.deepEqual(d.warnings, [], "経営 二郎 が二段階認証を未登録でも、警告にしない（任意）");
  assert.ok(!("mfaPolicy" in d) && !("mfaUnknown" in d), "強制日・不明の警告は返さない");
  assert.equal(d.links.payAudit, "#pay-audit");
});

await ok("経営者の変更履歴: owner の付与・剥奪・認証リセットの拒否だけ。他社・ほかの操作は含まない。新しい順・名前つき", async () => {
  setup();
  const d = (await call("security")).body;
  assert.deepEqual(d.history.map((h) => [h.label, h.actor, h.target]), [
    ["経営者に追加", "経営 一郎", "経営 二郎"],
    ["経営者の二段階認証リセットを断った", "社員 三郎", "経営 一郎"],
  ]);
  assert.equal(d.historyReadable, true);
});

await ok("履歴は新しい20件まで", async () => {
  setup();
  for (let i = 0; i < 30; i++) db.rows.gw_activity_log.push({ id: 100 + i, ts: tsOff(-10 - i), tenant_id: "t1", actor_id: "u1", action: "owner.grant", target: "employee:e2", detail: {} });
  assert.equal((await call("security")).body.history.length, 20);
});

await ok("経営者が1人だけなら、警告。ログインできない経営者は人数に数えない", async () => {
  setup();
  db.rows.gw_role_grants = db.rows.gw_role_grants.filter((g) => g.employee_id !== "e2");
  const d = (await call("security")).body;
  assert.ok(d.warnings.some((w) => w.key === "owner_single"));
  assert.equal(by((await call("hub")).body, "owner_single").href, "#security");
});

await ok("履歴の表が読めなくても、経営者の一覧は出る（historyReadable:false・履歴は空）。認証の取得失敗は「不明」で、警告にしない", async () => {
  setup();
  db.missing = new Set(["gw_activity_log"]);
  db.factorsFail = true;
  const d = (await call("security")).body;
  assert.equal(d.historyReadable, false);
  assert.deepEqual(d.history, []);
  assert.deepEqual(d.owners.map((o) => o.mfa), ["unknown", "unknown"]);
  assert.deepEqual(d.warnings, [], "不明を「未登録」と警告しない");
});

await ok("経営者の一覧を読めなければ、status:missing（0人とは出さない）", async () => {
  setup();
  db.readFail = new Set(["gw_role_grants"]);
  const d = (await call("security")).body;
  assert.equal(d.status, "missing");
  assert.equal(d.owners, undefined);
});

console.log("\n=== 2026-10 Phase 1：営業（sales）===\n");

await ok("hub は sales（目標と実績・担当者別・停滞）を返す。この会社の行だけ数える。書き込まない", async () => {
  setup();
  const sentAt = new Date(Date.now() - 3600000).toISOString();
  db.rows.gw_sales_approaches = [
    { id: "a1", tenant_id: "t1", company_id: "c1", employee_id: "e3", sent_at: sentAt, failed_at: null },
    { id: "a2", tenant_id: "t1", company_id: "c2", employee_id: "e3", sent_at: sentAt, failed_at: sentAt },
    { id: "ax", tenant_id: "t2", company_id: "cx", employee_id: "ex", sent_at: sentAt, failed_at: null },
  ];
  db.rows.gw_sales_deals = [{ id: "d1", tenant_id: "t1", company_id: "c1", owner_id: "e3", title: "テスト案件", stage: "meeting", amount: null, won_on: null, created_at: sentAt, updated_at: sentAt }];
  const r = await call("hub");
  assert.equal(r.statusCode, 200);
  const contact = r.body.sales.funnel.find((x) => x.key === "contact");
  assert.equal(contact.value, 1, "送れなかったもの・他社の分は数えない");
  assert.equal(r.body.sales.funnel.find((x) => x.key === "meeting").value, 1);
  assert.equal(r.body.sales.funnel.find((x) => x.key === "effective").value, null);
  assert.equal(db.writes.length, 0);
});

await ok("案件の表が無い（db/116 未適用）：営業の商談・提案・契約は「取得できません」。ほかのブロックはそのまま", async () => {
  setup();
  db.missing = new Set(["gw_sales_deals", "gw_sales_deal_history"]);
  const r = await call("hub");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.sales.funnel.find((x) => x.key === "meeting").status, "missing");
  assert.ok(r.body.people.tiles.length > 0);
  assert.equal(r.body.unreadable.includes("案件"), false, "営業の読めなさは、ホーム全体の注意書きに混ぜない（営業の欄の中で出す）");
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
