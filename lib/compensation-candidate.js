// 初回給与の「候補」を作る、純粋な部品（test/compensationcandidate.mjs）。表も画面も知らない。
//
// ■ 何のためか
//   db/105 のあと、経営者が社員1人ずつ、給与を手で入れるのは件数が多い。既存のデータ（契約・内定・本人の届出）から、
//   「この内容を初回給与として登録します」という**候補**を作る。
//
// ■ 守ること
//   ・自動では登録しない。候補は、入力欄に写るだけ。経営者が 確認 → 修正 → 理由入力 → 登録 する
//   ・適用開始日は決めない（「いつから」は経営者が決める）。参考の日付（契約の開始日・入社日）を出すだけ
//   ・手当は候補にできない（契約では文章の中にしかない）。文章があることを警告して、手入力してもらう
//   ・どのデータを基準に候補を作ったかを、記録（basis）に残す。経営者が候補を直したときは、直した項目も残す
//   ・基準の優先順位: 基本給は 契約 > 内定。通勤手当は 本人の届出（申告であって、会社が決めた額ではない）
//
// ■ 候補にできないもの
//   契約の賃金の種別が 月給・年俸・時給・日給 以外（その他・空）／金額が無い

import { WAGE_TYPES } from "./compensation.js";

const supported = (t) => WAGE_TYPES.includes(t);
const num = (v) => (v == null || v === "" ? null : Number(v));

export const SOURCE_TYPE_LABEL = { contract: "有効な契約の賃金", offer: "内定時の給与", commute_declared: "本人が届け出た定期代" };
/** 基準の言い方（履歴の表示用）。type → 短いラベル */
export const basisLabel = (type) => SOURCE_TYPE_LABEL[type] || String(type);

/**
 * @param {{
 *   contract?: {id?:string, wageType?:string|null, wageAmount?:number|null, wageNote?:string|null, periodFrom?:string|null}|null,
 *   contractCount?: number,
 *   offer?: {wageType?:string|null, wageAmount?:number|null, from?:string}|null,
 *   commuteDeclared?: number|null,
 *   employee?: {joinedOn?:string|null}|null,
 * }} refs
 * @returns {{ candidate: object|null, warnings: string[], why: string[], dateHints: {label:string, date:string}[] }}
 */
export function buildCandidate({ contract = null, contractCount = 0, offer = null, commuteDeclared = null, employee = null } = {}) {
  const warnings = [];
  const why = [];
  const sources = [];
  let wageType = null;
  let baseAmount = null;
  let baseFrom = null;

  const cAmount = num(contract?.wageAmount);
  const oAmount = num(offer?.wageAmount);

  if (contract && cAmount != null) {
    if (supported(contract.wageType)) {
      wageType = contract.wageType; baseAmount = cAmount; baseFrom = "contract";
      sources.push({ type: "contract", label: SOURCE_TYPE_LABEL.contract, id: contract.id || null, wageType: contract.wageType, wageAmount: cAmount });
    } else {
      why.push(`契約の賃金の種別が「${contract.wageType || "未設定"}」で、月給・年俸・時給・日給のどれでもないため、契約からは候補にできません`);
    }
  } else if (contract) {
    why.push("有効な契約に、賃金の金額がありません");
  } else {
    why.push("有効な契約がありません");
  }

  if (!baseFrom && offer && oAmount != null && supported(offer.wageType)) {
    wageType = offer.wageType; baseAmount = oAmount; baseFrom = "offer";
    sources.push({ type: "offer", label: SOURCE_TYPE_LABEL.offer, wageType: offer.wageType, wageAmount: oAmount, from: offer.from || null });
    warnings.push("契約から候補を作れないため、内定時の給与を基準にしました。入社前の条件なので、金額を確かめてください");
  } else if (baseFrom === "contract" && offer && oAmount != null
    && (offer.wageType !== contract.wageType || oAmount !== cAmount)) {
    warnings.push("内定時の給与が、契約の賃金と違います。契約（有効な最新の1件）を基準にしました");
  }
  if (!baseFrom && offer && oAmount == null) why.push("内定の給与に、金額がありません");

  if (contractCount > 1) warnings.push(`有効な契約が${contractCount}件あります。いちばん新しい1件を基準にしました。古い契約が残っていないか、契約の画面で確かめてください`);
  if (contract && String(contract.wageNote || "").trim()) {
    warnings.push("契約の注記（手当・控除など）に文章があります。手当は候補にできないので、内容を確かめて、手当を入力してください");
  }

  const commute = num(commuteDeclared);
  if (commute != null) {
    sources.push({ type: "commute_declared", label: SOURCE_TYPE_LABEL.commute_declared, amount: commute });
    warnings.push("通勤手当の候補は、本人が届け出た定期代です（会社が決めた額ではありません）。上限や非課税枠、実際に支給する額を確かめてください");
  }

  const dateHints = [];
  const seen = new Set();
  for (const [label, date] of [["契約の開始日", contract?.periodFrom], ["入社日", employee?.joinedOn]]) {
    const d = date ? String(date).slice(0, 10) : "";
    if (d && !seen.has(d)) { seen.add(d); dateHints.push({ label, date: d }); }
  }

  if (!baseFrom && commute == null) return { candidate: null, warnings: [], why, dateHints };
  if (!baseFrom) {
    // 基本給の基準が無く、通勤手当の候補だけがある。基本給は経営者が入れる
    warnings.unshift("基本給の候補を作れません。基本給と賃金の種別は、経営者が入力してください");
  }

  return {
    candidate: {
      wageType, baseAmount, commuteAmount: commute,
      // 記録の取り込み元（契約から / 内定から / 経営者の入力）。基本給の基準と同じ
      source: baseFrom === "contract" ? "contract_import" : baseFrom === "offer" ? "offer_import" : "owner",
      sources,
    },
    warnings, why: baseFrom ? [] : why, dateHints,
  };
}

const CANDIDATE_FIELDS = ["wageType", "baseAmount", "commuteAmount"];
const same = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));

/**
 * 記録（basis）に残す内容。どのデータを基準に候補を作り、経営者がどの項目を直したか。
 * @param {object} candidate  buildCandidate の candidate
 * @param {{wageType:string, baseAmount:number, commuteAmount:number|null, allowances?:object[]}} final  実際に記録する値
 */
export function basisOf(candidate, final) {
  const edited = CANDIDATE_FIELDS.filter((k) => !same(candidate[k], final[k]));
  return {
    version: 1, kind: "candidate",
    candidate: { wageType: candidate.wageType, baseAmount: candidate.baseAmount, commuteAmount: candidate.commuteAmount },
    sources: candidate.sources,
    edited,
    allowancesAdded: (final.allowances || []).length,
  };
}

/** 記録の取り込み元。基本給と種別が候補のままなら候補の元、直していれば「経営者の入力」 */
export function sourceOf(candidate, final) {
  return same(candidate.wageType, final.wageType) && same(candidate.baseAmount, final.baseAmount) ? candidate.source : "owner";
}

/** basis を、画面に出す一文に */
export function describeBasis(basis) {
  if (!basis || basis.kind !== "candidate") return null;
  const from = (basis.sources || []).map((s) => basisLabel(s.type)).join("・") || "（基準なし）";
  const FIELD = { wageType: "賃金の種別", baseAmount: "基本給", commuteAmount: "通勤手当" };
  const edited = (basis.edited || []).map((k) => FIELD[k] || k);
  return `候補から登録（基準: ${from}）${edited.length ? `／候補から直した項目: ${edited.join("・")}` : "／候補のまま"}${basis.allowancesAdded ? `／手当 ${basis.allowancesAdded}件を追加` : ""}`;
}
