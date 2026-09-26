// 採用HR：応募者管理（api/hr/applicants/index.js・detail.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 応募者を追加すると、行ができて選考タイムラインに「応募」が残る
//   2. 一覧には、担当者名・面談件数がつく
//   3. recruiterロールだけの人も使える。一般メンバーは使えない
//   4. 更新は渡した項目だけ変わる。ステージが動いたときだけタイムラインに足す
//   5. 表がまだ無い環境では落ちない
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
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
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
    order(col, opts) { order = col; return q; },
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
const HR = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], employee: { id: "emp-hr", display_name: "人事 太郎" } };
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "emp-m1", display_name: "一般 次郎" } };
let who = RECRUITER;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
    canRecruit: (c) => Boolean(c?.isAdmin || c?.isHr || (c?.roles || []).includes("recruiter")),
    canDecideHire: (c) => Boolean(c?.isAdmin || (c?.roles || []).includes("owner")),
  },
});

const { default: applicants } = await import(atRoot("api/hr/applicants/index.js"));
const { default: detail } = await import(atRoot("api/hr/applicants/detail.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const list = () => call(applicants, { method: "GET", url: "/api/hr/applicants" });
const create = (body) => call(applicants, { method: "POST", url: "/api/hr/applicants", body });
const getOne = (id) => call(detail, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const patch = (body) => call(detail, { method: "PATCH", url: "/api/hr/applicants/detail", body });

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
    gw_hr_applicants: [], gw_hr_interviews: [], gw_hr_timeline: [], gw_hr_offers: [], gw_employees: [],
  };
}
const body = (over = {}) => ({ name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル", ...over });

console.log("\n=== 応募者を追加（POST /api/hr/applicants） ===\n");

await ok("追加すると、行ができて選考タイムラインに「応募」が残る", async () => {
  setup();
  const r = await create(body());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.applicant.name, "山田 太郎");
  // 偽のSupabaseは列の既定値(default 'applied')を持たないので、
  // ここでは insert に stage を渡していないことだけを見る（実DBはdb/081のdefaultが入る）
  assert.equal(db.rows.gw_hr_applicants[0].stage, undefined, "stageは渡していない（DBのdefaultに任せる）");
  assert.equal(db.rows.gw_hr_timeline.length, 1);
  assert.equal(db.rows.gw_hr_timeline[0].event_key, "applied");
});

await ok("監査ログに hr.applicant_create が残る", async () => {
  setup();
  await create(body());
  assert.ok(logged.some((l) => l.action === "hr.applicant_create"));
});

await ok("氏名が無ければ拒否", async () => {
  setup();
  const r = await create(body({ name: "" }));
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_hr_applicants.length, 0);
});

await ok("hrロールでも使える", async () => {
  setup();
  who = HR;
  const r = await create(body());
  assert.equal(r.statusCode, 200);
});

await ok("一般メンバーは使えない", async () => {
  setup();
  who = MEMBER;
  const r = await create(body());
  assert.equal(r.statusCode, 403);
});

console.log("\n=== 一覧（GET /api/hr/applicants） ===\n");

await ok("担当者名・面談件数がつく", async () => {
  setup();
  db.rows.gw_employees.push({ id: "emp-r1", display_name: "採用 花子" });
  const created = await create(body({ recruiterId: "emp-r1" }));
  db.rows.gw_hr_interviews.push({ id: "iv1", applicant_id: created.body.applicant.id, kind: "casual" });
  const r = await list();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applicants[0].recruiterName, "採用 花子");
  assert.equal(r.body.applicants[0].interviewCount, 1);
});

await ok("一般メンバーは一覧も見えない", async () => {
  setup();
  who = MEMBER;
  const r = await list();
  assert.equal(r.statusCode, 403);
});

await ok("表がまだ無い環境では、一覧は落ちずに「まだ」と伝える", async () => {
  setup();
  db.missing = "gw_hr_applicants";
  const r = await list();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log("\n=== 詳細・更新（api/hr/applicants/detail.js） ===\n");

await ok("詳細に面談・タイムライン・合格通知がつく", async () => {
  setup();
  const created = await create(body());
  const r = await getOne(created.body.applicant.id);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applicant.name, "山田 太郎");
  assert.equal(r.body.timeline.length, 1);
  assert.deepEqual(r.body.interviews, []);
  assert.deepEqual(r.body.offers, []);
});

await ok("更新は渡した項目だけ変わる", async () => {
  setup();
  const created = await create(body());
  const r = await patch({ id: created.body.applicant.id, note: "電話で一次連絡済み" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applicant.note, "電話で一次連絡済み");
  assert.equal(r.body.applicant.name, "山田 太郎", "他の項目は変わらない");
});

await ok("ステージが動いたときだけ、タイムラインに足す", async () => {
  setup();
  const created = await create(body());
  await patch({ id: created.body.applicant.id, note: "メモだけ" });
  assert.equal(db.rows.gw_hr_timeline.length, 1, "メモだけでは増えない");

  await patch({ id: created.body.applicant.id, stage: "casual_interview" });
  assert.equal(db.rows.gw_hr_timeline.length, 2, "ステージが動いたら増える");
  assert.equal(db.rows.gw_hr_timeline[1].event_key, "stage_casual_interview");
});

await ok("無い応募者IDは404", async () => {
  setup();
  const r = await getOne("not-exists");
  assert.equal(r.statusCode, 404);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
