// 応募一覧のタブ（lib/hr.js listTabOf）と、応募形態（employmentType）の受け付け。
//   選考中／業務委託／無限道場／終了 を画面ごとに判定しない（shapeApplicant の listTab を使う）
import assert from "node:assert/strict";
import { listTabOf, isContractorApplicant, shapeApplicant, normalizeApplicant, APPLICANT_SOURCES, sourceStats } from "../lib/hr.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const A = (o) => ({ id: "a", name: "x", stage: "applied", status: "todo", ...o });

ok("通常の採用は「選考中」", () => assert.equal(listTabOf(A({ employment_type: "正社員" })), "active"));
ok("応募形態が未定でも「選考中」", () => assert.equal(listTabOf(A({})), "active"));
for (const t of ["業務委託", "副業", "フリーランス", "スポット", "業務委託（週2）"]) {
  ok(`応募形態「${t}」は「業務委託」`, () => assert.equal(listTabOf(A({ employment_type: t })), "contractor"));
}
ok("合格後の採用区分が contractor／spot なら「業務委託」", () => {
  assert.equal(listTabOf(A({ offer_type: "contractor" })), "contractor");
  assert.equal(listTabOf(A({ offer_type: "spot" })), "contractor");
  assert.equal(isContractorApplicant(A({ offer_type: "regular" })), false);
});
ok("見送り・辞退は、業務委託・無限道場でも「終了」（自動で移る。削除はしない）", () => {
  assert.equal(listTabOf(A({ status: "passed" })), "closed");
  assert.equal(listTabOf(A({ status: "declined", employment_type: "業務委託" })), "closed");
  assert.equal(listTabOf(A({ status: "passed", lead_category: "mugendojo" })), "closed");
  assert.equal(listTabOf(A({ status: "position_closed" })), "closed", "募集終了も終了タブ");
});
ok("無限道場リードは「無限道場」", () => assert.equal(listTabOf(A({ lead_category: "mugendojo", stage: "md_trial" })), "mugendojo"));
ok("shapeApplicant が listTab と ceoNeeded を返す", () => {
  const s = shapeApplicant(A({ employment_type: "業務委託", stage: "ceo_recommend", status: "ceo_interview_pending" }));
  assert.equal(s.listTab, "contractor");
  assert.equal(s.ceoNeeded, true);
  assert.equal(shapeApplicant(A({})).ceoNeeded, false);
});
ok("応募媒体は固定候補で、既存の自由記述は「その他」に集計する", () => {
  assert.deepEqual(APPLICANT_SOURCES, ["Wantedly", "Green", "Indeed", "求人ボックス", "エージェント", "リファラル", "自社サイト", "SNS", "イベント・セミナー", "その他"]);
  const s = sourceStats([
    { source: "Wantedly" }, { source: "Wantedly" }, { source: "自社サイト" }, { source: "旧媒体名" }, { source: null },
  ]);
  assert.equal(s.find((x) => x.key === "Wantedly").count, 2);
  assert.equal(s.find((x) => x.key === "自社サイト").count, 1);
  assert.equal(s.find((x) => x.key === "その他").count, 1);
});

ok("応募者の追加・編集で応募形態（employmentType）を受け付ける", () => {
  const v = normalizeApplicant({ name: "山田", jobTitle: "PM", source: "Wantedly", employmentType: "業務委託" });
  assert.equal(v.value?.employment_type ?? v.employment_type, "業務委託");
});

ok("早期引き渡し（db/143）：Office で手続き中は「Officeへ移動済み」、Office で辞退・不成立は「終了」。業務委託でも同じ", () => {
  assert.equal(listTabOf(A({ office_intake: { phase: "handed_off" } })), "office");
  assert.equal(listTabOf(A({ employment_type: "業務委託", office_intake: { phase: "handed_off" } })), "office");
  assert.equal(listTabOf(A({ office_intake: { phase: "withdrawn" } })), "closed");
  assert.equal(listTabOf(A({ office_intake: { phase: "awaiting_hearing" } })), "active", "ヒアリング中は選考中のまま");
  assert.equal(listTabOf(A({ status: "declined", office_intake: { phase: "handed_off" } })), "closed");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
