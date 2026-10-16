// CEO REVIEW の対象判定（lib/hr.js needsCeoReview / ceoReviewBucket）と、段階を戻さない laterStage の単体テスト。
//   ・CEO REVIEW・経営ハブ・NEXT ACTION が別々の条件で数えて、件数と一覧が食い違わないように、判定を1か所にした
//   ・カジュアル面談の予約（手入力・TimeRex）で、社長推薦まで進んだ人の段階を戻さない（戻ると一覧から消えていた）
import assert from "node:assert/strict";
import { needsCeoReview, ceoReviewBucket, laterStage } from "../lib/hr.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const TODAY = "2026-10-16";
const A = (o) => ({ id: "a", stage: "applied", status: "todo", rank: null, decision: null, ...o });
const IV = (o) => ({ kind: "ceo", scheduled_at: null, conducted_at: null, canceled_at: null, ...o });
const bucket = (a, interviews = [], contactState = null) => ceoReviewBucket(a, { interviews, contactState, today: TODAY });

console.log("\n=== laterStage：段階を後ろへ戻さない ===");
ok("社長推薦 → カジュアル面談の予約でも社長推薦のまま", () => assert.equal(laterStage("ceo_recommend", "casual_interview"), "ceo_recommend"));
ok("社長面談 → カジュアル面談の予約でも社長面談のまま", () => assert.equal(laterStage("ceo_interview", "casual_interview"), "ceo_interview"));
ok("新規応募 → カジュアル面談へは進む", () => assert.equal(laterStage("applied", "casual_interview"), "casual_interview"));
ok("社長推薦 → 社長面談へは進む", () => assert.equal(laterStage("ceo_recommend", "ceo_interview"), "ceo_interview"));
ok("内定のあとに面談を入れても内定のまま", () => assert.equal(laterStage("offer", "ceo_interview"), "offer"));
ok("無限道場リードの段階（md_*）は、そのまま次の値を使う", () => assert.equal(laterStage("md_trial", "md_casual"), "md_casual"));

console.log("\n=== needsCeoReview / ceoReviewBucket ===");
ok("段階が社長推薦なら対象（社長に会ってほしい人）", () => assert.equal(bucket(A({ stage: "ceo_recommend", status: "ceo_interview_pending", rank: "A" })), "recommended"));
ok("段階がカジュアル面談でも、状態が社長判断待ちなら対象（社長判断待ち）", () => assert.equal(bucket(A({ stage: "casual_interview", status: "ceo_decision_pending" })), "decisionPending"));
ok("段階が新規応募でも、状態が社長面談設定待ちなら対象", () => assert.equal(bucket(A({ status: "ceo_interview_pending" })), "recommended"));
ok("有効な社長面談があれば、段階・状態に関係なく対象", () => assert.equal(bucket(A({ stage: "casual_interview", status: "interview_scheduled" }), [IV({ scheduled_at: "2026-10-20T05:00:00Z" })]), "recommended"));
ok("社長面談が今日（JST）なら「今日会う人」", () => assert.equal(bucket(A({ stage: "ceo_interview", status: "interview_scheduled" }), [IV({ scheduled_at: "2026-10-16T00:30:00Z" })]), "todayMeetings"));
ok("JSTで今日でも UTC では前日の時刻（09:00 JST 前）を今日と判定する", () => assert.equal(bucket(A({ stage: "ceo_interview", status: "interview_scheduled" }), [IV({ scheduled_at: "2026-10-15T23:30:00Z" })]), "todayMeetings"));
ok("社長面談を実施済み・判断なしなら「社長判断待ち」", () => assert.equal(bucket(A({ stage: "ceo_interview", status: "eval_pending" }), [IV({ conducted_at: "2026-10-15T05:00:00Z" })]), "decisionPending"));
ok("保留（decision=hold）は「社長判断待ち」に残す", () => assert.equal(bucket(A({ stage: "ceo_interview", status: "ceo_decision_pending", decision: "hold" })), "decisionPending"));
ok("ランクB（追加確認）で社長推薦待ちの人は、社長の一覧ではない（採用担当が推薦する段階）", () => {
  assert.equal(needsCeoReview(A({ stage: "casual_interview", status: "ceo_recommend_pending", rank: "B" })), false);
});
ok("内定・見送りを決めて本人へ未連絡なら「判断済み・本人へ未連絡」", () => {
  assert.equal(bucket(A({ stage: "offer", status: "offer_draft_pending", decision: "hired" }), [], "pending"), "contactPending");
  assert.equal(bucket(A({ stage: "ceo_interview", status: "passed", decision: "rejected" }), [], "pending"), "contactPending");
});
ok("判断済みで連絡済みなら出さない", () => assert.equal(bucket(A({ stage: "offer", status: "offer_sent", decision: "hired" }), [], "done"), null));
ok("古い decision が残っていても、判断前の状態なら判断待ちの側に出す", () => {
  assert.equal(bucket(A({ stage: "ceo_recommend", status: "ceo_interview_pending", decision: "rejected" }), [], "done"), "recommended");
  assert.equal(bucket(A({ stage: "ceo_interview", status: "ceo_decision_pending", decision: "hired" }), [], "done"), "decisionPending");
});
ok("C評価（次回調整）・見送り（passed）・辞退は出さない", () => {
  assert.equal(bucket(A({ stage: "ceo_recommend", status: "next_scheduling_pending" })), null);
  assert.equal(bucket(A({ stage: "ceo_recommend", status: "passed" })), null);
  assert.equal(bucket(A({ stage: "ceo_interview", status: "declined" })), null);
});
ok("キャンセル済みの社長面談だけでは対象にしない", () => assert.equal(needsCeoReview(A({ stage: "casual_interview", status: "interview_scheduled" }), [IV({ canceled_at: "2026-10-10T00:00:00Z" })]), false));
ok("無限道場リードは対象外", () => {
  assert.equal(needsCeoReview(A({ stage: "md_trial", status: "ceo_decision_pending" })), false);
  assert.equal(needsCeoReview(A({ lead_category: "mugendojo", stage: "ceo_recommend" })), false);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
