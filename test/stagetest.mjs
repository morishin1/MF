// 入社手続きの段階。
//
// ■ 何を守るのか
//
//   段階の判定は1か所（lib/onboard-stage.js）で、5つの表の事実から出す。
//   ここがずれると、一覧・ダッシュボード・通知の3つが別の答えを出す。
//
//   守るのは
//     1. 事実 → 段階 が、決めた5段階の順に進むこと
//     2. 「次に誰が」が、段階ごとに正しく出ること
//     3. 社内準備は本人の作業と並行で、④を止めないが完了は止めること
//     4. KPI が重なりを許して数えること
import assert from "node:assert/strict";
import {
  computeStage, kpiOf, progressPct, daysToStart, stuckLine, STAGES,
} from "../lib/onboard-stage.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const item = (owner, status = "todo", required = true) => ({ owner, status, required });
const base = () => ({
  procedure: { status: "in_progress" },
  order: null, sign: null, consentsOk: false, profile: null,
  items: [item("employee"), item("employee"), item("hr"), item("it")],
});

console.log("— 5段階の順に進む —");

ok("段階は5つで、この順", () => {
  assert.deepEqual(STAGES.map((s) => s.key),
    ["conditions", "advisor_review", "signing", "intake", "complete"]);
});

ok("① 作成依頼を出していなければ、管理者の番", () => {
  const s = computeStage(base());
  assert.equal(s.key, "conditions");
  assert.deepEqual(s.nextActors, ["admin"]);
});

ok("② 依頼を出したら、社労士の番", () => {
  const s = computeStage({ ...base(), order: { status: "requested" } });
  assert.equal(s.key, "advisor_review");
  assert.deepEqual(s.nextActors, ["advisor"]);
});

ok("② 書面が届いても、発行前なら社労士の番のまま", () => {
  const s = computeStage({ ...base(), order: { status: "uploaded" } });
  assert.equal(s.key, "advisor_review");
  assert.match(s.blockers[0], /発行/);
});

ok("③ 発行したら、本人の番", () => {
  const s = computeStage({ ...base(), order: { status: "sent" }, sign: { status: "sent" } });
  assert.equal(s.key, "signing");
  assert.deepEqual(s.nextActors, ["employee"]);
});

ok("③ 署名しても、誓約書の同意が残っていれば締結のまま", () => {
  const s = computeStage({ ...base(), order: { status: "signed" },
                           sign: { status: "signed" }, consentsOk: false });
  assert.equal(s.key, "signing");
  assert.match(s.blockers.join(","), /同意/);
});

ok("④ 締結が済んだら、情報入力へ", () => {
  const s = computeStage({ ...base(), order: { status: "signed" },
                           sign: { status: "signed" }, consentsOk: true });
  assert.equal(s.key, "intake");
  assert.ok(s.nextActors.includes("employee"));
});

ok("④ 本人が出し終えても、社内準備が残れば完了にしない", () => {
  const f = { ...base(), order: { status: "signed" }, sign: { status: "signed" },
              consentsOk: true, profile: { status: "submitted" },
              items: [item("employee", "submitted"), item("hr"), item("it", "done")] };
  const s = computeStage(f);
  assert.equal(s.key, "intake");
  assert.deepEqual(s.nextActors, ["admin"], "本人はもう待たせない");
  assert.match(s.blockers[0], /社内準備が 1 件/);
});

ok("④ 社内準備は本人の作業を止めない（並行）", () => {
  // 社内が全部済んでいても、本人が出していなければ本人の番
  const f = { ...base(), order: { status: "signed" }, sign: { status: "signed" },
              consentsOk: true, profile: { status: "draft" },
              items: [item("employee"), item("hr", "done"), item("it", "done")] };
  const s = computeStage(f);
  assert.equal(s.key, "intake");
  assert.deepEqual(s.nextActors, ["employee"]);
});

ok("⑤ 全部そろったら完了", () => {
  const f = { ...base(), order: { status: "signed" }, sign: { status: "signed" },
              consentsOk: true, profile: { status: "submitted" },
              items: [item("employee", "done"), item("hr", "done"), item("it", "na")] };
  const s = computeStage(f);
  assert.equal(s.key, "complete");
  assert.deepEqual(s.blockers, []);
});

ok("任意の書類は、出ていなくても完了を止めない", () => {
  const f = { ...base(), order: { status: "signed" }, sign: { status: "signed" },
              consentsOk: true, profile: { status: "submitted" },
              items: [item("employee", "todo", false), item("hr", "done")] };
  assert.equal(computeStage(f).key, "complete");
});

ok("手続きが done なら、事実に関係なく完了", () => {
  assert.equal(computeStage({ ...base(), procedure: { status: "done" } }).key, "complete");
});

ok("取り消した依頼は、無いものとして扱う", () => {
  const s = computeStage({ ...base(), order: { status: "cancelled" } });
  assert.equal(s.key, "conditions");
});

console.log("\n— 進捗と日数 —");

ok("段階で刻み、④の中は書類の消化で刻む", () => {
  assert.equal(progressPct("conditions", []), 0);
  assert.equal(progressPct("advisor_review", []), 20);
  assert.equal(progressPct("signing", []), 40);
  assert.equal(progressPct("complete", []), 100);
  const half = [item("employee", "done"), item("hr")];
  assert.equal(progressPct("intake", half), 70);
});

ok("入社までの日数", () => {
  assert.equal(daysToStart("2026-10-01", "2026-09-15"), 16);
  assert.equal(daysToStart("2026-09-10", "2026-09-15"), -5);
  assert.equal(daysToStart(null, "2026-09-15"), null);
});

console.log("\n— KPI —");

ok("5つの数。重なりを許す", () => {
  const rows = [
    { kind: "onboarding", stage: "advisor_review", nextActors: ["advisor"], internalOpen: 3 },
    { kind: "onboarding", stage: "advisor_review", nextActors: ["advisor"], internalOpen: 0 },
    { kind: "onboarding", stage: "signing", nextActors: ["employee"], internalOpen: 2 },
    { kind: "onboarding", stage: "intake", nextActors: ["admin"], internalOpen: 1 },
    { kind: "onboarding", stage: "complete", nextActors: [], internalOpen: 0 },
    { kind: "offboarding", stage: "intake", nextActors: ["admin"], internalOpen: 1 },
  ];
  const k = kpiOf(rows);
  assert.equal(k.planned, 4, "完了していない入社");
  assert.equal(k.advisor, 2);
  assert.equal(k.employee, 1, "③ と、④で本人待ちのもの");
  assert.equal(k.prep, 3, "社内準備が残っているもの（段階は問わない）");
  assert.equal(k.complete, 1);
});

ok("退社は数えない", () => {
  const k = kpiOf([{ kind: "offboarding", stage: "intake", nextActors: [], internalOpen: 0 }]);
  assert.equal(k.planned, 0);
});

ok("一覧の「何が止まっているか」は 誰：何 の1行", () => {
  const line = stuckLine({ stage: "advisor_review", blockers: ["社労士の確認待ちです"] });
  assert.equal(line, "社労士：社労士の確認待ちです");
  assert.equal(stuckLine({ stage: "complete", blockers: [] }), "");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
