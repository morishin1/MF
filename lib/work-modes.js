// 勤務・育成区分（2軸の「横」）。
//
// ■ 何を持つか
//   どう雇うか、だけを持つ。期間・勤務時間・権限・開始レベル・研修。
//   何を目標にするか（KGI・KPI）は担当業務の側（lib/job-templates.js）。
//
//   以前は「新卒・未経験（バックオフィス）」のように雇い方と仕事内容を
//   1つに畳んでいた。その形だと、雇い方を1つ足すたびに職種のぶんだけ
//   テンプレートが増える。5×9 = 45通りになり、選ぶ側が見きれなくなる。
//
//   2軸にすれば、区分5つ・業務9つの14個を並べるだけで45通りを表せる。
//   人が増えても、テンプレートは乱立しない。
//
// ■ 新卒か中途かは、ここでは区別しない
//   同じ「未経験を育てながら任せる」なら、新卒でも第二新卒でも扱いは同じ。
//   採用経路は基本情報として名簿に残せばよく、育成の型を分ける理由にならない。
//
// ■ 区分がKPIそのものを変えるのは2つだけ
//   管理職 … 自分の成果に加えて、メンバーの育成と Blocker 解消を持つ。
//            これは担当業務のKPIには出てこないので、区分の側から足す。
//   育成併用 … 無限道場の受講そのものが、その期間の約束になっている。
//   ほかの区分は、勤務時間（件数の割り戻し）と育成期間（月数）で足りる。
//
// ■ ここに無い雇い方をするとき
//   区分を選ばず、フォームを直接埋めればよい。
//   テンプレートは入力を減らすためのもので、選択を狭めるためのものではない。

import { templateOf } from "./job-templates.js";

export const WORK_MODES = [
  {
    code: "GROWTH",
    label: "育成併用メンバー",
    note: "未経験・若手。無限道場と実務を並行して立ち上げます",
    values: {
      training_months: 3,
      probation_months: 6,
      weekly_hours: 40,
      contract_type: "有期",
      contract_months: 12,       // 入社日から数えて契約終了日を置く
      work_style: "ハイブリッド",
      autonomy_level_start: 1,
      account_type: "member",
      training_programs: ["無限道場"],
    },
    // 受講そのものが約束なので、KPIとして置く。3か月目は実務側に枠を戻す
    extraKpis: [
      { name: "無限道場", kind: "count", target: 4, unit: "回", scale: false, months: [1, 2] },
    ],
  },
  {
    code: "EXPERIENCED",
    label: "経験者メンバー",
    note: "経験あり。最初から自分で方法を選べる前提で、早めにKPIを持たせます",
    values: {
      training_months: 3,
      probation_months: 3,
      weekly_hours: 40,
      contract_type: "無期",
      contract_months: null,
      work_style: "ハイブリッド",
      autonomy_level_start: 2,
      account_type: "member",
      training_programs: [],
    },
  },
  {
    code: "PART",
    label: "短時間・パート",
    note: "週30時間未満。KPIの件数は勤務時間で自動的に割り戻します",
    values: {
      training_months: 3,
      probation_months: 3,
      weekly_hours: 20,
      contract_type: "有期",
      contract_months: 12,
      work_style: "出社",
      autonomy_level_start: 1,
      account_type: "member",
      training_programs: [],
    },
  },
  {
    code: "INTERN",
    label: "インターン・研修",
    note: "1〜3か月の短期。契約期間に合わせて計画を組みます",
    values: {
      training_months: 3,
      probation_months: null,
      weekly_hours: 20,
      contract_type: "有期",
      contract_months: 3,
      work_style: "出社",
      autonomy_level_start: 1,
      account_type: "member",
      training_programs: ["無限道場"],
    },
    roleWord: "アシスタント",     // 「バックオフィスアシスタント」のように組み立てる
  },
  {
    code: "MANAGER",
    label: "管理職・リーダー",
    note: "自分の成果に加えて、メンバーの育成と Blocker 解消を持つ側。管理画面が使えます",
    values: {
      training_months: 3,
      probation_months: 3,
      weekly_hours: 40,
      contract_type: "無期",
      contract_months: null,
      work_style: "ハイブリッド",
      autonomy_level_start: 3,
      account_type: "manager",
      training_programs: [],
    },
    roleWord: "マネージャー",
    extraScope: ["メンバー支援", "業務改善"],
    kgiSuffix: "あわせて、担当メンバーの止まっていることを自分で外せる。",
    extraKpis: [
      { name: "1on1",        kind: "count", target: 4, unit: "回", scale: false, months: [1, 2, 3] },
      { name: "Blocker解消", kind: "count", target: 4, unit: "件", scale: false, months: [1, 2, 3] },
    ],
  },
];

export const WORK_MODE_CODES = WORK_MODES.map((m) => m.code);

export const workModeOf = (code) =>
  WORK_MODES.find((m) => m.code === String(code || "").trim().toUpperCase()) || null;

/** 区分が足すKPI。無ければ空。lib/onboard.js から渡す */
export const modeKpis = (code) => workModeOf(code)?.extraKpis || [];

/** 3か月KGI に足す一文。管理職だけ。無ければ null */
export const modeKgiSuffix = (code) => workModeOf(code)?.kgiSuffix || null;

/**
 * 「勤務・育成区分 × 担当業務」を掛け合わせて、フォームの初期値にする。
 *
 * 区分と業務のどちらが勝つかを、ここ1か所で決める。
 *   期間・時間・権限・レベル … 区分（どう雇うか）
 *   Role・担当業務           … 業務（何をするか）。ただし管理職・インターンは
 *                              役職名の語尾だけ区分が足す
 *
 * @returns {object|null} フォームの値。どちらか選ばれていなければ null
 */
export function combine(modeCode, jobCode) {
  const mode = workModeOf(modeCode);
  if (!mode) return null;
  const job = templateOf(jobCode);
  const v = mode.values;

  return {
    work_mode: mode.code,
    job_family_code: job.code,
    // 「バックオフィスマネージャー」「営業アシスタント」のように組み立てる。
    // 語尾を足さない区分は、担当業務の既定の役割名をそのまま使う
    initial_role: mode.roleWord ? `${job.short}${mode.roleWord}` : job.role,
    work_scope: [...job.scope, ...(mode.extraScope || [])],
    training_months: v.training_months,
    probation_months: v.probation_months,
    weekly_hours: v.weekly_hours,
    contract_type: v.contract_type,
    contract_months: v.contract_months,
    work_style: v.work_style,
    autonomy_level_start: v.autonomy_level_start,
    account_type: v.account_type,
    training_programs: v.training_programs,
  };
}

/** 画面へ渡す形 */
export const workModeOptions = () =>
  WORK_MODES.map((m) => ({ code: m.code, label: m.label, note: m.note }));
