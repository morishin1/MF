// 管理者ダッシュボード：人ごとの今日3つ・完了数・期限超過・契約更新待ち。
//
// ■ 何を守るテストか
//
//   1. 期限超過・契約更新待ちは、人ごとに正しく数える
//   2. 今日の重要タスクは、focus_for で人ごとに束ね、3件まで
//   3. 担当が付いていないタスクは「未担当」にまとめて出す（黙って消えない）
//   4. 繰り返しの「元」（is_template）は数えない
//   5. 一般メンバーは開けない
//   6. 068・072が未適用でも、落ちずに出す
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, missingCols: new Set() };

const colErr = (spec) => {
  for (const c of db.missingCols) {
    if (String(spec || "").includes(c)) return { code: "42703", message: `column does not exist: ${c}` };
  }
  return null;
};

function table(name) {
  const f = [];
  let selectSpec = "";
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
    if (op === "gte") return String(r[k] ?? "") >= String(v);
    return true;
  }));
  const filterCols = () => f.map(([, k]) => k).join(",");
  const e = () => colErr(selectSpec) || colErr(filterCols());
  const q = {
    select(spec) { selectSpec = spec || ""; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    then: (fn) => Promise.resolve({ data: e() ? null : rows(), error: e() }).then(fn),
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false,
                 employee: { id: "emp-1", display_name: "山田 太郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true,
                employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = ADMIN;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});
mock.module(atRoot("lib/devices.js"), { namedExports: { jstDate: () => "2026-09-17" } });

const { default: team } = await import(atRoot("api/dashboard/team.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async () => {
  const r = res();
  await team({ method: "GET", url: "/api/dashboard/team", headers: { authorization: "Bearer x" } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  db.missingCols = new Set();
  db.rows = {
    gw_employees: [
      { id: "e1", tenant_id: "t1", display_name: "山田 太郎", status: "active" },
      { id: "e2", tenant_id: "t1", display_name: "鈴木 花子", status: "active" },
    ],
    gw_tasks: [
      // e1: 期限超過1件、契約更新待ち1件
      { id: "t1", tenant_id: "t1", assignee_id: "e1", status: "todo", due_on: "2026-09-10",
        category: "一般", is_template: false },
      { id: "t2", tenant_id: "t1", assignee_id: "e1", status: "todo", due_on: null,
        category: "契約更新", is_template: false },
      // e2: 期限内（超過ではない）
      { id: "t3", tenant_id: "t1", assignee_id: "e2", status: "doing", due_on: "2026-09-20",
        category: "一般", is_template: false },
      // 繰り返しの元。数えない
      { id: "t4", tenant_id: "t1", assignee_id: "e1", status: "todo", due_on: "2026-09-01",
        category: "一般", is_template: true },
      // 担当なし（cron発の端末未登録タスク等）
      { id: "t5", tenant_id: "t1", assignee_id: null, status: "todo", due_on: "2026-09-01",
        category: "端末管理", is_template: false },
      // 今日完了
      { id: "t6", tenant_id: "t1", assignee_id: "e2", status: "done",
        completed_at: "2026-09-17T01:00:00Z", is_template: false },
      // 昨日完了（今日には数えない）
      { id: "t7", tenant_id: "t1", assignee_id: "e2", status: "done",
        completed_at: "2026-09-15T01:00:00Z", is_template: false },
      // 今日の重要タスク（focus）
      { id: "f1", tenant_id: "t1", focus_for: "e1", focus_date: "2026-09-17", focus_rank: 1,
        title: "見積を出す", status: "todo" },
      { id: "f2", tenant_id: "t1", focus_for: "e1", focus_date: "2026-09-17", focus_rank: 2,
        title: "面談準備", status: "done" },
    ],
  };
}

console.log("\n=== 管理者ダッシュボード：チーム（今日3つ・完了・期限超過・契約更新待ち） ===\n");

await ok("期限超過・契約更新待ちを人ごとに数える", async () => {
  setup();
  const r = await call();
  assert.equal(r.statusCode, 200);
  const e1 = r.body.team.find((t) => t.employeeId === "e1");
  assert.equal(e1.overdue, 1);
  assert.equal(e1.renewalPending, 1);
});

await ok("繰り返しの元（is_template）は数えない", async () => {
  setup();
  const r = await call();
  const e1 = r.body.team.find((t) => t.employeeId === "e1");
  // t4 は期限超過っぽい日付だが is_template のため数えない → t1 の1件だけ
  assert.equal(e1.overdue, 1);
});

await ok("今日の重要タスクは、focus_for で束ねて3件まで", async () => {
  setup();
  const r = await call();
  const e1 = r.body.team.find((t) => t.employeeId === "e1");
  assert.equal(e1.today.length, 2);
  assert.equal(e1.today[0].title, "見積を出す");
  assert.equal(e1.today[1].done, true);
});

await ok("今日の完了数は、今日ぶんだけ数える", async () => {
  setup();
  const r = await call();
  const e2 = r.body.team.find((t) => t.employeeId === "e2");
  assert.equal(e2.doneToday, 1);
});

await ok("担当が付いていないタスクは「未担当」にまとまる。黙って消えない", async () => {
  setup();
  const r = await call();
  assert.ok(r.body.unassigned);
  assert.equal(r.body.unassigned.overdue, 1);
  assert.equal(r.body.team.some((t) => t.employeeId === "unassigned"), false);
});

await ok("何も無い人は、未担当にも出さない", async () => {
  setup();
  db.rows.gw_tasks = db.rows.gw_tasks.filter((t) => t.assignee_id !== null);
  const r = await call();
  assert.equal(r.body.unassigned, null);
});

await ok("一般メンバーは開けない", async () => {
  setup();
  who = MEMBER;
  const r = await call();
  assert.equal(r.statusCode, 403);
});

await ok("068未適用（is_template が無い）でも、落ちずに空で返す", async () => {
  setup();
  db.missingCols = new Set(["is_template"]);
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

await ok("072未適用（focus_date が無い）でも、今日の3つだけ空にして他は出す", async () => {
  setup();
  db.missingCols = new Set(["focus_date"]);
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.focusReady, false);
  const e1 = r.body.team.find((t) => t.employeeId === "e1");
  assert.equal(e1.today.length, 0);
  assert.equal(e1.overdue, 1, "他の数はちゃんと出る");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
