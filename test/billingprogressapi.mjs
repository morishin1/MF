// 月次請求進捗（gw_billing_progress）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. その月・その契約の行を「用意する」と、無ければ作る
//   2. もう一度「用意する」を呼んでも、増えずに同じ行を返す（対象月×メンバー×契約で一意）
//   3. 1段だけ進める・戻すができ、他の段はそのまま
//   4. 一般メンバーは触れない
//   5. month（YYYY-MM）を指定しない一覧は拒否する
//   6. 077が未適用でも、一覧は落ちずに「まだ」と伝える
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };

// DBの列既定値（DEFAULT）を模す。本物は insert で渡さなかった列にもこれが入る
const DEFAULTS = {
  gw_billing_progress: {
    timesheet_received: false, timesheet_received_at: null,
    work_confirmed: false, work_confirmed_at: null,
    board_created: false, board_created_at: null,
    sent: false, sent_at: null,
    bp_invoice_received: false, bp_invoice_received_at: null,
    note: null,
  },
};

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) => {
    if (k.startsWith("!")) return r[k.slice(1)] !== v;
    return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
  }));
  const e = () => err(name);
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...(DEFAULTS[name] || {}), ...r }));
      if (!e()) {
        // 一意制約（employee_id, billing_month, site_contract_id）を模す
        const dup = (db.rows[name] || []).some((x) =>
          x.employee_id === made[0]?.employee_id && x.billing_month === made[0]?.billing_month
          && x.site_contract_id === made[0]?.site_contract_id);
        if (dup) {
          const r = { select: () => r,
                      single: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }) };
          return r;
        }
        (db.rows[name] = db.rows[name] || []).push(...made);
      }
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }) };
      return r;
    },
    update(patch) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        select: () => r,
        maybeSingle: () => {
          const hit = match(name, g);
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: copy(hit[0]) || null, error: null });
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
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
                 employee: { id: "emp-1", display_name: "山田 太郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
                employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = ADMIN;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});

const { default: bp } = await import(atRoot("api/billing-progress/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await bp({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const get = (qs = "") => call({ method: "GET", url: `/api/billing-progress${qs}` });
const post = (body) => call({ method: "POST", url: "/api/billing-progress", body });
const patch = (body) => call({ method: "PATCH", url: "/api/billing-progress", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  db.missing = null;
  db.rows = { gw_billing_progress: [] };
}

console.log("\n=== 月次請求進捗（gw_billing_progress） ===\n");

console.log("— 用意する（二重に作らない）—");

await ok("無ければ作る", async () => {
  setup();
  const r = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.created, true);
  assert.equal(r.body.progress.timesheet_received, false);
});

await ok("もう一度呼んでも、増えずに同じ行を返す", async () => {
  setup();
  const r1 = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  const r2 = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  assert.equal(r2.body.created, false);
  assert.equal(r2.body.progress.id, r1.body.progress.id);
  assert.equal(db.rows.gw_billing_progress.length, 1);
});

await ok("契約が違えば、別の行になる", async () => {
  setup();
  await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  const r = await post({ employeeId: "e1", siteContractId: "sc-2", billingMonth: "2026-09" });
  assert.equal(r.body.created, true);
  assert.equal(db.rows.gw_billing_progress.length, 2);
});

await ok("month の形がおかしければ拒否する", async () => {
  setup();
  const r = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026/09" });
  assert.equal(r.statusCode, 400);
});

await ok("一般メンバーは用意できない", async () => {
  setup();
  who = MEMBER;
  const r = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  assert.equal(r.statusCode, 403);
});

console.log("— 進める・戻す —");

await ok("1段だけ進む。他はそのまま", async () => {
  setup();
  const made = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  const r = await patch({ id: made.body.progress.id, stage: "timesheet_received", done: true });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.progress.timesheet_received, true);
  assert.ok(r.body.progress.timesheet_received_at);
  assert.equal(r.body.progress.work_confirmed, false);
});

await ok("戻すと、時刻も消える", async () => {
  setup();
  const made = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  await patch({ id: made.body.progress.id, stage: "timesheet_received", done: true });
  const r = await patch({ id: made.body.progress.id, stage: "timesheet_received", done: false });
  assert.equal(r.body.progress.timesheet_received, false);
  assert.equal(r.body.progress.timesheet_received_at, null);
});

await ok("決まった段以外は拒否する", async () => {
  setup();
  const made = await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  const r = await patch({ id: made.body.progress.id, stage: "invoice_paid", done: true });
  assert.equal(r.statusCode, 400);
});

console.log("— 一覧 —");

await ok("month を指定しないと拒否する", async () => {
  setup();
  const r = await get();
  assert.equal(r.statusCode, 400);
});

await ok("対象月で絞って一覧が取れる", async () => {
  setup();
  await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-09" });
  await post({ employeeId: "e1", siteContractId: "sc-1", billingMonth: "2026-10" });
  const r = await get("?month=2026-09");
  assert.equal(r.body.progress.length, 1);
  assert.equal(r.body.progress[0].billing_month, "2026-09");
});

await ok("表がまだ無くても、一覧は落ちない", async () => {
  setup();
  db.missing = "gw_billing_progress";
  const r = await get("?month=2026-09");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
