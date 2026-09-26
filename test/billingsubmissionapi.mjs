// 月初業務D1（外部提出フォーム）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 管理側：月初進捗一覧が、現場契約×進捗×窓口×届いたファイルを1行にまとめる
//   2. 管理側：窓口の発行・再発行（1人1本、古いトークンは無効になる）・無効化
//   3. 管理側：一般メンバーは使えない
//   4. 公開フォーム：無効・期限切れ・無効化されたトークンは、理由を問わず「使えません」
//   5. 公開フォーム：他人の現場契約IDを渡しても紐付けられない
//   6. 公開フォーム：届くと、既存の進捗（gw_billing_progress）の該当の印が立つ。
//      表がまだ無くても新しく作る
//   7. 公開フォームは gwContext を経由しない（未ログインの相手が使うため）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      if (op === "is") return v === null ? r[k] == null : r[k] === v;
      if (op === "lte") return r[k] <= v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : -1));
    return out;
  };
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    lte(k, v) { f.push(["lte", k, v]); return q; },
    order(col) { order = col; return q; },
    limit() { return q; },
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
        maybeSingle: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
        then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn),
      };
      return r2;
    },
    upsert(row, opts) {
      const conflict = (opts?.onConflict || "").split(",");
      const made = [].concat(row).map((r) => ({ id: r.id || `${name}-${(db.rows[name] || []).length + 1}`, ...r }));
      for (const m of made) {
        const hit = (db.rows[name] || []).find((x) => conflict.length && conflict.every((k) => x[k] === m[k]));
        if (hit) Object.assign(hit, m);
        else (db.rows[name] = db.rows[name] || []).push(m);
      }
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
        then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter((x) => g.every(([op, k, v]) => {
          if (op === "eq") return x[k] === v;
          if (op === "is") return v === null ? x[k] == null : x[k] === v;
          return true;
        }));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList
          ? { data: hit.map(copy), error: null }
          : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        then: (fn) => {
          const hit = new Set((db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v)).map((x) => x.id));
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.has(x.id));
          return Promise.resolve({ data: [], error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

const signedUploads = [];
const fakeStorage = { from: () => ({
  createSignedUploadUrl: (path) => {
    signedUploads.push(path);
    return Promise.resolve({ data: { signedUrl: `https://x/${path}`, token: "up-1" }, error: null });
  },
  createSignedUrl: (path) => Promise.resolve({ data: { signedUrl: `https://x/${path}?view` }, error: null }),
}) };

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: fakeStorage }),
    userClient: () => ({ from: table, storage: fakeStorage }),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, employee: { id: "emp-member", display_name: "現場 太郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = ADMIN;
let gwContextCalls = 0;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => { gwContextCalls++; return who; },
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
  },
});

const { default: adminApi } = await import(atRoot("api/billing-submission/index.js"));
const { default: publicApi } = await import(atRoot("api/billing-submission/public.js"));
const { default: fileApi } = await import(atRoot("api/billing-submission/file.js"));
const { sha256 } = await import(atRoot("lib/billing-submission.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getList = (month) => call(adminApi, { method: "GET", url: `/api/billing-submission?month=${month}` });
const issue = (employeeId) => call(adminApi, { method: "POST", url: "/api/billing-submission", body: { employeeId } });
const revoke = (employeeId) => call(adminApi, { method: "DELETE", url: `/api/billing-submission?employeeId=${employeeId}` });
const preview = (token) => call(publicApi, { method: "GET", url: `/api/billing-submission/public?token=${token}` });
const submit = (body) => call(publicApi, { method: "POST", url: "/api/billing-submission/public", body });
const getFile = (id) => call(fileApi, { method: "GET", url: `/api/billing-submission/file?id=${id}` });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  db.missing = null;
  signedUploads.length = 0;
  logged.length = 0;
  gwContextCalls = 0;
  db.rows = {
    gw_employees: [
      { id: "emp-member", tenant_id: "t1", display_name: "現場 太郎", department: "常駐部" },
    ],
    gw_site_contracts: [
      { id: "sc-1", tenant_id: "t1", employee_id: "emp-member", engagement_kind: "bp",
        site_company: "顧客A社", prime_company: null, period_from: "2026-01-01", period_to: null },
    ],
    gw_billing_progress: [],
    gw_submission_links: [],
    gw_submissions: [],
    tenants: [{ id: "t1", name: "株式会社エイト" }],
  };
}

console.log("\n=== 管理側：月初進捗一覧（api/billing-submission/index.js GET） ===\n");

await ok("今月動いている現場契約が1行ずつ出る", async () => {
  setup();
  const r = await getList("2026-09");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].employeeName, "現場 太郎");
  assert.equal(r.body.rows[0].siteCompany, "顧客A社");
  assert.equal(r.body.rows[0].linkStatus, "none");
  assert.equal(r.body.rows[0].timesheetReceived, false);
});

await ok("month が無ければ拒否", async () => {
  setup();
  const r = await call(adminApi, { method: "GET", url: "/api/billing-submission" });
  assert.equal(r.statusCode, 400);
});

await ok("契約期間が終わっていれば対象外", async () => {
  setup();
  db.rows.gw_site_contracts[0].period_to = "2026-08-31";
  const r = await getList("2026-09");
  assert.equal(r.body.rows.length, 0);
});

await ok("一般メンバーは使えない", async () => {
  setup();
  who = MEMBER;
  const r = await getList("2026-09");
  assert.equal(r.statusCode, 403);
});

console.log("\n=== 管理側：窓口の発行・再発行・無効化 ===\n");

await ok("発行すると、平文トークンが1度だけ返る", async () => {
  setup();
  const r = await issue("emp-member");
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.token);
  assert.equal(db.rows.gw_submission_links.length, 1);
  assert.notEqual(db.rows.gw_submission_links[0].token_hash, r.body.token, "DBに平文は無い");
});

await ok("現場契約が無い人には発行できない", async () => {
  setup();
  db.rows.gw_employees.push({ id: "emp-x", tenant_id: "t1", display_name: "契約無し" });
  const r = await issue("emp-x");
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_site_contract");
});

await ok("再発行すると、古いトークンは使えなくなる（1人1本）", async () => {
  setup();
  const r1 = await issue("emp-member");
  const r2 = await issue("emp-member");
  assert.equal(db.rows.gw_submission_links.length, 1, "1人1本のまま");
  assert.notEqual(r1.body.token, r2.body.token);
  const p1 = await preview(r1.body.token);
  assert.equal(p1.statusCode, 404, "古いトークンはもう使えない");
});

await ok("監査ログに発行・再発行が残る", async () => {
  setup();
  await issue("emp-member");
  assert.ok(logged.some((l) => l.action === "billing_submission.link_issue"));
});

await ok("無効化すると、以後は使えなくなる", async () => {
  setup();
  const r1 = await issue("emp-member");
  const rv = await revoke("emp-member");
  assert.equal(rv.statusCode, 200);
  const p = await preview(r1.body.token);
  assert.equal(p.statusCode, 404);
});

console.log("\n=== 公開フォーム：確認（api/billing-submission/public.js GET） ===\n");

await ok("有効なトークンなら、本人名・現場契約が見える", async () => {
  setup();
  const r1 = await issue("emp-member");
  const p = await preview(r1.body.token);
  assert.equal(p.statusCode, 200);
  assert.equal(p.body.displayName, "現場 太郎");
  assert.equal(p.body.contracts.length, 1);
  assert.equal(p.body.contracts[0].siteCompany, "顧客A社");
});

await ok("gwContext を使わない（未ログインの相手が使うため）", async () => {
  setup();
  const r1 = await issue("emp-member");
  const before = gwContextCalls;
  await preview(r1.body.token);
  assert.equal(gwContextCalls, before);
});

await ok("でたらめなトークンは 404（理由を教えない）", async () => {
  setup();
  const p = await preview("not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxx");
  assert.equal(p.statusCode, 404);
});

console.log("\n=== 公開フォーム：提出（api/billing-submission/public.js POST） ===\n");

const submitBody = (token, over = {}) => ({
  token, targetMonth: "2026-09", kind: "timesheet", siteContractId: "sc-1",
  filename: "202609.pdf", mimeType: "application/pdf", sizeBytes: 2048, ...over,
});

await ok("届くと、gw_submissions に1行できて、進捗の印が立つ", async () => {
  setup();
  const r1 = await issue("emp-member");
  const s = await submit(submitBody(r1.body.token));
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.ok(s.body.uploadUrl);
  assert.equal(db.rows.gw_submissions.length, 1);
  assert.equal(db.rows.gw_submissions[0].kind, "timesheet");

  const p = db.rows.gw_billing_progress.find((x) => x.employee_id === "emp-member" && x.billing_month === "2026-09");
  assert.ok(p, "進捗の行ができている");
  assert.equal(p.timesheet_received, true);
});

await ok("既にある進捗の行なら、新しく作らず印だけ立てる", async () => {
  setup();
  db.rows.gw_billing_progress.push({
    id: "bp-1", tenant_id: "t1", employee_id: "emp-member", site_contract_id: "sc-1",
    billing_month: "2026-09", timesheet_received: false, bp_invoice_received: false,
  });
  const r1 = await issue("emp-member");
  await submit(submitBody(r1.body.token));
  assert.equal(db.rows.gw_billing_progress.length, 1, "行は増えない");
  assert.equal(db.rows.gw_billing_progress[0].timesheet_received, true);
});

await ok("請求書は bp_invoice_received を立てる", async () => {
  setup();
  const r1 = await issue("emp-member");
  await submit(submitBody(r1.body.token, { kind: "invoice", filename: "invoice.pdf" }));
  const p = db.rows.gw_billing_progress[0];
  assert.equal(p.bp_invoice_received, true);
  // 偽のSupabaseは列の既定値(false)を持たないので、未設定＝立っていないことだけ見る。
  // 本物のDBでは db/077 の default false が入る
  assert.ok(!p.timesheet_received);
});

await ok("他人の現場契約IDを渡しても紐付けられない", async () => {
  setup();
  db.rows.gw_employees.push({ id: "emp-other", tenant_id: "t1", display_name: "別の人" });
  db.rows.gw_site_contracts.push({
    id: "sc-other", tenant_id: "t1", employee_id: "emp-other", engagement_kind: "bp",
    site_company: "別の現場", period_from: "2026-01-01", period_to: null,
  });
  const r1 = await issue("emp-member");
  const s = await submit(submitBody(r1.body.token, { siteContractId: "sc-other" }));
  assert.equal(s.statusCode, 400);
  assert.equal(s.body.error, "invalid_contract");
  assert.equal(db.rows.gw_submissions.length, 0);
});

await ok("無効化されたトークンでは送れない", async () => {
  setup();
  const r1 = await issue("emp-member");
  await revoke("emp-member");
  const s = await submit(submitBody(r1.body.token));
  assert.equal(s.statusCode, 404);
});

await ok("大きすぎるファイルは拒否", async () => {
  setup();
  const r1 = await issue("emp-member");
  const s = await submit(submitBody(r1.body.token, { sizeBytes: 999 * 1024 * 1024 }));
  assert.equal(s.statusCode, 400);
  assert.equal(db.rows.gw_submissions.length, 0);
});

console.log("\n=== 管理側：届いたファイルを見る（api/billing-submission/file.js） ===\n");

await ok("署名付きの閲覧URLが返る", async () => {
  setup();
  const r1 = await issue("emp-member");
  await submit(submitBody(r1.body.token));
  const id = db.rows.gw_submissions[0].id;
  const r = await getFile(id);
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.url);
});

await ok("一般メンバーは使えない", async () => {
  setup();
  const r1 = await issue("emp-member");
  await submit(submitBody(r1.body.token));
  const id = db.rows.gw_submissions[0].id;
  who = MEMBER;
  const r = await getFile(id);
  assert.equal(r.statusCode, 403);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
