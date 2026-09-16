// 本人の画面の STEP（1〜5）。
//
// ■ 何を守るか
//   1. 5つの順番と名前
//   2. 「今やること」は、本人が動ける最初の STEP。待つだけの STEP は飛ばす
//   3. 契約書が届いていなくても、情報入力や書類提出は進められる
//   4. マイナンバー確認書類（受け取らないもの）は、STEP 4 を止めない
//   5. 本人のぶんが全部終わっても、社内準備が残っていれば「完了」にはならない
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { computeSteps, EMP_STEPS } = await import(join(ROOT, "lib/onboard-steps.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const consents = (agreed) => [
  { key: "pledge", title: "誓約書", agreed },
  { key: "privacy", title: "個人情報の取扱い", agreed },
  { key: "rules", title: "社内ルール確認書", agreed },
];
const docs = (status = "todo") => [
  { key: "doc_resume", title: "履歴書", required: true, status },
  { key: "doc_dependents", title: "扶養控除等申告書", required: true, status },
];
const base = () => ({
  contracts: [], consents: consents(false), orientation: [],
  profileStatus: "draft", missing: [{ label: "住所" }], documents: docs(),
  stage: "signing", procedureStatus: "in_progress",
});
const at = (r, key) => r.steps.find((s) => s.key === key);

console.log("\n=== 本人の STEP ===\n");

ok("5つ、この順", () => {
  assert.deepEqual(EMP_STEPS.map((s) => s.key),
    ["contract", "orientation", "profile", "documents", "complete"]);
});

ok("契約書が届いていないうちは、待ちにして先へ進ませる", () => {
  const r = computeSteps({ ...base(), consents: consents(true) });
  assert.equal(at(r, "contract").state, "waiting");
  // オリエンテーションが無ければ、次に動けるのは入社情報
  assert.equal(r.current, "profile");
});

ok("契約書が届いていたら、まず締結", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "労働条件通知書", kind: "employment", status: "sent", dueOn: "2026-10-01" }],
  });
  assert.equal(r.current, "contract");
  assert.equal(at(r, "contract").state, "current");
  assert.ok(at(r, "contract").items.some((i) => /締結/.test(i.note)));
});

ok("締結しても、同意が残っていれば STEP 1 のまま", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "労働条件通知書", kind: "employment", status: "signed" }],
    consents: consents(false),
  });
  assert.equal(r.current, "contract");
  assert.equal(at(r, "contract").done, false);
});

ok("改定された同意は、済んでいない扱い", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: [{ key: "rules", title: "社内ルール", agreed: true, needsReconsent: true }],
  });
  assert.equal(at(r, "contract").done, false);
});

ok("締結と同意が済んだら、オリエンテーション", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true),
    orientation: [{ id: "o1", title: "会社説明", required: true, confirmed: false }],
  });
  assert.equal(r.current, "orientation");
  assert.equal(at(r, "contract").done, true);
});

ok("任意の教材は、確認していなくても止めない", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true),
    orientation: [{ id: "o1", title: "おまけ", required: false, confirmed: false }],
  });
  assert.equal(at(r, "orientation").done, true);
  assert.equal(r.current, "profile");
});

ok("教材が1つも無ければ、STEP 2 は済んだ扱い", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true),
  });
  assert.equal(at(r, "orientation").done, true);
});

ok("入社情報を出したら、次は書類", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true), profileStatus: "submitted", missing: [],
  });
  assert.equal(r.current, "documents");
  assert.equal(at(r, "profile").done, true);
});

ok("未入力の項目は、いくつ残っているかを出す", () => {
  const r = computeSteps({ ...base(), missing: [{ label: "住所" }, { label: "電話番号" }] });
  assert.match(at(r, "profile").items[0].note, /あと 2 項目/);
});

ok("このシステムで受け取らない書類は、STEP 4 に出さない", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true), profileStatus: "submitted", missing: [],
    documents: [...docs("submitted"),
      { key: "doc_mynumber", title: "マイナンバー確認書類", required: false, status: "todo", collect: false }],
  });
  assert.equal(at(r, "documents").done, true);
  assert.ok(!at(r, "documents").items.some((i) => /マイナンバー/.test(i.label)));
});

ok("任意の書類は、出ていなくても止めない", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true), profileStatus: "submitted", missing: [],
    documents: [{ key: "doc_resume", title: "履歴書", required: true, status: "done" },
                { key: "doc_pension", title: "年金手帳", required: false, status: "todo" }],
  });
  assert.equal(at(r, "documents").done, true);
});

const allMineDone = () => ({
  ...base(),
  contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
  consents: consents(true), profileStatus: "submitted", missing: [],
  documents: docs("submitted"), stage: "intake",
});

ok("本人のぶんが終わっても、社内準備が残れば完了にしない", () => {
  const r = computeSteps(allMineDone());
  assert.equal(r.allMine, true);
  assert.equal(at(r, "complete").done, false);
  assert.equal(at(r, "complete").state, "waiting");
  assert.match(at(r, "complete").todo, /会社側の準備/);
});

ok("段階が complete になったら、STEP 5 も済み", () => {
  const r = computeSteps({ ...allMineDone(), stage: "complete" });
  assert.equal(at(r, "complete").done, true);
  assert.equal(r.pct, 100);
});

ok("手続きが done でも完了", () => {
  const r = computeSteps({ ...allMineDone(), procedureStatus: "done" });
  assert.equal(at(r, "complete").done, true);
});

ok("進み具合は、済んだ STEP の数で出す", () => {
  const r = computeSteps({
    ...base(),
    contracts: [{ id: "s1", title: "x", kind: "employment", status: "signed" }],
    consents: consents(true),
  });
  // 契約書・オリエンテーション（項目なし）の2つが済み → 40%
  assert.equal(r.pct, 40);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
