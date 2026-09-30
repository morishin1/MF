// 給与管理（/api/keiei/pay）：経営者だけ・追記だけ・監査つき・既存の表に書かない。
//
// ■ 何を守るテストか
//
//   1. 経営者（owner）だけが使える。人事・管理者・責任者・採用担当・経理・IT・営業・社労士・一般は 403（金額は一切返らない）。
//      二段階認証が済んでいなければ、経営者でも 403。権限のない人には、認証の案内より先に断る
//   2. 表（db/105）が無いときは、落とさず「未連携」。0 円とは言わない。書き込みは 503
//   3. 一覧: いまの給与（適用開始日が今日以前でいちばん新しい）・予定・適用前・未登録・契約との不一致・BP 対象外。
//      他社は出ない。1000 件を超えても切り捨てない
//   4. 個人: 履歴（適用開始日ごと・訂正の版ごと）・変更前/変更後・契約/内定/届出の参照・その人の監査ログ
//   5. 記録: 初回 → 変更 → 訂正の順に、版と種別が規則どおり。前の行は1件も変わらない。理由は必須。
//      同じ適用開始日への二重記録・画面が古い・同時記録は 409
//   6. 監査: 一覧・個人・監査ログを開くたびに残る。残せなければ、給与を返さない
//   7. 既存の表へは書かない（契約・内定・入社情報・gw_activity_log）。この API のコードに、更新・削除の入口が無い
//   8. unit_price は、扱わない（応答にも、コードにも無い）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 表の代わり（メモリ）。DB のトリガ（追記だけ・監査の自動記録・一意）を、必要な分だけ真似る ----
const db = { rows: {}, missing: new Set(), writes: [], forbidden: [], failInsert: {}, seq: 0 };
const MAX_ROWS = 1000;        // Supabase の応答の行数の上限（max-rows）
const logged = [];

function table(name) {
  const f = [];
  let span = null, lim = null, wantCount = false, single = null, mode = "select", payload = null, afterInsert = false;
  const ord = [];
  const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  const miss = () => (db.missing.has(name) ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const match = (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    if (op === "neq") return r[k] !== v;
    if (op === "lt") return r[k] != null && r[k] < v;
    if (op === "gte") return r[k] != null && r[k] >= v;
    if (op === "is") return (r[k] ?? null) === v;
    return true;
  });
  const sorted = (rows) => {
    if (!ord.length) return rows;
    return [...rows].sort((a, b) => {
      for (const [k, asc] of ord) {
        if (a[k] === b[k]) continue;
        const r = a[k] < b[k] ? -1 : 1;
        return asc ? r : -r;
      }
      return 0;
    });
  };
  const doInsert = () => {
    const e = miss();
    if (e) return { data: null, error: e };
    if (db.failInsert[name]) return { data: null, error: db.failInsert[name] };
    const list = Array.isArray(payload) ? payload : [payload];
    const out = [];
    for (const r of list) {
      const row = { ...copy(r) };
      if (name === "gw_compensations") {
        const dup = (db.rows[name] || []).find((x) => x.employee_id === row.employee_id && x.effective_from === row.effective_from && x.revision === row.revision);
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        row.id = row.id || `c${++db.seq}`;
        row.created_at = new Date().toISOString();
      } else if (name === "gw_pay_audit") {
        row.id = ++db.seq;
        row.ts = new Date().toISOString();
      } else row.id = row.id || `x${++db.seq}`;
      (db.rows[name] ||= []).push(row);
      db.writes.push({ table: name, op: "insert", row: copy(row) });
      // 記録の追加 → 監査ログ（db/105 の gw_comp_audit_trg と同じ）
      if (name === "gw_compensations") {
        (db.rows.gw_pay_audit ||= []).push({ id: ++db.seq, ts: row.created_at, tenant_id: row.tenant_id, actor_id: row.created_by,
          actor_name: row.created_by_name || (row.created_by ? null : "db"), action: row.kind === "correction" ? "correct" : "create",
          employee_id: row.employee_id, record_id: row.id,
          detail: { kind: row.kind, source: row.source, effective_from: row.effective_from, revision: row.revision, reason: row.reason, candidate: row.basis != null } });
      }
      out.push(row);
    }
    return { data: single ? { id: out[0].id } : out.map((r) => ({ id: r.id })), error: null };
  };
  const run = () => {
    if (mode === "insert") return doInsert();
    const e = miss();
    if (e) return { data: null, count: null, error: e };
    const all = sorted((db.rows[name] || []).filter(match));
    if (wantCount) return { data: null, count: all.length, error: null };
    let rows = span ? all.slice(span[0], Math.min(span[1] + 1, span[0] + MAX_ROWS)) : all.slice(0, Math.min(lim ?? MAX_ROWS, MAX_ROWS));
    if (span && lim != null) rows = rows.slice(0, lim);
    rows = rows.map(copy);
    if (single === "maybe") return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  };
  const q = {
    select(_c, opts) { wantCount = Boolean(opts?.count); if (mode === "insert") afterInsert = true; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    lt(k, v) { f.push(["lt", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(k, o) { ord.push([k, o?.ascending !== false]); return q; },
    limit(n) { lim = n; return q; },
    range(a, b) { span = [a, b]; return q; },
    maybeSingle() { single = "maybe"; return q; },
    single() { single = "one"; return q; },
    insert(v) { mode = "insert"; payload = v; return q; },
    // この API は、更新・削除をしない。呼ばれたら記録して、テストで落とす
    update() { db.forbidden.push(`${name}.update`); return q; },
    delete() { db.forbidden.push(`${name}.delete`); return q; },
    upsert() { db.forbidden.push(`${name}.upsert`); return q; },
    then: (fn, rej) => Promise.resolve(run()).then(fn, rej),
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-owner", email: "owner@example.com", factors: userFactors }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
let userFactors = [];
let who;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: pay } = await import(atRoot("api/keiei/pay.js"));
const C = await import(atRoot("lib/compensation.js"));

const jwt = (aal) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const get = async (q = "view=list", { aal = "aal2" } = {}) => {
  const r = res();
  await pay({ method: "GET", url: `/api/keiei/pay?${q}`, headers: { authorization: `Bearer ${jwt(aal)}` } }, r);
  return r;
};
const post = async (body, { aal = "aal2", method = "POST" } = {}) => {
  const r = res();
  await pay({ method, url: "/api/keiei/pay", headers: { authorization: `Bearer ${jwt(aal)}` }, body }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const ctxOf = (roles, extra = {}) => ({
  tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: roles.includes("labor_advisor"),
  roles, employee: { id: "emp-x", display_name: "経営 花子" }, ...extra,
});
const OWNER = ctxOf(["owner"]);

const TODAY = C.todayJst();
const day = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const PAST1 = "2025-04-01", PAST2 = "2026-04-01";

const rec = (id, employee, effective_from, extra = {}) => ({
  id, tenant_id: "t1", employee_id: employee, effective_from, revision: 1, kind: "initial", source: "owner",
  wage_type: "月給", base_amount: 300000, allowances: [], commute_amount: null, commute_note: null,
  contract_id: null, contract_wage_type: null, contract_wage_amount: null, reason: "入社時", before: null,
  created_by_name: "経営 花子", created_at: "2026-01-01T00:00:00Z", ...extra,
});

function setup() {
  who = OWNER; userFactors = [{ status: "verified", factor_type: "totp" }];
  logged.length = 0; db.missing = new Set(); db.writes = []; db.forbidden = []; db.failInsert = {}; db.seq = 1000;
  delete process.env.HR_PAY_SPLIT;
  const emp = (id, name, status = "active", extra = {}) => ({ id, tenant_id: "t1", display_name: name, status, employee_kind: "proper", department: "開発", position: null, employment_type: "正社員", joined_on: "2025-04-01", email: `${id}@x.jp`, ...extra });
  db.rows = {
    gw_employees: [
      emp("e1", "月給 太郎"), emp("e2", "年俸 花子"), emp("e3", "時給 次郎"), emp("e4", "契約なし"),
      emp("e5", "BP 三郎", "active", { employee_kind: "bp" }), emp("e6", "退職済み", "left"), emp("e7", "入社準備", "invited"),
      emp("e8", "契約と違う"), emp("e9", "適用前"),
      { ...emp("ex", "他社の人"), tenant_id: "t2" },
    ],
    gw_compensations: [
      // e1: 2025-04 に入社時、2026-04 に昇給（役職手当・通勤手当つき）
      rec("r1", "e1", PAST1, { base_amount: 280000 }),
      rec("r2", "e1", PAST2, { kind: "change", base_amount: 300000, allowances: [{ name: "役職手当", amount: 20000 }], commute_amount: 10000,
        reason: "昇給・役職手当の新設", before: { effectiveFrom: PAST1, revision: 1, wageType: "月給", baseAmount: 280000, allowances: [], commuteAmount: null } }),
      // e2: 年俸。来月から改定予定
      rec("r3", "e2", PAST1, { wage_type: "年俸", base_amount: 6000000 }),
      rec("r4", "e2", day(30), { kind: "change", wage_type: "年俸", base_amount: 6600000, reason: "改定", before: { effectiveFrom: PAST1, revision: 1, wageType: "年俸", baseAmount: 6000000, allowances: [], commuteAmount: null } }),
      rec("r5", "e3", PAST1, { wage_type: "時給", base_amount: 2000 }),
      rec("r6", "e6", PAST1, { base_amount: 200000 }),
      rec("r7", "e8", PAST1, { base_amount: 250000 }),
      rec("r8", "e9", day(10), { base_amount: 270000 }),
      { ...rec("rx", "ex", PAST1, { base_amount: 777777 }), tenant_id: "t2" },
    ],
    gw_contracts: [
      { id: "k1", employee_id: "e1", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 300000, wage_note: "役職手当 20000円", created_at: "2026-04-01", contract_type: "正社員", period_from: "2025-04-01", period_to: null },
      { id: "k2", employee_id: "e2", tenant_id: "t1", status: "active", wage_type: "年俸", wage_amount: 6000000, created_at: "2025-04-01" },
      { id: "k3", employee_id: "e3", tenant_id: "t1", status: "active", wage_type: "時給", wage_amount: 2000, created_at: "2025-04-01" },
      { id: "k7", employee_id: "e7", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 250000, created_at: "2026-09-01" },
      { id: "k8", employee_id: "e8", tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 260000, created_at: "2026-01-01" },
      { id: "k9", employee_id: "e9", tenant_id: "t1", status: "draft", wage_type: "月給", wage_amount: 999999, created_at: "2026-01-01" },
    ],
    gw_hr_applicants: [{ id: "a1", tenant_id: "t1", employee_id: "e1", wage_type: "月給", wage_amount: 270000 }],
    gw_hr_offers: [
      { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, wage_type: "月給", wage_amount: 275000 },
      { id: "o2", tenant_id: "t1", applicant_id: "a1", version: 2, wage_type: "月給", wage_amount: 280000 },
    ],
    gw_hr_pay: [],
    gw_onboard_profiles: [{ id: "p1", tenant_id: "t1", employee_id: "e1", commute_cost: 12000 }, { id: "p7", tenant_id: "t1", employee_id: "e7", commute_cost: 9000 }],
    gw_pay_audit: [],
  };
}
const snapshot = () => JSON.stringify(db.rows);

console.log("\n=== 経営者だけ ===\n");

await ok("経営者は開ける（一覧・個人・監査ログ）", async () => {
  setup();
  assert.equal((await get("view=list")).statusCode, 200);
  assert.equal((await get("view=detail&employeeId=e1")).statusCode, 200);
  assert.equal((await get("view=audit")).statusCode, 200);
});

await ok("経営者以外は、すべて 403。金額は一切返らない（読む・書く、どちらも）", async () => {
  const others = [
    ["会計の管理者だけ", ctxOf([], { isAdmin: true })], ["管理者＋人事", ctxOf(["hr"], { isAdmin: true })], ["人事", ctxOf(["hr"])],
    ["責任者", ctxOf(["manager"])], ["採用担当", ctxOf(["recruiter"])], ["経理", ctxOf(["finance"])], ["IT・管理", ctxOf(["it"])],
    ["営業担当", ctxOf(["sales"])], ["社労士", ctxOf(["labor_advisor"])], ["一般メンバー", ctxOf([])],
    ["責任者＋経理＋人事＋採用担当＋営業＋管理者", ctxOf(["manager", "finance", "hr", "recruiter", "sales"], { isAdmin: true })],
  ];
  for (const [label, c] of others) {
    for (const q of ["view=list", "view=detail&employeeId=e1", "view=audit", "view=candidates"]) {
      setup(); who = c;
      const r = await get(q);
      assert.equal(r.statusCode, 403, `${label} / ${q}`);
      assert.equal(r.body.error, "forbidden", `${label}: 認証の案内ではなく、権限で断る`);
      assert.ok(!/300000|280000|6000000/.test(JSON.stringify(r.body)), "金額が漏れていない");
      assert.equal(db.rows.gw_pay_audit.length, 0, "断られた人の閲覧は、監査ログに残らない（給与を見ていない）");
    }
    setup(); who = c;
    const w = await post({ action: "record", employeeId: "e4", effectiveFrom: day(0), wageType: "月給", baseAmount: 1, reason: "x" });
    assert.equal(w.statusCode, 403, `${label}: 書き込みも断る`);
    assert.equal(db.writes.length, 0, `${label}: 何も書かれていない`);
  }
});

await ok("所属（テナント）が無い人は 403。GET・POST 以外は 405。知らない view・action は 400", async () => {
  setup(); who = ctxOf(["owner"], { tenantId: null });
  assert.equal((await get()).statusCode, 403);
  setup();
  assert.equal((await post({}, { method: "PUT" })).statusCode, 405);
  assert.equal((await post({}, { method: "DELETE" })).statusCode, 405);
  const v = await get("view=nope"); assert.equal(v.statusCode, 400); assert.equal(v.body.error, "invalid_view");
  const a = await post({ action: "delete", employeeId: "e1" }); assert.equal(a.statusCode, 400); assert.equal(a.body.error, "invalid_action");
  assert.deepEqual(a.body.actions, ["preview_record", "record"], "更新・削除の入口は、そもそも無い");
  assert.equal((await get("view=detail")).statusCode, 400);
});

await ok("二段階認証（aal2）が済んでいない経営者は開けない。権限のない人には、認証を促さない", async () => {
  setup();
  const r = await get("view=list", { aal: "aal1" });
  assert.equal(r.statusCode, 403); assert.equal(r.body.error, "mfa_required");
  assert.ok(!/300000/.test(JSON.stringify(r.body)));
  const w = await post({ action: "record", employeeId: "e4" }, { aal: "aal1" });
  assert.equal(w.statusCode, 403); assert.equal(db.writes.length, 0);
  setup(); who = ctxOf(["hr"]);
  const h = await get("view=list", { aal: "aal1" });
  assert.equal(h.body.error, "forbidden", "人事には、二段階認証の案内より先に、権限で断る");
});

console.log("\n=== 表が無いとき ===\n");

await ok("db/105 が未適用なら、落とさず「未連携」。書き込みは 503。0 円とは言わない", async () => {
  setup(); db.missing = new Set(["gw_compensations"]);
  const r = await get("view=list");
  assert.equal(r.statusCode, 200); assert.equal(r.body.linked, false);
  assert.match(r.body.hint, /db\/105_compensation\.sql/);
  assert.equal(r.body.rows, undefined);
  const d = await get("view=detail&employeeId=e1"); assert.equal(d.body.linked, false);
  const w = await post({ action: "record", employeeId: "e1", effectiveFrom: day(0), wageType: "月給", baseAmount: 1, reason: "x" });
  assert.equal(w.statusCode, 503); assert.match(w.body.message, /db\/105/);
  // 監査ログの表だけ無い場合も、給与は返さない
  setup(); db.missing = new Set(["gw_pay_audit"]);
  const r2 = await get("view=list"); assert.equal(r2.body.linked, false); assert.equal(r2.body.rows, undefined);
});

console.log("\n=== 一覧 ===\n");

await ok("いまの給与・予定・適用前・未登録・契約との不一致が、正しく分かれる。BP・他社は出ない", async () => {
  setup();
  const r = await get("view=list");
  assert.equal(r.statusCode, 200);
  const by = Object.fromEntries(r.body.rows.map((x) => [x.id, x]));
  assert.ok(!by.e5, "BP は対象外"); assert.ok(!by.ex, "他社は出ない");
  assert.equal(r.body.summary.bpExcluded, 1);
  // e1: 2026-04-01 の版が「いま」。月額 = 基本給 + 手当 + 通勤手当
  assert.equal(by.e1.current.baseAmount, 300000);
  assert.equal(by.e1.current.effectiveFrom, PAST2);
  assert.equal(by.e1.current.monthly.total, 330000);
  assert.equal(by.e1.recordCount, 2);
  assert.deepEqual(by.e1.flags, []);
  assert.equal(by.e1.contract.state, "match");
  // e2: いまは 600万。来月から 660万の予定
  assert.equal(by.e2.current.baseAmount, 6000000);
  assert.equal(by.e2.next.baseAmount, 6600000); assert.equal(by.e2.next.effectiveFrom, day(30));
  assert.ok(by.e2.flags.includes("upcoming"));
  assert.equal(by.e2.current.monthly.base, 500000);
  // e3: 時給。月額の合計は出さない（実稼働が未確定）
  assert.equal(by.e3.current.wageType, "時給"); assert.equal(by.e3.current.monthly.total, null);
  // e4: 何も無い → 未登録。契約も無い
  assert.deepEqual(by.e4.flags, ["unregistered"]); assert.equal(by.e4.current, null); assert.equal(by.e4.contract, null);
  // e7: 入社準備中。契約はあるが記録は無い
  assert.ok(by.e7.flags.includes("unregistered")); assert.equal(by.e7.contract.state, "unregistered");
  // e8: 契約の賃金と違う
  assert.ok(by.e8.flags.includes("mismatch")); assert.equal(by.e8.contract.state, "amount");
  // e9: 適用前（記録はあるが、まだ始まっていない）。下書き（draft）の契約は見ない
  assert.deepEqual(by.e9.flags, ["future_only"]); assert.equal(by.e9.current, null); assert.equal(by.e9.contract, null);
  // 退職者も一覧には出る（履歴を見るため）が、集計には入れない
  assert.equal(by.e6.status, "left");
  assert.equal(by.e6.current.baseAmount, 200000);
});

await ok("集計: 在籍の人だけ。月額の合計は、月額に直せる人だけ（時給は数えない）", async () => {
  setup();
  const s = (await get("view=list")).body.summary;
  assert.equal(s.inService, 6);                       // e1 e2 e3 e4 e8 e9（BP・退職・入社準備は入れない）
  assert.equal(s.registered, 4);                      // e1 e2 e3 e8
  assert.equal(s.unregistered, 2);                    // e4（未登録）・e9（適用前）
  assert.equal(s.upcoming, 1);
  assert.equal(s.mismatch, 1);
  assert.equal(s.monthlyCounted, 3);                  // e1 330000 + e2 500000 + e8 250000
  assert.equal(s.monthlyTotal, 330000 + 500000 + 250000);
  assert.equal(s.hourlyLike, 1);
  assert.equal(s.contractsLinked, true);
});

await ok("1000 件を超えても切り捨てない（社員・記録とも）", async () => {
  setup();
  for (let i = 0; i < 1100; i++) {
    db.rows.gw_employees.push({ id: `b${i}`, tenant_id: "t1", display_name: `大量 ${String(i).padStart(4, "0")}`, status: "active", employee_kind: "proper" });
    db.rows.gw_compensations.push(rec(`br${i}`, `b${i}`, PAST1, { base_amount: 200000 }));
  }
  const r = await get("view=list");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 8 + 1100 + 0, "BP 以外の全員（他社は除く）");
  assert.equal(r.body.summary.inService, 6 + 1100);
  assert.equal(r.body.summary.registered, 4 + 1100, "1000 件目以降の記録も読んでいる");
  assert.equal(r.body.summary.monthlyTotal, 330000 + 500000 + 250000 + 1100 * 200000);
});

await ok("契約が読めなくても一覧は出す（不一致だけ判定しない）", async () => {
  setup(); db.missing = new Set(["gw_contracts"]);
  const r = await get("view=list");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.summary.contractsLinked, false);
  assert.equal(r.body.summary.mismatch, 0, "読めないものを、不一致とも一致とも言わない");
  const e8 = r.body.rows.find((x) => x.id === "e8");
  assert.equal(e8.contract, null);
});

await ok("社員や履歴を読み切れないときは、一部だけを出さない（500）", async () => {
  setup(); db.missing = new Set(["gw_employees"]);
  const r = await get("view=list");
  assert.equal(r.statusCode, 500); assert.equal(r.body.error, "db_read_failed");
  assert.ok(!/300000/.test(JSON.stringify(r.body)));
});

console.log("\n=== 個人 ===\n");

await ok("履歴: 適用開始日ごと・新しい順。変更前/変更後・変更者・日時・理由・訂正の版まで残る", async () => {
  setup();
  // e1 に訂正を足しておく（2026-04-01 の版2）
  db.rows.gw_compensations.push(rec("r2b", "e1", PAST2, { revision: 2, kind: "correction", base_amount: 310000, allowances: [{ name: "役職手当", amount: 20000 }], commute_amount: 10000,
    reason: "基本給の入力ミスを訂正", created_by_name: "経営 花子", created_at: "2026-05-01T00:00:00Z",
    before: { effectiveFrom: PAST2, revision: 1, wageType: "月給", baseAmount: 300000, allowances: [{ name: "役職手当", amount: 20000 }], commuteAmount: 10000 } }));
  const r = await get("view=detail&employeeId=e1");
  assert.equal(r.statusCode, 200);
  const b = r.body;
  assert.equal(b.linked, true);
  assert.equal(b.employee.name, "月給 太郎");
  assert.equal(b.current.baseAmount, 310000, "いまの給与 = 同じ適用開始日の最新の版");
  assert.equal(b.current.revision, 2);
  assert.deepEqual(b.groups.map((g) => g.effectiveFrom), [PAST2, PAST1], "新しい適用開始日が先");
  assert.deepEqual(b.groups[0].revisions.map((x) => x.revision), [2, 1], "訂正の版も残り、新しい版が先");
  assert.equal(b.recordCount, 3);
  const corr = b.groups[0].revisions[0];
  assert.equal(corr.kind, "correction"); assert.equal(corr.reason, "基本給の入力ミスを訂正"); assert.equal(corr.createdBy, "経営 花子");
  assert.ok(corr.createdAt);
  assert.deepEqual(corr.changes.map((c) => [c.key, c.from, c.to]), [["baseAmount", 300000, 310000]], "変更前 → 変更後");
  const change = b.groups[0].revisions[1];
  assert.ok(change.changes.some((c) => c.key === "baseAmount" && c.from === 280000 && c.to === 300000));
  assert.ok(change.changes.some((c) => c.key === "allowance:役職手当" && c.change === "added"));
  const first = b.groups[1].revisions[0];
  assert.equal(first.kind, "initial"); assert.equal(first.before, null);
  assert.ok(first.changes.every((c) => c.change === "added"), "初回は、すべて「追加」");
});

await ok("参照: 契約・内定・届出の定期代。書き換える入口は無く、給与の額の「正」は current", async () => {
  setup();
  const b = (await get("view=detail&employeeId=e1")).body;
  assert.equal(b.references.contract.check, "match");
  assert.equal(b.references.contract.view.wageAmount, 300000);
  assert.equal(b.references.contract.view.wageNote, "役職手当 20000円");
  assert.deepEqual([b.references.offer.wageType, b.references.offer.wageAmount], ["月給", 280000], "いちばん新しい版の内定");
  assert.equal(b.references.commuteDeclared, 12000);
  // 参照が無い人
  const d = (await get("view=detail&employeeId=e4")).body;
  assert.equal(d.current, null); assert.equal(d.references.offer, null); assert.equal(d.references.commuteDeclared, null);
  assert.equal(d.references.contract.view, null);
});

await ok("内定の参照は、HR_PAY_SPLIT=1 なら gw_hr_pay から読む（元の列は見ない）", async () => {
  setup(); process.env.HR_PAY_SPLIT = "1";
  db.rows.gw_hr_applicants[0].wage_amount = 1; db.rows.gw_hr_offers.forEach((o) => { o.wage_amount = 2; });
  db.rows.gw_hr_pay = [
    { id: "hp1", tenant_id: "t1", applicant_id: "a1", offer_id: null, wage_type: "月給", wage_amount: 271000 },
    { id: "hp2", tenant_id: "t1", applicant_id: "a1", offer_id: "o2", wage_type: "月給", wage_amount: 283000 },
  ];
  assert.equal((await get("view=detail&employeeId=e1")).body.references.offer.wageAmount, 283000);
  db.rows.gw_hr_pay = [{ id: "hp1", tenant_id: "t1", applicant_id: "a1", offer_id: null, wage_type: "月給", wage_amount: 271000 }];
  const o = (await get("view=detail&employeeId=e1")).body.references.offer;
  assert.equal(o.wageAmount, 271000); assert.match(o.from, /応募者/);
  delete process.env.HR_PAY_SPLIT;
});

await ok("他社の人・存在しない人は 404。他社の記録は、決して混ざらない", async () => {
  setup();
  assert.equal((await get("view=detail&employeeId=ex")).statusCode, 404);
  assert.equal((await get("view=detail&employeeId=nope")).statusCode, 404);
  const w = await post({ action: "record", employeeId: "ex", effectiveFrom: day(0), wageType: "月給", baseAmount: 1, reason: "x" });
  assert.equal(w.statusCode, 404); assert.equal(db.writes.length, 0);
  assert.ok(!JSON.stringify((await get("view=list")).body).includes("777777"));
});

console.log("\n=== 記録（追記だけ） ===\n");

const FIELDS = { action: "record", employeeId: "e4", effectiveFrom: PAST2, wageType: "月給", baseAmount: 320000,
  allowances: [{ name: "住宅手当", amount: 15000 }], commuteAmount: 8000, reason: "入社時の条件を登録" };

await ok("初回 → 変更 → 訂正。版と種別が規則どおり、前の行は1件も変わらない", async () => {
  setup();
  const beforeRows = JSON.stringify(db.rows.gw_compensations);
  const r1 = await post(FIELDS);
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  assert.deepEqual([r1.body.result.kind, r1.body.result.revision], ["initial", 1]);
  assert.equal(r1.body.current.baseAmount, 320000);
  const row1 = db.rows.gw_compensations.find((x) => x.employee_id === "e4");
  assert.equal(row1.before, null); assert.equal(row1.created_by, "u-owner"); assert.equal(row1.created_by_name, "経営 花子");
  assert.equal(row1.reason, "入社時の条件を登録");
  assert.equal(row1.tenant_id, "t1");
  assert.deepEqual(row1.allowances, [{ name: "住宅手当", amount: 15000 }]);

  // 変更（新しい適用開始日）
  const r2 = await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 340000, reason: "昇給" });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.deepEqual([r2.body.result.kind, r2.body.result.revision], ["change", 1]);
  const row2 = db.rows.gw_compensations.filter((x) => x.employee_id === "e4")[1];
  assert.equal(row2.before.baseAmount, 320000, "変更前 = その日に有効だった値");
  assert.equal(r2.body.current.baseAmount, 340000);

  // 訂正（同じ適用開始日の次の版）
  const r3 = await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 350000, reason: "金額の入力ミス", correct: true });
  assert.equal(r3.statusCode, 200, JSON.stringify(r3.body));
  assert.deepEqual([r3.body.result.kind, r3.body.result.revision], ["correction", 2]);
  const row3 = db.rows.gw_compensations.filter((x) => x.employee_id === "e4")[2];
  assert.equal(row3.before.baseAmount, 340000, "訂正の変更前 = 訂正される版");
  assert.equal(r3.body.current.baseAmount, 350000);
  assert.deepEqual(r3.body.groups[0].revisions.map((x) => x.revision), [2, 1], "訂正しても、元の版は履歴に残る");

  // 他の人の行は、1件も変わっていない。e4 の既存の行も書き換わっていない
  const others = JSON.stringify(db.rows.gw_compensations.filter((x) => x.employee_id !== "e4"));
  assert.equal(others, JSON.stringify(JSON.parse(beforeRows)), "既存の行は、そのまま");
  assert.equal(JSON.stringify(db.rows.gw_compensations.filter((x) => x.employee_id === "e4")[0]), JSON.stringify(row1));
  assert.deepEqual(db.forbidden, [], "更新・削除・upsert は、一度も呼ばれない");
});

await ok("記録するたびに、監査ログが残る（誰が・いつ・何を・なぜ）", async () => {
  setup();
  await post(FIELDS);
  await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 340000, reason: "昇給" });
  await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 350000, reason: "金額の入力ミス", correct: true });
  const a = db.rows.gw_pay_audit.filter((x) => x.employee_id === "e4");
  assert.deepEqual(a.map((x) => x.action), ["create", "create", "correct"]);
  assert.ok(a.every((x) => x.actor_name === "経営 花子" && x.actor_id === "u-owner" && x.tenant_id === "t1"));
  assert.equal(a[2].detail.reason, "金額の入力ミス");
  assert.ok(!JSON.stringify(a).includes("350000"), "監査ログに金額は写さない（記録そのものにある）");
});

await ok("理由は必須。日付・金額・手当の不正は 400（何も書かれない）", async () => {
  setup();
  const bad = [
    [{ reason: "" }, "reason"], [{ reason: "  " }, "reason"], [{ effectiveFrom: "" }, "effectiveFrom"], [{ effectiveFrom: "2026-13-01" }, "effectiveFrom"],
    [{ effectiveFrom: "1999-12-31" }, "effectiveFrom"], [{ wageType: "週給" }, "wageType"], [{ baseAmount: -1 }, "baseAmount"],
    [{ baseAmount: 1.5 }, "baseAmount"], [{ baseAmount: "abc" }, "baseAmount"], [{ baseAmount: null }, "baseAmount"],
    [{ allowances: [{ name: "A", amount: 1 }, { name: "a", amount: 2 }] }, "allowances"], [{ allowances: [{ name: "", amount: 5 }] }, "allowances"],
    [{ allowances: [{ name: "A", amount: -5 }] }, "allowances"], [{ commuteAmount: -1 }, "commuteAmount"], [{ source: "import_all" }, "source"],
  ];
  for (const [patch, field] of bad) {
    const r = await post({ ...FIELDS, ...patch });
    assert.equal(r.statusCode, 400, JSON.stringify(patch));
    assert.equal(r.body.field, field, JSON.stringify(patch));
  }
  assert.equal(db.writes.length, 0);
});

await ok("競合: 同じ適用開始日の二重記録・訂正する記録が無い・変更前と同じ内容は 409", async () => {
  setup();
  assert.equal((await post(FIELDS)).statusCode, 200);
  const dup = await post(FIELDS);
  assert.equal(dup.statusCode, 409); assert.equal(dup.body.error, "exists_at_date");
  const same = await post({ ...FIELDS, effectiveFrom: day(1) });
  assert.equal(same.statusCode, 409); assert.equal(same.body.error, "no_change");
  const none = await post({ ...FIELDS, effectiveFrom: day(2), correct: true });
  assert.equal(none.statusCode, 409); assert.equal(none.body.error, "nothing_to_correct");
  assert.equal(db.rows.gw_compensations.filter((x) => x.employee_id === "e4").length, 1, "何も増えていない");
});

await ok("画面が古いとき（basisId が違う）は記録しない。同時記録の一意制約も 409", async () => {
  setup();
  const p = await post({ ...FIELDS, action: "preview_record" });
  assert.equal(p.body.preview.basisId, null, "最初の記録には、変更前の記録が無い");
  await post(FIELDS);
  const id = db.rows.gw_compensations.find((x) => x.employee_id === "e4").id;
  // 別の人が先に記録したあと、古い画面（basisId=null）から変更しようとする
  const stale = await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 340000, reason: "昇給", basisId: null });
  assert.equal(stale.statusCode, 409); assert.equal(stale.body.error, "stale_basis");
  const good = await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 340000, reason: "昇給", basisId: id });
  assert.equal(good.statusCode, 200);
  // 読んだあとで同じ枠に先に入られた（一意制約）
  db.failInsert.gw_compensations = { code: "23505", message: "duplicate key" };
  const race = await post({ ...FIELDS, effectiveFrom: day(5), baseAmount: 360000, reason: "x" });
  assert.equal(race.statusCode, 409); assert.equal(race.body.error, "conflict");
  db.failInsert.gw_compensations = { code: "XX000", message: "boom" };
  assert.equal((await post({ ...FIELDS, effectiveFrom: day(6), baseAmount: 361000, reason: "x" })).statusCode, 500);
});

await ok("プレビューは書かない。変更前後・種別・注意・契約との食い違いを返す", async () => {
  setup();
  const before = snapshot();
  const r = await post({ action: "preview_record", employeeId: "e8", effectiveFrom: day(5), wageType: "月給", baseAmount: 255000, reason: "昇給" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const p = r.body.preview;
  assert.equal(p.kind, "change"); assert.equal(p.kindLabel, "変更"); assert.equal(p.revision, 1);
  assert.equal(p.before.baseAmount, 250000); assert.equal(p.after.baseAmount, 255000);
  assert.deepEqual(p.changes.map((c) => [c.key, c.from, c.to]), [["baseAmount", 250000, 255000]]);
  assert.ok(p.warnings.some((w) => /契約の賃金と食い違い/.test(w)));
  assert.equal(p.contractCheck.state, "amount");
  assert.equal(p.monthly.total, 255000);
  assert.equal(snapshot(), before, "プレビューでは、何も書かれない（監査ログも増えない）");
  assert.equal(db.writes.length, 0);
});

await ok("契約の写しを残す。契約そのものは書き換えない", async () => {
  setup();
  const contractsBefore = JSON.stringify(db.rows.gw_contracts);
  const r = await post({ action: "record", employeeId: "e8", effectiveFrom: day(5), wageType: "月給", baseAmount: 260000, reason: "契約に合わせる", source: "contract_import" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_compensations.find((x) => x.employee_id === "e8" && x.effective_from === day(5));
  assert.deepEqual([row.contract_id, row.contract_wage_type, row.contract_wage_amount, row.source], ["k8", "月給", 260000, "contract_import"]);
  assert.equal(JSON.stringify(db.rows.gw_contracts), contractsBefore, "契約は、そのまま");
});

await ok("「契約から」「内定から」と名乗るなら、元が実在すること", async () => {
  setup();
  const a = await post({ ...FIELDS, source: "contract_import" });
  assert.equal(a.statusCode, 409); assert.equal(a.body.error, "no_contract_wage");
  const b = await post({ ...FIELDS, source: "offer_import" });
  assert.equal(b.statusCode, 409); assert.equal(b.body.error, "no_offer_wage");
  const c = await post({ ...FIELDS, employeeId: "e1", effectiveFrom: day(3), baseAmount: 305000, source: "offer_import" });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(db.writes.filter((w) => w.table === "gw_compensations").length, 1);
});

await ok("BP は対象外（現場単価は給与ではない）。退職者の訂正はできる", async () => {
  setup();
  const bp = await post({ ...FIELDS, employeeId: "e5" });
  assert.equal(bp.statusCode, 409); assert.equal(bp.body.error, "bp_not_supported");
  assert.equal(db.writes.length, 0);
  const left = await post({ ...FIELDS, employeeId: "e6", effectiveFrom: PAST1, baseAmount: 210000, reason: "入力ミスの訂正", correct: true });
  assert.equal(left.statusCode, 200, JSON.stringify(left.body));
});

console.log("\n=== 初回給与の候補（自動登録はしない）===\n");

const candBody = (o = {}) => ({ action: "record", employeeId: "e7", effectiveFrom: day(0), wageType: "月給", baseAmount: 250000, commuteAmount: 9000,
  reason: "候補から登録", candidate: true, ...o });

await ok("個人の画面: 記録がない人には候補が付く（契約が基準・届出の定期代が通勤手当）。適用開始日は入らない", async () => {
  setup();
  const b = (await get("view=detail&employeeId=e7")).body;
  assert.equal(b.current, null);
  assert.equal(b.candidate.wageType, "月給"); assert.equal(b.candidate.baseAmount, 250000);
  assert.equal(b.candidate.commuteAmount, 9000); assert.equal(b.candidate.source, "contract_import");
  assert.deepEqual(b.candidate.sources.map((x) => x.type), ["contract", "commute_declared"]);
  assert.equal(b.candidate.sources[0].id, "k7");
  assert.ok(!("effectiveFrom" in b.candidate), "適用開始日は決めない");
  assert.ok(b.candidate.warnings.some((w) => /会社が決めた額ではありません/.test(w)));
  assert.equal(db.rows.gw_compensations.filter((r) => r.employee_id === "e7").length, 0, "見せただけで、登録していない");
});

await ok("候補を作れない人には、理由が付く。すでに記録がある人には、候補が付かない", async () => {
  setup();
  const none = (await get("view=detail&employeeId=e4")).body;
  assert.equal(none.candidate, null); assert.ok(none.candidateWhy.some((w) => /有効な契約がありません/.test(w)));
  const has = (await get("view=detail&employeeId=e1")).body;
  assert.equal(has.candidate, null); assert.deepEqual(has.candidateWhy, []);
  // 契約の種別が「その他」だけ → 候補なし。内定があれば内定を基準にする
  setup(); db.rows.gw_contracts.find((c) => c.employee_id === "e7").wage_type = "その他";
  const other = (await get("view=detail&employeeId=e7")).body;
  assert.equal(other.candidate.baseAmount, null, "基本給の候補は無い（届出の定期代だけ）");
  assert.equal(other.candidate.commuteAmount, 9000);
  assert.ok(other.candidateWhy.some((w) => /その他/.test(w)));
});

await ok("候補の一覧: 記録がない在籍者・退職手続き中・入社準備中だけ。BP・退職者・記録がある人・他社は出ない。候補がある人が先", async () => {
  setup();
  const r = await get("view=candidates");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rows.map((x) => x.id), ["e7", "e4"]);
  assert.equal(r.body.rows[0].candidate.baseAmount, 250000);
  assert.equal(r.body.rows[1].candidate, null); assert.ok(r.body.rows[1].why.length > 0);
  assert.deepEqual(r.body.summary, { total: 2, withCandidate: 1, withoutCandidate: 1 });
  assert.equal(db.writes.filter((w) => w.table === "gw_compensations").length, 0, "一覧で登録しない");
});

await ok("候補の一覧: 開いたことが監査に残る。残せなければ返さない", async () => {
  setup();
  await get("view=candidates");
  const a = db.rows.gw_pay_audit.at(-1);
  assert.deepEqual([a.action, a.detail.via], ["view_list", "candidates"]);
  setup(); db.failInsert.gw_pay_audit = { code: "XX000", message: "boom" };
  const r = await get("view=candidates");
  assert.equal(r.statusCode, 503); assert.ok(!/250000/.test(JSON.stringify(r.body)));
});

await ok("候補の一覧: 1000人を超えても切り捨てない。契約は100件ずつ読む", async () => {
  setup();
  for (let i = 0; i < 1100; i++) {
    db.rows.gw_employees.push({ id: `n${i}`, tenant_id: "t1", display_name: `新規 ${String(i).padStart(4, "0")}`, status: "active", employee_kind: "proper" });
    db.rows.gw_contracts.push({ id: `nk${i}`, employee_id: `n${i}`, tenant_id: "t1", status: "active", wage_type: "月給", wage_amount: 200000 + i, created_at: "2026-04-01" });
  }
  const r = await get("view=candidates");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 1102);
  assert.equal(r.body.summary.withCandidate, 1101, "1000人目以降にも、契約から候補が付いている");
});

await ok("契約や届出を読み切れないときは、候補なしと言わずに止める", async () => {
  setup(); db.missing = new Set(["gw_contracts"]);
  const r = await get("view=candidates");
  assert.equal(r.statusCode, 500); assert.equal(r.body.error, "db_read_failed");
});

await ok("候補のプレビュー: 基準と、直した項目が出る。書かない", async () => {
  setup();
  const same = (await post(candBody({ action: "preview_record" }))).body.preview;
  assert.match(same.basis.text, /候補から登録（基準: 有効な契約の賃金・本人が届け出た定期代）／候補のまま/);
  assert.deepEqual(same.basis.edited, []); assert.deepEqual(same.basis.sources, ["contract", "commute_declared"]);
  const edited = (await post(candBody({ action: "preview_record", baseAmount: 260000 }))).body.preview;
  assert.deepEqual(edited.basis.edited, ["baseAmount"]);
  assert.equal(db.writes.length, 0);
});

await ok("候補から登録: 基準がサーバの作り直しで basis に残る。取り込み元は契約。自動では登録されていない", async () => {
  setup();
  const r = await post(candBody());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_compensations.find((x) => x.employee_id === "e7");
  assert.equal(row.kind, "initial"); assert.equal(row.source, "contract_import");
  assert.equal(row.basis.kind, "candidate"); assert.deepEqual(row.basis.edited, []);
  assert.deepEqual(row.basis.candidate, { wageType: "月給", baseAmount: 250000, commuteAmount: 9000 });
  assert.deepEqual(row.basis.sources.map((x) => [x.type, x.id || null]), [["contract", "k7"], ["commute_declared", null]]);
  assert.equal(row.contract_id, "k7", "契約の写しも残る");
  assert.match(r.body.groups[0].revisions[0].basisText, /候補から登録/);
  assert.equal(db.rows.gw_pay_audit.at(-1).detail.candidate, true, "監査ログにも「候補から」と残る");
});

await ok("経営者が候補を直したら、直した項目が残り、取り込み元は経営者の入力。候補そのものは直す前の値で残る", async () => {
  setup();
  const r = await post(candBody({ baseAmount: 260000, commuteAmount: 5000, allowances: [{ name: "役職手当", amount: 10000 }], reason: "契約より高く決まっていたため" }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_compensations.find((x) => x.employee_id === "e7");
  assert.equal(row.source, "owner"); assert.equal(row.base_amount, 260000);
  assert.deepEqual(row.basis.edited, ["baseAmount", "commuteAmount"]);
  assert.equal(row.basis.allowancesAdded, 1);
  assert.equal(row.basis.candidate.baseAmount, 250000, "候補は、直す前の値");
  // 通勤手当だけ直したなら、基本給は候補のまま → 取り込み元は契約
  setup();
  await post(candBody({ commuteAmount: 5000 }));
  assert.equal(db.rows.gw_compensations.find((x) => x.employee_id === "e7").source, "contract_import");
});

await ok("画面の申告は信じない: source を偽っても、サーバが決める。basis も画面からは受け取らない", async () => {
  setup();
  await post(candBody({ source: "offer_import", basis: { kind: "candidate", sources: [{ type: "fake" }], edited: [] } }));
  const row = db.rows.gw_compensations.find((x) => x.employee_id === "e7");
  assert.equal(row.source, "contract_import");
  assert.ok(!JSON.stringify(row.basis).includes("fake"));
  // candidate を付けなければ、basis は無い（候補から入れたことにならない）
  setup();
  await post(candBody({ candidate: undefined }));
  assert.equal(db.rows.gw_compensations.find((x) => x.employee_id === "e7").basis, null);
});

await ok("候補は最初の記録にだけ。記録がある人・候補を作れない人・BP は断る（何も書かれない）", async () => {
  setup();
  const has = await post(candBody({ employeeId: "e1", effectiveFrom: day(2) }));
  assert.equal(has.statusCode, 409); assert.equal(has.body.error, "candidate_not_initial");
  const none = await post(candBody({ employeeId: "e4" }));
  assert.equal(none.statusCode, 409); assert.equal(none.body.error, "no_candidate"); assert.match(none.body.hint, /契約/);
  const bp = await post(candBody({ employeeId: "e5" }));
  assert.equal(bp.statusCode, 409); assert.equal(bp.body.error, "bp_not_supported");
  assert.equal(db.writes.length, 0);
});

await ok("候補を使っても、理由は必須・適用開始日は経営者が入れる（省けない）", async () => {
  setup();
  const noReason = await post(candBody({ reason: "" }));
  assert.equal(noReason.statusCode, 400); assert.equal(noReason.body.field, "reason");
  const noDate = await post(candBody({ effectiveFrom: "" }));
  assert.equal(noDate.statusCode, 400); assert.equal(noDate.body.field, "effectiveFrom");
  assert.equal(db.writes.length, 0);
});

console.log("\n=== 監査ログ ===\n");

await ok("一覧・個人・監査ログを開くたびに、誰がいつ開いたかが残る（金額は残さない）", async () => {
  setup();
  await get("view=list"); await get("view=detail&employeeId=e1"); await get("view=audit");
  const a = db.rows.gw_pay_audit;
  assert.deepEqual(a.map((x) => x.action), ["view_list", "view_detail", "view_audit"]);
  assert.ok(a.every((x) => x.actor_id === "u-owner" && x.actor_name === "経営 花子" && x.tenant_id === "t1"));
  assert.equal(a[1].employee_id, "e1");
  assert.ok(!/\d{6}/.test(JSON.stringify(a.map((x) => x.detail))), "金額は残さない");
});

await ok("監査ログを残せなければ、給与は返さない（一覧・個人・監査ログとも）", async () => {
  setup(); db.failInsert.gw_pay_audit = { code: "XX000", message: "boom" };
  for (const q of ["view=list", "view=detail&employeeId=e1", "view=audit"]) {
    const r = await get(q);
    assert.equal(r.statusCode, 503, q); assert.equal(r.body.error, "audit_unavailable", q);
    assert.ok(!/300000|330000|280000|6000000/.test(JSON.stringify(r.body)), `${q}: 給与を返していない`);
  }
});

await ok("監査ログの一覧: 新しい順・200 件ずつ・続き。社員名がつく。他社は出ない・社員で絞れる", async () => {
  setup();
  const A = db.rows.gw_pay_audit;
  for (let i = 1; i <= 250; i++) A.push({ id: i, ts: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}Z`, tenant_id: "t1", actor_id: "u", actor_name: "経営 花子", action: "view_detail", employee_id: i % 2 ? "e1" : "e2", record_id: null, detail: null });
  A.push({ id: 900, ts: "2026-09-02T00:00:00Z", tenant_id: "t2", actor_id: "z", actor_name: "他社", action: "view_list", employee_id: "ex", record_id: null, detail: null });
  db.seq = 5000;
  const p1 = (await get("view=audit")).body;
  assert.equal(p1.rows.length, 200); assert.ok(p1.nextBefore);
  assert.ok(p1.rows.every((x) => x.actor !== "他社"), "他社は出ない");
  assert.ok(p1.rows[0].id > p1.rows[1].id, "新しい順");
  assert.equal(p1.rows.find((x) => x.employeeId === "e1").employeeName, "月給 太郎");
  const p2 = (await get(`view=audit&before=${p1.nextBefore}`)).body;
  assert.ok(p2.rows.length > 0 && p2.rows.every((x) => x.id < Number(p1.nextBefore)));
  const ids = new Set([...p1.rows, ...p2.rows].map((x) => x.id));
  assert.equal(ids.size, p1.rows.length + p2.rows.length, "続きに重複が無い");
  const only = (await get("view=audit&employeeId=e2")).body;
  assert.ok(only.rows.every((x) => x.employeeId === "e2"));
  assert.equal((await get("view=audit&before=abc;drop")).statusCode, 200, "壊れたカーソルは無視（注入にならない）");
});

await ok("個人の画面に、その人の監査ログ（新しい順）が付く。ラベルつき", async () => {
  setup();
  await post(FIELDS);
  const d = (await get("view=detail&employeeId=e4")).body;
  assert.equal(d.audit[0].action, "create");
  assert.equal(d.audit[0].label, "給与を記録した");
  assert.equal(d.audit[0].actor, "経営 花子");
  assert.equal(d.audit[0].detail.reason, "入社時の条件を登録");
});

console.log("\n=== 既存の表に書かない・unit_price を扱わない ===\n");

await ok("記録しても、契約・内定・入社情報・社員名簿は変わらない。gw_activity_log にも書かない", async () => {
  setup();
  const keep = ["gw_contracts", "gw_hr_applicants", "gw_hr_offers", "gw_hr_pay", "gw_onboard_profiles", "gw_employees"];
  const before = keep.map((t) => JSON.stringify(db.rows[t]));
  await get("view=list"); await get("view=detail&employeeId=e1");
  await post(FIELDS);
  await post({ ...FIELDS, effectiveFrom: day(0), baseAmount: 340000, reason: "昇給" });
  assert.deepEqual(keep.map((t) => JSON.stringify(db.rows[t])), before);
  assert.deepEqual([...new Set(db.writes.map((w) => w.table))].sort(), ["gw_compensations", "gw_pay_audit"], "書いた表は、この2つだけ");
  assert.equal(logged.length, 0, "管理者も読める gw_activity_log には、給与の操作を書かない");
  assert.deepEqual(db.forbidden, []);
});

await ok("コードに、更新・削除・upsert の入口が無い。unit_price も無い", async () => {
  const src = readFileSync(atRoot("api/keiei/pay.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.(update|delete|upsert)\(/.test(src), "更新・削除・upsert を呼んでいない");
  assert.ok(!/unit_price|unitPrice/.test(src), "unit_price を扱わない");
  assert.ok(!/gwLog/.test(src), "gw_activity_log に書かない");
  assert.ok(!/userClient/.test(src), "サーバ（service_role）だけが読み書きする");
  const lib = readFileSync(atRoot("lib/compensation.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/unit_price|unitPrice/.test(lib), "lib も unit_price を扱わない");
  // 応答にも出ない
  setup();
  const all = JSON.stringify([(await get("view=list")).body, (await get("view=detail&employeeId=e1")).body]);
  assert.ok(!/unit_price|unitPrice/.test(all));
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
