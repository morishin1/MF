// 給与を、見られない人の応答から外す。
//
// 給与を見られる人は lib/gw.js の canSeeSalary が決める（最終形は経営者だけ）。
// ここは「見られない人に、給与が一切返らない」ことを、出口で保証する部品。
//
// ■ なぜ、応答の出口で外すのか
//   給与は、採用（応募者・内定）・キャリア（現在給与・給与レンジ・昇給判断）・
//   契約など、多くの API が、それぞれ別の形（wageAmount / salary_min など）で返している。
//   1つずつ「この項目は出さない」を書くと、あとから足した API から漏れる。
//   json()（lib/http.js）が唯一の出口なので、そこで給与のキーを一括で外す。
//   （res.__redactSalary が立っているときだけ。立てるのは、各 API の入口）
//
// ■ 入力も外す
//   給与を見られない人が、給与の欄を書き換えてしまうのも防ぐ。
//   見えていない値を、黙って上書き（null 化）してしまう事故も、同時に防げる。

/** 給与とみなすキー（応答は camelCase、DB の行はそのまま snake_case で返る箇所がある） */
export const SALARY_KEYS = new Set([
  "wageType", "wageAmount", "wageNote", "currentWage", "commuteCost",
  "salaryMin", "salaryMax", "salaryDecision", "salaryNote",
  "wage_type", "wage_amount", "wage_note", "commute_cost",
  "salary_min", "salary_max", "salary_decision", "salary_note",
]);

/** 応募者・内定の表の、給与の列（select の列名から外す） */
export const WAGE_COLUMNS = ["wage_type", "wage_amount"];

/** 給与のキーを、入れ子の中まで外した写しを返す。元は変えない */
export function redactSalary(value) {
  if (Array.isArray(value)) return value.map(redactSalary);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SALARY_KEYS.has(k)) out[k] = redactSalary(v);
    }
    return out;
  }
  return value;
}

/** 入力（リクエストの本文）から、給与のキーを外した写しを返す。元は変えない */
export function dropSalaryInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) if (!SALARY_KEYS.has(k)) out[k] = v;
  return out;
}

/** "a, b, c" 形式の select の列名から、指定の列を外す */
export function withoutColumns(columns, drop = WAGE_COLUMNS) {
  const gone = new Set(drop);
  return columns.split(",").map((c) => c.trim()).filter((c) => c && !gone.has(c)).join(", ");
}

/**
 * この応答から、給与を外すかどうかを決める。API の入口で、ctx を決めた直後に呼ぶ。
 * @returns {boolean} 見られる（＝外さない）なら true
 */
export function guardSalaryOutput(res, canSee) {
  if (!canSee && res) res.__redactSalary = true;
  return Boolean(canSee);
}
