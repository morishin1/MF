// パートナー制度の採算計算。税、現預金、一般管理費は含まない。
// すべて「円」の整数、比較時に使用。振込可能額の計算ではない。
export function contributionYen(revenue, directCost, partnerFee) {
  for (const n of [revenue,directCost,partnerFee]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("金額は0以上の整数が必要です");
  }
  return revenue - directCost - partnerFee;
}
export function monthlyRecoveryTargetYen(initialInvestment, monthlyFixed, months=6) {
  if (![initialInvestment,monthlyFixed,months].every(Number.isSafeInteger)
      || initialInvestment < 0 || monthlyFixed < 0 || months < 1)
    throw new TypeError("不正な投資額・固定費・回収期間です");
  return Math.ceil(initialInvestment / months) + monthlyFixed;
}
