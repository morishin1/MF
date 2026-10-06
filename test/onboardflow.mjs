// 入社の人別画面の6つの段階と「次にすること」（lib/onboard-flow.js）。
//
// ■ 何を守るテストか
//   ・並べ替えるだけ：段階の判定は lib/onboard-stage.js（stageFlags / computeStage）と同じ答え
//   ・署名依頼済み ≠ 締結済み／本人の提出 ≠ 会社の確認／入社日が来た ≠ 完了
//   ・閲覧記録・期限超過は補助の表示（排他にしない）
//   ・対象外は数えない
//   ・雛形で直接送った人が「作成依頼がまだ」で止まらない
//   ・アカウントが無ければ、まず作る（署名画面に入れない）
import assert from "node:assert/strict";
import { onboardFlow, FLOW_STEPS } from "../lib/onboard-flow.js";
import { computeStage } from "../lib/onboard-stage.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };
const TODAY = "2026-10-06";
const base = (over = {}) => ({ procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: true, profile: null, items: [], ...over });
const flow = (facts, more = {}) => onboardFlow({ facts, employee: { user_id: "u1" }, targetOn: "2026-10-20", today: TODAY, ...more });
const st = (f, k) => f.steps.find((s) => s.key === k);

ok("6つの段階の並び", () => {
  assert.deepEqual(FLOW_STEPS.map((s) => s.label), ["基本情報", "契約書の準備", "本人の確認・署名", "入社情報・必要書類", "アカウント・貸与品", "会社確認・完了"]);
});
ok("契約書が未準備：2つの作り方が出て、次にすることは「契約書を準備する」", () => {
  const f = flow(base());
  assert.equal(st(f, "contract").status, "未準備");
  assert.deepEqual(st(f, "contract").actions, ["make", "pdf"]);
  assert.equal(f.next.text, "契約書を準備する"); assert.equal(f.next.who, "人事");
  assert.equal(st(f, "sign").state, "todo");
});
ok("作成済みPDFが取り込まれて送付前：［確認して署名依頼］", () => {
  const f = flow(base({ order: { status: "uploaded" } }));
  assert.equal(st(f, "contract").status, "書面あり・送付前"); assert.deepEqual(st(f, "contract").actions, ["send_order"]);
  assert.equal(f.next.text, "契約書を確認して送る");
});
ok("雛形で直接送った人は、作成依頼がなくても「署名待ち」（①で止まらない）", () => {
  const facts = base({ sign: { status: "sent" } });
  assert.equal(computeStage(facts).key, "signing");
  const f = flow(facts, { sign: { status: "sent", source: null, due_on: "2026-10-13" } });
  assert.equal(st(f, "contract").state, "done"); assert.match(st(f, "contract").status, /入力して作成/);
  assert.equal(st(f, "sign").state, "current"); assert.match(st(f, "sign").status, /署名依頼済み・本人の署名待ち/);
  assert.equal(f.next.who, "本人"); assert.equal(f.next.dueOn, "2026-10-13");
});
ok("閲覧記録・期限超過は、署名待ちに添える（状態は1つ）", () => {
  const f = flow(base({ sign: { status: "sent" } }), { sign: { status: "sent", source: "uploaded", first_viewed_at: "2026-10-02T00:00:00Z", due_on: "2026-10-01" } });
  assert.equal(st(f, "sign").status, "署名依頼済み・本人の署名待ち（閲覧記録あり・期限超過）");
  assert.equal(st(f, "sign").late, true); assert.match(st(f, "contract").status, /作成済みPDF/);
});
ok("締結済みでも、誓約書・同意が残っていれば「締結済み・同意待ち」（署名依頼済み ≠ 締結済み）", () => {
  const f = flow(base({ sign: { status: "signed" }, consentsOk: false }));
  assert.equal(st(f, "sign").state, "current"); assert.match(st(f, "sign").status, /締結済み・誓約書／同意の確認待ち/);
  const g = flow(base({ sign: { status: "signed" } }));
  assert.equal(st(g, "sign").state, "done"); assert.equal(st(g, "sign").status, "締結済み");
});
ok("本人の提出と、会社の確認を分ける", () => {
  const items = [
    { owner: "employee", required: true, status: "todo", title: "住民票" },
    { owner: "employee", required: true, status: "submitted", title: "年金手帳" },
    { owner: "employee", required: true, status: "na", title: "対象外の書類" },
  ];
  const f = flow(base({ sign: { status: "signed" }, profile: { status: "submitted" }, items }), { items });
  assert.match(st(f, "intake").status, /入社情報 済み・書類 残り1件／会社の確認：1件待ち/);
  assert.equal(f.next.text, "本人の入社情報・書類の提出待ち");
  const items2 = items.map((i) => (i.status === "todo" ? { ...i, status: "submitted" } : i));
  const g = flow(base({ sign: { status: "signed" }, profile: { status: "submitted" }, items: items2 }), { items: items2 });
  assert.equal(g.next.text, "提出された書類を確認する"); assert.equal(g.next.who, "人事");
});
ok("アカウント・貸与品：項目が無ければ対象外（数えない）", () => {
  const f = flow(base({ sign: { status: "signed" } }), { assets: 2 });
  assert.equal(st(f, "setup").state, "na"); assert.equal(f.total, 5);
  const items = [{ owner: "it", category: "account", required: true, status: "todo", title: "Google" }];
  const g = flow(base({ sign: { status: "signed" }, items }), { items, assets: 1 });
  assert.equal(st(g, "setup").state, "current"); assert.match(st(g, "setup").status, /残り1件／全1件・貸与品 1件/);
});
ok("入社日が来ただけでは完了にしない", () => {
  const items = [{ owner: "hr", category: "task", required: true, status: "todo", title: "社内の準備" }];
  const f = flow(base({ sign: { status: "signed" }, profile: { status: "submitted" }, items }), { items, targetOn: "2026-10-01" });
  assert.equal(f.complete, false); assert.equal(st(f, "company").state, "todo");
  assert.match(st(f, "company").note, /入社日を過ぎていますが、手続きはまだ完了していません/);
});
ok("必須がすべて済めば完了（既存の判定と同じ）", () => {
  const items = [{ owner: "hr", required: true, status: "done", title: "社内の準備" }];
  const facts = base({ sign: { status: "signed" }, profile: { status: "submitted" }, items });
  assert.equal(computeStage(facts).key, "complete");
  const f = flow(facts, { items });
  assert.equal(f.complete, true); assert.equal(f.next, null); assert.equal(st(f, "company").status, "入社準備 完了");
});
ok("アカウントが無ければ、まず作る（署名画面に入れない）。Office の権限は付けないと案内", () => {
  const f = flow(base(), { employee: { user_id: null } });
  assert.equal(st(f, "basic").state, "current"); assert.match(st(f, "basic").note, /Office の権限は付けません/);
  assert.equal(f.next.text, "本人のアカウントを作る");
});

console.log(`\n合計 ${n} 件 通過`);
