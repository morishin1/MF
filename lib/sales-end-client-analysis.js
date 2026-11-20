// Sales「エンド営業」分析：ENGERの記録を実績と誤認させないための集計専用関数。
// DB・HTTP・個人情報に依存しない。画面/APIで同じ定義を共有する。
export const END_CLIENT_PERIODS = Object.freeze([30, 90, 365]);
export const SUPPLY_ROLE_TITLES = Object.freeze([
  "クラウドエンジニア",
  "PMO",
  "バックエンドエンジニア",
  "インフラエンジニア",
  "データエンジニア",
  "フロントエンドエンジニア",
]);

export function periodStartJst(days, now = new Date()) {
  if (!END_CLIENT_PERIODS.includes(days)) throw new Error("invalid_period");
  const d = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() - days + 1);
  return d.toISOString().slice(0, 10) + "T00:00:00+09:00";
}

export function summarizeEngagements(rows = []) {
  const distinctNames = new Set(rows.map((r) => String(r.company || "").trim()).filter(Boolean));
  return {
    totalRecords: rows.length,
    statusWorking: rows.filter((r) => r.status === "稼働中").length,
    statusPlanned: rows.filter((r) => r.status === "予定").length,
    companyNames: distinctNames.size,
    endDateMissing: rows.filter((r) => !r.end_date).length,
    withProposalId: rows.filter((r) => Boolean(r.proposal_id)).length,
    // 「稼働中」は入力ステータス。「現時点の稼働人数」「月次売上」ではない。
  };
}

function lossCategory(row) {
  const raw = [row.lost_reason_category, row.lost_reason, row.lost_detail_reason]
    .filter((x) => typeof x === "string").join(" ");
  if (/スキル|経験|アンマッチ|条件不一致|技術不足/i.test(raw)) return "スキル・条件不一致";
  if (/人材側|候補者側|辞退/i.test(raw)) return "人材側の辞退";
  if (/連絡|返信|無回答|音信|フォロー|架電|不通/i.test(raw)) return "連絡・フォロー不成立";
  if (/募集終了|充足|ポジション|クローズ|案件終了|他社|他候補/i.test(raw)) return "募集終了・他候補決定";
  if (/単価|金額|コスト|予算/i.test(raw)) return "金額・予算";
  return "その他・理由未分類";
}

export function summarizeEngerProposals(rows = []) {
  const lost = rows.filter((r) => r.stage === "失注" || r.stage === "見送り");
  const reasons = new Map();
  for (const r of lost) {
    const category = lossCategory(r);
    reasons.set(category, (reasons.get(category) || 0) + 1);
  }
  return {
    totalRecords: rows.length,
    lostRecords: lost.filter((r) => r.stage === "失注").length,
    rejectedRecords: lost.filter((r) => r.stage === "見送り").length,
    proposingRecords: rows.filter((r) => r.stage === "提案中").length,
    goodStageRecords: rows.filter((r) => ["合格", "稼働"].includes(r.stage)).length,
    lossReasons: [...reasons].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja")),
  };
}

export function summarizeEndClientCoverage(rows = []) {
  const industries = new Map();
  for (const row of rows) {
    const industry = String(row.industry || "").trim();
    if (industry) industries.set(industry, (industries.get(industry) || 0) + 1);
  }
  return {
    flaggedCount: rows.length,
    industryKnown: rows.filter((r) => Boolean(String(r.industry || "").trim())).length,
    sizeKnown: rows.filter((r) => Boolean(String(r.employee_band || "").trim())).length,
    industries: [...industries].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count).slice(0, 6),
  };
}
