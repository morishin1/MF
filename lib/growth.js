// 3か月育成計画。労働条件 → 3か月KGI → 月間KGI/KPI → 今日のKPI。
//
// ■ 何のための仕組みか
//   入社した人が「何をすればいいか分からない」まま立ち止まらないようにする。
//   3か月の行き先を先に決めて、それを月・週・今日まで割る。
//
// ■ 労働条件と育成目標は別（要件 §2-1）
//   KPIの達成状況を理由に、賃金・労働時間・雇用形態・契約条件が
//   動くことがあってはならない。
//   このファイルから契約（gw_contracts）へ書き戻す関数は作らない。
//   参照するのは「どんな業務のためのKPIか」を決めるときだけ。
//
// ■ 3か月KGIは固定、月間は毎月見直す（§10）
//   3か月の行き先を毎月変えると、何に向かっているか分からなくなる。
//   一方で月の目標は、実績を見て調整できないと、初月の想定のまま
//   達成不能な数字が3か月残る。

// -----------------------------------------------------------------------------
// KPIの型（§12）
// -----------------------------------------------------------------------------
//
// 型ごとに、日々の実績の積み上げ方が違う。
// 「達成率90%」を毎日足して 900% になっては困る。
export const KPI_KINDS = [
  { key: "number", label: "数値",    roll: "sum",  unit: "件",  hint: "例：営業20件" },
  { key: "count",  label: "回数",    roll: "sum",  unit: "回",  hint: "例：AI活用12回" },
  { key: "output", label: "成果物",  roll: "sum",  unit: "本",  hint: "例：マニュアル2本" },
  { key: "rate",   label: "達成率",  roll: "last", unit: "%",   hint: "例：業務完了率90%" },
  { key: "score",  label: "評価",    roll: "last", unit: "点",  hint: "例：上長レビュー80点" },
  { key: "onoff",  label: "実施",    roll: "any",  unit: "",    hint: "例：成果発表 実施" },
];

export const kindOf = (k) => KPI_KINDS.find((x) => x.key === k) || KPI_KINDS[0];

// 3か月を3段階に分ける（§8）。新しい計画を作るときの下敷き
export const STAGES = [
  {
    monthNo: 1, level: 1,
    title: "基本業務を安定して実行できる",
    kgi: "決められた業務を期限内に安定して実行し、不明点を自分から報告・相談できる。",
  },
  {
    monthNo: 2, level: 2,
    title: "自分で優先順位を決めて仕事を進める",
    kgi: "担当業務について、複数の選択肢から自分で方法を選び、優先順位をつけて進められる。",
  },
  {
    monthNo: 3, level: 3,
    title: "自分で考え、改善までできる",
    kgi: "担当領域について、目標から逆算して次の行動を設定し、改善まで実施できる。",
  },
];

// -----------------------------------------------------------------------------
// 日付
// -----------------------------------------------------------------------------
export const monthStart = (s) => `${String(s).slice(0, 7)}-01`;

export function addMonths(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // 月末の丸め。1/31 + 1か月 が 3/3 にならないように
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** 計画に並ぶ月。start_date の月から monthCount か月ぶん */
export function monthsOf(startDate, monthCount = 3) {
  const out = [];
  for (let i = 0; i < monthCount; i++) {
    out.push({ monthNo: i + 1, month: monthStart(addMonths(monthStart(startDate), i)) });
  }
  return out;
}

/** その月の営業日（土日を除く）。日割りに使う */
export function workdaysIn(month) {
  const out = [];
  const d = new Date(`${monthStart(month)}T00:00:00Z`);
  const m = d.getUTCMonth();
  while (d.getUTCMonth() === m) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// -----------------------------------------------------------------------------
// 進捗（§15 §22）
// -----------------------------------------------------------------------------

/**
 * 月間KPIの実績を、日々の記録から積み上げる。
 *
 * @param {object} kpi   gw_growth_kpis の行
 * @param {Array}  daily その月の gw_daily_kpis（kpi_id が一致するもの）
 */
export function rollup(kpi, daily) {
  // 日報から積み上げない KPI（上長レビュー点など）は、人が入れた値をそのまま
  if (kpi.from_daily === false) {
    return kpi.manual_value == null ? null : Number(kpi.manual_value);
  }

  const vals = daily
    .filter((d) => d.actual != null)
    .sort((a, b) => (a.work_date < b.work_date ? -1 : 1))
    .map((d) => Number(d.actual))
    .filter((v) => Number.isFinite(v));
  if (!vals.length) return null;

  switch (kindOf(kpi.kind).roll) {
    case "sum":  return Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100;
    // 達成率や評価点は、足しても意味がない。最後に入れた値を見る
    case "last": return vals[vals.length - 1];
    case "any":  return vals.some((v) => v > 0) ? 1 : 0;
    default:     return null;
  }
}

/** 1つのKPIの進み具合 */
export function kpiProgress(kpi, daily) {
  const actual = rollup(kpi, daily);
  const target = kpi.target_value == null ? null : Number(kpi.target_value);
  const k = kindOf(kpi.kind);

  const rate = (target > 0 && actual != null)
    ? Math.round((actual / target) * 100)
    : null;

  return {
    id: kpi.id,
    name: kpi.name,
    kind: kpi.kind,
    kindLabel: k.label,
    unit: kpi.unit || k.unit,
    target,
    actual,
    rate,
    // 100%を超えることはある。達成したかどうかは別に持つ
    hit: target != null && actual != null && actual >= target,
    weight: Number(kpi.weight) || 1,
    fromDaily: kpi.from_daily !== false,
    sortOrder: kpi.sort_order,
  };
}

/**
 * 月間KGIの進捗（§15 の「KGI進捗 72%」）。
 *
 * 重み付きの平均にする。1つのKPIが100%を超えても、
 * そのぶんで他の未達を埋められないよう、各KPIは100%で頭を打つ。
 * そうしないと「簡単なKPIを300%やれば全体が達成」になる。
 */
export function monthProgress(kpis) {
  const judged = kpis.filter((k) => k.rate != null);
  if (!judged.length) return null;
  const w = judged.reduce((a, k) => a + k.weight, 0);
  if (!w) return null;
  return Math.round(
    judged.reduce((a, k) => a + Math.min(100, k.rate) * k.weight, 0) / w);
}

/**
 * 今日のぶんの割り当て（§13 月間 → 週次 → 日次）。
 *
 * AIに割らせない。残りの目標を、残りの営業日で割るだけ。
 * AIが「今日は3件」と言っても、その根拠は結局この計算なので、
 * 毎日AIを呼ぶ理由がない。ずれたぶんは翌日に自動で乗る。
 *
 * 積み上げ型（sum）だけが対象。達成率や評価点は日割りできない。
 */
export function dailyShare(kpi, progress, date) {
  if (kindOf(kpi.kind).roll !== "sum") return null;
  if (progress.target == null) return null;

  const days = workdaysIn(date).filter((d) => d >= date);
  if (!days.length) return null;

  const remain = Math.max(0, progress.target - (progress.actual || 0));
  if (remain === 0) return 0;

  // 端数は切り上げる。切り捨てると最終日に全部残る
  return Math.ceil(remain / days.length);
}

// -----------------------------------------------------------------------------
// 画面に返す形
// -----------------------------------------------------------------------------
export const shapePlan = (p) => ({
  id: p.id,
  employeeId: p.employee_id,
  userId: p.user_id,
  contractId: p.contract_id,
  startDate: p.start_date,
  endDate: p.end_date,
  threeMonthKgi: p.three_month_kgi,
  status: p.status,
  aiStatus: p.ai_status,
  aiDraft: p.ai_draft,
  aiError: p.ai_error,
  note: p.note,
  approvedAt: p.approved_at,
});

export const shapeMonth = (m) => ({
  id: m.id,
  planId: m.plan_id,
  monthNo: m.month_no,
  month: m.month,
  kgi: m.kgi,
  targetLevel: m.target_level,
  status: m.status,
  reviewNote: m.review_note,
  reviewedAt: m.reviewed_at,
});

/** 3か月のうち何日目か。画面に「残り73日」と出すため */
export function planDays(plan, today) {
  const end = new Date(`${plan.end_date}T00:00:00Z`);
  const now = new Date(`${today}T00:00:00Z`);
  const start = new Date(`${plan.start_date}T00:00:00Z`);
  const total = Math.round((end - start) / 86400000);
  const left = Math.round((end - now) / 86400000);
  return {
    total,
    left: Math.max(0, left),
    elapsed: Math.max(0, total - Math.max(0, left)),
    started: now >= start,
    over: left < 0,
  };
}
