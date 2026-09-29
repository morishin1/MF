// 契約・キャリアの完了状態（lib/career.js の contractStatus/careerStatus/overallStatus）。
//
// ■ 何を守るテストか（GW「契約締結×キャリア設定」完了状態 §2・§3・§8・§17 のテスト §20）
//
//   1. active契約 + signed署名依頼がそろって初めて「契約締結済み」
//   2. active契約はあるが締結済み書面が確認できないときは完了扱いにしない（§8）
//   3. 署名済み書面はあるがactive契約が無いときも完了扱いにしない（§8）
//   4. キャリアは track・現在Level・1年後/3年後・次回評価日がそろい、本人確認まで済んで初めて「設定済み」
//   5. 本人確認待ちは「キャリア本人確認待ち」
//   6. 両方そろって初めて overallStatus は completed になる
//   7. 5つの状態（contract_pending/contract_signing/career_setup/career_confirming/completed）だけを返す
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

const CONTRACT = { id: "k1" };
const sign = (over = {}) => ({ status: "signed", contract_id: "k1", ...over });

console.log("\n=== 契約の完了状態（§2・§8） ===\n");

ok("active契約 + 紐づくsigned署名依頼で「契約締結済み」", () => {
  const st = C.contractStatus({ contract: CONTRACT, signs: [sign()] });
  assert.equal(st.key, "signed");
  assert.equal(st.ok, true);
  assert.equal(st.label, "契約締結済み");
});

ok("古いデータ（contract_idが無い）のsignedも、いまのactive契約の署名として扱う", () => {
  const st = C.contractStatus({ contract: CONTRACT, signs: [sign({ contract_id: null })] });
  assert.equal(st.key, "signed");
});

ok("active契約はあるが締結済み書面が無いと完了にしない。⚠が付く", () => {
  const st = C.contractStatus({ contract: CONTRACT, signs: [] });
  assert.equal(st.key, "unsigned");
  assert.equal(st.ok, false);
  assert.equal(st.warn, true);
  assert.equal(st.label, "締結済み書面が確認できません");
});

ok("active契約はあるが、署名済み書面が別の契約のものなら完了にしない", () => {
  const st = C.contractStatus({ contract: CONTRACT, signs: [sign({ contract_id: "other" })] });
  assert.equal(st.key, "unsigned");
  assert.equal(st.warn, true);
});

ok("active契約があり、署名待ち（sent）だけなら「本人の署名待ちです」", () => {
  const st = C.contractStatus({ contract: CONTRACT, signs: [sign({ status: "sent" })] });
  assert.equal(st.key, "pending_signature");
  assert.equal(st.warn, false);
});

ok("署名済み書面はあるがactive契約が無いと完了にしない。⚠が付く", () => {
  const st = C.contractStatus({ contract: null, signs: [sign()] });
  assert.equal(st.key, "orphan_signed");
  assert.equal(st.warn, true);
  assert.equal(st.label, "現在契約が設定されていません");
});

ok("何もなければ「契約条件が未確定です」", () => {
  const st = C.contractStatus({ contract: null, signs: [] });
  assert.equal(st.key, "no_contract");
  assert.equal(st.warn, false);
});

console.log("\n=== キャリアの完了状態（§2） ===\n");

const career = (over = {}) => ({
  track_id: "t1", current_level_id: "l1",
  one_year_target_note: "L2になる", three_year_target_note: "L3になる",
  next_review_on: "2027-03-01",
  ...over,
});

ok("キャリア未設定なら「キャリア未設定」", () => {
  const st = C.careerStatus({ career: null });
  assert.equal(st.key, "not_set");
  assert.equal(st.ok, false);
});

ok("項目がそろっていなければ「キャリア未設定」", () => {
  const st = C.careerStatus({ career: career({ next_review_on: null }) });
  assert.equal(st.key, "not_set");
});

ok("項目はそろっているが、まだ本人へ送っていなければ「キャリア未設定」のまま", () => {
  const st = C.careerStatus({ career: career() });
  assert.equal(st.key, "not_set");
});

ok("本人確認を依頼中なら「キャリア本人確認待ち」", () => {
  const st = C.careerStatus({ career: career({ confirm_requested_at: "2026-09-01T00:00:00Z" }) });
  assert.equal(st.key, "confirming");
  assert.equal(st.ok, false);
});

ok("本人が確認すれば「キャリア設定済み」", () => {
  const st = C.careerStatus({ career: career({
    confirm_requested_at: "2026-09-01T00:00:00Z", employee_confirmed_at: "2026-09-02T00:00:00Z",
  }) });
  assert.equal(st.key, "confirmed");
  assert.equal(st.ok, true);
  assert.equal(st.label, "キャリア設定済み");
});

ok("確認依頼のあとで項目を直しても、確認日時が新しければ確認済みのまま", () => {
  const st = C.careerStatus({ career: career({
    confirm_requested_at: "2026-09-01T00:00:00Z", employee_confirmed_at: "2026-09-02T00:00:00Z",
  }) });
  assert.equal(st.key, "confirmed");
});

ok("項目を直したあとで再送すると、また確認待ちに戻る", () => {
  const st = C.careerStatus({ career: career({
    confirm_requested_at: "2026-09-05T00:00:00Z", employee_confirmed_at: "2026-09-02T00:00:00Z",
  }) });
  assert.equal(st.key, "confirming");
});

ok("以前からの「初回面談で合意済み」（agreed_at）は確認済み扱い", () => {
  const st = C.careerStatus({ career: career({ agreed_at: "2026-01-01T00:00:00Z" }) });
  assert.equal(st.key, "confirmed");
});

console.log("\n=== 全体ステータス（§3・§17） ===\n");

const CS_OK = { key: "signed", label: "契約締結済み", ok: true, warn: false };
const CS_PENDING = { key: "pending_signature", label: "本人の署名待ちです", ok: false, warn: false };
const CS_NONE = { key: "no_contract", label: "契約条件が未確定です", ok: false, warn: false };
const KS_OK = { key: "confirmed", label: "キャリア設定済み", ok: true, nextReviewOn: "2027-03-01" };
const KS_CONFIRMING = { key: "confirming", label: "キャリア本人確認待ち", ok: false, nextReviewOn: "2027-03-01" };
const KS_NONE = { key: "not_set", label: "キャリア未設定", ok: false, nextReviewOn: null };

ok("契約が未確定なら contract_pending。「契約条件を設定してください」", () => {
  const st = C.overallStatus({ contractStatus: CS_NONE, careerStatus: KS_NONE });
  assert.equal(st.key, "contract_pending");
  assert.equal(st.nextAction.label, "契約条件を設定してください");
});

ok("署名待ちなら contract_signing。「本人の署名待ちです」", () => {
  const st = C.overallStatus({ contractStatus: CS_PENDING, careerStatus: KS_NONE });
  assert.equal(st.key, "contract_signing");
  assert.equal(st.nextAction.label, "本人の署名待ちです");
});

ok("契約は済んでいてもキャリア未設定なら career_setup", () => {
  const st = C.overallStatus({ contractStatus: CS_OK, careerStatus: KS_NONE });
  assert.equal(st.key, "career_setup");
  assert.equal(st.nextAction.label, "キャリアプランを設定してください");
});

ok("キャリアが本人確認待ちなら career_confirming", () => {
  const st = C.overallStatus({ contractStatus: CS_OK, careerStatus: KS_CONFIRMING });
  assert.equal(st.key, "career_confirming");
  assert.equal(st.nextAction.label, "本人のキャリア確認待ちです");
});

ok("両方そろって completed。NEXT ACTIONは次回評価まで待機", () => {
  const st = C.overallStatus({ contractStatus: CS_OK, careerStatus: KS_OK });
  assert.equal(st.key, "completed");
  assert.match(st.nextAction.label, /次回評価/);
  assert.equal(st.nextAction.dueOn, "2027-03-01");
});

ok("5つの状態だけを返す（§3）", () => {
  assert.deepEqual(C.OVERALL_STATES.map((s) => s.key),
    ["contract_pending", "contract_signing", "career_setup", "career_confirming", "completed"]);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
