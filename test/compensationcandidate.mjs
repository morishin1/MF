// 初回給与の「候補」を作る部品（lib/compensation-candidate.js）。
//
// ■ 何を守るのか
//   1. 候補は、既存のデータ（契約・内定・本人の届出）から作る。基本給の基準は 契約 > 内定、通勤手当は本人の届出
//   2. 自動では決めない: 候補に適用開始日は入らない（参考の日付を出すだけ）。手当は候補にしない（文章があれば警告）
//   3. 候補にできないとき（契約の種別が「その他」・金額なし・契約なし）は、理由を返す。推測で埋めない
//   4. どのデータを基準にしたか（basis）と、経営者が候補のどこを直したか（edited）が残る
import assert from "node:assert/strict";
import { buildCandidate, basisOf, sourceOf, describeBasis, basisLabel } from "../lib/compensation-candidate.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const contract = (o = {}) => ({ id: "k1", wageType: "月給", wageAmount: 300000, wageNote: null, periodFrom: "2025-04-01", ...o });

console.log("— 基本給の基準: 契約 > 内定 —");

ok("契約の賃金から候補を作る。基準（sources）に契約の id・種別・金額が入り、取り込み元は contract_import", () => {
  const r = buildCandidate({ contract: contract(), contractCount: 1 });
  assert.equal(r.candidate.wageType, "月給"); assert.equal(r.candidate.baseAmount, 300000);
  assert.equal(r.candidate.commuteAmount, null); assert.equal(r.candidate.source, "contract_import");
  assert.deepEqual(r.candidate.sources, [{ type: "contract", label: "有効な契約の賃金", id: "k1", wageType: "月給", wageAmount: 300000 }]);
  assert.deepEqual(r.warnings, []); assert.deepEqual(r.why, []);
});

ok("PostgreSQL の numeric は文字列で来る。数に直す", () => {
  const r = buildCandidate({ contract: contract({ wageAmount: "300000.00" }) });
  assert.equal(r.candidate.baseAmount, 300000);
});

ok("契約に使えない賃金しかないとき（種別が「その他」）は、内定を基準にして警告する。取り込み元は offer_import", () => {
  const r = buildCandidate({ contract: contract({ wageType: "その他" }), offer: { wageType: "月給", wageAmount: 280000, from: "内定（合格通知）" } });
  assert.equal(r.candidate.baseAmount, 280000); assert.equal(r.candidate.source, "offer_import");
  assert.equal(r.candidate.sources[0].type, "offer");
  assert.ok(r.warnings.some((w) => /内定時の給与を基準/.test(w)));
});

ok("契約が無い・金額が無いときも、内定があれば内定を基準にする", () => {
  for (const c of [null, contract({ wageAmount: null })]) {
    const r = buildCandidate({ contract: c, offer: { wageType: "年俸", wageAmount: 4800000 } });
    assert.equal(r.candidate.wageType, "年俸"); assert.equal(r.candidate.baseAmount, 4800000);
  }
});

ok("契約と内定が食い違うとき、契約を基準にして警告する。同じなら警告しない", () => {
  const diff = buildCandidate({ contract: contract(), offer: { wageType: "月給", wageAmount: 280000 } });
  assert.equal(diff.candidate.baseAmount, 300000);
  assert.ok(diff.warnings.some((w) => /内定時の給与が、契約の賃金と違います/.test(w)));
  const same = buildCandidate({ contract: contract(), offer: { wageType: "月給", wageAmount: 300000 } });
  assert.deepEqual(same.warnings, []);
  const type = buildCandidate({ contract: contract(), offer: { wageType: "年俸", wageAmount: 300000 } });
  assert.ok(type.warnings.some((w) => /違います/.test(w)), "種別だけ違っても警告");
});

console.log("\n— 通勤手当・手当・日付 —");

ok("通勤手当は、本人が届け出た定期代を候補にする。会社が決めた額ではないと警告する", () => {
  const r = buildCandidate({ contract: contract(), commuteDeclared: 12000 });
  assert.equal(r.candidate.commuteAmount, 12000);
  assert.deepEqual(r.candidate.sources.map((s) => s.type), ["contract", "commute_declared"]);
  assert.equal(r.candidate.sources[1].amount, 12000);
  assert.ok(r.warnings.some((w) => /会社が決めた額ではありません/.test(w)));
  assert.equal(buildCandidate({ contract: contract(), commuteDeclared: 0 }).candidate.commuteAmount, 0, "0 円の届出は 0 円");
  assert.equal(buildCandidate({ contract: contract(), commuteDeclared: null }).candidate.commuteAmount, null);
});

ok("手当は候補にしない。契約の注記に文章があれば警告する", () => {
  const r = buildCandidate({ contract: contract({ wageNote: "皆勤手当 5000円" }) });
  assert.ok(!("allowances" in r.candidate), "候補に手当は無い");
  assert.ok(r.warnings.some((w) => /手当は候補にできない/.test(w)));
  assert.deepEqual(buildCandidate({ contract: contract({ wageNote: "   " }) }).warnings, [], "空白だけの注記は警告しない");
});

ok("有効な契約が2件以上なら警告する", () => {
  const r = buildCandidate({ contract: contract(), contractCount: 3 });
  assert.ok(r.warnings.some((w) => /3件/.test(w)));
});

ok("適用開始日は決めない。参考の日付（契約の開始日・入社日）を出すだけ。同じ日付は1つ", () => {
  const r = buildCandidate({ contract: contract({ periodFrom: "2025-04-01" }), employee: { joinedOn: "2025-04-01" } });
  assert.ok(!("effectiveFrom" in r.candidate), "候補に適用開始日は入らない");
  assert.deepEqual(r.dateHints, [{ label: "契約の開始日", date: "2025-04-01" }]);
  const two = buildCandidate({ contract: contract({ periodFrom: "2025-04-01" }), employee: { joinedOn: "2025-04-15T00:00:00Z" } });
  assert.deepEqual(two.dateHints.map((h) => h.date), ["2025-04-01", "2025-04-15"]);
});

console.log("\n— 候補にできないとき —");

ok("契約も内定も届出も無ければ、候補は無い（理由を返す）", () => {
  const r = buildCandidate({});
  assert.equal(r.candidate, null); assert.ok(r.why.some((w) => /有効な契約がありません/.test(w)));
});

ok("契約の種別が「その他」だけなら、候補は無い。理由に種別が出る", () => {
  const r = buildCandidate({ contract: contract({ wageType: "その他" }) });
  assert.equal(r.candidate, null); assert.ok(r.why.some((w) => /その他/.test(w)));
  const empty = buildCandidate({ contract: contract({ wageType: null }) });
  assert.ok(empty.why.some((w) => /未設定/.test(w)));
});

ok("契約に金額が無いだけなら、候補は無い", () => {
  const r = buildCandidate({ contract: contract({ wageAmount: null }) });
  assert.equal(r.candidate, null); assert.ok(r.why.some((w) => /金額がありません/.test(w)));
});

ok("届出の定期代だけあるとき: 基本給の候補は無いが、通勤手当の候補は出す。基本給は経営者が入れる", () => {
  const r = buildCandidate({ commuteDeclared: 9000 });
  assert.equal(r.candidate.baseAmount, null); assert.equal(r.candidate.wageType, null);
  assert.equal(r.candidate.commuteAmount, 9000); assert.equal(r.candidate.source, "owner");
  assert.ok(r.warnings[0].includes("基本給の候補を作れません"));
  assert.ok(r.why.length > 0, "基本給を作れなかった理由");
});

console.log("\n— 基準（basis）の記録 —");

const cand = () => buildCandidate({ contract: contract(), commuteDeclared: 12000 }).candidate;

ok("候補のまま登録すると edited は空。基準（契約・届出）が残る", () => {
  const c = cand();
  const b = basisOf(c, { wageType: "月給", baseAmount: 300000, commuteAmount: 12000, allowances: [] });
  assert.equal(b.kind, "candidate"); assert.equal(b.version, 1);
  assert.deepEqual(b.candidate, { wageType: "月給", baseAmount: 300000, commuteAmount: 12000 });
  assert.deepEqual(b.edited, []); assert.equal(b.allowancesAdded, 0);
  assert.deepEqual(b.sources.map((s) => s.type), ["contract", "commute_declared"]);
  assert.equal(sourceOf(c, { wageType: "月給", baseAmount: 300000 }), "contract_import");
});

ok("経営者が直した項目が edited に残る。基本給を直したら、取り込み元は経営者の入力", () => {
  const c = cand();
  const final = { wageType: "月給", baseAmount: 310000, commuteAmount: 10000, allowances: [{ name: "役職手当", amount: 20000 }] };
  const b = basisOf(c, final);
  assert.deepEqual(b.edited, ["baseAmount", "commuteAmount"]);
  assert.equal(b.allowancesAdded, 1);
  assert.deepEqual(b.candidate, { wageType: "月給", baseAmount: 300000, commuteAmount: 12000 }, "候補そのものは、直す前の値で残る");
  assert.equal(sourceOf(c, final), "owner");
  // 通勤手当だけ直しても、基本給が候補のままなら、取り込み元は契約
  assert.equal(sourceOf(c, { wageType: "月給", baseAmount: 300000, commuteAmount: 5000 }), "contract_import");
});

ok("文字列の金額でも、同じ値なら直したことにならない（300000 と \"300000\"）", () => {
  const b = basisOf(cand(), { wageType: "月給", baseAmount: "300000", commuteAmount: "12000", allowances: [] });
  assert.deepEqual(b.edited, []);
});

ok("画面に出す一文: 基準・直した項目・手当の追加", () => {
  const c = cand();
  assert.equal(describeBasis(basisOf(c, { wageType: "月給", baseAmount: 300000, commuteAmount: 12000, allowances: [] })),
    "候補から登録（基準: 有効な契約の賃金・本人が届け出た定期代）／候補のまま");
  assert.equal(describeBasis(basisOf(c, { wageType: "月給", baseAmount: 310000, commuteAmount: 12000, allowances: [{ name: "a", amount: 1 }] })),
    "候補から登録（基準: 有効な契約の賃金・本人が届け出た定期代）／候補から直した項目: 基本給／手当 1件を追加");
  assert.equal(describeBasis(null), null); assert.equal(describeBasis({ kind: "other" }), null);
  assert.equal(basisLabel("offer"), "内定時の給与");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
