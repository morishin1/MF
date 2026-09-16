// タスク一覧の見え方。印・絞り込み・上の数・並び。
//
// ■ 何を守るテストか
//
//   1. 印は6つだけ。完了したものには他の印を付けない
//   2. 期限が入っていないタスクを、期間の絞り込みで消さない
//   3. 上の数は、絞り込んでも動かない（別に数える）
//   4. 並びは 期限超過 → 今日 → 期限の近い順。完了は下
//   5. 履歴は、人が読める1行になる
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const V = await import(join(ROOT, "lib/task-view.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TODAY = "2026-09-16";
const TOMORROW = "2026-09-17";
const task = (over = {}) => ({
  id: "t1", title: "A社へ提案書を送る", assignee_id: "emp-1",
  due_on: TODAY, priority: "normal", status: "todo", category: "営業",
  accepted_at: null, created_by: null, ...over,
});
const names = new Map([
  ["emp-1", { name: "山田 太郎", department: "営業" }],
  ["emp-2", { name: "鈴木 次郎", department: "制作" }],
]);
const row = (over = {}) => V.rowOf(task(over), { today: TODAY, names });

console.log("\n=== タスク一覧の見え方 ===\n");
console.log("— 印 —");

ok("印は6つ", () => {
  assert.deepEqual(V.BADGE_KEYS, ["overdue", "urgent", "today", "ai", "waiting", "done"]);
});

ok("期限を過ぎていれば「期限超過」", () => {
  assert.ok(row({ due_on: "2026-09-10" }).badges.includes("overdue"));
  assert.equal(row({ due_on: "2026-09-10" }).overdue, true);
});

ok("優先度が高ければ「緊急」", () => {
  assert.ok(row({ priority: "high" }).badges.includes("urgent"));
});

ok("今日やると決めたもの、期限が今日のものは「今日」", () => {
  assert.ok(row({ focus_date: TODAY, due_on: null }).badges.includes("today"));
  assert.ok(row({ due_on: TODAY }).badges.includes("today"));
  assert.ok(!row({ due_on: TOMORROW }).badges.includes("today"));
});

ok("AIの指摘か担当の案があれば「AI提案」", () => {
  assert.ok(row({ ai_review: { verdict: "fix" } }).badges.includes("ai"));
  assert.ok(row({ ai_assignee: "emp-2" }).badges.includes("ai"));
  assert.ok(!row().badges.includes("ai"));
});

ok("人から頼まれて、まだ受けていなければ「確認待ち」", () => {
  const t = V.rowOf({ ...task({ created_by: "u-9", accepted_at: null }), requested_by_other: true },
    { today: TODAY, names });
  assert.ok(t.badges.includes("waiting"));
  // 自分で立てたものには付けない
  const mine = V.rowOf({ ...task({ created_by: "u-9", accepted_at: null }), requested_by_other: false },
    { today: TODAY, names });
  assert.ok(!mine.badges.includes("waiting"));
});

ok("完了したものは「完了」だけ。他の印は付けない", () => {
  const r = row({ status: "done", due_on: "2026-09-01", priority: "high", ai_review: { verdict: "ok" } });
  assert.deepEqual(r.badges, ["done"]);
});

ok("取りやめたものには印を付けない", () => {
  assert.deepEqual(row({ status: "cancelled" }).badges, []);
});

console.log("— 行に出すもの —");

ok("出すのは、一覧で要るものだけ", () => {
  const r = row({ kpi_link: "新規開拓", service: "ENGER", focus_rank: 1, carry_count: 2 });
  assert.equal(r.title, "A社へ提案書を送る");
  assert.equal(r.assignee, "山田 太郎");
  assert.equal(r.department, "営業");
  assert.equal(r.priorityLabel, "ふつう");
  assert.equal(r.statusLabel, "未着手");
  assert.equal(r.kpi, "新規開拓");
  assert.equal(r.service, "ENGER");
  assert.equal(r.carryCount, 2);
  // 中身（目的・完了条件・メモ）は一覧に出さない
  assert.equal(r.purpose, undefined);
  assert.equal(r.doneCondition, undefined);
  assert.equal(r.body, undefined);
});

console.log("— 絞り込み —");

const many = () => [
  row({ id: "a", due_on: "2026-09-10", title: "遅れているもの" }),
  row({ id: "b", due_on: TODAY, title: "今日のもの" }),
  row({ id: "c", due_on: TOMORROW, title: "明日のもの" }),
  row({ id: "d", due_on: null, focus_date: TODAY, title: "期限なしの重要タスク" }),
  row({ id: "e", due_on: null, title: "期限なし" }),
  row({ id: "f", due_on: "2026-09-25", title: "今月の先のほう", assignee_id: "emp-2" }),
];
const ids = (rows) => rows.map((r) => r.id);
const opt = { today: TODAY, tomorrow: TOMORROW };

ok("今日：期限が今日のものと、今日の重要タスク", () => {
  const r = V.applyFilters(many(), { range: "today" }, opt);
  assert.deepEqual(ids(r).sort(), ["b", "d"]);
});

ok("明日：期限が明日のもの", () => {
  assert.deepEqual(ids(V.applyFilters(many(), { range: "tomorrow" }, opt)), ["c"]);
});

ok("今週：月曜から日曜まで", () => {
  const r = V.applyFilters(many(), { range: "week" }, opt);
  // 2026-09-16 は水曜。月曜は 09-14、日曜は 09-20
  assert.deepEqual(ids(r).sort(), ["b", "c"]);
});

ok("今月：その月のもの", () => {
  const r = V.applyFilters(many(), { range: "month" }, opt);
  assert.deepEqual(ids(r).sort(), ["a", "b", "c", "f"]);
});

ok("すべて：期限なしも残る", () => {
  assert.equal(V.applyFilters(many(), { range: "all" }, opt).length, 6);
});

ok("担当・部署・優先度・状態で絞れる", () => {
  assert.deepEqual(ids(V.applyFilters(many(), { assigneeId: "emp-2" }, opt)), ["f"]);
  assert.deepEqual(ids(V.applyFilters(many(), { department: "制作" }, opt)), ["f"]);
  const pri = V.applyFilters([row({ id: "x", priority: "high" }), row({ id: "y" })], { priority: "high" }, opt);
  assert.deepEqual(ids(pri), ["x"]);
  const st = V.applyFilters([row({ id: "x", status: "done" }), row({ id: "y" })], { status: "open" }, opt);
  assert.deepEqual(ids(st), ["y"]);
});

ok("AI提案だけに絞れる", () => {
  const rows = [row({ id: "x", ai_review: { verdict: "fix" } }), row({ id: "y" })];
  assert.deepEqual(ids(V.applyFilters(rows, { ai: true }, opt)), ["x"]);
});

ok("キーワードは、題名・担当・分類・サービス・KPIから探す", () => {
  const rows = [
    row({ id: "x", title: "見積を出す" }),
    row({ id: "y", title: "別のこと", service: "ENGER" }),
    row({ id: "z", title: "また別", assignee_id: "emp-2" }),
  ];
  assert.deepEqual(ids(V.applyFilters(rows, { q: "見積" }, opt)), ["x"]);
  assert.deepEqual(ids(V.applyFilters(rows, { q: "enger" }, opt)), ["y"], "大文字小文字を区別しない");
  assert.deepEqual(ids(V.applyFilters(rows, { q: "鈴木" }, opt)), ["z"]);
});

console.log("— 上の数 —");

ok("今日・完了・未完了・期限超過を数える", () => {
  const rows = [
    row({ id: "a", due_on: TODAY, status: "done" }),
    row({ id: "b", due_on: TODAY }),
    row({ id: "c", focus_date: TODAY, due_on: null }),
    row({ id: "d", due_on: "2026-09-01" }),
    row({ id: "e", due_on: TOMORROW }),
  ];
  const k = V.kpiOf(rows, { today: TODAY, tomorrow: TOMORROW, people: [], focusDays: [] });
  assert.equal(k.today, 3);
  assert.equal(k.done, 1);
  assert.equal(k.open, 2);
  assert.equal(k.overdue, 1);
});

ok("明日ぶんを決めていない人と、確定していない人を数える", () => {
  const people = [{ id: "emp-1" }, { id: "emp-2" }, { id: "emp-3" }];
  const rows = [
    row({ id: "a", focus_date: TOMORROW, due_on: TOMORROW }),                     // emp-1 は登録済み
    V.rowOf(task({ id: "b", focus_date: TOMORROW, assignee_id: "emp-2" }), { today: TODAY, names }),
  ];
  const focusDays = [
    { employee_id: "emp-1", focus_date: TOMORROW, status: "confirmed" },
    { employee_id: "emp-2", focus_date: TOMORROW, status: "ai_checked" },
  ];
  const k = V.kpiOf(rows, { today: TODAY, tomorrow: TOMORROW, people, focusDays });
  assert.equal(k.noTomorrow, 1, "emp-3 が未登録");
  assert.equal(k.waiting, 1, "emp-2 が確定待ち");
});

console.log("— 並び —");

ok("期限超過 → 今日 → 期限の近い順。完了は下", () => {
  const rows = [
    row({ id: "done", status: "done", due_on: "2026-09-01" }),
    row({ id: "future", due_on: "2026-09-30" }),
    row({ id: "late", due_on: "2026-09-10" }),
    row({ id: "today", focus_date: TODAY, due_on: null }),
  ];
  assert.deepEqual(ids(V.sortRows(rows, TODAY)), ["late", "today", "future", "done"]);
});

console.log("— 履歴 —");

ok("担当変更・期限変更・完了は、読める文になる", () => {
  assert.match(V.eventLine({ kind: "assigned", detail: { fromName: "山田", toName: "鈴木" } }),
    /山田 → 鈴木/);
  assert.match(V.eventLine({ kind: "due", detail: { from: "2026-09-16", to: "2026-09-18" } }),
    /2026-09-16 → 2026-09-18/);
  assert.match(V.eventLine({ kind: "priority", detail: { from: "normal", to: "high" } }), /ふつう → 高/);
  assert.match(V.eventLine({ kind: "status", detail: { to: "done", result: "送付した" } }),
    /完了.*送付した/);
  assert.match(V.eventLine({ kind: "carry", detail: { label: "明日へ持ち越す", reason: "返事待ち" } }),
    /明日へ持ち越す：返事待ち/);
  assert.match(V.eventLine({ kind: "ai", detail: { adopted: true, what: "担当" } }), /AIの案を採りました/);
  assert.equal(V.eventLine({ kind: "created" }), "作成しました");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
