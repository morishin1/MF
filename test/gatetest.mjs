// 日報は「明日の3件を決めてから」。
//
// ■ 何を守るテストか
//
//   1. 明日ぶんが確定していないと、日報は出せない（理由も返る）
//   2. 確定していれば、これまでどおり出せる
//   3. 表がまだ無い環境（072 未適用）では止めない
//   4. 読み取りでも、今日の3件と明日の状態が返る
//   5. 日報（朝・夜）は、もう gw_action_items へ何も作らない。
//      gw_tasks/gw_focus_days が Single Source of Truth で、
//      同じ仕事が2つの表に生まれない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, missing: new Set() };

function table(name) {
  const f = [];
  const err = () => (db.missing.has(name)
    ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) =>
    (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq() { return q; }, in() { return q; }, is() { return q; }, not() { return q; },
    or() { return q; },
    gte() { return q; }, lte() { return q; }, lt() { return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: err() ? null : (rows()[0] || null), error: err() }),
    single: () => Promise.resolve({ data: err() ? null : (rows()[0] || null), error: err() }),
    then: (fn) => Promise.resolve({ data: err() ? null : rows(), error: err() }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: r.id || `${name}-${n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: made[0], error: err() }),
                  then: (fn) => Promise.resolve({ data: made, error: err() }).then(fn) };
      return r;
    },
    update(patch) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        select: () => r, single: () => Promise.resolve({ data: patch, error: null }),
        then: (fn) => {
          for (const x of (db.rows[name] || []).filter((y) => g.every(([k, v]) => y[k] === v))) {
            Object.assign(x, patch);
          }
          return Promise.resolve({ data: [patch], error: null }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({ tenantId: "t1", isAdmin: false, roles: [],
                              employee: { id: "emp-1", display_name: "山田 太郎", employment_type: "正社員" } }),
    canManageHr: () => false,
  },
});
// 日報の本筋ではないものは、動くだけの形にしておく
mock.module(atRoot("lib/actions.js"), {
  namedExports: {
    closeItems: async () => 0, shapeItem: (a) => a, ensureKpis: async () => {},
    shapeKpi: (k) => k, rankToday: (x) => x, nextWorkday: (d) => d,
    SOURCE_LABEL: {}, STATUS_LABEL: {}, kpiRate: () => 0,
  },
});
mock.module(atRoot("lib/nippo-eval.js"), {
  namedExports: {
    isConfigured: () => false, PROMPT_VERSION: "test",
    evaluateNippo: async () => ({}), SCHEMA: {},
  },
});

const { default: nippo } = await import(atRoot("api/nippo/index.js"));
const { nextFocusDate, jstToday } = await import(atRoot("lib/focus.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await nippo({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TODAY = jstToday();
const TOMORROW = nextFocusDate(TODAY);
const task = (id, over = {}) => ({
  id, tenant_id: "t1", assignee_id: "emp-1", focus_for: "emp-1", focus_date: TOMORROW,
  title: `やること${id}`, purpose: "売上のため", done_condition: "送付が完了している",
  due_on: TOMORROW, priority: "high", status: "todo", ...over,
});

function setup({ status = null, tasks = [], missing = [] } = {}) {
  db.missing = new Set(missing);
  db.rows = {
    gw_employees: [{ id: "emp-1", tenant_id: "t1", user_id: "u-1", display_name: "山田 太郎", status: "active" }],
    tc_nippo: [], tc_weekly_review: [], tc_thanks: [], tc_nippo_replies: [],
    gw_reminder_prefs: [{ employee_id: "emp-1", workdays: [1, 2, 3, 4, 5] }],
    gw_action_items: [], gw_daily_kpis: [], gw_nippo_ai_evals: [],
    gw_focus_days: status ? [{ id: "d1", tenant_id: "t1", employee_id: "emp-1",
                               focus_date: TOMORROW, status }] : [],
    gw_tasks: tasks,
  };
}
const body = (over = {}) => ({
  date: TODAY, workItems: [{ task: "A社へ提案", done: true }],
  tomorrow: "明日もやる", ...over,
});

console.log("\n=== 日報は、明日の3件を決めてから ===\n");

await ok("何も決めていなければ、出せない", async () => {
  setup();
  const r = await call({ method: "POST", url: "/api/nippo", body: body() });
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, "focus_required");
  assert.match(r.body.hint, /重要タスク/);
  assert.equal(r.body.focusDate, TOMORROW);
  assert.equal(db.rows.tc_nippo.length, 0, "日報が入ってしまっています");
});

await ok("3件そろっていても、確定していなければ出せない", async () => {
  setup({ status: "ai_checked", tasks: [task("t1"), task("t2"), task("t3")] });
  const r = await call({ method: "POST", url: "/api/nippo", body: body() });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "focus_required");
});

await ok("確定していれば、これまでどおり出せる", async () => {
  setup({ status: "confirmed", tasks: [task("t1"), task("t2"), task("t3")] });
  const r = await call({ method: "POST", url: "/api/nippo", body: body() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.tc_nippo.length, 1);
});

await ok("表がまだ無い環境では止めない（072 未適用）", async () => {
  setup({ missing: ["gw_focus_days"] });
  const r = await call({ method: "POST", url: "/api/nippo", body: body() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("タスクの表に列が無いときも止めない", async () => {
  setup({ missing: ["gw_tasks"] });
  const r = await call({ method: "POST", url: "/api/nippo", body: body() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

console.log("— 画面に渡すもの —");

await ok("今日の3件と、明日の状態が返る", async () => {
  setup({
    status: "confirmed",
    tasks: [
      task("t1", { focus_date: TODAY, status: "done" }),
      task("t2", { focus_date: TODAY }),
      task("t3"), task("t4"), task("t5"),
    ],
  });
  const r = await call({ method: "GET", url: `/api/nippo?date=${TODAY}` });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const f = r.body.focus;
  assert.ok(f, "focus が返っていません");
  assert.equal(f.today.length, 2);
  assert.equal(f.progress.label, "1 / 2");
  assert.equal(f.tomorrow.length, 3);
  assert.equal(f.state.confirmed, true);
  assert.equal(f.gate.open, true);
});

await ok("確定していなければ、開かない理由が返る", async () => {
  setup({ status: "draft", tasks: [task("t1")] });
  const r = await call({ method: "GET", url: `/api/nippo?date=${TODAY}` });
  assert.equal(r.body.focus.gate.open, false);
  assert.match(r.body.focus.gate.hint, /3件/);
});

await ok("表が無い環境では focus は null（画面はこれまでどおり）", async () => {
  setup({ missing: ["gw_focus_days"] });
  const r = await call({ method: "GET", url: `/api/nippo?date=${TODAY}` });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.focus, null);
});

console.log("\n=== 日報からは、もう gw_action_items を作らない（gw_tasksがSSOT） ===\n");

await ok("朝に最優先・やることを書いても、gw_action_items は増えない", async () => {
  setup();
  const r = await call({
    method: "POST", url: "/api/nippo",
    body: { kind: "morning", date: TODAY, topPriority: "C社見積を出す", actions: [{ task: "A社へ連絡" }] },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_action_items.length, 0, "朝の入力から作られてしまっています");
});

await ok("明日の3つ確定 → 日報送信 → 同じ仕事が二重生成されない", async () => {
  setup({ status: "confirmed", tasks: [task("t1"), task("t2"), task("t3")] });
  const r = await call({
    method: "POST", url: "/api/nippo",
    body: body({ tomorrow: "C社見積を出す", tomorrowDeadline: "明日中", doneActionIds: [] }),
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_action_items.length, 0, "日報から別系統のタスクが生まれてしまっています");
  assert.equal(r.body.actions.planned, undefined, "もう作らないので planned は返さない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
