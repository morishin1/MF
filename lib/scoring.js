// 評価の点数の出し方。
//
// ■ 10か条は「点数の内訳」ではなく「理由」
//   社内行動指針の EIGHT 10 ACTIONS を、そのまま 10項目 × 10点 = 100点 に
//   していたが、それだと全項目が等しい重みになる。
//   会社の考え方は「努力量ではなく、何を前に進めたか」なので、
//   成果に重みを置いた配点にする。
//
//     成果 40%   KPI・成果物・前進
//     行動 30%   量・スピード・実行
//     成長 20%   改善・学習
//     チーム 10% 報連相・協働
//
//   10か条の点は残す。ただし合計には使わず、
//   「なぜこの評価なのか」を見るための内訳として出す。
//
// ■ 評価しないもの
//   残業時間・日報の文字数・AIとの会話量は点に入れない。
//   長く書いた人・長く働いた人が高くなる仕組みにしない。

// 社内行動指針の10か条。キーは日次・週次・月次で共通。
// label は画面用の短い言い方、desc は AI に渡す説明（カッコ内が判断の目安）。
export const ACTIONS = [
  { key: "quantity",             no: "01", short: "量",     label: "まず量をこなす",
    desc: "まず量をこなせる（完成度にこだわって止まらず、70〜80点でも早く出せる）" },
  { key: "report_consult",       no: "02", short: "報連相", label: "自分から報告・相談する",
    desc: "自分から報告・相談できる（分からないまま抱え込まない）" },
  { key: "action",               no: "03", short: "行動",   label: "考えるだけで終わらず行動する",
    desc: "考えるだけで終わらず、行動する（「ここまでやりました」が言える）" },
  { key: "self_learning",        no: "04", short: "学習",   label: "自分で学ぶ",
    desc: "自分で学べる（教わるのを待たず、自分で調べて試せる）" },
  { key: "consistency",          no: "05", short: "継続",   label: "モチベーションに左右されない",
    desc: "モチベーションに左右されない（約束・役割・期限を基準にする）" },
  { key: "results",              no: "06", short: "成果",   label: "努力ではなく成果を見る",
    desc: "努力ではなく成果を見る（何を改善し、何を生み出したか説明できる）" },
  { key: "feedback_improvement", no: "07", short: "改善",   label: "フィードバックを改善につなげる",
    desc: "フィードバックを改善につなげる（指摘を受けて次の行動を変えられる）" },
  { key: "forward_thinking",     no: "08", short: "前進",   label: "論破より前進を選ぶ",
    desc: "論破より前進を選ぶ（チーム・顧客にとって何が良いかを考える）" },
  { key: "team_attitude",        no: "09", short: "チーム", label: "周囲の空気を悪くしない",
    desc: "周囲の空気を悪くしない（批判で終わらず「ではどうするか」まで出す）" },
  { key: "customer_focus",       no: "10", short: "顧客",   label: "顧客と向き合う",
    desc: "顧客と向き合える（営業職でなくても顧客の課題・価値を考えられる）" },
];

/**
 * 100点の内訳。
 * どの条をどの区分で見るかは、指針の説明文（カッコ内）に合わせている。
 */
export const CATEGORIES = [
  {
    key: "results", label: "成果", weight: 40,
    note: "KPI・成果物・前進",
    actions: ["results", "forward_thinking", "customer_focus"],
  },
  {
    key: "action", label: "行動", weight: 30,
    note: "量・スピード・実行",
    actions: ["quantity", "action", "consistency"],
  },
  {
    key: "growth", label: "成長", weight: 20,
    note: "改善・学習",
    actions: ["self_learning", "feedback_improvement"],
  },
  {
    key: "team", label: "チーム", weight: 10,
    note: "報連相・協働",
    actions: ["report_consult", "team_attitude"],
  },
];

export const ACTION_KEYS = ACTIONS.map((a) => a.key);

/** 評価できた点だけを取り出す。材料不足は null（0点にしない） */
const pick = (s) => {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  return s && s.status === "evaluated" && Number.isFinite(s.score) ? s.score : null;
};

/**
 * 10か条の点（各0〜10）から、100点満点の総合点を出す。
 *
 * 材料が無い条は、その区分の平均から外す。0点で足すと
 * 「書くことが少なかった日」というだけで点が落ちる。
 * 区分ごと材料が無ければ、その区分の重みを分母から外して按分する。
 *
 * @param {Record<string, {score,status}|number>} scores
 * @returns {{total:number|null, categories:Array, ratedActions:number}}
 */
export function score(scores) {
  const categories = CATEGORIES.map((c) => {
    const values = c.actions.map((k) => pick(scores?.[k])).filter((v) => v !== null);
    const avg = values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
    return {
      key: c.key,
      label: c.label,
      note: c.note,
      weight: c.weight,
      // 10点満点の平均
      avg: avg === null ? null : Math.round(avg * 10) / 10,
      // その区分に配点された点（重み × 平均 / 10）
      points: avg === null ? null : Math.round((avg / 10) * c.weight * 10) / 10,
      rated: values.length,
      of: c.actions.length,
      actions: c.actions,
    };
  });

  const judged = categories.filter((c) => c.avg !== null);
  const weightSum = judged.reduce((a, c) => a + c.weight, 0);
  const total = weightSum
    ? Math.round(judged.reduce((a, c) => a + (c.avg / 10) * c.weight, 0) / weightSum * 100)
    : null;

  return {
    total,
    categories,
    ratedActions: ACTION_KEYS.filter((k) => pick(scores?.[k]) !== null).length,
  };
}

/** 画面に渡す用。定義を2か所に置かないため、まとめて返す */
export const rubric = () => ({ actions: ACTIONS, categories: CATEGORIES });

/** AIのプロンプトに入れる説明。日次・週次で同じ文面を使う */
export const promptRubric = () => [
  "【評価する10か条】各0〜10点",
  ...ACTIONS.map((a) => `${a.no}. ${a.desc}`),
  "",
  "【総合点の出し方（あなたは計算しません）】",
  "10か条の点は、下の4区分にまとめてから重み付けし、システムが100点に換算します。",
  ...CATEGORIES.map((c) => {
    const names = c.actions.map((k) => ACTIONS.find((a) => a.key === k)?.short).join("・");
    return `・${c.label} ${c.weight}%（${c.note}）… ${names}`;
  }),
  "10項目の単純合計にはしません。10か条は「なぜその評価なのか」を示すための内訳です。",
].join("\n");

/**
 * 保存用に、点の内訳だけを取り出す。
 * 表示のたびに計算し直さなくて済むよう categories 列へ入れる。
 */
export const categoryBreakdown = (scores) =>
  score(scores).categories.map(({ key, label, weight, avg, points, rated, of }) =>
    ({ key, label, weight, avg, points, rated, of }));
