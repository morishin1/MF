// とりあえずメモ。純粋関数だけを見る。
//
// ■ 何を守るテストか
//
//   1. 空・長すぎる本文は保存させない
//   2. 決定は4つだけ。それ以外は認めない
//   3. task/hand を選んだときだけ、タスクの下書きを作る（self/dropでは作らない）
//   4. hand のときは、担当をその人にする。それ以外は本人のまま
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = await import(join(ROOT, "lib/quick-memo.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== とりあえずメモ（純粋関数） ===\n");

console.log("— 本文の整形 —");

ok("前後の空白を削る", () => {
  assert.equal(M.cleanBody("  A社 見積確認  "), "A社 見積確認");
});
ok("空・空白だけは null（保存させない）", () => {
  assert.equal(M.cleanBody(""), null);
  assert.equal(M.cleanBody("   "), null);
  assert.equal(M.cleanBody(undefined), null);
});
ok(`${M.BODY_MAX}文字を超えたら切る`, () => {
  const long = "あ".repeat(M.BODY_MAX + 50);
  assert.equal(M.cleanBody(long).length, M.BODY_MAX);
});
ok("連続する空白・改行は1つにまとめる", () => {
  assert.equal(M.cleanBody("A社\n\n見積   確認"), "A社 見積 確認");
});

console.log("— 決定 —");

ok("決定は4つだけ", () => {
  assert.deepEqual(M.DECISION_KEYS, ["task", "self", "hand", "drop"]);
});
ok("4つ以外は認めない", () => {
  assert.equal(M.isDecision("task"), true);
  assert.equal(M.isDecision("carry"), false);
  assert.equal(M.isDecision(""), false);
  assert.equal(M.isDecision(undefined), false);
});
ok("ラベルが引ける", () => {
  assert.equal(M.decisionLabel("task"), "正式タスク化");
  assert.equal(M.decisionLabel("hand"), "他の人へ依頼");
});

console.log("— タスクの下書き —");

const memo = { id: "m1", employee_id: "emp-1", body: "A社へ見積を送る" };

ok("task：本人のタスクとして下書きを作る", () => {
  const d = M.taskDraftFor(memo, "task", { createdBy: "u-1" });
  assert.ok(d);
  assert.equal(d.title, "A社へ見積を送る");
  assert.equal(d.assignee_id, "emp-1");
  assert.equal(d.status, "todo");
  assert.equal(d.created_by, "u-1");
});
ok("hand：渡す相手を担当にする", () => {
  const d = M.taskDraftFor(memo, "hand", { assigneeId: "emp-2" });
  assert.equal(d.assignee_id, "emp-2");
});
ok("hand：相手を指定しなければ担当は空（勝手に本人にしない）", () => {
  const d = M.taskDraftFor(memo, "hand", {});
  assert.equal(d.assignee_id, null);
});
ok("self・drop はタスクを作らない", () => {
  assert.equal(M.taskDraftFor(memo, "self"), null);
  assert.equal(M.taskDraftFor(memo, "drop"), null);
});
ok("既定の優先度は「ふつう」。明日の3つには入れない（focus_date を持たせない）", () => {
  const d = M.taskDraftFor(memo, "task");
  assert.equal(d.priority, "normal");
  assert.ok(!("focus_date" in d));
  assert.ok(!("focus_for" in d));
});

console.log("— 画面向けの形 —");

ok("rowOf：DBの行を画面が使う形にそろえる", () => {
  const r = M.rowOf({
    id: "m1", body: "見積確認", status: "decided", decision: "task",
    decision_note: null, ai_decision: "task", ai_reason: "内容が明確",
    promoted_task_id: "t9", created_at: "2026-09-16T00:00:00Z",
  });
  assert.equal(r.decisionLabel, "正式タスク化");
  assert.equal(r.aiReason, "内容が明確");
  assert.equal(r.promotedTaskId, "t9");
});
ok("rowOf：決めていないものは decisionLabel も null", () => {
  const r = M.rowOf({ id: "m1", body: "x", status: "open", created_at: "2026-09-16T00:00:00Z" });
  assert.equal(r.decision, null);
  assert.equal(r.decisionLabel, null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
