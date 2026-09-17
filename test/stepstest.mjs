// 入社手続きのSTEP（1〜6）。3者共通。
//
// ■ 何を守るか
//   1. 6つの順番と名前、担当
//   2. 社労士が発行するまで、本人契約は動かせない（社労士確認が先）
//   3. 契約・同意が済んでも、社内準備（会社確認）が残れば完了にしない
//   4. マイナンバー確認書類（受け取らないもの）は、STEP 4 を止めない
//   5. 会社確認の内訳を渡せない呼び出し元でも、段階で代わりに判定する（後方互換）
//   6. 「今どこで止まっているか」は、見ている人によって言い方が変わる
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { computeSteps, statusBanner, STEPS, STEP_KEYS } = await import(join(ROOT, "lib/onboard-steps.js"));

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
const employment = (status) => [
  { id: "s1", title: "労働条件通知書", kind: "employment", status, dueOn: "2026-10-01" },
];
const base = () => ({
  contracts: [], consents: consents(false), orientation: [],
  profileStatus: "draft", missing: [{ label: "住所" }], documents: docs(),
  stage: "advisor_review", procedureStatus: "in_progress",
});
const at = (r, key) => r.steps.find((s) => s.key === key);

console.log("\n=== 入社手続きのSTEP（3者共通）===\n");

ok("6つ、この順・この担当", () => {
  assert.deepEqual(STEP_KEYS,
    ["advisor_check", "contract", "profile", "documents", "company", "complete"]);
  assert.deepEqual(STEPS.map((s) => s.actor),
    ["advisor", "employee", "employee", "employee", "admin", null]);
});

console.log("— 1. 社労士確認 —");

ok("社労士が発行するまで、STEP1は未完了。今は社労士の番", () => {
  const r = computeSteps(base());
  assert.equal(at(r, "advisor_check").done, false);
  assert.equal(r.current, "advisor_check");
});

ok("発行された（本人あての契約書面ができた）ら、STEP1は完了", () => {
  const r = computeSteps({ ...base(), contracts: employment("sent") });
  assert.equal(at(r, "advisor_check").done, true);
});

console.log("— 2. 本人契約 —");

ok("社労士確認が済むまで、本人契約は動かせない（先に進ませない）", () => {
  const r = computeSteps({ ...base(), consents: consents(true) });
  assert.equal(r.current, "advisor_check");
  assert.equal(at(r, "contract").done, false);
});

ok("発行されたら、本人契約が今の番", () => {
  const r = computeSteps({ ...base(), contracts: employment("sent") });
  assert.equal(r.current, "contract");
  assert.ok(at(r, "contract").items.some((i) => /締結/.test(i.note)));
});

ok("締結しても、同意が残っていればSTEP2のまま", () => {
  const r = computeSteps({ ...base(), contracts: employment("signed"), consents: consents(false) });
  assert.equal(r.current, "contract");
  assert.equal(at(r, "contract").done, false);
});

ok("改定された同意は、済んでいない扱い", () => {
  const r = computeSteps({
    ...base(), contracts: employment("signed"),
    consents: [{ key: "rules", title: "社内ルール", agreed: true, needsReconsent: true }],
  });
  assert.equal(at(r, "contract").done, false);
});

ok("締結と同意が済んだら、次は入社情報", () => {
  const r = computeSteps({ ...base(), contracts: employment("signed"), consents: consents(true) });
  assert.equal(r.current, "profile");
  assert.equal(at(r, "contract").done, true);
});

console.log("— 3. 入社情報 —");

ok("未入力の項目は、いくつ残っているかを出す", () => {
  const r = computeSteps({ ...base(), missing: [{ label: "住所" }, { label: "電話番号" }] });
  assert.match(at(r, "profile").items[0].note, /あと 2 項目/);
});

ok("入社情報を出したら、次は書類", () => {
  const r = computeSteps({
    ...base(), contracts: employment("signed"), consents: consents(true),
    profileStatus: "submitted", missing: [],
  });
  assert.equal(r.current, "documents");
  assert.equal(at(r, "profile").done, true);
});

console.log("— 4. 必要書類（＋オリエンテーション）—");

ok("オリエンテーションも、必要書類のSTEPに含める", () => {
  const r = computeSteps({
    ...base(), contracts: employment("signed"), consents: consents(true),
    profileStatus: "submitted", missing: [], documents: docs("submitted"),
    orientation: [{ id: "o1", title: "会社説明", required: true, confirmed: false }],
  });
  assert.equal(at(r, "documents").done, false);
  assert.ok(at(r, "documents").items.some((i) => i.label === "会社説明"));
});

ok("任意の教材は、確認していなくても止めない", () => {
  const r = computeSteps({
    ...base(), contracts: employment("signed"), consents: consents(true),
    profileStatus: "submitted", missing: [], documents: docs("submitted"),
    orientation: [{ id: "o1", title: "おまけ", required: false, confirmed: false }],
  });
  assert.equal(at(r, "documents").done, true);
});

ok("このシステムで受け取らない書類は、STEP4に出さない", () => {
  const r = computeSteps({
    ...base(), contracts: employment("signed"), consents: consents(true),
    profileStatus: "submitted", missing: [],
    documents: [...docs("submitted"),
      { key: "doc_mynumber", title: "マイナンバー確認書類", required: false, status: "todo", collect: false }],
  });
  assert.equal(at(r, "documents").done, true);
  assert.ok(!at(r, "documents").items.some((i) => /マイナンバー/.test(i.label)));
});

const employeeDone = () => ({
  ...base(),
  contracts: employment("signed"), consents: consents(true),
  profileStatus: "submitted", missing: [], documents: docs("submitted"),
  stage: "intake",
});

console.log("— 5. 会社確認（並行して進む）—");

ok("内訳を渡せば、それで判定する", () => {
  const r = computeSteps({ ...employeeDone(),
    internalItems: [{ title: "PC準備", status: "todo" }, { title: "Slack発行", status: "done" }] });
  assert.equal(at(r, "company").done, false);
  assert.equal(r.current, "company");
  assert.match(at(r, "company").items[0].note, /準備中/);
});

ok("会社側が全部済めば、会社確認も完了", () => {
  const r = computeSteps({ ...employeeDone(),
    internalItems: [{ title: "PC準備", status: "done" }, { title: "Slack発行", status: "done" }] });
  assert.equal(at(r, "company").done, true);
});

ok("任意の項目は、済んでいなくても止めない", () => {
  const r = computeSteps({ ...employeeDone(),
    internalItems: [{ title: "PC準備", status: "done" }, { title: "ロッカー", required: false, status: "todo" }] });
  assert.equal(at(r, "company").done, true);
});

ok("内訳を渡せない呼び出し元は、これまでどおり段階で判定する（後方互換）", () => {
  const r1 = computeSteps({ ...employeeDone() });
  assert.equal(at(r1, "company").done, false);
  const r2 = computeSteps({ ...employeeDone(), stage: "complete" });
  assert.equal(at(r2, "company").done, true);
});

console.log("— 6. 完了 —");

ok("本人・社労士のぶんが終わっても、会社確認が残れば完了にしない", () => {
  const r = computeSteps({ ...employeeDone(),
    internalItems: [{ title: "PC準備", status: "todo" }] });
  assert.equal(r.allMine, true);
  assert.equal(at(r, "complete").done, false);
  assert.match(at(r, "complete").todo, /会社側の準備/);
});

ok("段階がcompleteになったら、完了", () => {
  const r = computeSteps({ ...employeeDone(), stage: "complete",
    internalItems: [{ title: "PC準備", status: "done" }] });
  assert.equal(at(r, "complete").done, true);
  assert.equal(r.pct, 100);
});

ok("手続きがdoneでも完了", () => {
  const r = computeSteps({ ...employeeDone(), procedureStatus: "done" });
  assert.equal(at(r, "complete").done, true);
});

ok("進み具合は、済んだSTEPの数で出す（6分の1＝17%）", () => {
  const r = computeSteps({ ...base(), contracts: employment("sent") });
  // 社労士確認だけ済んでいる状態
  assert.equal(r.pct, 17);
});

console.log("\n=== 「今どこか」の言い方（statusBanner）===\n");

ok("社労士確認中：本人には「待ち」、社労士には「自分の番」", () => {
  const r = computeSteps(base());
  const forSelf = statusBanner(r, "self");
  assert.equal(forSelf.mine, false);
  assert.match(forSelf.title, /社労士確認待ち/);
  assert.match(forSelf.detail, /社労士が確認しています/);

  const forAdvisor = statusBanner(r, "advisor");
  assert.equal(forAdvisor.mine, true);
  assert.match(forAdvisor.title, /確認をお願いします/);
});

ok("発行後：本人には「自分の番」、管理者・社労士には「本人待ち」", () => {
  const r = computeSteps({ ...base(), contracts: employment("sent") });
  const forSelf = statusBanner(r, "self");
  assert.equal(forSelf.mine, true);
  assert.match(forSelf.title, /あなたの確認が必要です/);

  const forAdmin = statusBanner(r, "admin");
  assert.equal(forAdmin.mine, false);
  assert.match(forAdmin.detail, /送付済み/);
  assert.equal(forAdmin.nextActorLabel, "本人");
});

ok("会社確認中：管理者には「自分の番」、本人には「待ち」", () => {
  const r = computeSteps({ ...employeeDone(),
    internalItems: [{ title: "PC準備", status: "todo" }] });
  const forAdmin = statusBanner(r, "admin");
  assert.equal(forAdmin.mine, true);
  assert.match(forAdmin.title, /社内準備をお願いします/);

  const forSelf = statusBanner(r, "self");
  assert.equal(forSelf.mine, false);
});

ok("完了：誰が見ても同じ文", () => {
  const r = computeSteps({ ...employeeDone(), stage: "complete",
    internalItems: [{ title: "PC準備", status: "done" }] });
  const b = statusBanner(r, "self");
  assert.match(b.title, /完了/);
  assert.equal(b.nextActorLabel, "—");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
