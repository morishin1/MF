// 採用HR Stage 5：合格通知作成（api/hr/offers/index.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 作成すると、応募者の現在の採用条件がスナップショットされ、応募者の状態が
//      「社内確認待ち」へ進む（1応募者につき1回だけ。offer_draft_pending以外からは作れない）
//   2. 回答期限は必須。渡さなければ断る
//   3. 社内確認待ちの間だけ、内容を直せる（PATCH update）
//   4. 確定すると、応募者の状態が「本人送付待ち」へ進む（PATCH confirm）
//   5. 版（version）は応募者ごとに1から積み上がる
//   6. token・token_hashは作成時に必ず入るが、平文tokenはどこにも返さない
//      （本人への実際の送付・専用URL発行はStage 6）
//   7. recruiterロールだけの人も使える。一般メンバーは使えない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "neq") return r[k] !== v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : a[order] > b[order] ? -1 : 0));
    return out;
  };
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
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
        then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
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
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "emp-r1", display_name: "採用 花子" } };
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "emp-m1", display_name: "一般 次郎" } };
let who = RECRUITER;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canRecruit: (c) => Boolean(c?.isAdmin || c?.isHr || (c?.roles || []).includes("recruiter")),
  },
});

const { default: offers } = await import(atRoot("api/hr/offers/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const create = (body) => call(offers, { method: "POST", url: "/api/hr/offers", body });
const act = (body) => call(offers, { method: "PATCH", url: "/api/hr/offers", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = RECRUITER;
  db.missing = null;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [{
      id: "a1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", source: "リファラル",
      stage: "offer", status: "offer_draft_pending", rank: "A", decision: "hired", decision_due_on: null,
      employment_type: "正社員", contract_type: "無期", contract_end_date: null, join_date: "2026-11-01",
      probation_months: 3, wage_type: "月給", wage_amount: 400000, weekly_hours: 40, work_location: "東京",
      recruiter_id: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z",
    }],
    gw_hr_offers: [], gw_hr_timeline: [],
  };
}

console.log("\n=== 合格通知を作成する（POST /api/hr/offers） ===\n");

await ok("作成すると、応募者の採用条件がスナップショットされる", async () => {
  setup();
  const r = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.offer.employmentType, "正社員");
  assert.equal(r.body.offer.joinDate, "2026-11-01");
  assert.equal(r.body.offer.wageAmount, 400000);
  assert.equal(r.body.offer.version, 1);
  assert.equal(r.body.offer.respondBy, "2026-10-15");
});

await ok("応募者の状態が「社内確認待ち」へ進む", async () => {
  setup();
  await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.equal(db.rows.gw_hr_applicants[0].status, "offer_review_pending");
});

await ok("渡した項目は、応募者の現在値を上書きする", async () => {
  setup();
  const r = await create({ applicantId: "a1", respondBy: "2026-10-15", wageAmount: 450000 });
  assert.equal(r.body.offer.wageAmount, 450000);
});

await ok("選考タイムラインに残る", async () => {
  setup();
  await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "offer_drafted"));
});

await ok("監査ログに残る", async () => {
  setup();
  await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.ok(logged.some((l) => l.action === "hr.offer_create"));
});

await ok("token_hashは必ず入るが、平文tokenはどこにも返さない", async () => {
  setup();
  const r = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.ok(db.rows.gw_hr_offers[0].token_hash, "token_hashが保存される");
  assert.equal(JSON.stringify(r.body).includes(db.rows.gw_hr_offers[0].token_hash), false, "token_hash自体もレスポンスに出さない");
  const keys = Object.keys(r.body.offer);
  assert.ok(!keys.some((k) => /token/i.test(k)), "token関連のキーがレスポンスに無い");
});

await ok("回答期限が無ければ断る", async () => {
  setup();
  const r = await create({ applicantId: "a1" });
  assert.equal(r.statusCode, 400);
});

await ok("offer_draft_pending以外からは作れない", async () => {
  setup();
  db.rows.gw_hr_applicants[0].status = "ceo_decision_pending";
  const r = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.equal(r.statusCode, 409);
});

await ok("応募者がいなければ404", async () => {
  setup();
  const r = await create({ applicantId: "not-exists", respondBy: "2026-10-15" });
  assert.equal(r.statusCode, 404);
});

await ok("2回目は版（version）が積み上がる", async () => {
  setup();
  await create({ applicantId: "a1", respondBy: "2026-10-15" });
  db.rows.gw_hr_applicants[0].status = "offer_draft_pending";
  const r = await create({ applicantId: "a1", respondBy: "2026-10-20" });
  assert.equal(r.body.offer.version, 2);
});

console.log("\n=== 社内確認待ちの間に、内容を直す（PATCH update） ===\n");

await ok("内容を直せる", async () => {
  setup();
  const c = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  const r = await act({ id: c.body.offer.id, action: "update", wageAmount: 420000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.offer.wageAmount, 420000);
});

await ok("社内確認待ちでなければ直せない（確定後・作成前）", async () => {
  setup();
  const c = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  db.rows.gw_hr_applicants[0].status = "offer_send_pending";
  const r = await act({ id: c.body.offer.id, action: "update", wageAmount: 420000 });
  assert.equal(r.statusCode, 409);
});

await ok("更新する項目が無ければ断る", async () => {
  setup();
  const c = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  const r = await act({ id: c.body.offer.id, action: "update" });
  assert.equal(r.statusCode, 400);
});

console.log("\n=== 内容を確定する（PATCH confirm） ===\n");

await ok("確定すると、応募者の状態が「本人送付待ち」へ進む", async () => {
  setup();
  const c = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  const r = await act({ id: c.body.offer.id, action: "confirm" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "offer_send_pending");
  assert.equal(db.rows.gw_hr_applicants[0].status, "offer_send_pending");
});

await ok("選考タイムラインに残る", async () => {
  setup();
  const c = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  await act({ id: c.body.offer.id, action: "confirm" });
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "offer_confirmed"));
});

await ok("社内確認待ちでなければ確定できない（二重確定を防ぐ）", async () => {
  setup();
  const c = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  await act({ id: c.body.offer.id, action: "confirm" });
  const r = await act({ id: c.body.offer.id, action: "confirm" });
  assert.equal(r.statusCode, 409);
});

await ok("合格通知が無ければ404", async () => {
  setup();
  const r = await act({ id: "not-exists", action: "confirm" });
  assert.equal(r.statusCode, 404);
});

console.log("\n=== 誰が触れるか ===\n");

await ok("一般メンバーは使えない", async () => {
  setup();
  who = MEMBER;
  const r = await create({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.equal(r.statusCode, 403);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
