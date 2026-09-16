// とりあえずメモのAPIを、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 誰でも自分のぶんに1行足せる。期日・担当は要らない
//   2. gw_tasks には触れない（決めるまでは）
//   3. AIは案を置くだけ。ai_decision があっても、それだけでは何も動かない
//   4. task/hand を選んだときだけ gw_tasks に1行できる。self/drop は作らない
//   5. 他人のぶんを決められるのは管理者・人事だけ
//   6. 決めたあとは、もう一度 decide できない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
// 本物のDBが列の default で埋める値。偽物は insert 時に何も埋めないので、
// テストが見たい既定値はここに書く（focusapi.mjs と同じやり方）
const DEFAULTS = {
  gw_quick_memos: { status: "open" },
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
    neq(k, v) { f.push(["!" + k, v]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        ...(DEFAULTS[name] || {}),
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
                  maybeSingle: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
                  then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn) };
      return r;
    },
    update(patch) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        select: () => r,
        single: () => {
          const hit = match(name, g);
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: copy(hit[0]), error: null });
        },
        maybeSingle: () => r.single(),
        then: (fn) => {
          const hit = match(name, g);
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: hit.map(copy), error: null }).then(fn);
        },
      };
      return r;
    },
    delete() {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        then: (fn) => {
          const hit = new Set(match(name, g).map((x) => x.id));
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.has(x.id));
          return Promise.resolve({ data: [], error: null }).then(fn);
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
let who = MEMBER;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});
const notified = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (n) => { notified.push(...n); return { created: n.length }; } },
});

let aiOn = true;
let aiOut = { items: [{ index: 0, decision: "task", reason: "内容が明確です" }] };
mock.module(atRoot("lib/task-ai.js"), {
  namedExports: { aiConfigured: () => aiOn, reviewMemos: async () => aiOut },
});

const { default: memo } = await import(atRoot("api/tasks/memo.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await memo({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = (qs = "") => call({ method: "GET", url: `/api/tasks/memo${qs}` });
const post = (body) => call({ method: "POST", url: "/api/tasks/memo", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  notified.length = 0;
  who = MEMBER;
  db.missing = null;
  aiOn = true;
  aiOut = { items: [{ index: 0, decision: "task", reason: "内容が明確です" }] };
  db.rows = {
    gw_employees: [
      { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", status: "active", user_id: "u-1" },
      { id: "emp-2", tenant_id: "t1", display_name: "鈴木 次郎", status: "active", user_id: "u-2" },
    ],
    gw_quick_memos: [], gw_tasks: [],
  };
}
const mineOf = () => (db.rows.gw_quick_memos || []).filter((m) => m.employee_id === "emp-1");

console.log("\n=== とりあえずメモ API ===\n");

console.log("— 書く —");

await ok("1行足せる。期日・担当は要らない", async () => {
  setup();
  const r = await post({ action: "add", body: "A社へ見積を送る" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.memo.body, "A社へ見積を送る");
  assert.equal(r.body.memo.status, "open");
  assert.equal(mineOf().length, 1);
});

await ok("空では書けない", async () => {
  setup();
  const r = await post({ action: "add", body: "   " });
  assert.equal(r.statusCode, 400);
});

await ok("gw_tasks には触れない（決めるまで）", async () => {
  setup();
  await post({ action: "add", body: "見積確認" });
  assert.equal((db.rows.gw_tasks || []).length, 0);
});

await ok("表がまだ無くても、エラーにしない", async () => {
  setup();
  db.missing = "gw_quick_memos";
  const r = await get();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log("— 一覧 —");

await ok("自分の未決定ぶんだけ出る", async () => {
  setup();
  await post({ action: "add", body: "1件目" });
  await post({ action: "add", body: "2件目" });
  const r = await get();
  assert.equal(r.body.memos.length, 2);
});

await ok("他人のぶんは、指定しても本人以外は見えない（管理者以外）", async () => {
  setup();
  db.rows.gw_quick_memos = [{ id: "m1", tenant_id: "t1", employee_id: "emp-2",
    body: "他人のメモ", status: "open", created_at: "2026-09-16T00:00:00Z" }];
  const r = await get("?employeeId=emp-2");
  assert.equal(r.statusCode, 403);
});

console.log("— 取り消す —");

await ok("決める前なら、本人が取り消せる", async () => {
  setup();
  const add = await post({ action: "add", body: "消すやつ" });
  const r = await post({ action: "remove", id: add.body.memo.id });
  assert.equal(r.statusCode, 200);
  assert.equal(mineOf().length, 0);
});

console.log("— AIに見てもらう —");

await ok("案を置くだけ。ai_decision があっても状態は open のまま", async () => {
  setup();
  await post({ action: "add", body: "A社へ見積を送る" });
  const r = await post({ action: "review" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.memos[0].aiDecision, "task");
  assert.equal(r.body.memos[0].aiReason, "内容が明確です");
  assert.equal(r.body.memos[0].status, "open", "案が付いただけでは決まらない");
});

await ok("AIの鍵が無い環境では、そのまま拒否する", async () => {
  setup();
  aiOn = false;
  await post({ action: "add", body: "x" });
  const r = await post({ action: "review" });
  assert.equal(r.statusCode, 503);
});

console.log("— 人が決める —");

await ok("task：タスクが1件できる。担当は本人", async () => {
  setup();
  const add = await post({ action: "add", body: "A社へ見積を送る" });
  const r = await post({ action: "decide", id: add.body.memo.id, decision: "task" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.memo.status, "decided");
  assert.equal(r.body.memo.decision, "task");
  assert.ok(r.body.memo.promotedTaskId);
  const t = db.rows.gw_tasks.find((x) => x.id === r.body.memo.promotedTaskId);
  assert.equal(t.title, "A社へ見積を送る");
  assert.equal(t.assignee_id, "emp-1");
});

await ok("hand：相手を指定しないと拒否する", async () => {
  setup();
  const add = await post({ action: "add", body: "x" });
  const r = await post({ action: "decide", id: add.body.memo.id, decision: "hand" });
  assert.equal(r.statusCode, 400);
});

await ok("hand：タスクは相手の担当になり、相手に通知が行く", async () => {
  setup();
  const add = await post({ action: "add", body: "見積レビュー" });
  const r = await post({ action: "decide", id: add.body.memo.id, decision: "hand", assigneeId: "emp-2" });
  assert.equal(r.statusCode, 200);
  const t = db.rows.gw_tasks.find((x) => x.id === r.body.memo.promotedTaskId);
  assert.equal(t.assignee_id, "emp-2");
  assert.ok(notified.some((n) => n.employeeId === "emp-2"));
});

await ok("self・drop はタスクを作らない", async () => {
  setup();
  const a1 = await post({ action: "add", body: "自分でやった" });
  await post({ action: "decide", id: a1.body.memo.id, decision: "self" });
  const a2 = await post({ action: "add", body: "要らなかった" });
  await post({ action: "decide", id: a2.body.memo.id, decision: "drop" });
  assert.equal((db.rows.gw_tasks || []).length, 0);
});

await ok("決めたあとは、もう一度決められない", async () => {
  setup();
  const add = await post({ action: "add", body: "x" });
  await post({ action: "decide", id: add.body.memo.id, decision: "self" });
  const r = await post({ action: "decide", id: add.body.memo.id, decision: "task" });
  assert.equal(r.statusCode, 409);
});

await ok("決めたあとは、一覧に出てこない", async () => {
  setup();
  const add = await post({ action: "add", body: "x" });
  await post({ action: "decide", id: add.body.memo.id, decision: "self" });
  const r = await get();
  assert.equal(r.body.memos.length, 0);
});

console.log("— 権限 —");

await ok("他人のぶんは、一般メンバーは決められない", async () => {
  setup();
  db.rows.gw_quick_memos = [{ id: "m1", tenant_id: "t1", employee_id: "emp-2",
    body: "他人のメモ", status: "open", created_at: "2026-09-16T00:00:00Z" }];
  const r = await post({ action: "decide", id: "m1", decision: "self" });
  assert.equal(r.statusCode, 403);
});

await ok("管理者は、他人のぶんも決められる", async () => {
  setup();
  who = ADMIN;
  db.rows.gw_quick_memos = [{ id: "m1", tenant_id: "t1", employee_id: "emp-2",
    body: "他人のメモ", status: "open", created_at: "2026-09-16T00:00:00Z" }];
  const r = await post({ action: "decide", id: "m1", decision: "self" });
  assert.equal(r.statusCode, 200);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
