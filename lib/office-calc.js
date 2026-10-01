// 契約条件の読み書きと、売上側の精算計算（/office）。
//
// ■ 純関数だけ。DB にも API にも触らない
//
// ■ 契約条件は、コードに書かない
//   単価・精算幅・超過／控除単価・丸めは、すべて gw_site_contract_terms の行から来る。
//   ここには「140〜180h」のような数字を1つも持たない。
//   gw_site_contracts.unit_price / settlement_condition は、意味が確定していないので使わない。
//   新しい条件は sales_unit_price（客先への売上単価）と purchase_unit_price（BP・外注への仕入単価）。
//
// ■ 自動計算するのは、規則がはっきり決まっているものだけ
//   ・月額：精算幅の中なら固定、外なら超過／控除の単価で増減
//   ・時給：時間 × 単価
//   次のものは、計算せず「要確認」にして理由を返す（推測で金額を出さない）：
//   ・日給（稼働日数の扱いが未確定）／月の途中で条件が変わる／月の一部だけ有効な条件（日割り）
//   ・単価・精算幅・超過／控除の単価が未設定／円未満の丸めが未設定で端数が出る
//   ・条件が1件も無い
//
// ■ 仕入側（BP・外注への支払）の精算は、ここでは計算しない
//   売上側と同じ幅・単価で精算するのか、別の条件なのかが確定していないため。
//   purchase_unit_price は、単価として持つだけ。
//
// ■ 金額は整数の演算で出す（小数の誤差を持ち込まない）
//   単価（円・小数2桁まで）→ 銭の整数、時間 → 分。端数は amountRounding で円にする。

import { daysInMonth } from "./holidays.js";

export const PRICING_TYPES = ["monthly", "hourly", "daily"];
export const PRICING_LABEL = { monthly: "月額", hourly: "時給", daily: "日給" };
export const SETTLEMENT_MODES = ["range", "fixed"];
export const ROUND_MODES = ["floor", "ceil", "round"];
export const ROUND_LABEL = { floor: "切捨て", ceil: "切上げ", round: "四捨五入" };
export const ROUND_SCOPES = ["day", "month"];
export const SETTLE_UNITS = [5, 10, 15, 30, 60];
export const MAX_PRICE = 9999999999.99;

const pad = (n) => String(n).padStart(2, "0");
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ""));

/** YYYY-MM-DD で、暦に実在するか */
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** 数値（または数字の文字列）を、小数2桁までの 0 以上の数にする。空は null。不正は undefined */
function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+(\.\d{1,2})?$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return undefined;
  return Math.round(n * 100) / 100;
}
const cents = (yen) => Math.round(yen * 100);

/** 時間（例 140・"162.5"）→ 分。空は null。不正は undefined */
function hoursToMin(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+(\.\d{1,2})?$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 744) return undefined;   // 31日×24時間
  return Math.round(n * 60);
}

/**
 * 画面・API からの入力を、DB の列にそろえる。
 * 直せない入力は errors に日本語で入れる（黙って直さない）
 *
 * @returns {{ ok: boolean, errors: string[], value: object }}
 *   value … gw_site_contract_terms の列（snake_case）。site_contract_id・tenant_id は呼び側で足す
 */
export function parseTermsInput(b = {}) {
  const errors = [];
  const err = (m) => errors.push(m);

  const validFrom = b.validFrom ?? b.valid_from;
  const validTo = b.validTo ?? b.valid_to ?? null;
  if (!isRealDate(validFrom)) err("有効開始日を、実在する日付（YYYY-MM-DD）で入れてください");
  const to = validTo === "" ? null : validTo;
  if (to !== null && !isRealDate(to)) err("有効終了日は、実在する日付（YYYY-MM-DD）か、空にしてください");
  if (isRealDate(validFrom) && to && isRealDate(to) && to < validFrom) err("有効終了日が、開始日より前です");

  const pricingType = b.pricingType ?? b.pricing_type;
  if (!PRICING_TYPES.includes(pricingType)) err("単価の種類（月額・時給・日給）を選んでください");

  const sales = money(b.salesUnitPrice ?? b.sales_unit_price);
  if (sales === undefined) err("売上単価は、0以上の数（小数2桁まで）で入れてください");
  const purchase = money(b.purchaseUnitPrice ?? b.purchase_unit_price);
  if (purchase === undefined) err("仕入単価は、0以上の数（小数2桁まで）で入れてください");

  let settlementMode = b.settlementMode ?? b.settlement_mode ?? null;
  if (settlementMode === "") settlementMode = null;
  if (settlementMode !== null && !SETTLEMENT_MODES.includes(settlementMode)) err("精算の方法が正しくありません");
  if (pricingType === "monthly" && settlementMode === null) err("月額は、精算の方法（精算幅あり／精算なし）を選んでください");

  let minMin = b.settleMinMinutes ?? b.settle_min_minutes ?? null;
  let maxMin = b.settleMaxMinutes ?? b.settle_max_minutes ?? null;
  if (b.settleMinHours !== undefined || b.settleMaxHours !== undefined) {
    minMin = hoursToMin(b.settleMinHours);
    maxMin = hoursToMin(b.settleMaxHours);
    if (minMin === undefined) err("精算幅の下限は、0〜744 の時間（小数2桁まで）で入れてください");
    if (maxMin === undefined) err("精算幅の上限は、0〜744 の時間（小数2桁まで）で入れてください");
  }
  const okMin = minMin === undefined || minMin === null || (Number.isInteger(minMin) && minMin >= 0);
  const okMax = maxMin === undefined || maxMin === null || (Number.isInteger(maxMin) && maxMin >= 0);
  if (!okMin || !okMax) err("精算幅は、0以上の整数（分）で指定してください");
  if (pricingType === "monthly" && settlementMode === "range") {
    if (minMin == null || maxMin == null) err("精算幅ありの月額は、下限と上限の時間を入れてください");
    else if (minMin > maxMin) err("精算幅の下限が、上限より大きいです");
  }
  if (settlementMode === "fixed" || pricingType !== "monthly") { minMin = null; maxMin = null; }

  let unit = b.settleUnitMinutes ?? b.settle_unit_minutes ?? null;
  if (unit === "") unit = null;
  if (unit !== null) unit = Number(unit);
  if (unit !== null && !SETTLE_UNITS.includes(unit)) err(`精算の単位（分）は ${SETTLE_UNITS.join("・")} のどれかにしてください`);
  let roundingMode = b.roundingMode ?? b.rounding_mode ?? null;
  let roundingScope = b.roundingScope ?? b.rounding_scope ?? null;
  if (roundingMode === "") roundingMode = null;
  if (roundingScope === "") roundingScope = null;
  if (roundingMode !== null && !ROUND_MODES.includes(roundingMode)) err("丸めの方向が正しくありません");
  if (roundingScope !== null && !ROUND_SCOPES.includes(roundingScope)) err("丸めの単位（日ごと／月合計）が正しくありません");
  if (unit !== null && (roundingMode === null || roundingScope === null)) err("精算の単位を入れたときは、丸めの方向と、日ごと／月合計の別も選んでください");
  if (unit === null) { roundingMode = null; roundingScope = null; }

  const over = money(b.overRatePerHour ?? b.over_rate_per_hour);
  const under = money(b.underRatePerHour ?? b.under_rate_per_hour);
  if (over === undefined) err("超過単価は、0以上の数（円／時間・小数2桁まで）で入れてください");
  if (under === undefined) err("控除単価は、0以上の数（円／時間・小数2桁まで）で入れてください");

  let amountRounding = b.amountRounding ?? b.amount_rounding ?? null;
  if (amountRounding === "") amountRounding = null;
  if (amountRounding !== null && !ROUND_MODES.includes(amountRounding)) err("円未満の丸めが正しくありません");

  const prorate = b.prorate === true || b.prorate === "true";

  return {
    ok: errors.length === 0,
    errors,
    value: {
      valid_from: isRealDate(validFrom) ? validFrom : null,
      valid_to: to,
      pricing_type: pricingType,
      sales_unit_price: sales === undefined ? null : sales,
      purchase_unit_price: purchase === undefined ? null : purchase,
      settlement_mode: settlementMode,
      settle_min_minutes: minMin === undefined ? null : minMin,
      settle_max_minutes: maxMin === undefined ? null : maxMin,
      settle_unit_minutes: unit,
      rounding_mode: roundingMode,
      rounding_scope: roundingScope,
      over_rate_per_hour: over === undefined ? null : over,
      under_rate_per_hour: under === undefined ? null : under,
      prorate,
      amount_rounding: amountRounding,
    },
  };
}

/** DB の行（snake_case）→ 計算・表示用（camelCase）。数値は数にそろえる */
export function normalizeTerms(r) {
  if (!r) return null;
  const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    id: r.id ?? null,
    siteContractId: r.site_contract_id ?? null,
    validFrom: r.valid_from ?? null,
    validTo: r.valid_to ?? null,
    pricingType: r.pricing_type ?? null,
    salesUnitPrice: n(r.sales_unit_price),
    purchaseUnitPrice: n(r.purchase_unit_price),
    settlementMode: r.settlement_mode ?? null,
    settleMinMinutes: n(r.settle_min_minutes),
    settleMaxMinutes: n(r.settle_max_minutes),
    settleUnitMinutes: n(r.settle_unit_minutes),
    roundingMode: r.rounding_mode ?? null,
    roundingScope: r.rounding_scope ?? null,
    overRatePerHour: n(r.over_rate_per_hour),
    underRatePerHour: n(r.under_rate_per_hour),
    prorate: r.prorate === true,
    amountRounding: r.amount_rounding ?? null,
  };
}

/**
 * ある月に効く条件を選ぶ。
 * @returns {{ status: 'none'|'ok'|'multiple', terms: object|null, partial: boolean, candidates: object[] }}
 *   none     … 月にかかる条件が無い
 *   multiple … 月にかかる条件が2件以上（月の途中で条件が変わる）。自動では選ばない
 *   ok       … 1件。partial は、月の全体をカバーしていない（月の途中から／までの条件）
 */
export function termsForMonth(rows, month) {
  if (!isMonth(month)) return { status: "none", terms: null, partial: false, candidates: [] };
  const first = `${month}-01`;
  const last = `${month}-${pad(daysInMonth(month))}`;
  const cands = (rows || [])
    .map((r) => (r && "validFrom" in r ? r : normalizeTerms(r)))
    .filter((t) => t && t.validFrom && t.validFrom <= last && (!t.validTo || t.validTo >= first))
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  if (cands.length === 0) return { status: "none", terms: null, partial: false, candidates: [] };
  if (cands.length > 1) return { status: "multiple", terms: null, partial: false, candidates: cands };
  const t = cands[0];
  const partial = t.validFrom > first || Boolean(t.validTo && t.validTo < last);
  return { status: "ok", terms: t, partial, candidates: cands };
}

/** 端数のある整数の商を、円にする。num/den（den>0）。mode: floor|ceil|round（.5 は切上げ） */
function divRound(num, den, mode) {
  const q = Math.floor(num / den);
  const r = num - q * den;
  if (r === 0) return { yen: q, fraction: false };
  if (mode === "ceil") return { yen: q + 1, fraction: true };
  if (mode === "round") return { yen: r * 2 >= den ? q + 1 : q, fraction: true };
  return { yen: q, fraction: true };
}

/**
 * 契約条件と、確定した実働（分）から、売上側の精算を出す。
 *
 * @param {{ terms: ReturnType<typeof termsForMonth>, minutes: number|null }} a
 *   minutes … 確定した月合計（丸め済み）。確定していなければ null（計算しない）
 * @returns {{
 *   status: 'none'|'review'|'calculated',
 *   reasons: string[],
 *   pricingType: string|null, salesUnitPrice: number|null,
 *   band: 'within'|'over'|'under'|null, overMinutes: number, underMinutes: number,
 *   amount: number|null, adjustment: number|null
 * }}
 *   none … 条件が無い。review … 計算せず、人が見る。calculated … 金額が出た
 *   adjustment … 月額の、単価からの増減（時給は null）
 *   band は、金額が出せなくても、精算幅と実働の位置関係が分かれば返す（照合のため）
 */
export function settle({ terms, minutes } = {}) {
  const base = { pricingType: null, salesUnitPrice: null, band: null, overMinutes: 0, underMinutes: 0, amount: null, adjustment: null };
  const review = (reasons, extra = {}) => ({ status: "review", reasons, ...base, ...extra });

  if (!terms || terms.status === "none") {
    return { status: "none", reasons: ["この月に効く契約条件が登録されていません"], ...base };
  }
  if (terms.status === "multiple") {
    return review(["この月に効く契約条件が2件以上あります（月の途中で条件が変わる）。自動計算せず、確認してください"]);
  }
  const t = terms.terms;
  const common = { pricingType: t.pricingType, salesUnitPrice: t.salesUnitPrice };
  const reasons = [];

  // 位置関係（月額・精算幅あり）は、金額が出せなくても照合のために出す
  let band = null, over = 0, under = 0;
  if (t.pricingType === "monthly" && t.settlementMode === "range" && minutes !== null && minutes !== undefined
      && t.settleMinMinutes !== null && t.settleMaxMinutes !== null) {
    if (minutes > t.settleMaxMinutes) { band = "over"; over = minutes - t.settleMaxMinutes; }
    else if (minutes < t.settleMinMinutes) { band = "under"; under = t.settleMinMinutes - minutes; }
    else band = "within";
  }
  const withBand = { ...common, band, overMinutes: over, underMinutes: under };

  if (terms.partial) {
    reasons.push(t.prorate
      ? "月の一部だけ有効な条件です。日割りの精算は、まだ自動計算していません"
      : "月の一部だけ有効な条件です（月の途中からの開始・終了）。日割りの扱いを確認してください");
  }
  if (t.pricingType === "daily") reasons.push("日給は、稼働日数の扱いが確定していないため、自動計算していません");
  if (t.salesUnitPrice === null) reasons.push("売上単価が未設定です");
  if (minutes === null || minutes === undefined) reasons.push("稼働時間が確定していません");
  if (reasons.length) return review(reasons, withBand);

  // ここから先は、月額（精算幅あり／なし）か時給で、月の全体を1件の条件がカバーしている
  const priceC = cents(t.salesUnitPrice);
  // 銭 × 分 の整数で持つ。円にするときは 6000（100銭 × 60分）で割る
  //   時給：単価（銭/時間）× 分 ／ 月額：単価（銭）× 60 ＋ 超過・控除（銭/時間）× 分
  const DEN = 6000;
  let numer;
  if (t.pricingType === "hourly") {
    numer = priceC * minutes;
  } else if (t.settlementMode === "fixed") {
    numer = priceC * 60;
  } else {
    if (t.settleMinMinutes === null || t.settleMaxMinutes === null) {
      return review(["精算幅（下限・上限）が未設定です"], withBand);
    }
    numer = priceC * 60;
    if (band === "over") {
      if (t.overRatePerHour === null) return review(["超過単価が未設定です（精算しない場合は 0 を入れてください）"], withBand);
      numer += cents(t.overRatePerHour) * over;
    } else if (band === "under") {
      if (t.underRatePerHour === null) return review(["控除単価が未設定です（控除しない場合は 0 を入れてください）"], withBand);
      numer -= cents(t.underRatePerHour) * under;
    }
  }
  if (numer < 0) return review(["控除が単価を超えます。条件を確認してください"], withBand);

  const hasFraction = numer % DEN !== 0;
  if (hasFraction && t.amountRounding === null) {
    return review(["円未満の端数が出ます。円未満の丸め（切捨て・切上げ・四捨五入）が未設定です"], withBand);
  }
  const { yen } = divRound(numer, DEN, t.amountRounding || "floor");
  return {
    status: "calculated", reasons: [], ...withBand,
    amount: yen,
    adjustment: t.pricingType === "monthly" ? yen - Math.round(t.salesUnitPrice) : null,
  };
}

/** 契約条件の1行の見出し（画面用）。例：月額 700,000円（140〜180h） */
export function describeTerms(t) {
  if (!t) return "";
  const yen = (v) => (v === null || v === undefined ? "未設定" : `${Number(v).toLocaleString("ja-JP")}円`);
  const h = (m) => String(Math.round((m / 60) * 100) / 100);
  const lab = PRICING_LABEL[t.pricingType] || "種類未設定";
  let s = `${lab} ${yen(t.salesUnitPrice)}`;
  if (t.pricingType === "monthly") {
    s += t.settlementMode === "fixed" ? "（精算なし）"
      : t.settleMinMinutes !== null && t.settleMaxMinutes !== null ? `（${h(t.settleMinMinutes)}〜${h(t.settleMaxMinutes)}h）` : "（精算幅 未設定）";
  }
  return s;
}
