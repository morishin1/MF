// 採用HR：応募者一覧の複数選択操作（api/hr/applicants/bulk.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか（採用HR応募者一覧・ドロワーUI改善指示書 §1・§2・§6）
//
//   1. ステータス変更・担当変更・削除ができる
//   2. 削除は選考終了（stage/status）とは別の操作。応募者レコードそのものを消す
//   3. 他テナントのid・存在しないidが混ざっても、実在＆自テナントの行だけを対象にする
//   4. 空のids・不正なactionは断る。一度に選べる件数には上限がある
//   5. recruiterロールだけの人も使える。一般メンバーは使えない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const copy = (r) => (r ? { ...r } : null);
const match = (g) => (x) => g.every(([op, k, v]) =>
  op === "eq" ? x[k] === v : (Array.isArray(v) ? v.includes(x[k]) : x[k] === v));

function table(name) {
  const q = {
    select() { return q; },
    eq(k, v) { fs.push(["eq", k, v]); return q; },
    in(k, v) { fs.push(["in", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        in: (k, v) => { g.push(["in", k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter(match(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        in: (k, v) => { g.push(["in", k, v]); return r2; },
        then: (fn) => {
          const all = db.rows[name] || [];
          const hit = all.filter(match(g));
          db.rows[name] = all.filter((x) => !hit.includes(x));
          return Promise.resolve({ data: hit.map(copy), error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  let fs = [];
  const rows = () => (db.rows[name] || []).filter(match(fs));
  return q;
}

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
// 判定は本物（lib/gw.js）を使う。テストで条件を書き直すと、本番とずれても気づけない
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
    canRecruit: REAL_GW.canRecruit,
    canDecideHire: REAL_GW.canDecideHire,
  },
});

const { default: bulk } = await import(atRoot("api/hr/applicants/bulk.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (body) => {
  const r = res();
  await bulk({ method: "POST", url: "/api/hr/applicants/bulk", headers: { authorization: "Bearer x" }, body }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = RECRUITER;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "山田 太郎", status: "todo", recruiter_id: null },
      { id: "a2", tenant_id: "t1", name: "佐藤 花子", status: "todo", recruiter_id: null },
      { id: "a3", tenant_id: "t2", name: "他社の応募者", status: "todo", recruiter_id: null }, // 他テナント
    ],
    gw_employees: [{ id: "emp-x", tenant_id: "t1", display_name: "面接 一郎", status: "active" }],
  };
}

console.log("\n=== ステータス変更（setStatus） ===\n");

await ok("選んだ全員のstatusが変わる", async () => {
  setup();
  const r = await call({ ids: ["a1", "a2"], action: "setStatus", status: "passed" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.updated, 2);
  assert.equal(db.rows.gw_hr_applicants.find((x) => x.id === "a1").status, "passed");
  assert.equal(db.rows.gw_hr_applicants.find((x) => x.id === "a2").status, "passed");
});

await ok("不正なstatusは断る", async () => {
  setup();
  const r = await call({ ids: ["a1"], action: "setStatus", status: "not_a_status" });
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_hr_applicants.find((x) => x.id === "a1").status, "todo", "変わっていない");
});

await ok("監査ログに件数が残る", async () => {
  setup();
  await call({ ids: ["a1", "a2"], action: "setStatus", status: "passed" });
  const l = logged.find((x) => x.action === "hr.applicant_bulk_status");
  assert.ok(l);
  assert.equal(l.detail.count, 2);
});

console.log("\n=== 担当変更（setRecruiter） ===\n");

await ok("選んだ全員のrecruiter_idが変わる", async () => {
  setup();
  const r = await call({ ids: ["a1", "a2"], action: "setRecruiter", recruiterId: "emp-x" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_applicants.find((x) => x.id === "a1").recruiter_id, "emp-x");
});

await ok("空にすると「未定」に戻せる", async () => {
  setup();
  db.rows.gw_hr_applicants.find((x) => x.id === "a1").recruiter_id = "emp-x";
  const r = await call({ ids: ["a1"], action: "setRecruiter", recruiterId: "" });
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_hr_applicants.find((x) => x.id === "a1").recruiter_id, null);
});

console.log("\n=== 削除（delete。選考終了とは別の操作） ===\n");

await ok("選んだ応募者が削除される", async () => {
  setup();
  const r = await call({ ids: ["a1"], action: "delete" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted, 1);
  assert.ok(!db.rows.gw_hr_applicants.some((x) => x.id === "a1"));
  assert.ok(db.rows.gw_hr_applicants.some((x) => x.id === "a2"), "選んでいない人は残る");
});

await ok("複数選択でも人数どおり削除される", async () => {
  setup();
  const r = await call({ ids: ["a1", "a2"], action: "delete" });
  assert.equal(r.body.deleted, 2);
  assert.equal(db.rows.gw_hr_applicants.filter((x) => x.tenant_id === "t1").length, 0);
});

await ok("監査ログに削除した人数・名前が残る", async () => {
  setup();
  await call({ ids: ["a1", "a2"], action: "delete" });
  const l = logged.find((x) => x.action === "hr.applicant_delete");
  assert.ok(l);
  assert.equal(l.detail.count, 2);
  assert.deepEqual(l.detail.names.sort(), ["佐藤 花子", "山田 太郎"]);
});

console.log("\n=== 安全対策 ===\n");

await ok("他テナントのidは対象にならない", async () => {
  setup();
  const r = await call({ ids: ["a3"], action: "delete" });
  assert.equal(r.statusCode, 404);
  assert.ok(db.rows.gw_hr_applicants.some((x) => x.id === "a3"), "他社の応募者は消えない");
});

await ok("idsが空なら断る", async () => {
  setup();
  const r = await call({ ids: [], action: "delete" });
  assert.equal(r.statusCode, 400);
});

await ok("一度に選べる件数には上限がある", async () => {
  setup();
  const many = Array.from({ length: 201 }, (_, i) => `id-${i}`);
  const r = await call({ ids: many, action: "delete" });
  assert.equal(r.statusCode, 400);
});

await ok("知らないactionは断る", async () => {
  setup();
  const r = await call({ ids: ["a1"], action: "archive" });
  assert.equal(r.statusCode, 400);
});

console.log("\n=== 誰が触れるか（既存HR権限設計に従う） ===\n");

await ok("recruiterロールは使える", async () => {
  setup();
  who = RECRUITER;
  const r = await call({ ids: ["a1"], action: "delete" });
  assert.equal(r.statusCode, 200);
});

await ok("一般メンバーは使えない", async () => {
  setup();
  who = MEMBER;
  const r = await call({ ids: ["a1"], action: "delete" });
  assert.equal(r.statusCode, 403);
  assert.ok(db.rows.gw_hr_applicants.some((x) => x.id === "a1"), "消えていない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
