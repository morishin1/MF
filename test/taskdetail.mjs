// 引き出し（タスクの詳細）から、そのまま片付けられるか。
//
// ■ 何を守るテストか
//
//   1. 概要・コメント・履歴が、1回の読み取りで返る
//   2. 担当・期限・優先度・状態を、引き出しの中で変えられる
//   3. 変えたことが履歴に残る（誰が・何から何へ）
//   4. AIの案は、採る・担当だけ採る・このまま の3つ。押したら案は片付く
//   5. 見てよいのは 担当・頼んだ人・管理者だけ
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) =>
    (k.startsWith("!") ? r[k.slice(1)] !== v : Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is() { return q; }, not() { return q; }, or() { return q; },
    lt() { return q; }, gte() { return q; }, lte() { return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || "2026-09-16T01:00:00Z", ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: copy(made[0]), error: null }),
                  then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn) };
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
        then: (fn) => {
          const hit = match(name, g);
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: hit.map(copy), error: null }).then(fn);
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

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: whoUser }), getMemberships: async () => [] },
});
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
                 employee: { id: "emp-1", display_name: "山田 太郎" } };
const OTHER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
                employee: { id: "emp-3", display_name: "無関係 三郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
                employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = MEMBER;
let whoUser = "u-1";
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});
const notified = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (n) => { notified.push(...n); return { created: n.length }; },
                  clearNotification: async () => {} },
});

const { default: detail } = await import(atRoot("api/tasks/detail.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await detail({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = (id) => call({ method: "GET", url: `/api/tasks/detail?id=${id}` });
const post = (body) => call({ method: "POST", url: "/api/tasks/detail", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const task = () => db.rows.gw_tasks[0];
const events = () => db.rows.gw_task_events || [];

function setup(over = {}) {
  notified.length = 0;
  who = MEMBER; whoUser = "u-1";
  db.rows = {
    gw_employees: [
      { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", department: "営業",
        status: "active", user_id: "u-1" },
      { id: "emp-2", tenant_id: "t1", display_name: "鈴木 次郎", department: "制作",
        status: "active", user_id: "u-2" },
      { id: "emp-hr", tenant_id: "t1", display_name: "事務 花子", status: "active", user_id: "u-hr" },
    ],
    gw_tasks: [{
      id: "t1", tenant_id: "t1", title: "A社へ提案書を送る",
      purpose: "新規売上のため", done_condition: "先方へ送付が完了している",
      kpi_link: "新規開拓", service: "ENGER", link: null, category: "営業",
      assignee_id: "emp-1", due_on: "2026-09-16", priority: "normal", status: "todo",
      created_by: "u-2", created_at: "2026-09-15T01:00:00Z",
      focus_date: null, focus_for: null, carry_count: 0, ai_review: null,
      ai_assignee: null, ai_assignee_why: null, accepted_at: null,
      ...over,
    }],
    gw_task_comments: [], gw_task_events: [], gw_focus_days: [],
  };
}

console.log("\n=== タスクの引き出し ===\n");
console.log("— 読む —");

await ok("概要・コメント・履歴が、1回で返る", async () => {
  setup();
  db.rows.gw_task_comments.push({ id: "c1", task_id: "t1", author_id: "u-2",
                                  author_name: "鈴木 次郎", body: "急ぎでお願いします",
                                  created_at: "2026-09-15T02:00:00Z" });
  const r = await get("t1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const t = r.body.task;
  assert.equal(t.title, "A社へ提案書を送る");
  assert.equal(t.purpose, "新規売上のため");
  assert.equal(t.doneCondition, "先方へ送付が完了している");
  assert.equal(t.kpi, "新規開拓");
  assert.equal(t.service, "ENGER");
  assert.equal(t.assignee, "山田 太郎");
  assert.equal(t.createdBy, "鈴木 次郎");
  assert.equal(t.madeBy, "human");
  assert.equal(r.body.comments.length, 1);
  assert.equal(r.body.comments[0].name, "鈴木 次郎");
  assert.ok(r.body.people.length >= 2, "担当を変える選択肢が要る");
});

await ok("履歴が空でも、作成の1行は出す", async () => {
  setup();
  const r = await get("t1");
  assert.equal(r.body.events.length, 1);
  assert.equal(r.body.events[0].kind, "created");
});

await ok("無関係の人には見せない", async () => {
  setup();
  who = OTHER; whoUser = "u-9";
  const r = await get("t1");
  assert.equal(r.statusCode, 403);
});

await ok("管理者は見られる", async () => {
  setup();
  who = ADMIN; whoUser = "u-hr";
  const r = await get("t1");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.canManage, true);
});

await ok("無いものは 404", async () => {
  setup();
  const r = await get("nope");
  assert.equal(r.statusCode, 404);
});

console.log("— 引き出しの中で変える —");

await ok("担当を変えると、履歴に残って相手に届く", async () => {
  setup();
  const r = await post({ id: "t1", action: "update", assigneeId: "emp-2" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().assignee_id, "emp-2");
  assert.equal(task().accepted_at, null, "新しい担当の受諾は取り消す");
  const e = events().find((x) => x.kind === "assigned");
  assert.ok(e, "履歴が無い");
  assert.equal(e.detail.fromName, "山田 太郎");
  assert.equal(e.detail.toName, "鈴木 次郎");
  assert.ok(notified.some((n) => n.employeeId === "emp-2"));
});

await ok("期限・優先度も、その場で変えられる", async () => {
  setup();
  await post({ id: "t1", action: "update", dueOn: "2026-09-20" });
  await post({ id: "t1", action: "update", priority: "high" });
  assert.equal(task().due_on, "2026-09-20");
  assert.equal(task().priority, "high");
  assert.ok(events().some((e) => e.kind === "due" && e.detail.to === "2026-09-20"));
  assert.ok(events().some((e) => e.kind === "priority" && e.detail.to === "high"));
});

await ok("目的・完了条件・KPI・サービス・URLを直せる", async () => {
  setup();
  const r = await post({ id: "t1", action: "update",
                         purpose: "直した目的", doneCondition: "直した条件",
                         kpi: "既存深耕", service: "無限道場", url: "https://example.jp/a" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().purpose, "直した目的");
  assert.equal(task().done_condition, "直した条件");
  assert.equal(task().kpi_link, "既存深耕");
  assert.equal(task().service, "無限道場");
  assert.equal(task().link, "https://example.jp/a");
  const e = events().find((x) => x.kind === "edited");
  assert.ok(e.detail.fields.includes("purpose"));
});

await ok("URL は http(s) だけ", async () => {
  setup();
  const r = await post({ id: "t1", action: "update", url: "javascript:alert(1)" });
  assert.equal(r.statusCode, 400);
  assert.equal(task().link, null);
});

await ok("何も変わっていなければ、履歴を増やさない", async () => {
  setup();
  const r = await post({ id: "t1", action: "update", priority: "normal" });
  assert.equal(r.body.changed, false);
  assert.equal(events().length, 0);
});

await ok("完了にすると、結果と時刻が残り、頼んだ人に届く", async () => {
  setup();
  const r = await post({ id: "t1", action: "status", status: "done", result: "送付しました" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().status, "done");
  assert.equal(task().result, "送付しました");
  assert.ok(task().completed_at);
  assert.ok(events().some((e) => e.kind === "status" && e.detail.to === "done"));
  assert.ok(notified.some((n) => /終わらせました/.test(n.title)));
});

await ok("完了を戻すと、完了の時刻も消える", async () => {
  setup();
  await post({ id: "t1", action: "status", status: "done" });
  await post({ id: "t1", action: "status", status: "todo" });
  assert.equal(task().status, "todo");
  assert.equal(task().completed_at, null);
});

console.log("— コメント —");

await ok("コメントすると、相手に届く", async () => {
  setup();
  const r = await post({ id: "t1", action: "comment", body: "明日までにやります" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.comment.body, "明日までにやります");
  assert.equal(r.body.comment.mine, true);
  assert.equal(db.rows.gw_task_comments.length, 1);
  assert.ok(events().some((e) => e.kind === "comment"));
  // 頼んだ人（鈴木）に届く
  assert.ok(notified.some((n) => n.employeeId === "emp-2"));
});

await ok("空のコメントは受けない", async () => {
  setup();
  const r = await post({ id: "t1", action: "comment", body: "   " });
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_task_comments.length, 0);
});

console.log("— 持ち越し —");

await ok("引き出しからも、持ち越しを決められる", async () => {
  setup({ focus_date: "2026-09-15", focus_for: "emp-1" });
  const r = await post({ id: "t1", action: "carry", decision: "carry",
                         reason: "先方の返事待ち", date: "2026-09-17" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().focus_date, "2026-09-17");
  assert.equal(task().carry_count, 1);
  assert.equal(task().not_done_reason, "先方の返事待ち");
  const e = events().find((x) => x.kind === "carry");
  assert.equal(e.detail.decision, "carry");
});

await ok("別の人へ渡すと、担当が変わって知らせが届く", async () => {
  setup({ focus_date: "2026-09-15", focus_for: "emp-1" });
  const r = await post({ id: "t1", action: "carry", decision: "hand", assigneeId: "emp-2" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().assignee_id, "emp-2");
  assert.equal(task().focus_date, null);
  assert.ok(notified.some((n) => n.employeeId === "emp-2"));
});

await ok("知らない決め方は受けない", async () => {
  setup();
  const r = await post({ id: "t1", action: "carry", decision: "なんとなく" });
  assert.equal(r.statusCode, 400);
});

console.log("— AIの案 —");

const withAi = () => setup({
  ai_review: { verdict: "fix", reason: "作業になっています", fix: "新規5社へ初回連絡する",
               doneCondition: "5社に送信が完了している", kpi: "新規開拓" },
  ai_assignee: "emp-2", ai_assignee_why: "山田さんに寄っているため",
});

await ok("提案を採用すると、題名・完了条件・担当が入る", async () => {
  withAi();
  const r = await post({ id: "t1", action: "ai", how: "adopt" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().title, "新規5社へ初回連絡する");
  assert.equal(task().done_condition, "5社に送信が完了している");
  assert.equal(task().assignee_id, "emp-2");
  assert.ok(events().some((e) => e.kind === "ai" && e.detail.adopted === true));
  assert.ok(notified.some((n) => n.employeeId === "emp-2"));
});

await ok("担当だけ変えることもできる", async () => {
  withAi();
  const r = await post({ id: "t1", action: "ai", how: "assign" });
  assert.equal(r.statusCode, 200);
  assert.equal(task().assignee_id, "emp-2");
  assert.equal(task().title, "A社へ提案書を送る", "題名は変えない");
});

await ok("このまま進めると、何も変わらない", async () => {
  withAi();
  const r = await post({ id: "t1", action: "ai", how: "keep" });
  assert.equal(r.statusCode, 200);
  assert.equal(task().title, "A社へ提案書を送る");
  assert.equal(task().assignee_id, "emp-1");
});

await ok("押したあとは、案が一覧に出続けない", async () => {
  withAi();
  await post({ id: "t1", action: "ai", how: "keep" });
  assert.equal(task().ai_assignee, null, "担当の案が残っています");
  assert.equal(task().ai_review.adopted, "keep");
  // 一覧の印は「AIの案が片付いていない」ときだけ
  const { rowOf } = await import(atRoot("lib/task-view.js"));
  const r = rowOf(task(), { today: "2026-09-16" });
  assert.ok(r.badges.includes("ai"), "履歴としては残る");
});

await ok("案が無ければ、押しても何も起きない", async () => {
  setup();
  const r = await post({ id: "t1", action: "ai", how: "adopt" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_ai");
});

console.log("— 触れる人 —");

await ok("無関係の人は変えられない", async () => {
  setup();
  who = OTHER; whoUser = "u-9";
  const r = await post({ id: "t1", action: "update", priority: "high" });
  assert.equal(r.statusCode, 403);
  assert.equal(task().priority, "normal");
});

await ok("頼んだ人も直せる（担当を人に渡したあとも）", async () => {
  setup();
  who = { ...MEMBER, employee: { id: "emp-2", display_name: "鈴木 次郎" } };
  whoUser = "u-2";
  const r = await post({ id: "t1", action: "update", dueOn: "2026-09-25" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(task().due_on, "2026-09-25");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
