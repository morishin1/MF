// 毎日の実行管理。「明日の3件」から「今日やる3つ」まで。
//
// ■ 何を守るテストか
//
//   1. 3件そろい、項目が埋まるまで確定できない
//   2. 確定するまで日報は書けない（書けない理由が、そのまま画面に出る）
//   3. 進み具合は「その日に決めた数」が分母。積んであるタスクの数ではない
//   4. 明日＝次の営業日。金曜の夜に決めたら、土曜ではなく月曜ぶん
//   5. 管理者の一覧で、止まっている人が分かる
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const F = await import(join(ROOT, "lib/focus.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

/** 項目のそろったタスク1件 */
const task = (over = {}) => ({
  id: over.id || "t1",
  title: "A社へ提案書を送る",
  purpose: "今期の新規売上をつくるため",
  done_condition: "先方へ送付が完了している",
  assignee_id: "emp-1",
  due_on: "2026-09-17",
  priority: "high",
  kpi_link: "新規開拓",
  status: "todo",
  ...over,
});
const three = () => [task({ id: "t1" }), task({ id: "t2" }), task({ id: "t3" })];

console.log("\n=== 毎日の実行管理 ===\n");
console.log("— 決める —");

ok("1日に決めるのは3件。上限は5件", () => {
  assert.equal(F.MIN_FOCUS, 3);
  assert.equal(F.MAX_FOCUS, 5);
});

ok("要るのは タスク名・目的・完了条件・担当・期限・優先度", () => {
  const required = F.FOCUS_FIELDS.filter((f) => f.required).map((f) => f.key);
  assert.deepEqual(required,
    ["title", "purpose", "done_condition", "assignee_id", "due_on", "priority"]);
});

ok("欠けている項目を、名前で返す", () => {
  const m = F.missingFields(task({ purpose: "", done_condition: null }));
  assert.deepEqual(m.map((x) => x.label), ["目的", "完了条件"]);
  assert.deepEqual(F.missingFields(task()), []);
});

ok("2件では確定できない。あと何件かを言う", () => {
  const st = F.focusState({ day: null, tasks: [task({ id: "t1" }), task({ id: "t2" })] });
  assert.equal(st.key, "draft");
  assert.equal(st.ready, false);
  assert.match(st.todo, /あと 1 件/);
});

ok("3件あっても、項目が欠けていれば確定できない", () => {
  const st = F.focusState({ day: { status: "ready" }, tasks: [...three().slice(0, 2), task({ id: "t3", done_condition: "" })] });
  assert.equal(st.key, "draft");
  assert.equal(st.ready, false);
  assert.equal(st.incomplete.length, 1);
  assert.match(st.todo, /足りない項目/);
});

ok("3件そろえば、AIに見てもらえる状態", () => {
  const st = F.focusState({ day: { status: "draft" }, tasks: three() });
  assert.equal(st.key, "ready");
  assert.equal(st.ready, true);
  assert.match(st.todo, /AI/);
});

ok("AIが見たら、人の確認待ち", () => {
  const st = F.focusState({ day: { status: "ai_checked" }, tasks: three() });
  assert.equal(st.key, "ai_checked");
  assert.match(st.todo, /確定/);
});

ok("確定したら確定のまま。あとで件数が減っても戻さない", () => {
  const st = F.focusState({ day: { status: "confirmed" }, tasks: [task()] });
  assert.equal(st.confirmed, true);
  assert.equal(st.key, "confirmed");
});

ok("取りやめたタスクは数えない", () => {
  const st = F.focusState({ day: null, tasks: [...three(), task({ id: "t4", status: "cancelled" })] });
  assert.equal(st.count, 3);
});

console.log("— 日報の解放 —");

ok("確定していなければ、日報は書けない。理由も出す", () => {
  const g = F.nippoGate({ day: { status: "ready" }, tasks: three(), focusDate: "2026-09-17" });
  assert.equal(g.open, false);
  assert.match(g.hint, /2026-09-17/);
  assert.match(g.hint, /3件/);
});

ok("確定していれば書ける", () => {
  const g = F.nippoGate({ day: { status: "confirmed" }, tasks: three(), focusDate: "2026-09-17" });
  assert.equal(g.open, true);
  assert.match(g.hint, /日報/);
});

console.log("— 終わらせる —");

ok("完了の数は「その日に決めた数」が分母", () => {
  const p = F.progressOf([task({ id: "t1", status: "done" }), task({ id: "t2" }), task({ id: "t3" })]);
  assert.equal(p.label, "1 / 3");
  assert.equal(p.done, 1);
  assert.equal(p.total, 3);
  assert.equal(p.allDone, false);
  assert.equal(p.pct, 33);
});

ok("3件そろうと「完了」", () => {
  const p = F.progressOf(three().map((t) => ({ ...t, status: "done" })));
  assert.equal(p.label, "3 / 3");
  assert.equal(p.allDone, true);
  assert.equal(p.pct, 100);
});

ok("取りやめたものは分母からも外す", () => {
  const p = F.progressOf([task({ id: "t1", status: "done" }), task({ id: "t2", status: "cancelled" })]);
  assert.equal(p.label, "1 / 1");
  assert.equal(p.allDone, true);
});

ok("1件も無ければ、完了にはしない", () => {
  assert.equal(F.progressOf([]).allDone, false);
});

console.log("— 明日 —");

ok("平日の翌日は、次の日", () => {
  assert.equal(F.nextFocusDate("2026-09-16"), "2026-09-17");   // 水 → 木
});

ok("金曜の次は月曜（土日を飛ばす）", () => {
  assert.equal(F.nextFocusDate("2026-09-18"), "2026-09-24");   // 金 → next biz day
});

ok("日付でなければ null", () => {
  assert.equal(F.nextFocusDate("きょう"), null);
  assert.equal(F.nextFocusDate(""), null);
});

console.log("— 未完了 —");

ok("選べるのは4つ。自動では決めない", () => {
  assert.deepEqual(F.CARRY_KEYS, ["carry", "lower", "hand", "drop"]);
  for (const c of F.CARRY_CHOICES) assert.ok(c.label && c.hint, c.key);
});

console.log("— 管理者の一覧 —");

const emp = (id, name, dep) => ({ id, display_name: name, department: dep });

ok("3件終わって明日も確定していれば「完了」", () => {
  const r = F.boardRow({
    employee: emp("e1", "A", "営業"),
    today: { day: { status: "confirmed" }, tasks: three().map((t) => ({ ...t, status: "done" })) },
    tomorrow: { day: { status: "confirmed" }, tasks: three() },
  });
  assert.equal(r.state, "done");
  assert.equal(r.stateLabel, "完了");
  assert.equal(r.today.label, "3 / 3");
  assert.equal(r.tomorrow.confirmed, true);
  assert.equal(r.stuck, "");
});

ok("明日が未登録なら「注意」。何が止まっているかも出す", () => {
  const r = F.boardRow({
    employee: emp("e2", "B"),
    today: { day: { status: "confirmed" }, tasks: [task({ status: "done" }), task({ id: "t2" }), task({ id: "t3" })] },
    tomorrow: { day: null, tasks: [] },
  });
  assert.equal(r.state, "warn");
  assert.equal(r.today.label, "1 / 3");
  assert.match(r.stuck, /明日のタスクが未登録/);
});

ok("今日ぶんに手が付いていなければ「注意」", () => {
  const r = F.boardRow({
    employee: emp("e3", "C"),
    today: { day: { status: "confirmed" }, tasks: three() },
    tomorrow: { day: { status: "confirmed" }, tasks: three() },
  });
  assert.equal(r.state, "warn");
  assert.match(r.stuck, /手が付いていません/);
});

ok("明日ぶんがAI確認中なら「進行中」", () => {
  const r = F.boardRow({
    employee: emp("e4", "D"),
    today: { day: { status: "confirmed" }, tasks: [task({ status: "done" }), task({ id: "t2", status: "done" }), task({ id: "t3" })] },
    tomorrow: { day: { status: "ai_checked" }, tasks: three() },
  });
  assert.equal(r.state, "working");
  assert.equal(r.tomorrow.label, "確認待ち");
  assert.match(r.stuck, /確認待ち/);
});

ok("上の数は、止まっている人が分かるだけでよい", () => {
  const rows = [
    F.boardRow({ employee: emp("e1", "A"), today: { tasks: three().map((t) => ({ ...t, status: "done" })) },
                 tomorrow: { day: { status: "confirmed" }, tasks: three() } }),
    F.boardRow({ employee: emp("e2", "B"), today: { tasks: three() }, tomorrow: { tasks: [] } }),
    F.boardRow({ employee: emp("e3", "C"), today: { tasks: three() }, tomorrow: { day: { status: "ready" }, tasks: three() } }),
  ];
  const s = F.boardSummary(rows);
  assert.equal(s.people, 3);
  assert.equal(s.doneAll, 1);
  assert.equal(s.noTomorrow, 1);
  assert.equal(s.waiting, 1);
  assert.equal(s.warn, 2);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
