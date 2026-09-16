// 明日の3件を決めて、AIが見て、人が確定して、翌日終わらせるまで。
//
// ■ 何を守るテストか
//
//   1. 3件そろうまで確定できない
//   2. AIは案を出すだけ。確定するまで担当も内容も変わらない
//   3. 確定すると、担当者へ配信され、日報が書けるようになる
//   4. 未完了は自動で翌日へ動かない。決めたときだけ動く
//   5. 他人のぶんを触れるのは管理者だけ
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
const DEFAULTS = {
  gw_tasks: { status: "todo", priority: "normal", carry_count: 0 },
  gw_focus_days: { status: "draft" },
};

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) => {
    if (k.startsWith("!")) return r[k.slice(1)] !== v;
    if (k.startsWith("<")) return r[k.slice(1)] && r[k.slice(1)] < v;
    if (k.startsWith("null:")) {
      const kk = k.slice(5);
      return v === "is" ? r[kk] == null : r[kk] != null;
    }
    return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
  }));
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    lt(k, v) { f.push(["<" + k, v]); return q; },
    gte() { return q; }, lte() { return q; },
    in(k, v) { f.push([k, v]); return q; },
    is(k, v) { f.push([`null:${k}`, v === null ? "is" : "not"]); return q; },
    not(k, op, v) { f.push([`null:${k}`, v === null ? "not" : "is"]); return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        ...(DEFAULTS[name] || {}),
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: copy(made[0]), error: null }),
                  maybeSingle: () => Promise.resolve({ data: copy(made[0]), error: null }),
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
        maybeSingle: () => r.single(),
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
  namedExports: { notify: async (n) => { notified.push(...n); return { created: n.length }; },
                  clearNotification: async () => {} },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

// AIは呼ばない。返す形だけ決めて差し替える
let aiOn = true;
let aiOut = null;
mock.module(atRoot("lib/task-ai.js"), {
  namedExports: {
    aiConfigured: () => aiOn,
    reviewFocus: async () => aiOut,
    reviewCarry: async () => ({ model: "test", result: { items: [
      { index: 0, decision: "drop", reason: "3回持ち越しています" },
    ] } }),
  },
});

const { default: focus } = await import(atRoot("api/tasks/focus.js"));
const { nextFocusDate, jstToday } = await import(atRoot("lib/focus.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await focus({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = (qs = "") => call({ method: "GET", url: `/api/tasks/focus${qs}` });
const post = (body) => call({ method: "POST", url: "/api/tasks/focus", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TODAY = jstToday();
const TOMORROW = nextFocusDate(TODAY);

function setup() {
  notified.length = 0; logged.length = 0;
  aiOn = true;
  aiOut = { model: "test-model", result: {
    overall: { ok: true, summary: "明日やる内容として妥当です", warnings: ["1人に3件とも寄っています"] },
    tasks: [
      { index: 0, verdict: "ok", reason: "目標につながっています" },
      { index: 1, verdict: "fix", reason: "作業になっています", fix: "新規5社へ初回連絡する",
        done_condition: "5社に送信が完了している", kpi: "新規開拓" },
      { index: 2, verdict: "ok", reason: "問題ありません",
        assignee_name: "鈴木 次郎", assignee_why: "山田さんに寄っているため" },
    ],
  } };
  db.rows = {
    gw_employees: [
      { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", status: "active",
        department: "営業", user_id: "u-1" },
      { id: "emp-2", tenant_id: "t1", display_name: "鈴木 次郎", status: "active",
        department: "営業", user_id: "u-2" },
      { id: "emp-hr", tenant_id: "t1", display_name: "事務 花子", status: "active", user_id: "u-hr" },
    ],
    gw_role_grants: [], gw_tasks: [], gw_focus_days: [],
    gw_week_goals: [], gw_kpi_templates: [],
  };
}
const full = (n) => ({
  title: `やること${n}`, purpose: "売上をつくるため", doneCondition: "送付が完了している",
  dueOn: TOMORROW, priority: "high", kpiLink: "新規開拓", date: TOMORROW,
});
const tasksOf = (date) => (db.rows.gw_tasks || []).filter((t) => t.focus_date === date);
const dayOf = (date, emp = "emp-1") =>
  (db.rows.gw_focus_days || []).find((d) => d.focus_date === date && d.employee_id === emp);

async function addThree() {
  for (const n of [1, 2, 3]) await post({ action: "add", ...full(n) });
}

console.log("\n=== 明日の3件を決める ===\n");
console.log("— 登録 —");

await ok("1件足すと、その日の行ができて「登録中」", async () => {
  setup();
  const r = await post({ action: "add", ...full(1) });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.title, "やること1");
  assert.equal(r.body.task.focusDate, TOMORROW);
  assert.equal(r.body.task.focusRank, 1);
  assert.equal(dayOf(TOMORROW)?.status, "draft");
});

await ok("担当を決めなくても登録できる（AIが候補を出す）", async () => {
  setup();
  const r = await post({ action: "add", title: "担当未定のしごと", date: TOMORROW });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  // 誰のぶんとして決めているかは分かるようにしておく
  assert.equal(r.body.task.assigneeId, "emp-1");
});

await ok("タスク名が無ければ足せない", async () => {
  setup();
  const r = await post({ action: "add", date: TOMORROW });
  assert.equal(r.statusCode, 400);
});

await ok("3件そろうと、AI確認待ちになる", async () => {
  setup();
  await addThree();
  assert.equal(dayOf(TOMORROW)?.status, "ready");
  const r = await get();
  assert.equal(r.body.tomorrowState.key, "ready");
  assert.equal(r.body.tomorrowState.ready, true);
});

await ok("項目が欠けていると、そろっていても確定できない", async () => {
  setup();
  await post({ action: "add", title: "目的なし", date: TOMORROW });
  await post({ action: "add", ...full(2) });
  await post({ action: "add", ...full(3) });
  const r = await post({ action: "confirm", date: TOMORROW });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "not_ready_yet");
  assert.match(r.body.hint, /足りない項目/);
});

await ok("5件を超えては決めさせない", async () => {
  setup();
  for (const n of [1, 2, 3, 4, 5]) await post({ action: "add", ...full(n) });
  const r = await post({ action: "add", ...full(6) });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "too_many");
  assert.match(r.body.hint, /どれも終わりません/);
});

await ok("外すと、タスクは消えずに重要タスクから外れるだけ", async () => {
  setup();
  await addThree();
  const id = tasksOf(TOMORROW)[0].id;
  const r = await post({ action: "remove", id });
  assert.equal(r.statusCode, 200);
  assert.equal(tasksOf(TOMORROW).length, 2);
  assert.equal(db.rows.gw_tasks.length, 3, "タスクそのものは残る");
  assert.equal(dayOf(TOMORROW)?.status, "draft", "3件を切ったので登録中へ戻る");
});

console.log("— AIが見る —");

await ok("3件そろう前は、AIに出さない", async () => {
  setup();
  await post({ action: "add", ...full(1) });
  const r = await post({ action: "check", date: TOMORROW });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "not_ready_yet");
});

await ok("AIの講評が、タスクごとに付く", async () => {
  setup();
  await addThree();
  const r = await post({ action: "check", date: TOMORROW });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ai.summary, "明日やる内容として妥当です");
  assert.deepEqual(r.body.ai.warnings, ["1人に3件とも寄っています"]);
  const t = r.body.tasks;
  assert.equal(t[0].aiReview.verdict, "ok");
  assert.equal(t[1].aiReview.verdict, "fix");
  assert.equal(t[1].aiReview.fix, "新規5社へ初回連絡する");
  assert.equal(t[1].aiReview.doneCondition, "5社に送信が完了している");
  assert.equal(dayOf(TOMORROW)?.status, "ai_checked");
});

await ok("AIは直さない。案を出すだけ（本文は変わらない）", async () => {
  setup();
  await addThree();
  await post({ action: "check", date: TOMORROW });
  assert.equal(tasksOf(TOMORROW)[1].title, "やること2", "AIが勝手に書き換えています");
  assert.equal(tasksOf(TOMORROW)[1].done_condition, "送付が完了している");
});

await ok("担当の案は、担当そのものには入れない", async () => {
  setup();
  await addThree();
  const r = await post({ action: "check", date: TOMORROW });
  const t = r.body.tasks[2];
  assert.equal(t.aiAssignee, "emp-2", "候補を出していません");
  assert.match(t.aiAssigneeWhy, /寄っている/);
  assert.equal(tasksOf(TOMORROW)[2].assignee_id, "emp-1", "AIが担当を変えています");
});

await ok("直したら、AIの確認はやり直し", async () => {
  setup();
  await addThree();
  await post({ action: "check", date: TOMORROW });
  const id = tasksOf(TOMORROW)[0].id;
  await post({ action: "update", id, title: "書き直した" });
  assert.equal(dayOf(TOMORROW)?.status, "ready", "古い講評のまま確定できてしまいます");
});

await ok("AIの鍵が無ければ、そう言う（確定は止めない）", async () => {
  setup();
  aiOn = false;
  await addThree();
  const r = await post({ action: "check", date: TOMORROW });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "ai_not_configured");
  const c = await post({ action: "confirm", date: TOMORROW });
  assert.equal(c.statusCode, 200, "AIが無いと確定できないのは困る");
});

console.log("— 確定 —");

await ok("確定すると、状態が変わって記録が残る", async () => {
  setup();
  await addThree();
  const r = await post({ action: "confirm", date: TOMORROW });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.state.confirmed, true);
  assert.equal(dayOf(TOMORROW)?.status, "confirmed");
  assert.ok(dayOf(TOMORROW)?.confirmed_at);
  assert.ok(logged.some((l) => l.action === "focus.confirm"));
});

await ok("担当が他の人のものは、その人に配信する", async () => {
  setup();
  await post({ action: "add", ...full(1), assigneeId: "emp-2" });
  await post({ action: "add", ...full(2) });
  await post({ action: "add", ...full(3) });
  notified.length = 0;
  const r = await post({ action: "confirm", date: TOMORROW });
  assert.equal(r.body.sent, 1);
  const n = notified.find((x) => x.employeeId === "emp-2");
  assert.ok(n, "配信されていません");
  assert.match(n.title, /重要タスク/);
});

await ok("自分のぶんだけなら、通知は出さない", async () => {
  setup();
  await addThree();
  notified.length = 0;
  await post({ action: "confirm", date: TOMORROW });
  assert.equal(notified.length, 0);
});

await ok("確定したあとは足せない・直せない", async () => {
  setup();
  await addThree();
  await post({ action: "confirm", date: TOMORROW });
  const a = await post({ action: "add", ...full(4) });
  assert.equal(a.statusCode, 409);
  assert.equal(a.body.error, "already_confirmed");
});

await ok("2回押しても、確定は1回", async () => {
  setup();
  await addThree();
  await post({ action: "confirm", date: TOMORROW });
  const r = await post({ action: "confirm", date: TOMORROW });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.already, true);
});

console.log("— 終わらせる —");

await ok("完了を押すと、その場で 1/3 が返る", async () => {
  setup();
  // 今日ぶんとして3件、確定済みにしておく
  for (const n of [1, 2, 3]) await post({ action: "add", ...full(n), date: TODAY });
  const id = tasksOf(TODAY)[0].id;
  const r = await post({ action: "complete", id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.progress.label, "1 / 3");
  assert.equal(r.body.done, false);
  assert.equal(tasksOf(TODAY)[0].status, "done");
  assert.ok(tasksOf(TODAY)[0].completed_at);
});

await ok("3件終わると「今日の重要タスク完了」", async () => {
  setup();
  for (const n of [1, 2, 3]) await post({ action: "add", ...full(n), date: TODAY });
  let r;
  for (const t of tasksOf(TODAY)) r = await post({ action: "complete", id: t.id });
  assert.equal(r.body.done, true);
  assert.equal(r.body.message, "今日の重要タスク完了");
});

await ok("押し間違いは戻せる", async () => {
  setup();
  for (const n of [1, 2, 3]) await post({ action: "add", ...full(n), date: TODAY });
  const id = tasksOf(TODAY)[0].id;
  await post({ action: "complete", id });
  const r = await post({ action: "reopen", id });
  assert.equal(r.body.progress.label, "0 / 3");
  assert.equal(tasksOf(TODAY)[0].status, "todo");
});

await ok("他人のタスクは完了にできない", async () => {
  setup();
  await post({ action: "add", ...full(1), date: TODAY });
  db.rows.gw_tasks[0].assignee_id = "emp-2";
  const r = await post({ action: "complete", id: db.rows.gw_tasks[0].id });
  assert.equal(r.statusCode, 403);
});

console.log("— 未完了 —");

await ok("終わらなかったものは、翌日へ自動で動かない", async () => {
  setup();
  db.rows.gw_tasks.push({
    id: "old-1", tenant_id: "t1", assignee_id: "emp-1", title: "昨日の残り",
    focus_date: "2026-09-01", focus_for: "emp-1", status: "todo", carry_count: 0,
  });
  const r = await get();
  assert.equal(r.body.carryOver.length, 1, "残っていません");
  assert.equal(r.body.carryOver[0].focusDate, "2026-09-01");
  assert.equal(tasksOf(TOMORROW).length, 0, "勝手に動いています");
});

await ok("持ち越すと決めたときだけ動く。回数も数える", async () => {
  setup();
  db.rows.gw_tasks.push({
    id: "old-1", tenant_id: "t1", assignee_id: "emp-1", title: "昨日の残り",
    focus_date: "2026-09-01", focus_for: "emp-1", status: "todo", carry_count: 1,
  });
  const r = await post({ action: "carry", id: "old-1", decision: "carry",
                         reason: "先方の返事待ちだった", date: TOMORROW });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.focusDate, TOMORROW);
  assert.equal(r.body.task.carryCount, 2);
  assert.equal(r.body.task.notDoneReason, "先方の返事待ちだった");
  assert.ok(logged.some((l) => l.action === "focus.carry"));
});

await ok("優先度を下げると、重要タスクから外れる", async () => {
  setup();
  db.rows.gw_tasks.push({ id: "old-1", tenant_id: "t1", assignee_id: "emp-1",
                          title: "残り", focus_date: "2026-09-01", focus_for: "emp-1", status: "todo", priority: "high" });
  const r = await post({ action: "carry", id: "old-1", decision: "lower" });
  assert.equal(r.body.task.focusDate, null);
  assert.equal(r.body.task.priority, "normal");
});

await ok("別の人へ渡すと、担当が変わって知らせが届く", async () => {
  setup();
  db.rows.gw_tasks.push({ id: "old-1", tenant_id: "t1", assignee_id: "emp-1",
                          title: "残り", focus_date: "2026-09-01", focus_for: "emp-1", status: "todo" });
  notified.length = 0;
  const r = await post({ action: "carry", id: "old-1", decision: "hand", assigneeId: "emp-2" });
  assert.equal(r.body.task.assigneeId, "emp-2");
  assert.equal(r.body.task.focusDate, null);
  assert.ok(notified.some((n) => n.employeeId === "emp-2"));
});

await ok("渡す相手を選ばなければ、断る", async () => {
  setup();
  db.rows.gw_tasks.push({ id: "old-1", tenant_id: "t1", assignee_id: "emp-1",
                          title: "残り", focus_date: "2026-09-01", focus_for: "emp-1", status: "todo" });
  const r = await post({ action: "carry", id: "old-1", decision: "hand" });
  assert.equal(r.statusCode, 400);
});

await ok("やらないことにすると、取りやめになる", async () => {
  setup();
  db.rows.gw_tasks.push({ id: "old-1", tenant_id: "t1", assignee_id: "emp-1",
                          title: "残り", focus_date: "2026-09-01", focus_for: "emp-1", status: "todo" });
  const r = await post({ action: "carry", id: "old-1", decision: "drop", reason: "不要になった" });
  assert.equal(r.body.task.status, "cancelled");
  assert.equal(r.body.task.focusDate, null);
});

await ok("知らない決め方は受けない", async () => {
  setup();
  db.rows.gw_tasks.push({ id: "old-1", tenant_id: "t1", assignee_id: "emp-1",
                          title: "残り", focus_date: "2026-09-01", focus_for: "emp-1", status: "todo" });
  const r = await post({ action: "carry", id: "old-1", decision: "なんとなく" });
  assert.equal(r.statusCode, 400);
});

await ok("AIは、何度も持ち越しているものに「やらない」を薦められる", async () => {
  setup();
  db.rows.gw_tasks.push({ id: "old-1", tenant_id: "t1", assignee_id: "emp-1",
                          title: "残り", focus_date: "2026-09-01", focus_for: "emp-1", status: "todo", carry_count: 3 });
  const r = await post({ action: "carryPlan", date: TODAY });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.items[0].decision, "drop");
  assert.equal(r.body.items[0].taskId, "old-1");
  // 案を出しただけ。動かしていない
  assert.equal(db.rows.gw_tasks[0].status, "todo");
});

console.log("— 誰が触れるか —");

await ok("一般メンバーは、他人のぶんを見られない", async () => {
  setup();
  const r = await get("?employeeId=emp-2");
  assert.equal(r.statusCode, 403);
});

await ok("管理者は、他人のぶんを見て、代わりに確定できる", async () => {
  setup();
  await addThree();                                  // 山田さんのぶん
  who = ADMIN;
  try {
    const g = await get("?employeeId=emp-1");
    assert.equal(g.statusCode, 200, JSON.stringify(g.body));
    assert.equal(g.body.tomorrowTasks.length, 3);
    const c = await post({ action: "confirm", date: TOMORROW, employeeId: "emp-1" });
    assert.equal(c.statusCode, 200, JSON.stringify(c.body));
    assert.equal(dayOf(TOMORROW)?.status, "confirmed");
    assert.ok(logged.some((l) => l.action === "focus.confirm" && l.detail.byAdmin === true));
  } finally { who = MEMBER; }
});

await ok("管理者は、代わりにタスクを足せる", async () => {
  setup();
  who = ADMIN;
  try {
    const r = await post({ action: "add", ...full(1), employeeId: "emp-1" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.task.assigneeId, "emp-1");
  } finally { who = MEMBER; }
});

console.log("— 一覧 —");

await ok("今日ぶん・明日ぶん・持ち越しを、1回で返す", async () => {
  setup();
  await post({ action: "add", ...full(1), date: TODAY });
  await addThree();
  const r = await get();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.todayTasks.length, 1);
  assert.equal(r.body.tomorrowTasks.length, 3);
  assert.equal(r.body.todayProgress.label, "0 / 1");
  assert.equal(r.body.tomorrowDate, TOMORROW);
  assert.ok(r.body.people.length >= 2, "担当の選択肢が要る");
  assert.deepEqual(r.body.carryChoices.map((c) => c.key), ["carry", "lower", "hand", "drop"]);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
