// 入社準備の6ステップ（lib/onboard-six.js）。
//
// ■ 何を守るのか
//
//   1. 4つ目の判定を作らない。6ステップの完了・要対応は、既存の段階（computeStage）と
//      キャリア状態（careerStatus）から決まる。すべての事実の組み合わせで、段階と食い違わない
//   2. ① 入社案内は、まだ事実を持つ表が無い。「データ未連携」で、進み具合に数えない
//   3. 事実が読めないときは、完了にも要対応にもせず「データ未連携」にする（0・完了と言い張らない）
//   4. 「次に誰が何をするか」が先に分かる（会社・本人・社労士）
//   5. 給与・手当の金額を返さない
import assert from "node:assert/strict";
import { mapSix, summarizeSix, SIX_STEPS, SIX_KEYS } from "../lib/onboard-six.js";
import { computeStage, stageFlags } from "../lib/onboard-stage.js";

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
const CAREER_OK = {
  track_id: "t", current_level_id: "l", one_year_target_note: "a", three_year_target_note: "b",
  next_review_on: "2027-04-01", agreed_at: "2026-09-01T00:00:00Z",
};

console.log("— 6ステップの定義 —");

ok("6つ。この順", () => {
  assert.deepEqual(SIX_KEYS, ["guide", "contract", "info_docs", "account", "career", "final"]);
  assert.deepEqual(SIX_STEPS.map((s) => s.label),
    ["入社案内", "労働条件・契約", "本人情報・必要書類", "アカウント準備", "キャリア設計", "最終確認"]);
  assert.deepEqual(SIX_STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
});

ok("① 入社案内は、いつでも「データ未連携」。進み具合に数えない", () => {
  for (const f of [base(), atIntake(), { ...base(), procedure: { status: "done" } }]) {
    const r = mapSix({ facts: f, career: CAREER_OK });
    assert.equal(stepOf(r, "guide").state, "unlinked");
  }
  const r = mapSix({ facts: { ...base(), procedure: { status: "done" } }, career: CAREER_OK });
  assert.equal(r.total, 5, "案内を除いた5つで数える");
  assert.equal(r.done, 5);
});

console.log("— 段階との対応 —");

ok("依頼前: ② が経営者の番。③④ はこれから", () => {
  const r = mapSix({ facts: base(), career: null });
  const c = stepOf(r, "contract");
  assert.equal(c.state, "current");
  assert.equal(c.actor, "owner");
  assert.match(c.note, /作成依頼/);
  assert.equal(stepOf(r, "info_docs").state, "todo");
  assert.equal(stepOf(r, "account").state, "todo");
  assert.equal(r.next.label, "労働条件の作成依頼待ち");
  assert.equal(r.next.actor, "owner");
  assert.equal(r.needsCompany, true);
  assert.equal(r.complete, false);
});

ok("社労士の確認中: 社労士の番。会社の要対応にはしない", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "requested" } }, career: null });
  assert.equal(stepOf(r, "contract").actor, "advisor");
  assert.equal(r.next.label, "社労士の確認待ち");
  assert.equal(r.needsCompany, false);
  assert.deepEqual(r.waitingOn, ["advisor"]);
});

ok("書面が届いて発行前: 社労士の確認待ちのまま（発行の文言が出る）", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "uploaded" } }, career: null });
  assert.match(stepOf(r, "contract").note, /発行/);
});

ok("本人の締結待ち: 本人の番", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "sent" }, sign: { status: "sent" } }, career: null });
  assert.equal(stepOf(r, "contract").actor, "employee");
  assert.equal(r.next.label, "契約の署名待ち");
  assert.equal(r.needsCompany, false);
});

ok("署名済みでも誓約書の同意が残れば、② は終わらない", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "signed" }, sign: { status: "signed" }, consentsOk: false }, career: null });
  assert.equal(stepOf(r, "contract").state, "current");
  assert.match(stepOf(r, "contract").detail.join(""), /誓約書/);
});

ok("④ 入社情報・書類・社内準備: 本人の作業（③）と社内の作業（④）が並行して出る", () => {
  const r = mapSix({ facts: atIntake(), career: null });
  assert.equal(stepOf(r, "contract").state, "done");
  const info = stepOf(r, "info_docs"), acc = stepOf(r, "account");
  assert.equal(info.state, "current");
  assert.equal(info.actor, "employee");
  assert.equal(acc.state, "current");
  assert.equal(acc.actor, "owner");
  assert.match(acc.note, /社内準備が 2 件/);
  assert.equal(r.next.actor, "employee", "先に並ぶ本人の番を「次」にする");
  assert.equal(r.needsCompany, true, "会社の番のステップもあるので要対応");
  assert.deepEqual([...r.waitingOn].sort(), ["employee", "owner"]);
});

ok("本人の分が済めば、③ は完了。社内準備だけが残る", () => {
  const f = atIntake({ profile: { status: "submitted" },
    items: [it("employee", "done"), it("employee", "submitted"), it("hr"), it("it", "done")] });
  const r = mapSix({ facts: f, career: null });
  assert.equal(stepOf(r, "info_docs").state, "done");
  assert.equal(stepOf(r, "account").state, "current");
  assert.equal(r.next.label, "アカウント・社内準備中");
});

ok("オリエンテーション未確認は、③ に残る（本人の作業）", () => {
  const f = atIntake({ profile: { status: "submitted" }, orientationOk: false,
    items: [it("employee", "done"), it("hr", "done")] });
  const r = mapSix({ facts: f, career: null });
  assert.equal(stepOf(r, "info_docs").state, "current");
  assert.match(stepOf(r, "info_docs").note, /オリエンテーション/);
});

ok("マイナンバー書類は、③ を止めない（段階の判定と同じ）", () => {
  const f = atIntake({ profile: { status: "submitted" },
    items: [it("employee", "todo", true, "doc_mynumber"), it("hr", "done")] });
  const r = mapSix({ facts: f, career: null });
  assert.equal(stepOf(r, "info_docs").state, "done");
});

ok("手続きが完了（段階 complete）でキャリア未設定: ⑤ が上長の番、⑥ はまだ", () => {
  const f = { ...base(), procedure: { status: "done" } };
  const r = mapSix({ facts: f, career: null });
  assert.equal(stepOf(r, "contract").state, "done");
  assert.equal(stepOf(r, "info_docs").state, "done");
  assert.equal(stepOf(r, "account").state, "done");
  const c = stepOf(r, "career");
  assert.equal(c.state, "current");
  assert.equal(c.actor, "manager");
  assert.equal(stepOf(r, "final").state, "todo");
  assert.equal(r.next.label, "キャリア設定待ち");
  assert.equal(r.complete, false);
});

ok("キャリアが本人確認待ち: 本人の番", () => {
  const career = { ...CAREER_OK, agreed_at: null, confirm_requested_at: "2026-09-10T00:00:00Z", employee_confirmed_at: null };
  const r = mapSix({ facts: { ...base(), procedure: { status: "done" } }, career });
  const c = stepOf(r, "career");
  assert.equal(c.state, "current");
  assert.equal(c.actor, "employee");
  assert.equal(r.next.label, "キャリアの本人確認待ち");
});

ok("入社手続きが終わるまで、キャリア未設定を「要対応」にしない（これから）。journey の順と同じ", () => {
  assert.equal(stepOf(mapSix({ facts: base(), career: null }), "career").state, "todo");
  const r = mapSix({ facts: atIntake(), career: null });
  assert.equal(stepOf(r, "career").state, "todo");
  assert.ok(!r.waitingOn.includes("manager"));
});

ok("全部そろう: ⑥ 最終確認が完了。入社準備完了", () => {
  const r = mapSix({ facts: { ...base(), procedure: { status: "done" } }, career: CAREER_OK });
  assert.equal(stepOf(r, "career").state, "done");
  assert.equal(stepOf(r, "final").state, "done");
  assert.equal(r.complete, true);
  assert.equal(r.next.label, "入社準備完了");
  assert.equal(r.next.tone, "green");
  assert.equal(r.needsCompany, false);
});

console.log("— 事実が読めないとき —");

ok("入社手続きの事実が読めない: ②③④⑥ は「データ未連携」。完了とも要対応とも言わない", () => {
  const r = mapSix({ facts: null, career: CAREER_OK });
  for (const k of ["contract", "info_docs", "account", "final"]) assert.equal(stepOf(r, k).state, "unlinked", k);
  assert.equal(stepOf(r, "career").state, "done", "キャリアは別の事実なので、読めていれば出す");
  assert.equal(r.complete, false);
  assert.equal(r.needsCompany, false);
  assert.equal(r.next.label, "データ未連携");
});

ok("キャリアの表が読めない: ⑤⑥ は「データ未連携」。未設定とは言わない", () => {
  const r = mapSix({ facts: { ...base(), procedure: { status: "done" } }, career: null, careerLinked: false });
  assert.equal(stepOf(r, "career").state, "unlinked");
  assert.equal(stepOf(r, "final").state, "unlinked");
  assert.equal(r.complete, false);
});

console.log("— 4つ目の判定を持たない（段階・キャリアと食い違わない）—");

ok("事実のあらゆる組み合わせで、②③④ は段階（computeStage）と一致する", () => {
  const orders = [null, { status: "requested" }, { status: "uploaded" }, { status: "sent" }, { status: "signed" }, { status: "cancelled" }];
  const signs = [null, { status: "sent" }, { status: "signed" }, { status: "cancelled" }];
  const procs = ["in_progress", "done", "cancelled"];
  const profiles = [null, { status: "draft" }, { status: "submitted" }];
  const itemSets = [
    [], [it("employee")], [it("employee", "done")], [it("hr")], [it("hr", "done")],
    [it("employee", "done"), it("hr")], [it("employee"), it("hr", "done")], [it("employee", "done"), it("hr", "done")],
    [it("employee", "todo", true, "doc_mynumber")],
  ];
  let n = 0;
  for (const status of procs) for (const order of orders) for (const sign of signs)
    for (const consentsOk of [false, true]) for (const profile of profiles)
      for (const items of itemSets) for (const orientationOk of [undefined, true, false]) {
        const f = { procedure: { status }, order, sign, consentsOk, profile, items, orientationOk };
        const at = computeStage(f).key;
        const x = stageFlags(f);
        const r = mapSix({ facts: f, career: CAREER_OK });
        const s = (k) => stepOf(r, k);
        n += 1;
        const tag = JSON.stringify(f);
        // ② は、段階が intake / complete に達したときだけ完了
        assert.equal(s("contract").state === "done", at === "intake" || at === "complete", `② ${tag}`);
        assert.equal(s("contract").state === "current", ["conditions", "advisor_review", "signing"].includes(at), `② current ${tag}`);
        // ③④ は、intake のときだけ「要対応」。complete なら完了。それ以前はこれから
        if (at === "complete") {
          assert.equal(s("info_docs").state, "done", `③ ${tag}`);
          assert.equal(s("account").state, "done", `④ ${tag}`);
        } else if (at === "intake") {
          const mineOpen = !x.profileSubmitted || x.employeeOpen > 0 || !x.orientationOk;
          assert.equal(s("info_docs").state, mineOpen ? "current" : "done", `③ intake ${tag}`);
          assert.equal(s("account").state, x.internalOpen ? "current" : "done", `④ intake ${tag}`);
        } else {
          assert.equal(s("info_docs").state, "todo", `③ 前 ${tag}`);
          assert.equal(s("account").state, "todo", `④ 前 ${tag}`);
        }
        // ⑥ は、段階が complete で、キャリアも済んでいるときだけ
        assert.equal(s("final").state === "done", at === "complete", `⑥ ${tag}`);
        assert.equal(r.complete, at === "complete", `complete ${tag}`);
        assert.equal(r.stage, at);
      }
  assert.ok(n > 3000, `組み合わせを網羅している（${n}）`);
});

ok("キャリアの ⑤ は careerStatus と一致する（未設定・確認待ち・設定済み）", () => {
  const pend = { ...CAREER_OK, agreed_at: null, confirm_requested_at: "2026-09-10T00:00:00Z", employee_confirmed_at: null };
  const done = { ...CAREER_OK, agreed_at: null, confirm_requested_at: "2026-09-10T00:00:00Z", employee_confirmed_at: "2026-09-11T00:00:00Z" };
  const f = { ...base(), procedure: { status: "done" } };
  assert.equal(stepOf(mapSix({ facts: f, career: null }), "career").state, "current");
  assert.equal(stepOf(mapSix({ facts: f, career: { ...CAREER_OK, agreed_at: null } }), "career").state, "current", "そろっていても、本人へ送る前");
  assert.equal(stepOf(mapSix({ facts: f, career: pend }), "career").state, "current");
  assert.equal(stepOf(mapSix({ facts: f, career: done }), "career").state, "done");
  assert.equal(stepOf(mapSix({ facts: f, career: CAREER_OK }), "career").state, "done");
});

console.log("— 一覧の集計と、出さないもの —");

ok("summarizeSix: 誰の番かで数える。本人と会社が同時なら両方に入る。完了は別", () => {
  const rows = [
    { six: mapSix({ facts: base(), career: null }) },                                                  // 会社
    { six: mapSix({ facts: { ...base(), order: { status: "requested" } }, career: null }) },           // 社労士
    { six: mapSix({ facts: atIntake(), career: null }) },                                              // 本人＋会社
    { six: mapSix({ facts: { ...base(), procedure: { status: "done" } }, career: CAREER_OK }) },       // 完了
    { name: "six なし" },
  ];
  const s = summarizeSix(rows);
  assert.deepEqual(s, { total: 4, inProgress: 3, company: 2, employee: 1, advisor: 1, complete: 1 });
});

ok("給与・手当の金額を、どの状態でも返さない", () => {
  const f = { ...atIntake(), wage_amount: 999999, order: { status: "signed", wage_amount: 999999 } };
  const text = JSON.stringify(mapSix({ facts: f, career: CAREER_OK }));
  assert.ok(!/wage|salary|999999|給与額|時給|基本給/.test(text), text);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
