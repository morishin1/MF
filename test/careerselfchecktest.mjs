// 本人の自己チェック（lib/career.js の upsertSelfCheck・selfCheckView）。db/110。
//
// ■ 何を守るテストか（GW キャリア基準「10件表示・本人自己チェック」改善 §20）
//   1. 基準が10件なら10件ぶん返す（切り詰めない）
//   2. 本人のチェック（checked）と、会社の正式評価（confirmedStatus）は別の値のまま持つ
//      （どちらかからどちらかを計算しない・上書きしない）
//   3. チェック・解除の両方を、他の基準の値を壊さずに保存できる
//   4. 本人は「できる」と思っているが会社はまだ、という認識差（mismatches）を拾える
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const C = await import(join(ROOT, "lib/career.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const crit = (over = {}) => ({
  id: "c1", category: "業務遂行", title: "担当タスクを期限内に完了できる", required: true,
  sort_order: 0, is_active: true, ...over,
});
const CRITERIA_10 = Array.from({ length: 10 }, (_, i) => crit({ id: `c${i}`, sort_order: i, title: `基準${i}` }));

console.log("\n=== upsertSelfCheck ===\n");

ok("無い基準は追加、ある基準は上書き。他の基準はそのまま", () => {
  let list = C.upsertSelfCheck([], "c1", true, "2026-09-30T00:00:00Z");
  assert.deepEqual(list, [{ criterionId: "c1", checked: true, checkedAt: "2026-09-30T00:00:00Z" }]);
  list = C.upsertSelfCheck(list, "c2", true, "2026-09-30T01:00:00Z");
  assert.equal(list.length, 2);
  list = C.upsertSelfCheck(list, "c1", false, "2026-09-30T02:00:00Z");
  assert.equal(list.length, 2, "件数は増えない（上書き）");
  assert.deepEqual(list.find((x) => x.criterionId === "c1"),
    { criterionId: "c1", checked: false, checkedAt: "2026-09-30T02:00:00Z" });
  assert.equal(list.find((x) => x.criterionId === "c2").checked, true, "他の基準は変わらない");
});

ok("既存値が配列でなくても（null・未定義）壊れない", () => {
  assert.deepEqual(C.upsertSelfCheck(null, "c1", true, "t"), [{ criterionId: "c1", checked: true, checkedAt: "t" }]);
  assert.deepEqual(C.upsertSelfCheck(undefined, "c1", true, "t"), [{ criterionId: "c1", checked: true, checkedAt: "t" }]);
});

console.log("\n=== selfCheckView：基準10件なら10件ぶん返す ===\n");

ok("基準が10件なら10件（6件などに切り詰めない）", () => {
  const v = C.selfCheckView(CRITERIA_10, [], []);
  assert.equal(v.total, 10);
  assert.equal(v.items.length, 10);
  assert.equal(v.checked, 0);
});

ok("非アクティブな基準は数えない", () => {
  const v = C.selfCheckView([...CRITERIA_10, crit({ id: "c-off", is_active: false })], [], []);
  assert.equal(v.total, 10);
});

console.log("\n=== selfCheckView：本人チェックと会社評価は別の値 ===\n");

ok("チェックしても confirmedStatus は変わらない（デフォルト not_yet）", () => {
  const v = C.selfCheckView(CRITERIA_10, [{ criterionId: "c0", checked: true, checkedAt: "t" }], []);
  const item = v.items.find((i) => i.id === "c0");
  assert.equal(item.checked, true);
  assert.equal(item.confirmedStatus, "not_yet");
  assert.equal(item.confirmedLabel, "まだ", "会社向けの「未達」より、本人向けの言い方（memberLabel）を使う");
});

ok("正式評価があっても、本人のチェックは書き換わらない", () => {
  const v = C.selfCheckView(CRITERIA_10,
    [{ criterionId: "c0", checked: false, checkedAt: "t" }],
    [{ criterionId: "c0", result: "achieved" }]);
  const item = v.items.find((i) => i.id === "c0");
  assert.equal(item.checked, false, "本人は未チェックのまま（会社がachievedでも自動で変わらない）");
  assert.equal(item.confirmedStatus, "achieved");
});

ok("updatedAt は自己チェックの最新の checkedAt", () => {
  const v = C.selfCheckView(CRITERIA_10, [
    { criterionId: "c0", checked: true, checkedAt: "2026-09-01T00:00:00Z" },
    { criterionId: "c1", checked: true, checkedAt: "2026-09-30T00:00:00Z" },
  ], []);
  assert.equal(v.updatedAt, "2026-09-30T00:00:00Z");
});

console.log("\n=== selfCheckView：認識差（mismatches） ===\n");

ok("本人はできると思っているが、会社の正式評価はまだ → 認識差", () => {
  const v = C.selfCheckView(CRITERIA_10,
    [{ criterionId: "c0", checked: true, checkedAt: "t" }],
    [{ criterionId: "c0", result: "in_progress" }]);
  assert.equal(v.mismatches.length, 1);
  assert.equal(v.mismatches[0].id, "c0");
});

ok("本人チェック・会社評価とも一致（achieved）なら認識差ではない", () => {
  const v = C.selfCheckView(CRITERIA_10,
    [{ criterionId: "c0", checked: true, checkedAt: "t" }],
    [{ criterionId: "c0", result: "achieved" }]);
  assert.equal(v.mismatches.length, 0);
});

ok("本人が未チェックなら、会社が未評価でも認識差にしない", () => {
  const v = C.selfCheckView(CRITERIA_10, [], []);
  assert.equal(v.mismatches.length, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
