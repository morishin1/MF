// 入社準備の6ステップ（lib/onboard-six.js）。
//
// ■ 何を守るのか
//
//   1. 4つ目の判定を作らない。6ステップの完了・要対応は、既存の段階（computeStage）から決まる。
//      すべての事実の組み合わせで、段階と食い違わない
//   2. ① 入社案内確認は、発行された案内があるときだけ数える。無ければ「対象外」で、ほかを止めない
//   3. 事実が読めないときは、完了にも要対応にもせず「データ未連携」にする（完了と言い張らない）
//   4. 「次に誰が何をするか」が先に分かる。経営者の一覧と本人の画面で、状態は同じで言い方だけが違う
//   5. 給与・手当の金額を返さない。本人には、社内準備の内訳も出さない
//   6. キャリアはステップに入れず、入社準備が終わったあとの「次の一手」として添える
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
const done = () => ({ ...base(), procedure: { status: "done" } });
const stepOf = (r, key) => r.steps.find((s) => s.key === key);
const CAREER_OK = {
  track_id: "t", current_level_id: "l", one_year_target_note: "a", three_year_target_note: "b",
  next_review_on: "2027-04-01", agreed_at: "2026-09-01T00:00:00Z",
};
const ISSUED = { status: "issued", version: 1, confirmedVersion: null, confirmedAt: null };
const CONFIRMED = { ...ISSUED, confirmedVersion: 1, confirmedAt: "2026-09-20T01:00:00Z" };

console.log("— 6ステップの定義 —");

ok("6つ。この順（入社案内確認 / 雇用契約 / 入社情報入力 / 必要書類提出 / 会社確認 / 入社準備完了）", () => {
  assert.deepEqual(SIX_KEYS, ["guide", "contract", "info", "docs", "company", "complete"]);
  assert.deepEqual(SIX_STEPS.map((s) => s.label),
    ["入社案内確認", "雇用契約", "入社情報入力", "必要書類提出", "会社確認", "入社準備完了"]);
  assert.deepEqual(SIX_STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
});

console.log("— ① 入社案内確認 —");

ok("案内が無い・下書きのときは「対象外」。数えず、ほかを止めない", () => {
  for (const g of [null, { status: "draft", version: 1, confirmedVersion: null }]) {
    const r = mapSix({ facts: done(), guide: g });
    assert.equal(stepOf(r, "guide").state, "na");
    assert.equal(r.total, 5, "案内を除いた5つで数える");
    assert.equal(r.done, 5);
    assert.equal(r.complete, true, "案内が無くても、手続きが終われば完了");
  }
});

ok("発行された案内は、本人が確認するまで「本人の番」。完了にもならない", () => {
  const r = mapSix({ facts: done(), guide: ISSUED });
  const g = stepOf(r, "guide");
  assert.equal(g.state, "current");
  assert.equal(g.actor, "employee");
  assert.equal(r.complete, false, "手続きが終わっていても、案内が未確認なら完了にしない");
  assert.equal(r.next.key, "guide");
  assert.deepEqual(r.waitingOn, ["employee"]);
});

ok("確認済みなら完了。確認した日付が出る", () => {
  const r = mapSix({ facts: done(), guide: CONFIRMED });
  assert.equal(stepOf(r, "guide").state, "done");
  assert.match(stepOf(r, "guide").note, /2026\/09\/20/);
  assert.equal(r.complete, true);
});

ok("案内を出し直して版が上がったら、確認し直し（前の版の確認は数えない）", () => {
  const r = mapSix({ facts: done(), guide: { ...CONFIRMED, version: 2 } });
  assert.equal(stepOf(r, "guide").state, "current");
  assert.equal(r.complete, false);
});

ok("案内は、契約など後ろのステップを止めない（並行して進む）", () => {
  const r = mapSix({ facts: base(), guide: ISSUED });
  assert.equal(stepOf(r, "guide").state, "current");
  assert.equal(stepOf(r, "contract").state, "current");
  assert.deepEqual([...r.waitingOn].sort(), ["employee", "owner"]);
});

ok("案内の表が読めないときは「データ未連携」。完了は止めない", () => {
  const r = mapSix({ facts: done(), guide: null, guideLinked: false });
  assert.equal(stepOf(r, "guide").state, "unlinked");
  assert.equal(r.complete, true);
  assert.equal(r.total, 5);
});

console.log("— 段階との対応（②〜⑥）—");

ok("依頼前: ② が経営者の番。③④⑤ はこれから", () => {
  const r = mapSix({ facts: base() });
  const c = stepOf(r, "contract");
  assert.equal(c.state, "current");
  assert.equal(c.actor, "owner");
  assert.match(c.note, /契約書の準備がまだです/);
  for (const k of ["info", "docs", "company"]) assert.equal(stepOf(r, k).state, "todo", k);
  assert.equal(r.next.label, "労働条件の作成依頼待ち");
  assert.equal(r.needsCompany, true);
  assert.equal(r.complete, false);
});

ok("社労士の確認中: 社労士の番。会社の要対応にはしない", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "requested" } } });
  assert.equal(stepOf(r, "contract").actor, "advisor");
  assert.equal(r.next.label, "社労士の確認待ち");
  assert.equal(r.needsCompany, false);
  assert.deepEqual(r.waitingOn, ["advisor"]);
});

ok("書面が届いて発行前: 社労士の確認待ちのまま（発行の文言が出る）", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "uploaded" } } });
  assert.match(stepOf(r, "contract").note, /発行/);
});

ok("本人の締結待ち: 本人の番", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "sent" }, sign: { status: "sent" } } });
  assert.equal(stepOf(r, "contract").actor, "employee");
  assert.equal(r.next.label, "契約の署名待ち");
  assert.equal(r.needsCompany, false);
});

ok("署名済みでも誓約書の同意が残れば、② は終わらない", () => {
  const r = mapSix({ facts: { ...base(), order: { status: "signed" }, sign: { status: "signed" }, consentsOk: false } });
  assert.equal(stepOf(r, "contract").state, "current");
  assert.match(stepOf(r, "contract").detail.join(""), /誓約書/);
});

ok("締結後: ③ 入社情報・④ 必要書類（本人）と ⑤ 会社確認（社内）が並行して出る", () => {
  const r = mapSix({ facts: atIntake() });
  assert.equal(stepOf(r, "contract").state, "done");
  const info = stepOf(r, "info"), docs = stepOf(r, "docs"), co = stepOf(r, "company");
  assert.equal(info.state, "current");
  assert.equal(info.actor, "employee");
  assert.equal(docs.state, "current");
  assert.equal(docs.actor, "employee");
  assert.match(docs.note, /書類の提出が 2 件/);
  assert.equal(co.state, "current");
  assert.equal(co.actor, "owner");
  assert.match(co.note, /社内準備が 2 件/);
  assert.equal(r.next.actor, "employee", "先に並ぶ本人の番を「次」にする");
  assert.equal(r.needsCompany, true, "会社の番のステップもあるので要対応");
  assert.deepEqual([...r.waitingOn].sort(), ["employee", "owner"]);
});

ok("入社情報を提出したら ③ は完了。書類と会社確認が残る", () => {
  const r = mapSix({ facts: atIntake({ profile: { status: "submitted" } }) });
  assert.equal(stepOf(r, "info").state, "done");
  assert.equal(stepOf(r, "docs").state, "current");
});

ok("書類が出そろい、オリエンテーションも確認済みなら ④ は完了。社内準備だけが残る", () => {
  const f = atIntake({ profile: { status: "submitted" },
    items: [it("employee", "done"), it("employee", "submitted"), it("hr"), it("it", "done")] });
  const r = mapSix({ facts: f });
  assert.equal(stepOf(r, "docs").state, "done");
  assert.equal(stepOf(r, "company").state, "current");
  assert.equal(r.next.label, "社内準備中");
});

ok("オリエンテーション未確認は、④ に残る（本人の作業）", () => {
  const f = atIntake({ profile: { status: "submitted" }, orientationOk: false,
    items: [it("employee", "done"), it("hr", "done")] });
  const r = mapSix({ facts: f });
  assert.equal(stepOf(r, "docs").state, "current");
  assert.match(stepOf(r, "docs").note, /オリエンテーション/);
});

ok("マイナンバー書類は、④ を止めない（段階の判定と同じ）", () => {
  const f = atIntake({ profile: { status: "submitted" },
    items: [it("employee", "todo", true, "doc_mynumber"), it("hr", "done")] });
  assert.equal(stepOf(mapSix({ facts: f }), "docs").state, "done");
});

ok("手続きが完了（段階 complete）: ②〜⑤ が完了、⑥ 入社準備完了", () => {
  const r = mapSix({ facts: done(), career: null });
  for (const k of ["contract", "info", "docs", "company", "complete"]) assert.equal(stepOf(r, k).state, "done", k);
  assert.equal(r.complete, true);
  assert.equal(r.next.label, "入社準備完了");
  assert.equal(r.next.tone, "green");
});

console.log("— 事実が読めないとき —");

ok("入社手続きの事実が読めない: ②〜⑥ は「データ未連携」。完了とも要対応とも言わない", () => {
  const r = mapSix({ facts: null, guide: CONFIRMED });
  for (const k of ["contract", "info", "docs", "company", "complete"]) assert.equal(stepOf(r, k).state, "unlinked", k);
  assert.equal(r.complete, false);
  assert.equal(r.needsCompany, false);
  assert.equal(r.next.label, "データ未連携");
});

console.log("— キャリアは「次の一手」（ステップに入れない）—");

ok("入社準備が終わる前は、キャリアを出さない", () => {
  assert.equal(mapSix({ facts: atIntake(), career: null }).after, null);
});

ok("入社準備完了でキャリア未設定: after が上長の番。完了は変わらない", () => {
  const r = mapSix({ facts: done(), career: null });
  assert.equal(r.complete, true);
  assert.equal(r.after.key, "career");
  assert.equal(r.after.label, "キャリア設定待ち");
  assert.equal(r.after.actor, "manager");
  assert.equal(r.needsCompany, true, "上長の番なので、会社の要対応");
});

ok("キャリアが本人確認待ち: 本人の番。設定済みなら次の一手は無い", () => {
  const pend = { ...CAREER_OK, agreed_at: null, confirm_requested_at: "2026-09-10T00:00:00Z", employee_confirmed_at: null };
  const a = mapSix({ facts: done(), career: pend }).after;
  assert.equal(a.actor, "employee");
  assert.equal(a.label, "キャリアの本人確認待ち");
  const b = mapSix({ facts: done(), career: CAREER_OK }).after;
  assert.equal(b.actor, null);
  assert.equal(b.state, "confirmed");
});

ok("キャリアの表が読めなければ、after を出さない（未設定とは言わない）", () => {
  assert.equal(mapSix({ facts: done(), career: null, careerLinked: false }).after, null);
});

console.log("— 4つ目の判定を持たない（段階と食い違わない）—");

ok("事実のあらゆる組み合わせで、②〜⑥ は段階（computeStage）と一致する", () => {
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
        for (const audience of ["company", "self"]) {
          const r = mapSix({ facts: f, audience });
          const s = (k) => stepOf(r, k);
          n += 1;
          const tag = `${audience} ${JSON.stringify(f)}`;
          assert.equal(s("contract").state === "done", at === "intake" || at === "complete", `② ${tag}`);
          assert.equal(s("contract").state === "current", ["conditions", "advisor_review", "signing"].includes(at), `② current ${tag}`);
          if (at === "complete") {
            for (const k of ["info", "docs", "company"]) assert.equal(s(k).state, "done", `${k} ${tag}`);
          } else if (at === "intake") {
            assert.equal(s("info").state, x.profileSubmitted ? "done" : "current", `③ ${tag}`);
            assert.equal(s("docs").state, x.employeeOpen > 0 || !x.orientationOk ? "current" : "done", `④ ${tag}`);
            assert.equal(s("company").state, x.internalOpen ? "current" : "done", `⑤ ${tag}`);
          } else {
            for (const k of ["info", "docs", "company"]) assert.equal(s(k).state, "todo", `${k} 前 ${tag}`);
          }
          // ⑥ は、段階が complete のときだけ（案内は無いので止めない）
          assert.equal(s("complete").state === "done", at === "complete", `⑥ ${tag}`);
          assert.equal(r.complete, at === "complete", `complete ${tag}`);
          assert.equal(r.stage, at);
        }
      }
  assert.ok(n > 6000, `組み合わせを網羅している（${n}）`);
});

ok("経営者の一覧と本人の画面で、状態（state）は同じ。違うのは言い方だけ", () => {
  const facts = [base(), atIntake(), done(), { ...base(), order: { status: "requested" } }];
  for (const f of facts) for (const guide of [null, ISSUED, CONFIRMED]) {
    const a = mapSix({ facts: f, guide, audience: "company" });
    const b = mapSix({ facts: f, guide, audience: "self" });
    assert.deepEqual(a.steps.map((s) => [s.key, s.state, s.actor]), b.steps.map((s) => [s.key, s.state, s.actor]));
    assert.equal(a.complete, b.complete);
    assert.equal(a.done, b.done);
  }
});

console.log("— 本人の言い方 —");

ok("本人には「あなた」「会社」と言う。社内準備の内訳（件数）は出さない", () => {
  const r = mapSix({ facts: atIntake(), audience: "self" });
  assert.equal(stepOf(r, "info").actorLabel, "あなた");
  assert.equal(stepOf(r, "company").actorLabel, "会社");
  assert.ok(!/\d+ 件/.test(stepOf(r, "company").note), stepOf(r, "company").note);
  assert.deepEqual(stepOf(r, "company").detail, []);
  const c = mapSix({ facts: atIntake(), audience: "company" });
  assert.match(stepOf(c, "company").note, /社内準備が 2 件/);
});

ok("本人の「次にやること」は、本人の番を先に出す", () => {
  const r = mapSix({ facts: atIntake(), guide: ISSUED, audience: "self" });
  assert.equal(r.next.actor, "employee");
  assert.equal(r.next.key, "guide");
  const r2 = mapSix({ facts: atIntake({ profile: { status: "submitted" }, items: [it("employee", "done"), it("hr")] }), guide: CONFIRMED, audience: "self" });
  assert.equal(r2.next.key, "company", "本人の番が無ければ、会社の番");
  assert.equal(r2.next.actor, "owner");
  assert.equal(r2.next.tone, "red");
});

ok("契約前の本人には、会社が準備中と言う（操作は要らない）", () => {
  const r = mapSix({ facts: base(), audience: "self" });
  assert.equal(stepOf(r, "contract").note, "会社が労働条件通知書を準備しています");
  assert.equal(stepOf(r, "contract").actorLabel, "会社");
  const r2 = mapSix({ facts: { ...base(), order: { status: "sent" }, sign: { status: "sent" } }, audience: "self" });
  assert.match(stepOf(r2, "contract").note, /確認して、締結してください/);
  assert.equal(stepOf(r2, "contract").actorLabel, "あなた");
});

console.log("— 一覧の集計と、出さないもの —");

ok("summarizeSix: 誰の番かで数える。本人と会社が同時なら両方に入る。完了は別", () => {
  const rows = [
    { six: mapSix({ facts: base() }) },                                                  // 会社
    { six: mapSix({ facts: { ...base(), order: { status: "requested" } } }) },           // 社労士
    { six: mapSix({ facts: atIntake() }) },                                              // 本人＋会社
    { six: mapSix({ facts: done(), career: CAREER_OK }) },                               // 完了
    { name: "six なし" },
  ];
  assert.deepEqual(summarizeSix(rows), { total: 4, inProgress: 3, company: 2, employee: 1, advisor: 1, complete: 1 });
});

ok("summarizeSix: 入社準備が終わっていても、キャリアが上長の番なら「会社の対応待ち」に数える（完了の数にも入る）", () => {
  const rows = [{ six: mapSix({ facts: done(), career: null }) }, { six: mapSix({ facts: done(), career: CAREER_OK }) }];
  const s = summarizeSix(rows);
  assert.equal(s.complete, 2);
  assert.equal(s.inProgress, 0);
  assert.equal(s.company, 1, "キャリア未設定の1人");
});

ok("給与・手当の金額を、どの状態でも返さない", () => {
  const f = { ...atIntake(), wage_amount: 999999, order: { status: "signed", wage_amount: 999999 } };
  for (const audience of ["company", "self"]) {
    const text = JSON.stringify(mapSix({ facts: f, career: CAREER_OK, guide: ISSUED, audience }));
    assert.ok(!/wage|salary|999999|給与額|時給|基本給/.test(text), text);
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
