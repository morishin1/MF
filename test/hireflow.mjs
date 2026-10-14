// Office の入社の流れ（lib/hire-flow.js）。HR → Office 切替ルール：
//   HRで正式契約まで完了 → ［Officeへ引き渡す］ → Office：入社書類 → アカウント・端末 → オリエンテーション → 入社完了
// の4つの言い方にそろえる（正式契約は Office の段ではない。HR で終わっている）。
//
// ■ 何を守るのか
//   1. 4つ。この順。NEXT ACTION は、順番の最初の「済んでいない」ステップ。「正式契約」は Office のステップに無い
//   2. 第3の判定を作らない。既存の段階（computeStage）と食い違わない（完了は段階が complete のときだけ）
//   3. 社員登録の前（手続きが無い）は、入社書類の入り口＝「社員登録をして、入社書類の依頼を始める」
//   4. 並行して進むもの（本人の書類と社内準備）は、各ステップの note に残りを書く
//   5. HR から引き渡された人には「HRで正式契約まで完了」の印（正式契約：署名済み／不要）が付く
//   6. 給与・連絡先など、状態と件数以外を返さない
import assert from "node:assert/strict";
import { hireFlowOf, hrDoneOf, HIRE_STEPS, HIRE_KEYS, HIRE_FROM_HR_LABEL } from "../lib/hire-flow.js";
import { computeStage } from "../lib/onboard-stage.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const it = (owner, status = "todo", required = true, key = "x") => ({ owner, status, required, item_key: key });
const base = () => ({
  procedure: { status: "in_progress" },
  order: null, sign: null, consentsOk: false, profile: null,
  items: [it("employee"), it("employee"), it("hr"), it("it")],
});
const atIntake = (o = {}) => ({
  ...base(), order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true, ...o,
});
const stepOf = (r, key) => r.steps.find((s) => s.key === key);
const states = (r) => r.steps.map((s) => `${s.key}:${s.state}`).join(" ");

console.log("— 4つの定義 —");

ok("4つ。この順（入社書類 / アカウント・端末 / オリエンテーション / 入社完了）。「正式契約」は無い", () => {
  assert.deepEqual(HIRE_KEYS, ["docs", "account", "orientation", "complete"]);
  assert.deepEqual(HIRE_STEPS.map((s) => s.label), ["入社書類", "アカウント・端末", "オリエンテーション", "入社完了"]);
  assert.deepEqual(HIRE_STEPS.map((s) => s.n), [1, 2, 3, 4]);
  const r = hireFlowOf({ facts: base() });
  assert.deepEqual(r.steps.map((s) => s.key), HIRE_KEYS);
  assert.ok(!r.steps.some((s) => /正式契約/.test(s.label)), "Office のステップに「正式契約」は出さない");
});

console.log("— HR から引き渡された人の印（4つの前）—");

const H = (o = {}) => ({ formalRequired: true, formalSignedAt: "2026-10-12T00:00:00Z", ...o });

ok("正式契約が必要だった人：「HRで正式契約まで完了」・正式契約：署名済み", () => {
  const r = hireFlowOf({ handoff: H() });
  assert.deepEqual([r.hr.label, r.hr.detail, r.hr.formalRequired], [HIRE_FROM_HR_LABEL, "正式契約：署名済み", true]);
  assert.equal(HIRE_FROM_HR_LABEL, "HRで正式契約まで完了");
});

ok("正式契約が不要だった人：「HRで正式契約まで完了」・正式契約：不要", () => {
  const r = hireFlowOf({ handoff: H({ formalRequired: false, formalSignedAt: null }) });
  assert.deepEqual([r.hr.label, r.hr.detail, r.hr.formalRequired], [HIRE_FROM_HR_LABEL, "正式契約：不要", false]);
});

ok("HR を通らない人（引き渡しなし）には印を付けない", () => {
  assert.equal(hireFlowOf({ facts: base() }).hr, null);
  assert.equal(hrDoneOf(null), null);
});

console.log("— 社員登録の前（HR から引き渡された人）—");

ok("社員登録の前：NEXT ACTION は入社書類（社員登録をして、依頼を始める。人事・労務の番）", () => {
  const r = hireFlowOf({ handoff: H() });
  assert.equal(r.registered, false);
  assert.equal(r.next.key, "docs");
  assert.equal(r.next.label, "入社書類を集める");
  assert.equal(r.next.phase, "入社書類");
  assert.equal(r.next.actorLabel, "人事・労務");
  assert.match(r.next.note, /社員登録をして、入社書類の依頼を始めます/);
  assert.equal(stepOf(r, "docs").state, "current");
  assert.equal(stepOf(r, "account").state, "todo");
  assert.match(stepOf(r, "account").note, /社員登録のあと/);
  assert.equal(stepOf(r, "orientation").state, "todo");
  assert.equal(stepOf(r, "complete").state, "todo");
});

ok("正式契約の有無で、Office の最初のステップは変わらない（どちらも入社書類から）", () => {
  for (const h of [H(), H({ formalRequired: false, formalSignedAt: null })]) {
    const r = hireFlowOf({ handoff: h });
    assert.equal(r.next.key, "docs");
    assert.equal(states(r), "docs:current account:todo orientation:todo complete:todo");
  }
});

console.log("— 社員登録のあと（既存の段階の事実を並べ直すだけ）—");

ok("契約書類の準備がまだ（段階 conditions）：入社書類・人事・労務の番", () => {
  const r = hireFlowOf({ facts: base() });
  assert.equal(r.registered, true);
  assert.equal(r.next.key, "docs");
  assert.equal(r.next.actorLabel, "人事・労務");
  assert.match(r.next.note, /契約書類の準備がまだ/);
});

ok("社労士の確認待ち（段階 advisor_review）：入社書類・社労士の番", () => {
  const r = hireFlowOf({ facts: { ...base(), order: { status: "sent_to_advisor" } } });
  assert.equal(computeStage({ ...base(), order: { status: "sent_to_advisor" } }).key, "advisor_review");
  assert.equal(r.next.key, "docs");
  assert.equal(r.next.actorLabel, "社労士");
});

ok("本人の締結待ち（段階 signing）：入社書類・本人の番", () => {
  const r = hireFlowOf({ facts: { ...base(), sign: { status: "sent" } } });
  assert.equal(computeStage({ ...base(), sign: { status: "sent" } }).key, "signing");
  assert.equal(r.next.key, "docs");
  assert.equal(r.next.actorLabel, "本人");
});

ok("契約書類の締結が済んだ（段階 intake）：次も入社書類（入社情報の入力・本人の提出書類）", () => {
  const f = atIntake();
  assert.equal(computeStage(f).key, "intake");
  const r = hireFlowOf({ facts: f });
  assert.equal(r.next.key, "docs");
  assert.equal(r.next.actorLabel, "本人");
  assert.match(r.next.note, /入社情報の入力がまだ/);
});

ok("入社書類がそろい、社内準備が残る：次はアカウント・端末（人事・労務）", () => {
  const f = atIntake({
    profile: { status: "submitted" },
    items: [it("employee", "done"), it("hr", "todo"), it("it", "todo")],
  });
  const r = hireFlowOf({ facts: f });
  assert.equal(stepOf(r, "docs").state, "done");
  assert.equal(r.next.key, "account");
  assert.equal(r.next.label, "アカウント・端末を用意する");
  assert.match(r.next.note, /社内準備が 2 件残っています/);
});

ok("社内準備もそろい、オリエンテーションが残る：次はオリエンテーション（本人）", () => {
  const f = atIntake({
    profile: { status: "submitted" }, orientationOk: false,
    items: [it("employee", "done"), it("hr", "done"), it("it", "done")],
  });
  const r = hireFlowOf({ facts: f });
  assert.equal(stepOf(r, "account").state, "done");
  assert.equal(r.next.key, "orientation");
  assert.equal(r.next.actorLabel, "本人");
});

ok("並行して進むもの：本人の書類と社内準備が両方残るときは、先に入社書類。社内準備の残りも note に出る", () => {
  const f = atIntake({ items: [it("employee", "todo"), it("it", "todo")] });
  const r = hireFlowOf({ facts: f });
  assert.equal(r.next.key, "docs");
  assert.match(stepOf(r, "docs").note, /入社情報の入力がまだ/);
  assert.match(stepOf(r, "docs").note, /書類の提出が 1 件残っています/);
  assert.equal(stepOf(r, "account").state, "todo");
  assert.match(stepOf(r, "account").note, /社内準備が 1 件残っています/);
});

ok("全部そろった（段階 complete）：入社完了。ほかも全部 done", () => {
  const f = atIntake({ profile: { status: "submitted" }, items: [it("employee", "done"), it("hr", "done")] });
  assert.equal(computeStage(f).key, "complete");
  const r = hireFlowOf({ facts: f });
  assert.equal(r.complete, true);
  assert.equal(r.next.key, "complete");
  assert.equal(r.next.done, true);
  assert.ok(r.steps.every((s) => s.state === "done"), states(r));
});

ok("管理者が手続きを完了にした：入社完了（段階が complete）", () => {
  const f = { ...base(), procedure: { status: "done" } };
  const r = hireFlowOf({ facts: f });
  assert.equal(r.complete, true);
  assert.ok(r.steps.every((s) => s.state === "done"));
});

ok("LegalSign の正式契約が HR で済んでいる人の、契約書類（雇用契約書など）の準備は、別の書類の話だと分かる言い方", () => {
  for (const [facts, who] of [[base(), "人事・労務"], [{ ...base(), order: { status: "sent_to_advisor" } }, "社労士"], [{ ...base(), sign: { status: "sent" } }, "本人"]]) {
    const r = hireFlowOf({ handoff: H(), facts });
    assert.equal(r.next.key, "docs");
    assert.equal(r.next.actorLabel, who);
    assert.match(r.next.note, /^LegalSign の正式契約は HR で済んでいます。/);
  }
  // 引き渡しでない人・正式契約が不要の人には付けない
  assert.doesNotMatch(hireFlowOf({ facts: base() }).next.note, /LegalSign/);
  assert.doesNotMatch(hireFlowOf({ handoff: H({ formalRequired: false, formalSignedAt: null }), facts: base() }).next.note, /LegalSign/);
  // 締結が済んでいれば（段階 intake）、次の段階に進むだけ
  assert.equal(hireFlowOf({ handoff: H(), facts: atIntake() }).next.key, "docs");
});

ok("取り消した手続き：全部 na。NEXT ACTION は出さない", () => {
  const r = hireFlowOf({ facts: { ...base(), procedure: { status: "cancelled" } } });
  assert.equal(r.cancelled, true);
  assert.ok(r.steps.every((s) => s.state === "na"));
  assert.match(r.next.label, /取り消されました/);
});

console.log("— 第3の判定を作らない —");

ok("完了と言うのは、既存の段階が complete のときだけ（事実の組み合わせすべてで食い違わない）", () => {
  const orders = [null, { status: "sent" }, { status: "uploaded" }, { status: "signed" }];
  const signs = [null, { status: "sent" }, { status: "signed" }];
  let n = 0;
  for (const order of orders) for (const sign of signs) for (const consentsOk of [false, true])
    for (const profile of [null, { status: "submitted" }]) for (const emp of ["todo", "done"])
      for (const internal of ["todo", "done"]) for (const orientationOk of [true, false]) {
        const f = { ...base(), order, sign, consentsOk, profile, orientationOk,
          items: [it("employee", emp), it("hr", internal), it("it", internal)] };
        const stage = computeStage(f).key;
        const r = hireFlowOf({ facts: f });
        n++;
        assert.equal(r.complete, stage === "complete", `${JSON.stringify({ order, sign, consentsOk, profile, emp, internal, orientationOk })} → 段階 ${stage} / 完了 ${r.complete}`);
        // 契約書類の締結が済んでいる（入社書類は入社情報・提出書類の段）のは、段階が intake 以降のときだけ。それまでは入社書類が「契約書類」の言い方
        if (!["intake", "complete"].includes(stage)) assert.equal(stepOf(r, "docs").state, "current");
        // NEXT ACTION が1つだけ current になる（完了を除く）
        const cur = r.steps.filter((s) => s.state === "current");
        assert.equal(cur.length, stage === "complete" ? 0 : 1, states(r));
      }
  assert.ok(n > 100);
});

ok("給与・連絡先などを返さない（状態と件数だけ）", () => {
  const r = hireFlowOf({ handoff: { ...H(), wageAmount: 300000, email: "a@example.com", accept_ip: "1.2.3.4", legalsignUrl: "https://sign.example/x" } });
  const s = JSON.stringify(r);
  assert.ok(!/300000|a@example|1\.2\.3\.4|sign\.example/.test(s));
});

console.log(`\n${pass} 件OK${fail ? ` / ${fail} 件NG` : ""}`);
process.exit(fail ? 1 : 0);
