// 職種テンプレート。
//
// ■ なぜテンプレートを先に置くのか（指示書 §14）
//   毎回AIにゼロからKPIを作らせない。標準テンプレート80% + AI個別調整20%。
//
//   ゼロから作らせると、同じ職種でも人ごとにKPIの粒度も名前もばらつく。
//   ばらつくと、月次で「先月と比べてどうか」が見られなくなり、
//   職種をまたいだ比較もできなくなる。
//   何より、出てきた案が妥当かどうかを人が判断できない。
//
// ■ 3か月の段階に合わせてKPIを出し分ける
//   職種ごとの「使うKPIの語彙」を全部持ち、各月はそこから4〜6個を引く。
//   月ごとに見るものが変わるのは、月ごとに目的が違うから。
//     MONTH 1 … 決まったことを、決まったとおりに、期限内にやれるか
//               （だから全職種の1か月目に「報告相談」を置く。
//                 困ったときに声を上げられることが、この月の目的そのもの）
//     MONTH 2 … 自分で方法を選び、やり方を変えられるか
//     MONTH 3 … 成果が出ているか、自分で次を決められるか
//
// ■ 目標値は週の所定労働時間で割り戻す
//   週29時間の人に週40時間ぶんの件数を出すと、初月から未達が続く。
//   未達が続くとKPIそのものを見なくなる。
//   件数系だけを割り戻し、率（％）と成果物の点数はそのまま。
//
// ■ ここに無い職種
//   job_family_code が一致しなければ BACKOFFICE を使い、
//   AIに「業務範囲から個別に調整させる」側の比重を上げる。

const BASE_HOURS = 40;   // 目標値の基準。週40時間ぶんの数字で書いてある

/**
 * KPIの書き方
 *   kind   … lib/growth.js の6種（number/count/output/rate/score/onoff）
 *   scale  … 週の所定労働時間で割り戻すか。件数系は true、率は false
 *   months … その職種で、どの月に見るKPIか
 */
export const JOB_TEMPLATES = [
  {
    code: "BACKOFFICE",
    label: "バックオフィス・事業推進",
    kgi: "基本業務を一人で安定して進め、必要な報告相談を行い、AIを利用した業務改善まで実施できる。",
    monthKgi: [
      "決められた業務を期限内に実行し、分からないことを自分から相談できる。",
      "複数のやり方から自分で選び、手順を整理して他の人も使える形にできる。",
      "自分で改善点を見つけ、AIを使って業務のやり方を変えられる。",
    ],
    kpis: [
      { name: "業務完了率",   kind: "rate",   target: 90,  unit: "%",  scale: false, months: [1, 2, 3] },
      { name: "日報提出",     kind: "rate",   target: 100, unit: "%",  scale: false, months: [1, 2, 3] },
      { name: "期限遵守",     kind: "rate",   target: 95,  unit: "%",  scale: false, months: [1, 2] },
      { name: "報告相談",     kind: "count",  target: 8,   unit: "回", scale: true,  months: [1] },
      { name: "マニュアル作成", kind: "output", target: 2,  unit: "本", scale: false, months: [2, 3] },
      { name: "AI活用",       kind: "count",  target: 12,  unit: "回", scale: true,  months: [1, 2, 3] },
      { name: "改善",         kind: "count",  target: 2,   unit: "件", scale: false, months: [2, 3] },
    ],
  },
  {
    code: "SALES",
    label: "営業",
    kgi: "自分で営業先と進め方を決め、数字の変化から次の打ち手を立てられる。",
    monthKgi: [
      "決められた件数の接触を、期限内に確実にこなせる。",
      "返信率の高い条件を見つけ、営業のやり方を自分で変えられる。",
      "商談化までの流れを自分で組み立て、成果につなげられる。",
    ],
    kpis: [
      { name: "接触数",   kind: "count", target: 200, unit: "件", scale: true,  months: [1, 2, 3] },
      { name: "返信数",   kind: "count", target: 20,  unit: "件", scale: true,  months: [1, 2] },
      { name: "日報提出", kind: "rate",  target: 100, unit: "%",  scale: false, months: [1] },
      { name: "報告相談", kind: "count", target: 8,   unit: "回", scale: true,  months: [1] },
      { name: "返信率",   kind: "rate",  target: 10,  unit: "%",  scale: false, months: [2, 3] },
      { name: "商談数",   kind: "count", target: 8,   unit: "件", scale: true,  months: [2, 3] },
      { name: "提案数",   kind: "count", target: 6,   unit: "件", scale: true,  months: [3] },
      { name: "商談化率", kind: "rate",  target: 30,  unit: "%",  scale: false, months: [3] },
      { name: "改善回数", kind: "count", target: 2,   unit: "件", scale: false, months: [2, 3] },
    ],
  },
  {
    code: "CS",
    label: "カスタマーサポート",
    kgi: "問い合わせを一人で完結させ、繰り返し起きる問題を仕組みで減らせる。",
    monthKgi: [
      "決められた手順で問い合わせに対応し、判断に迷うものを相談できる。",
      "自分で解決できる範囲を広げ、対応の速さを上げられる。",
      "同じ問い合わせが起きない形に、手順や案内を変えられる。",
    ],
    kpis: [
      { name: "対応件数",     kind: "count", target: 120, unit: "件", scale: true,  months: [1, 2, 3] },
      { name: "日報提出",     kind: "rate",  target: 100, unit: "%",  scale: false, months: [1] },
      { name: "報告相談",     kind: "count", target: 8,   unit: "回", scale: true,  months: [1] },
      { name: "初回対応時間", kind: "score", target: 90,  unit: "点", scale: false, months: [1, 2] },
      { name: "課題解決",     kind: "rate",  target: 85,  unit: "%",  scale: false, months: [2, 3] },
      { name: "フォロー",     kind: "count", target: 20,  unit: "件", scale: true,  months: [2, 3] },
      { name: "改善",         kind: "count", target: 2,   unit: "件", scale: false, months: [2, 3] },
      { name: "継続率",       kind: "rate",  target: 90,  unit: "%",  scale: false, months: [3] },
    ],
  },
  {
    code: "ENGINEER",
    label: "エンジニア",
    kgi: "任された機能を一人で仕上げ、指摘を次の実装に反映できる。",
    monthKgi: [
      "決められたタスクを納期内に終わらせ、詰まったら早めに相談できる。",
      "レビューの指摘を次の実装に反映し、同じ指摘を繰り返さない。",
      "自分で設計を決めて実装し、品質の問題を先に潰せる。",
    ],
    kpis: [
      { name: "タスク完了", kind: "count", target: 16,  unit: "件", scale: true,  months: [1, 2, 3] },
      { name: "納期遵守",   kind: "rate",  target: 90,  unit: "%",  scale: false, months: [1, 2, 3] },
      { name: "日報提出",   kind: "rate",  target: 100, unit: "%",  scale: false, months: [1] },
      { name: "報告相談",   kind: "count", target: 8,   unit: "回", scale: true,  months: [1] },
      { name: "レビュー対応", kind: "rate", target: 95, unit: "%",  scale: false, months: [2, 3] },
      { name: "不具合",     kind: "number", target: 2,  unit: "件", scale: false, months: [2, 3] },
      { name: "学習",       kind: "count", target: 8,   unit: "回", scale: true,  months: [1, 2] },
      { name: "改善",       kind: "count", target: 2,   unit: "件", scale: false, months: [3] },
    ],
  },
  {
    code: "PR",
    label: "広報・マーケティング",
    kgi: "自分で企画から発信までを回し、反応の数字から次の企画を立てられる。",
    monthKgi: [
      "決められた本数を期限内に出し、内容の確認を自分から依頼できる。",
      "反応の良い内容の傾向をつかみ、企画を自分で変えられる。",
      "流入や問い合わせにつながる形まで、自分で設計できる。",
    ],
    kpis: [
      { name: "投稿",       kind: "count",  target: 20,  unit: "本", scale: true,  months: [1, 2, 3] },
      { name: "コンテンツ", kind: "output", target: 4,   unit: "本", scale: false, months: [1, 2, 3] },
      { name: "日報提出",   kind: "rate",   target: 100, unit: "%",  scale: false, months: [1] },
      { name: "報告相談",   kind: "count",  target: 8,   unit: "回", scale: true,  months: [1] },
      { name: "反応",       kind: "count",  target: 200, unit: "件", scale: true,  months: [2, 3] },
      { name: "流入",       kind: "count",  target: 500, unit: "件", scale: true,  months: [2, 3] },
      { name: "問い合わせ", kind: "count",  target: 5,   unit: "件", scale: true,  months: [3] },
      { name: "改善",       kind: "count",  target: 2,   unit: "件", scale: false, months: [2, 3] },
    ],
  },
  {
    code: "EC",
    label: "EC運営",
    kgi: "出品から在庫・問い合わせまでを一人で回し、売れ方から改善を判断できる。",
    monthKgi: [
      "決められた件数を正確に出品し、判断に迷うものを相談できる。",
      "商品情報の整え方を自分で判断し、売れ行きの違いに気づける。",
      "売上と在庫の数字から、自分で打ち手を決められる。",
    ],
    kpis: [
      { name: "出品数",       kind: "count",  target: 100, unit: "件", scale: true,  months: [1, 2, 3] },
      { name: "商品情報整備", kind: "rate",   target: 95,  unit: "%",  scale: false, months: [1, 2] },
      { name: "日報提出",     kind: "rate",   target: 100, unit: "%",  scale: false, months: [1] },
      { name: "報告相談",     kind: "count",  target: 8,   unit: "回", scale: true,  months: [1] },
      { name: "問い合わせ対応", kind: "count", target: 40, unit: "件", scale: true,  months: [1, 2, 3] },
      { name: "在庫処理",     kind: "count",  target: 30,  unit: "件", scale: true,  months: [2, 3] },
      { name: "売上",         kind: "number", target: 0,   unit: "円", scale: false, months: [2, 3] },
      { name: "改善",         kind: "count",  target: 2,   unit: "件", scale: false, months: [2, 3] },
    ],
  },
];

export const JOB_CODES = JOB_TEMPLATES.map((t) => t.code);

/** 見つからなければ BACKOFFICE。空欄で登録された人も止めない */
export const templateOf = (code) =>
  JOB_TEMPLATES.find((t) => t.code === String(code || "").trim().toUpperCase())
  || JOB_TEMPLATES[0];

/**
 * その月に使うKPIを、テンプレートから引く。
 *
 * @param {string} code        職種コード
 * @param {number} monthNo     1〜3
 * @param {number} weeklyHours 週の所定労働時間。件数系の目標を割り戻す
 */
export function kpisFor(code, monthNo, weeklyHours) {
  const t = templateOf(code);
  const ratio = weeklyHours > 0 ? Math.min(1, weeklyHours / BASE_HOURS) : 1;

  return t.kpis
    .filter((k) => k.months.includes(Number(monthNo)))
    .slice(0, 6)                       // 6個まで。7個以上あるとどれも追わなくなる
    .map((k, i) => ({
      sort_order: i,
      name: k.name,
      kind: k.kind,
      // 割り戻したあと、1未満に潰れないよう下限1にする。
      // 「月0件」が目標になっていると、達成しても何も起きない
      target_value: k.scale && k.target > 0
        ? Math.max(1, Math.round(k.target * ratio))
        : k.target,
      unit: k.unit,
      // 売上のように、その人の担当が決まらないと数字を置けないものは
      // 目標なしで出す。人が後から入れる
      from_daily: true,
      template_code: `${t.code}:${k.name}`,
      note: null,
    }))
    // 目標が 0 のものは「未設定」として残す。0を目標にはしない
    .map((k) => (k.target_value === 0 ? { ...k, target_value: null } : k));
}

/** 3か月ぶんまとめて。取り込み直後の自動生成で使う */
export const planFromTemplate = (code, weeklyHours, months = 3) => {
  const t = templateOf(code);
  return {
    code: t.code,
    label: t.label,
    threeMonthKgi: t.kgi,
    months: Array.from({ length: months }, (_, i) => ({
      month_no: i + 1,
      // 4か月目以降は3か月目の型を繰り返す。周回の2周目以降で使う
      kgi: t.monthKgi[Math.min(i, t.monthKgi.length - 1)],
      target_level: Math.min(3, i + 1),
      kpis: kpisFor(t.code, Math.min(3, i + 1), weeklyHours),
    })),
  };
};

/** 画面の選択肢用 */
export const jobOptions = () =>
  JOB_TEMPLATES.map((t) => ({ code: t.code, label: t.label, kgi: t.kgi }));
