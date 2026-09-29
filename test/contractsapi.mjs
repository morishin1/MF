// 契約（api/contracts/index.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか（GW「契約締結×キャリア設定」完了状態 §9・§20-11・§20-13）
//
//   1. draft の契約は、これまでどおり自由に直せる
//   2. active（締結済み）の契約は、直接の上書きができない（correction が無ければ断る）
//   3. correction:true + reason を付けたときだけ「登録情報の訂正」として直せる
//   4. 訂正は変更前・変更後・理由が監査ログに残る
//   5. superseded の契約も同じく直接は上書きできない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB ----------------------------------------------------------------
const db = { rows: {} };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return v.includes(r[k]);
    if (op === "neq") return r[k] !== v;
    return true;
  });
}
function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? "") < (b[col] ?? "") ? (asc ? -1 : 1) : (a[col] ?? "") > (b[col] ?? "") ? (asc ? 1 : -1) : 0));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }) };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply(),
        single: () => apply(),
        then: (fn, rej) => apply().then(fn, rej),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-admin" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
const REAL_GW = await import(atRoot("lib/gw.js"));
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: { id: "e-admin" } };
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => ADMIN } });
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

const { default: contracts } = await import(atRoot("api/contracts/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await contracts({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const post = (body) => call({ method: "POST", url: "/api/contracts", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup(status, over = {}) {
  logged.length = 0;
  db.rows = {
    gw_contracts: [{
      id: "k1", tenant_id: "t1", employee_id: "emp-1", status,
      contract_type: "契約社員", period_from: "2026-01-01", period_to: "2026-12-31",
      wage_type: "時給", wage_amount: 1200, work_hours: "9-18",
      probation_months: null, renewable: null, renewal_criteria: null,
      work_days: null, work_place: null, job_content: null, wage_note: null,
      document_type: null, training_months: null, weekly_hours: null,
      remote_ok: null, work_scope: [], scope_change: null, training_programs: [],
      training_review_note: null, fixed_term: true,
      renewal_notice_days: 30, note: null,
      ...over,
    }],
  };
}

console.log("\n=== draft の契約は自由に直せる ===\n");

await ok("draft はそのまま更新できる（理由なしでよい）", async () => {
  setup("draft");
  const r = await post({ action: "update", id: "k1", contract: { wage_amount: 1300 } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_contracts[0].wage_amount, 1300);
  assert.equal(logged.length, 0, "draftの直しでは訂正ログを残さない");
});

console.log("\n=== active（締結済み）の契約は、直接は上書きできない（§9） ===\n");

await ok("correction を付けずに直そうとすると断る", async () => {
  setup("active");
  const r = await post({ action: "update", id: "k1", contract: { wage_amount: 1300 } });
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "signed_contract_locked");
  assert.equal(db.rows.gw_contracts[0].wage_amount, 1200, "変わっていない");
});

await ok("correction:true だけで reason が無ければ断る", async () => {
  setup("active");
  const r = await post({ action: "update", id: "k1", correction: true, contract: { wage_amount: 1300 } });
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_contracts[0].wage_amount, 1200);
});

// 訂正のテストは、実際の登録値と同じ完全なフォームを送る（送っていない項目は
// normalize() で null にされてしまうため、意図しない項目まで変わって見えるのを防ぐ）
const FULL = {
  contract_type: "契約社員", fixed_term: true, period_from: "2026-01-01", period_to: "2026-12-31",
  wage_type: "時給", wage_amount: 1200, work_hours: "9-18",
};

await ok("correction:true + reason があれば「登録情報の訂正」として直せる", async () => {
  setup("active");
  const r = await post({
    action: "update", id: "k1", correction: true, reason: "登録時の入力ミス。実際は12/24までの契約",
    contract: { ...FULL, period_to: "2026-12-24" },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_contracts[0].period_to, "2026-12-24");
});

await ok("訂正は、変更前・変更後・理由・操作者・操作日時が監査ログに残る", async () => {
  setup("active");
  await post({
    action: "update", id: "k1", correction: true, reason: "登録時の入力ミス",
    contract: { ...FULL, period_to: "2026-12-24" },
  });
  assert.equal(logged.length, 1);
  const e = logged[0];
  assert.equal(e.action, "contract.correct");
  assert.equal(e.target, "employee:emp-1");
  assert.equal(e.actorId, "u-admin");
  assert.equal(e.detail.reason, "登録時の入力ミス");
  assert.deepEqual(e.detail.changes, [{ field: "period_to", before: "2026-12-31", after: "2026-12-24" }]);
});

await ok("何も変わっていない訂正は断る", async () => {
  setup("active");
  const r = await post({ action: "update", id: "k1", correction: true, reason: "念のため", contract: FULL });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_changes");
});

console.log("\n=== superseded の契約も、直接は上書きできない ===\n");

await ok("superseded も correction が無ければ断る", async () => {
  setup("superseded");
  const r = await post({ action: "update", id: "k1", contract: { wage_amount: 1300 } });
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_contracts[0].wage_amount, 1200);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
