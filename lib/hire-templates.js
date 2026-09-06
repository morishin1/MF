// 採用・育成テンプレート。
//
// ■ 何のためか
//   採用のしかたは、そう何通りもない。
//   「新卒・未経験のバックオフィス」「営業の中途」のように、
//   だいたい決まった組み合わせを繰り返している。
//
//   毎回ゼロから10項目を埋めるのではなく、テンプレートを選んで
//   氏名・メール・入社日だけ変えれば登録できる状態にする。
//
// ■ 職種テンプレート（lib/job-templates.js）との違い
//   職種テンプレート … 何を目標にするか（3か月KGI・月間KPI）
//   採用テンプレート … どう雇うか（育成期間・勤務時間・開始レベル・研修）
//   前者は本人が達成するもの、後者は会社が決める条件。分けて持つ。
//
// ■ ここに無い採り方をするとき
//   テンプレートを選ばず、フォームを直接埋めればよい。
//   テンプレートは入力を減らすためのもので、選択を狭めるためのものではない。

export const HIRE_TEMPLATES = [
  {
    code: "NEW_BACKOFFICE",
    label: "新卒・未経験（バックオフィス）",
    note: "はじめて働く人。決まったことを確実にやれる状態から始めます",
    values: {
      job_family_code: "BACKOFFICE",
      initial_role: "事業推進・バックオフィス担当",
      training_months: 3,
      probation_months: 6,
      weekly_hours: 40,
      contract_type: "有期",
      contract_months: 12,          // 入社日から数えて契約終了日を置く
      work_style: "ハイブリッド",
      autonomy_level_start: 1,
      work_scope: ["バックオフィス", "事業推進", "営業支援", "資料作成"],
      training_programs: ["無限道場"],
      account_type: "member",
    },
  },
  {
    code: "NEW_SALES",
    label: "新卒・未経験（営業）",
    note: "決められた件数を確実にこなすところから始めます",
    values: {
      job_family_code: "SALES",
      initial_role: "法人開拓担当",
      training_months: 3,
      probation_months: 6,
      weekly_hours: 40,
      contract_type: "有期",
      contract_months: 12,
      work_style: "ハイブリッド",
      autonomy_level_start: 1,
      work_scope: ["新規開拓", "商談", "営業改善"],
      training_programs: ["無限道場"],
      account_type: "member",
    },
  },
  {
    code: "MID_SALES",
    label: "中途（営業）",
    note: "経験がある人。最初から自分で方法を選べる前提で始めます",
    values: {
      job_family_code: "SALES",
      initial_role: "法人開拓担当",
      training_months: 3,
      probation_months: 3,
      weekly_hours: 40,
      contract_type: "無期",
      work_style: "ハイブリッド",
      autonomy_level_start: 2,
      work_scope: ["新規開拓", "商談", "提案", "営業改善"],
      training_programs: [],
      account_type: "member",
    },
  },
  {
    code: "MID_ENGINEER",
    label: "中途（エンジニア）",
    note: "経験がある人。納期と品質を自分で守れる前提で始めます",
    values: {
      job_family_code: "ENGINEER",
      initial_role: "開発担当",
      training_months: 3,
      probation_months: 3,
      weekly_hours: 40,
      contract_type: "無期",
      work_style: "リモート",
      autonomy_level_start: 2,
      work_scope: ["開発", "レビュー", "改善"],
      training_programs: [],
      account_type: "member",
    },
  },
  {
    code: "PART_EC",
    label: "パート・短時間（EC運営）",
    note: "週の勤務時間が短い人。KPIの件数は勤務時間で自動的に割り戻します",
    values: {
      job_family_code: "EC",
      initial_role: "EC運営担当",
      training_months: 3,
      probation_months: 3,
      weekly_hours: 20,
      contract_type: "有期",
      contract_months: 12,
      work_style: "出社",
      autonomy_level_start: 1,
      work_scope: ["出品", "商品情報整備", "問い合わせ対応"],
      training_programs: [],
      account_type: "member",
    },
  },
  {
    code: "INTERN",
    label: "インターン・短期",
    note: "期間が短いので、育成も1か月ぶんだけ組みます",
    values: {
      job_family_code: "BACKOFFICE",
      initial_role: "アシスタント",
      training_months: 1,
      probation_months: null,
      weekly_hours: 20,
      contract_type: "有期",
      contract_months: 3,
      work_style: "出社",
      autonomy_level_start: 1,
      work_scope: ["資料作成", "データ整理"],
      training_programs: [],
      account_type: "member",
    },
  },
  {
    code: "MANAGER",
    label: "管理職・リーダー",
    note: "他の人の Blocker を外す側。管理者権限が付きます",
    values: {
      job_family_code: "BACKOFFICE",
      initial_role: "マネージャー",
      training_months: 3,
      probation_months: 3,
      weekly_hours: 40,
      contract_type: "無期",
      work_style: "ハイブリッド",
      autonomy_level_start: 3,
      work_scope: ["事業推進", "メンバー支援", "業務改善"],
      training_programs: [],
      account_type: "manager",
    },
  },
];

export const hireTemplateOf = (code) =>
  HIRE_TEMPLATES.find((t) => t.code === String(code || "").trim().toUpperCase()) || null;

/** 画面へ渡す形。contract_months は「入社日から何か月後を終了日にするか」 */
export const hireOptions = () =>
  HIRE_TEMPLATES.map((t) => ({ code: t.code, label: t.label, note: t.note, values: t.values }));
