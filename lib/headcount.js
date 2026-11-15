// 在籍人数と区分別人数は、同じ名簿の各人を1回ずつ数える。
// 育成期間があるだけで「育成枠」とは扱わず、登録された区分だけを使う。
const CURRENT = new Set(["active", "leaving"]);
const CATEGORIES = [
  ["regular", "正社員"], ["contract", "契約社員"], ["partTime", "パート・アルバイト"],
  ["contractor", "業務委託"], ["officer", "役員"], ["training", "育成枠"],
  ["trial", "2週間トライアル"], ["spot", "スポット・副業"], ["bp", "BP"],
  ["other", "その他"], ["unclassified", "区分未設定"],
];
const EMPLOYMENT = {
  "正社員": "regular", "契約社員": "contract", "有期雇用": "contract",
  "パート": "partTime", "アルバイト": "partTime", "パート・アルバイト": "partTime",
  "業務委託": "contractor", "役員": "officer", "育成枠": "training",
  "2週間トライアル": "trial", "スポット": "spot", "副業": "spot", "スポット・副業": "spot",
};
const RECRUITMENT = {
  executive_employee: "regular", part_time: "partTime", contractor: "contractor",
  training: "training", trial_2weeks: "trial", spot: "spot",
};

export function summarizeHeadcount(employees, { applicants = [] } = {}) {
  // 同じ社員に複数の採用記録があっても人数を増やさない。区分が食い違えば推測しない。
  const recruitment = new Map();
  for (const a of applicants || []) {
    if (!a.employee_id || !["accepted", "done"].includes(a.status) || !Object.hasOwn(RECRUITMENT, a.offer_type)) continue;
    if (!recruitment.has(a.employee_id)) recruitment.set(a.employee_id, new Set());
    recruitment.get(a.employee_id).add(RECRUITMENT[a.offer_type]);
  }
  const counts = Object.fromEntries(CATEGORIES.map(([key]) => [key, 0]));
  const active = (employees || []).filter(e => CURRENT.has(e.status));
  for (const e of active) {
    const type = String(e.employment_type || "").trim();
    const offered = recruitment.get(e.id);
    const key = e.employee_kind === "bp" ? "bp" : (Object.hasOwn(EMPLOYMENT, type) ? EMPLOYMENT[type] : null)
      || (offered?.size === 1 ? [...offered][0] : type ? "other" : "unclassified");
    counts[key]++;
  }
  return {
    status: "exact", total: active.length, proper: active.length - counts.bp, bp: counts.bp,
    invited: (employees || []).filter(e => e.status === "invited").length,
    breakdown: CATEGORIES.map(([key, label]) => ({ key, label, count: counts[key] })),
  };
}

export function headcountLabel(headcount) {
  if (!headcount) return null;
  // 古いAPI応答・キャッシュも表示できるよう互換性を保つ。
  if (!Array.isArray(headcount.breakdown)) return `プロパー ${headcount.proper}・BP ${headcount.bp}`;
  return headcount.breakdown.filter(c => c.count > 0 || ["regular", "training"].includes(c.key))
    .map(c => `${c.label} ${c.count}人`).join("・");
}
