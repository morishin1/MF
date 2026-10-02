// /api/office（月末月初業務の一覧・提出ファイル閲覧）を、偽の Supabase で通す。
//
// ■ 何を守るテストか
//
//   1. 入れるのは 経営者・責任者・経理 だけ。人事・営業・採用担当・IT・社労士・
//      会計の管理者だけの人・一般メンバーは 403（データには一切触れない）
//   2. 二段階認証（MFA）は要求しない。MFA 未登録・aal1 でも、経営者・責任者・経理は通る。
//      権限のない人は、aal1 でも aal2 でも 403 forbidden（MFA の登録画面へ誘導しない）
//   3. ログインした人の権限（RLS）で読む。DB（gw_is_office、db/100）が未適用なら、
//      「0件」と見間違えないよう、画面に知らせる
//   4. 単価・精算条件・メモを select しない・返さない（単価の意味が確認できるまで）
//   5. 30日までの月・2月・月末日/翌月1日の境界。名簿に無い契約は、その行だけ出さない
//   6. 提出ファイルの閲覧：署名URLだけ返し、置き場所（storage_path）は返さない。閲覧ログを残す
//
// 判定関数（lib/gw.js の canAccessOffice）は、モックせず本物を通す
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";

const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);
const { pgDateError } = await import("./_pgdate.mjs");

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, missing: null, policy100: true };
const selects = [];           // 読もうとした列（単価を読んでいないかを見る）
const admin_calls = { employees: 0 };
let who = null;

const OFFICE_TABLES = ["gw_site_contracts", "gw_billing_progress", "gw_submissions", "gw_partner_companies",
  "gw_timesheets", "gw_site_contract_terms"];
const hasOfficeRole = (c) => ["owner", "manager", "finance"].some((r) => (c?.roles || []).includes(r));
/** 実DBの RLS の再現：既存ポリシーは is_tenant_staff、db/100 は gw_is_office の読み取り */
const rlsAllows = (name, c) => {
  if (OFFICE_TABLES.includes(name)) return Boolean(c?.isAdmin) || (db.policy100 && hasOfficeRole(c));
  if (name === "gw_employees") return Boolean(c?.isAdmin);     // 名簿は Office に開けない
  return true;
};

function table(name, { asUser }) {
  const f = [];
  let cols = null, head = false, wantCount = false, order = null;
  const rows = () => {
    if (asUser && !rlsAllows(name, who)) return [];
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return v.includes(r[k]);
      if (op === "lt") return r[k] < v;
      if (op === "lte") return r[k] <= v;
      if (op === "neq") return r[k] !== v;
      if (op === "is") return v === null ? r[k] === null || r[k] === undefined : r[k] === v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? -1 : 1));
    // 列の絞り込み：頼んだ列だけを返す（頼んでいない列は、見えない）
    if (cols) out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    return out;
  };
  const err = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : pgDateError(f));
  const q = {
    select(c, opts) {
      selects.push({ table: name, cols: c, asUser });
      if (name === "gw_employees" && !asUser) admin_calls.employees++;
      cols = c === "*" || !c ? null : c.split(",").map((s) => s.trim());
      head = !!opts?.head; wantCount = opts?.count === "exact";
      return q;
    },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    lt(k, v) { f.push(["lt", k, v]); return q; },
    lte(k, v) { f.push(["lte", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(c) { order = c; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: err() ? null : (rows()[0] ? { ...rows()[0] } : null), error: err() }),
    then: (fn) => {
      const e = err();
      const r = e ? [] : rows();
      const out = { data: e ? null : (head ? null : r.map((x) => ({ ...x }))), error: e };
      if (wantCount) out.count = e ? null : r.length;
      return Promise.resolve(out).then(fn);
    },
  };
  return q;
}

const signed = [];
const storage = { from: (bucket) => ({
  createSignedUrl: (path, ttl) => {
    signed.push({ bucket, path, ttl });
    return Promise.resolve({ data: { signedUrl: `https://storage.example/${path}?token=t` }, error: null });
  },
}) };
mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: (n) => table(n, { asUser: false }), storage }),
    userClient: () => ({ from: (n) => table(n, { asUser: true }), storage }),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", factors: who?.factors || [] }), getMemberships: async () => [] },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
// 判定関数は本物（モックしない）。文脈だけ差し替える
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));

// ---- 人物 -----------------------------------------------------------------
const P = (roles, extra = {}) => ({ tenantId: "t1", isAdmin: false, isHr: false, roles, employee: { id: "e-x" }, ...extra });
const OWNER = P(["owner"], { isHr: true });
const MANAGER = P(["manager"]);
const FINANCE = P(["finance"]);
const DENIED = {
  "人事": P(["hr"], { isHr: true }),
  "営業担当": P(["sales"]),
  "採用担当": P(["recruiter"]),
  "IT・管理": P(["it"]),
  "社労士": P(["labor_advisor"]),
  "会計の管理者だけ": P([], { isAdmin: true, isHr: true }),
  "会計の管理者＋人事": P(["hr"], { isAdmin: true, isHr: true }),
  "一般メンバー": P([]),
};
const ENROLLED = [{ factor_type: "totp", status: "verified" }];

const token = (aal) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u-1", aal })}.sig`;
};
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, url, { aal = "aal2", method = "GET" } = {}) => {
  const r = res();
  await h({ method, url, headers: { authorization: `Bearer ${token(aal)}` } }, r);
  return r;
};
const list = (month, o) => call(indexApi, `/api/office?month=${month}`, o);
const file = (id, o) => call(fileApi, `/api/office/file?id=${id}`, o);

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const UNIT = "700000";
function setup() {
  who = OWNER;
  db.missing = null; db.policy100 = true;
  selects.length = 0; logged.length = 0; signed.length = 0; admin_calls.employees = 0;
  const nomarks = { timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false };
  db.rows = {
    gw_employees: [
      { id: "e-pp", tenant_id: "t1", display_name: "田中 太郎", department: "常駐部", employee_kind: "proper", partner_company_id: null, note: "人事メモ" },
      { id: "e-bp", tenant_id: "t1", display_name: "鈴木 花子", department: null, employee_kind: "bp", partner_company_id: "pc-1", note: "人事メモ" },
    ],
    gw_partner_companies: [{ id: "pc-1", tenant_id: "t1", company_name: "株式会社ビーピー" }],
    gw_site_contracts: [
      // 単価・精算条件・メモが入っている契約（API は読んではいけない）
      { id: "sc-pp", tenant_id: "t1", employee_id: "e-pp", engagement_kind: "pp", site_company: "顧客A社", prime_company: null,
        period_from: "2026-04-01", period_to: null, renewal_status: "confirmed",
        unit_price: Number(UNIT), unit_price_type: "月額", settlement_condition: "140h〜180h、超過1,500円/控除1,200円", note: "契約メモ" },
      { id: "sc-bp", tenant_id: "t1", employee_id: "e-bp", engagement_kind: "bp", site_company: "顧客B社", prime_company: "上位商事",
        period_from: "2026-04-01", period_to: null, renewal_status: "pending",
        unit_price: 650000, unit_price_type: "月額", settlement_condition: "精算あり", note: null },
      // 他社
      { id: "sc-x", tenant_id: "t2", employee_id: "e-x", engagement_kind: "pp", site_company: "他社の客先", period_from: "2026-01-01", period_to: null, renewal_status: "pending" },
    ],
    gw_billing_progress: [
      { id: "bp-pp", tenant_id: "t1", employee_id: "e-pp", site_contract_id: "sc-pp", billing_month: "2026-09", ...nomarks, timesheet_received: true, timesheet_received_at: "2026-09-30T01:00:00Z" },
    ],
    gw_submissions: [
      { id: "11111111-1111-4111-8111-111111111111", tenant_id: "t1", employee_id: "e-pp", site_contract_id: "sc-pp", target_month: "2026-09",
        kind: "timesheet", file_name: "田中_9月.pdf", storage_path: "t1/e-pp/11111111.pdf", submitted_at: "2026-09-30T01:00:00Z" },
      { id: "22222222-2222-4222-8222-222222222222", tenant_id: "t2", employee_id: "e-x", site_contract_id: "sc-x", target_month: "2026-09",
        kind: "timesheet", file_name: "他社.pdf", storage_path: "t2/e-x/2222.pdf", submitted_at: "2026-09-30T01:00:00Z" },
    ],
  };
}

console.log("— 入れる人：経営者・責任者・経理だけ —");

for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
  await ok(`${label} は一覧を見られる`, async () => {
    setup(); who = p;
    const r = await list("2026-09");
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.rows.length, 2);
    assert.equal(r.headers["cache-control"], "no-store");
  });
}
await ok("会計の管理者＋経理 は、経理の権限があるので入れる（管理者の権限では入れない）", async () => {
  setup(); who = P(["finance"], { isAdmin: true });
  assert.equal((await list("2026-09")).statusCode, 200);
});
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は 403（データに触れず、ログも残さない）`, async () => {
    setup(); who = p;
    const r = await list("2026-09");
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "forbidden");
    assert.equal(selects.length, 0, "1つも表を読んでいない");
    const f = await file("11111111-1111-4111-8111-111111111111");
    assert.equal(f.statusCode, 403);
    assert.equal(signed.length, 0, "署名URLを出していない");
    assert.equal(logged.length, 0);
  });
}
await ok("POST など GET 以外は 405", async () => {
  setup();
  assert.equal((await call(indexApi, "/api/office?month=2026-09", { method: "POST" })).statusCode, 405);
  assert.equal((await call(fileApi, "/api/office/file?id=x", { method: "DELETE" })).statusCode, 405);
});

console.log("\n— 二段階認証（MFA）は要求しない：権限だけで通す —");

// 2026-09-30 の決定：Office の閲覧・一覧・勤務表・契約条件は MFA なしで通す。MFA を残すのは、支払・振込・給与・請求書送信・権限変更・
// MFA/パスワードのリセット・金融/会計サービスへの確定送信（lib/mfa.js）。Office には、そのどれも無い。
// requireMfa は強制日（2026-10-01）から、strict でなくても aal2 を求めるので、Office の API は、そもそも呼ばない
// （test/mfatest.mjs が、api/office/*.js に requireMfa・lib/mfa.js の参照が無いことを見張る）
for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
  await ok(`${label}：MFA を登録していない・6桁で確かめていない（aal1）でも、一覧もファイルも見られる`, async () => {
    setup(); who = { ...p, factors: [] };
    const r = await list("2026-09", { aal: "aal1" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.rows.length > 0);
    const f = await file("11111111-1111-4111-8111-111111111111", { aal: "aal1" });
    assert.equal(f.statusCode, 200, JSON.stringify(f.body));
    assert.equal(signed.length, 1);
  });
}
await ok("登録済みで aal1 でも、aal2 と同じ結果を返す（MFA の状態は、結果を変えない）", async () => {
  setup(); who = { ...FINANCE, factors: ENROLLED };
  const a = await list("2026-09", { aal: "aal1" });
  const b = await list("2026-09", { aal: "aal2" });
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.body, b.body);
});
await ok("権限のない人は、aal1 でも aal2 でも 403 forbidden（MFA を求めない・MFA の登録画面へ誘導しない）", async () => {
  for (const aal of ["aal1", "aal2"]) {
    for (const [label, p] of Object.entries(DENIED)) {
      setup(); who = { ...p, factors: [] };
      const r = await list("2026-09", { aal });
      assert.equal(r.statusCode, 403, `${label} ${aal}`);
      assert.equal(r.body.error, "forbidden", `${label} ${aal}`);
    }
  }
});

console.log("\n— 一覧の中身 —");

await ok("要員・客先・BP会社・現在工程・要対応が、既存の印から導かれる", async () => {
  setup();
  const r = await list("2026-09");
  const pp = r.body.rows.find((x) => x.employeeName === "田中 太郎");
  const bp = r.body.rows.find((x) => x.employeeName === "鈴木 花子");
  assert.equal(pp.siteCompany, "顧客A社");
  assert.equal(pp.kindLabel, "PP（自社）");
  assert.equal(pp.stage, "work");
  assert.equal(pp.cols.timesheet.label, "提出済");
  assert.equal(pp.submissions.length, 1, "他社のファイルは混ざらない");
  assert.equal(pp.submissions[0].fileName, "田中_9月.pdf");
  assert.equal(bp.partnerName, "株式会社ビーピー");
  assert.equal(bp.primeCompany, "上位商事");
  assert.equal(bp.stage, "timesheet");
  assert.equal(bp.cols.vendorInvoice.label, "未受領");
  assert.equal(bp.cols.payment.label, "未着手", "支払の表（db/117）があれば、BP請求書の前は「未着手」");
  assert.equal(r.body.summary.total, 2);
  // db/117 が未適用なら、支払は「未管理」のまま（一覧は止めない）
  db.missing = "gw_vendor_invoice_lines";
  const r2 = await list("2026-09");
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.rows.find((x) => x.employeeName === "鈴木 花子").cols.payment.label, "未管理");
  assert.equal(r2.body.phase4.ready, false);
  assert.match(r2.body.phase4.message, /db\/117/);
  db.missing = null;
  assert.equal(r.body.deadline, "2026-10-05");
  assert.ok(r.body.filters.length && r.body.stages.length);
});
await ok("他社の契約・提出は出ない", async () => {
  setup();
  const r = await list("2026-09");
  assert.ok(!r.body.rows.some((x) => x.siteCompany === "他社の客先"));
  assert.ok(!JSON.stringify(r.body).includes("他社.pdf"));
});
await ok("単価・精算条件・メモを select しない・返さない", async () => {
  setup();
  const r = await list("2026-09");
  // 既存の gw_site_contracts.unit_price / settlement_condition / note は、どの表からも読まない。
  // （Phase 3 の契約条件 gw_site_contract_terms の sales_unit_price・purchase_unit_price は別の列）
  const askedOf = (tables) => selects.filter((s) => !tables || tables.includes(s.table)).map((s) => s.cols).join(",");
  for (const w of [/(^|[^a-z_])unit_price/, /settlement_condition/, /\*/]) {
    assert.ok(!w.test(askedOf()), `${w} を読もうとしている: ${askedOf()}`);
  }
  assert.ok(!/(^|[^a-z_])note\b/.test(askedOf(["gw_site_contracts", "gw_employees", "gw_billing_progress", "gw_submissions"])),
    "契約・名簿・進捗・提出の note を読まない");
  const text = JSON.stringify(r.body);
  for (const w of [UNIT, "650000", "unit_price", "settlement", "140h", "契約メモ", "人事メモ"]) {
    assert.ok(!text.includes(w), `${w} が応答に入っている`);
  }
});
await ok("名簿は Office 権限の RLS では開けず、必要な列だけを判定のあとに読む", async () => {
  setup(); who = FINANCE;    // 会計の管理者ではない経理。名簿の RLS は通らない
  const r = await list("2026-09");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 2, "氏名が引けている");
  const empSelect = selects.filter((s) => s.table === "gw_employees");
  assert.ok(empSelect.length && empSelect.every((s) => !s.asUser), "名簿は userClient では読まない");
  assert.ok(empSelect.every((s) => !s.cols.includes("note") && !s.cols.includes("email")), "人事の機微の列は読まない");
});
await ok("印が1つも無い月でも、契約があれば行が出る（進捗の行が無い＝勤務表待ち）", async () => {
  setup();
  const r = await list("2026-08");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 2);
  assert.ok(r.body.rows.every((x) => x.stage === "timesheet"));
});
await ok("退職済みの要員の契約は、隠さず「要確認」で出す（他の行はそのまま）", async () => {
  setup();
  db.rows.gw_employees.find((e) => e.id === "e-pp").status = "left";
  const r = await list("2026-09");
  const pp = r.body.rows.find((x) => x.employeeName === "田中 太郎");
  const bp = r.body.rows.find((x) => x.employeeName === "鈴木 花子");
  assert.equal(pp.check, true);
  assert.match(pp.warnings.join(), /退職済み/);
  assert.equal(bp.check, false);
  assert.equal(r.body.rows.length, 2, "隠さない");
});
await ok("名簿に無い契約は、その行だけ出さない（全体は止めない）", async () => {
  setup();
  db.rows.gw_employees = db.rows.gw_employees.filter((e) => e.id !== "e-bp");
  const r = await list("2026-09");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.rows.map((x) => x.employeeName), ["田中 太郎"]);
});
await ok("勤務表未提出で期限を過ぎた行は、期限超過（過去の月で、いまの日付に依らず確かめる）", async () => {
  setup();
  db.rows.gw_site_contracts.forEach((c) => { c.period_from = "2019-01-01"; });
  const r = await list("2020-01");
  assert.equal(r.body.deadline, "2020-02-05");
  assert.ok(r.body.rows.every((x) => x.overdue), "期限（2020-02-05）はとうに過ぎている");
  assert.equal(r.body.summary.overdue, 2);
  assert.equal(r.body.rows[0].tags.includes("overdue"), true);
});
await ok("まだ先の月は、期限超過にならない", async () => {
  setup();
  const r = await list("2099-01");
  assert.ok(r.body.rows.every((x) => !x.overdue));
});

console.log("\n— 月：30日までの月・2月・境界・入力 —");

for (const month of ["2026-09", "2026-11", "2027-02", "2028-02"]) {
  await ok(`31日が無い月（${month}）でも一覧が出る`, async () => {
    setup();
    const r = await list(month);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.rows.length, 2);
  });
}
await ok("月末日に始まる契約は対象、翌月1日に始まる契約は対象外", async () => {
  setup();
  db.rows.gw_site_contracts = [
    { id: "sc-last", tenant_id: "t1", employee_id: "e-pp", engagement_kind: "pp", site_company: "月末開始", period_from: "2026-09-30", period_to: null, renewal_status: "pending" },
    { id: "sc-next", tenant_id: "t1", employee_id: "e-pp", engagement_kind: "pp", site_company: "翌月開始", period_from: "2026-10-01", period_to: null, renewal_status: "pending" },
  ];
  const r = await list("2026-09");
  assert.deepEqual(r.body.rows.map((x) => x.siteCompany), ["月末開始"]);
});
await ok("前の月に終わった契約は対象外／当月に終わる契約は対象", async () => {
  setup();
  db.rows.gw_site_contracts = [
    { id: "sc-ended", tenant_id: "t1", employee_id: "e-pp", engagement_kind: "pp", site_company: "8月に終了", period_from: "2026-01-01", period_to: "2026-08-31", renewal_status: "pending" },
    { id: "sc-ending", tenant_id: "t1", employee_id: "e-pp", engagement_kind: "pp", site_company: "9月に終了", period_from: "2026-01-01", period_to: "2026-09-01", renewal_status: "pending" },
  ];
  const r = await list("2026-09");
  assert.deepEqual(r.body.rows.map((x) => x.siteCompany), ["9月に終了"]);
});
await ok("month が不正なら 400。無ければ今月", async () => {
  setup();
  for (const m of ["2026-13", "2026-9", "abc", "2026-00"]) {
    assert.equal((await list(m)).statusCode, 400, m);
  }
  const r = await call(indexApi, "/api/office");
  assert.equal(r.statusCode, 200);
  assert.match(r.body.month, /^\d{4}-(0[1-9]|1[0-2])$/);
  assert.equal(r.body.month, r.body.today.slice(0, 7));
});
await ok("契約が1件も無い月は、空の一覧（対象 0 件）", async () => {
  setup(); db.rows.gw_site_contracts = [];
  const r = await list("2026-09");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.rows, []);
  assert.equal(r.body.summary.total, 0);
  assert.equal(r.body.accessNotReady, undefined, "本当に0件なら、権限の未適用とは言わない");
});

console.log("\n— DB（RLS）：Office 権限の設定が未適用のとき —");

await ok("権限があるのに 0 件に見える（db/100 未適用）とき、画面に知らせる", async () => {
  setup(); who = FINANCE; db.policy100 = false;
  const r = await list("2026-09");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.rows, []);
  assert.equal(r.body.accessNotReady, true);
  assert.match(r.body.message, /db\/100_office_access\.sql/);
  // 空の一覧と同じ形で返す（画面が summary を前提に描くので、欠けると「取得に失敗しました」に化ける）
  assert.equal(r.body.summary.total, 0);
  assert.ok(Array.isArray(r.body.filters) && Array.isArray(r.body.stages));
});
await ok("db/100 未適用でも、経営者が会計の管理者を兼ねていれば、既存のポリシーで読める", async () => {
  setup(); who = P(["owner"], { isAdmin: true }); db.policy100 = false;
  assert.equal((await list("2026-09")).body.rows.length, 2);
});
await ok("表がまだ無い環境（076/077/080 未適用）では、落ちずに案内を返す", async () => {
  for (const t of ["gw_site_contracts", "gw_billing_progress", "gw_submissions"]) {
    setup(); db.missing = t;
    const r = await list("2026-09");
    assert.equal(r.statusCode, 200, t);
    assert.equal(r.body.notReady, true);
    assert.match(r.body.message, /db\/0(76|77|80)_/);
    assert.equal(r.body.summary.total, 0, "空の一覧と同じ形（画面が summary を前提に描く）");
    assert.ok(Array.isArray(r.body.filters));
  }
});

console.log("\n— Phase 3：勤務表の状態・稼働時間・契約条件を、一覧に足す —");

const P3 = () => {
  setup();
  const mk = (id, emp, contract, sha, at) => ({ id, tenant_id: "t1", employee_id: emp, site_contract_id: contract, target_month: "2026-09",
    kind: "timesheet", file_name: "x.pdf", storage_path: "t1/x", submitted_at: at, sha256: sha });
  db.rows.gw_submissions = [
    mk("11111111-1111-4111-8111-111111111111", "e-pp", "sc-pp", "a".repeat(64), "2026-09-30T01:00:00Z"),
    mk("44444444-4444-4444-8444-444444444444", "e-bp", "sc-bp", "b".repeat(64), "2026-09-30T02:00:00Z"),
  ];
  db.rows.gw_billing_progress = [
    { id: "bp-pp", tenant_id: "t1", employee_id: "e-pp", site_contract_id: "sc-pp", billing_month: "2026-09",
      timesheet_received: true, timesheet_received_at: "2026-09-30T01:00:00Z", work_confirmed: true, work_confirmed_at: "2026-10-01T01:00:00Z",
      board_created: false, sent: false, bp_invoice_received: false },
    { id: "bp-bp", tenant_id: "t1", employee_id: "e-bp", site_contract_id: "sc-bp", billing_month: "2026-09",
      timesheet_received: true, work_confirmed: true, board_created: false, sent: false, bp_invoice_received: false },
  ];
  db.rows.gw_timesheets = [
    { id: "ts-pp", tenant_id: "t1", employee_id: "e-pp", site_contract_id: "sc-pp", target_month: "2026-09",
      submission_id: "11111111-1111-4111-8111-111111111111", status: "confirmed", read_state: "ok", read_warnings: [],
      work_days: 20, unresolved_count: 0, flagged_count: 0, total_minutes: 9750 },
    { id: "ts-bp", tenant_id: "t1", employee_id: "e-bp", site_contract_id: "sc-bp", target_month: "2026-09",
      submission_id: "44444444-4444-4444-8444-444444444444", status: "confirmed", read_state: "ok", read_warnings: [],
      work_days: 20, unresolved_count: 0, flagged_count: 0, total_minutes: 9600 },
  ];
  db.rows.gw_site_contract_terms = [
    { id: "tm-pp", tenant_id: "t1", site_contract_id: "sc-pp", valid_from: "2026-04-01", valid_to: null, pricing_type: "hourly", sales_unit_price: 4500, purchase_unit_price: 3800 },
  ];
};
const rowOf = (r, name) => r.body.rows.find((x) => x.employeeName === name);

await ok("確定した稼働時間が、稼働確認の欄に出る（確認済 162.5h）。印と勤務表の確定が一致していれば、要確認にならない", async () => {
  P3();
  const r = await list("2026-09");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.phase3, { ready: true });
  const pp = rowOf(r, "田中 太郎");
  assert.equal(pp.cols.work.label, "確認済 162.5h");
  assert.equal(pp.cols.work.state, "confirmed");
  assert.equal(pp.sheetInfo.state, "confirmed");
  assert.equal(pp.sheetInfo.hours, "162.5");
  assert.equal(pp.check, false);
  assert.equal(pp.stage, "invoice_create", "確定したので、請求作成へ進む");
});
await ok("契約条件（時給 4,500円）から、売上の精算を返す：162.5h × 4,500 = 731,250円", async () => {
  P3();
  const pp = rowOf(await list("2026-09"), "田中 太郎");
  assert.equal(pp.settle.status, "calculated");
  assert.equal(pp.settle.amount, 731250);
  assert.equal(pp.terms.status, "ok");
  assert.ok(!pp.tags.includes("terms"));
});
await ok("稼働を確定したのに契約条件が無い行は「契約条件の確認」。今日やることにも出る", async () => {
  P3();
  const r = await list("2026-09");
  const bp = rowOf(r, "鈴木 花子");
  assert.equal(bp.settle.status, "none");
  assert.equal(bp.settle.amount, null);
  assert.ok(bp.tags.includes("terms"));
  assert.equal(bp.check, false, "要確認（警告）にはしない。別の絞り込みで見せる");
  const t = r.body.summary.today.find((x) => x.key === "terms");
  assert.equal(t.count, 1);
  assert.ok(r.body.filters.some((f) => f.key === "terms"));
});
await ok("下書き（確認待ち）は、時間を出さず「確認待ち」。要確認・入力が必要な日の数が、次にやることに入る", async () => {
  P3();
  db.rows.gw_billing_progress.find((p) => p.employee_id === "e-pp").work_confirmed = false;
  Object.assign(db.rows.gw_timesheets.find((t) => t.employee_id === "e-pp"), { status: "draft", unresolved_count: 2, flagged_count: 3, total_minutes: 4800 });
  const r = await list("2026-09");
  const pp = rowOf(r, "田中 太郎");
  assert.equal(pp.cols.work.label, "確認待ち");
  assert.equal(pp.sheetInfo.hours, null, "確定していない時間は出さない");
  assert.equal(pp.settle, null);
  assert.equal(pp.stage, "work");
  assert.match(pp.action.text, /入力が必要な日 2日/);
  assert.match(pp.action.text, /要確認 3日/);
  const work = r.body.summary.today.find((x) => x.key === "work");
  assert.match(work.note, /確認待ち 1件/);
});
await ok("ファイルだけ届いて未読取なら「未読取」。手で付けた稼働確認の印（勤務表の行なし）は「確認済（手動）」で、警告にしない", async () => {
  P3();
  db.rows.gw_timesheets = [];
  db.rows.gw_billing_progress.find((p) => p.employee_id === "e-bp").work_confirmed = false;
  const r = await list("2026-09");
  assert.equal(rowOf(r, "鈴木 花子").cols.work.label, "未読取");
  const pp = rowOf(r, "田中 太郎");
  assert.equal(pp.cols.work.label, "確認済（手動）");
  assert.equal(pp.check, false, "既存の月初作業管理で付けた印は、食い違いではない");
});
await ok("印と勤務表が食い違えば要確認：確定しているのに印が無い／印があるのに下書き", async () => {
  P3();
  db.rows.gw_billing_progress.find((p) => p.employee_id === "e-pp").work_confirmed = false;     // 確定しているのに、印が無い
  Object.assign(db.rows.gw_timesheets.find((t) => t.employee_id === "e-bp"), { status: "draft" });  // 印はあるのに、下書き
  const r = await list("2026-09");
  assert.match(rowOf(r, "田中 太郎").warnings.join(), /勤務表は確定していますが、稼働確認の印がありません/);
  assert.match(rowOf(r, "鈴木 花子").warnings.join(), /稼働確認の印はありますが、勤務表は確定していません/);
});
await ok("同じファイルが別の人にも出ていれば、両方に要確認。読取後に新しいファイルが届いても要確認", async () => {
  P3();
  db.rows.gw_submissions[1].sha256 = "a".repeat(64);                    // 田中さんと鈴木さんが、同じ中身
  db.rows.gw_submissions.push({ id: "55555555-5555-4555-8555-555555555555", tenant_id: "t1", employee_id: "e-pp", site_contract_id: "sc-pp",
    target_month: "2026-09", kind: "timesheet", file_name: "new.pdf", storage_path: "t1/n", submitted_at: "2026-10-02T00:00:00Z", sha256: "c".repeat(64) });
  const r = await list("2026-09");
  const pp = rowOf(r, "田中 太郎"), bp = rowOf(r, "鈴木 花子");
  assert.match(pp.warnings.join(), /同じファイルが、別の人・別の契約/);
  assert.match(bp.warnings.join(), /同じファイルが、別の人・別の契約/);
  assert.match(pp.warnings.join(), /新しい勤務表のファイルが届いています/);
  assert.ok(!/新しい勤務表/.test(bp.warnings.join()));
});
await ok("勤務表の氏名が登録と違うと、要確認（read_warnings の name_mismatch）", async () => {
  P3();
  db.rows.gw_timesheets.find((t) => t.employee_id === "e-pp").read_warnings = [{ code: "name_mismatch", text: "…" }];
  assert.match(rowOf(await list("2026-09"), "田中 太郎").warnings.join(), /氏名が、登録の氏名と一致しません/);
});
await ok("差し戻し中は、再提出を待つ表示（勤務表待ち）。受領の印が外れていれば工程は勤務表待ち", async () => {
  P3();
  Object.assign(db.rows.gw_timesheets.find((t) => t.employee_id === "e-pp"), { status: "returned" });
  Object.assign(db.rows.gw_billing_progress.find((p) => p.employee_id === "e-pp"), { timesheet_received: false, work_confirmed: false });
  const pp = rowOf(await list("2026-09"), "田中 太郎");
  assert.equal(pp.stage, "timesheet");
  assert.match(pp.action.text, /再提出を待っています/);
});
await ok("Phase 3 の表が未作成（db/105〜107 未適用）でも、Phase 2 の一覧は出す。phase3.ready=false と案内", async () => {
  for (const t of ["gw_timesheets", "gw_site_contract_terms"]) {
    P3(); db.missing = t;
    const r = await list("2026-09");
    assert.equal(r.statusCode, 200, t);
    assert.equal(r.body.rows.length, 2);
    assert.equal(r.body.phase3.ready, false);
    assert.match(r.body.phase3.message, /db\/10[567]_/);
    assert.equal(r.body.notReady, undefined);
    assert.equal(rowOf(r, "田中 太郎").cols.work.label, "確認済", "印だけの、従来の表示");
    assert.equal(rowOf(r, "田中 太郎").sheetInfo, null);
  }
});
await ok("一覧の応答に、置き場所・単価（仕入を含む）・精算条件・メモを含めない。金額は確定した行の売上だけ", async () => {
  P3();
  const text = JSON.stringify((await list("2026-09")).body);
  for (const w of ["storage_path", "t1/x", "purchase_unit_price", "3800", "sales_unit_price", "settlement_condition", "契約メモ", "人事メモ"]) {
    assert.ok(!text.includes(w), `${w} が一覧に入っている`);
  }
});

console.log("\n— 提出ファイルの閲覧 —");

const FILE = "11111111-1111-4111-8111-111111111111";
await ok("署名URL（5分）とファイル名だけを返し、置き場所は返さない。閲覧ログを残す", async () => {
  setup();
  const r = await file(FILE);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/storage\.example\//);
  assert.equal(r.body.filename, "田中_9月.pdf");
  assert.equal(r.body.expiresInSec, 300);
  // 署名付きURLには置き場所が含まれる（実際の Supabase もそう）。項目として返さないことを見る
  assert.deepEqual(Object.keys(r.body).sort(), ["expiresInSec", "filename", "url"], "storage_path などの項目を返していない");
  assert.deepEqual(signed[0], { bucket: "billing-submissions", path: "t1/e-pp/11111111.pdf", ttl: 300 });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "office.submission.view");
  assert.equal(logged[0].target, `submission:${FILE}`);
  assert.equal(logged[0].actorId, "u-1");
  assert.ok(!JSON.stringify(logged[0]).includes("token="), "ログに URL を入れない");
  assert.equal(r.headers["cache-control"], "no-store");
});
await ok("他社のファイル・存在しない id は 404、id の形が違えば 400、無ければ 400", async () => {
  setup();
  assert.equal((await file("22222222-2222-4222-8222-222222222222")).statusCode, 404, "他社");
  assert.equal((await file("33333333-3333-4333-8333-333333333333")).statusCode, 404, "無い");
  assert.equal((await file("not-a-uuid")).statusCode, 400);
  assert.equal((await call(fileApi, "/api/office/file")).statusCode, 400);
  assert.equal(signed.length, 0);
  assert.equal(logged.length, 0);
});
await ok("DB（RLS）が Office 権限を通さない状態では、ファイルも出さない（404）", async () => {
  setup(); who = MANAGER; db.policy100 = false;
  const r = await file(FILE);
  assert.equal(r.statusCode, 404);
  assert.equal(signed.length, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
