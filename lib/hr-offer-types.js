// 面談合格後の「採用区分」（offer_type）。5つの区分ごとの、入力項目・本人への見せ方・必要書類・流れ。
// 値の定義と、純粋な関数だけ（DB・外部に触らない。日本時間の日付は lib/jst.js）。画面・API はここを正として使い、別に定義を持たない。
//
// ■ 採用区分とステータスは分ける（HR 面談合格後の採用・育成フロー仕様 §18）
//   status は既存の値（合格通知作成待ち → 社内確認待ち → 本人送付待ち → 送付済み → 承諾待ち → 承諾済み）を
//   そのまま使い、区分（gw_hr_applicants.offer_type / gw_hr_offers.offer_type）で言い方と入力項目を変える。
//   「業務委託で承諾待ち」「育成枠で承諾待ち」を同じ status で扱える。
//
// ■ 項目の置き場所
//   既存の列があるもの（入社予定日・試用期間・勤務地・週の勤務時間・契約終了日・給与区分・金額）は既存の列。
//   区分にしか無い項目（役職・委託業務・成果物・NDA など）は gw_hr_offers.offer_terms（jsonb）。
//   ・金額は必ず既存の給与の列（wage_type / wage_amount）へ。lib/salary.js・lib/hr-pay.js の
//     「給与を見られない人には返さない・書かせない」がそのまま効く
//   ・金額の補足（インセンティブ・交通費）は offer_terms に入るが、キー名を lib/salary.js の
//     SALARY_KEYS に入れてあり（incentive・commuteCost）、見られない人の応答からは外れる
//
// ■ 候補者には社内用語を見せない（§9・§11）
//   本人向けの書類名（内定通知・業務委託オファー…）・項目名だけを publicOfferView() で作る。
//   internal: true の項目（社内用の備考）は本人に出さない。

import { ymd as jstYmd } from "./jst.js";

export const OFFER_TYPE_FLOW = { normal: "normal", training: "training" };

const YES_NO_NDA = ["必要", "不要"];

// ---- 毎回同じ内容はテンプレート（オファー作成・メール送信・同意完結 UI/UX改善仕様 §10） ----------------
// 業務内容の標準文。選ぶと本文に入り、そのまま直せる。将来マスター（表）へ移すときは、この配列を表から読むだけでよい形
export const DUTY_TEMPLATES = [
  { key: "ai_dx", label: "AI・DX支援", text: "企業・自治体へのAI・DX導入支援、業務改善、調査、提案および関連業務" },
  { key: "sales", label: "営業", text: "法人への営業活動、商談対応、顧客フォローおよび関連業務" },
  { key: "operation", label: "運営", text: "サービス・イベント・講座の運営、進行管理、問い合わせ対応および関連業務" },
  { key: "instructor", label: "講師", text: "研修・講座の講師、教材の準備、受講者のサポートおよび関連業務" },
  { key: "backoffice", label: "バックオフィス", text: "経理・総務・人事などの管理業務、書類作成、データ入力および関連業務" },
  { key: "other", label: "その他", text: "" },
];

// 育成コース。period は「育成期間」の既定（選ぶと自動で入る）。将来 LMS・コースマスターと接続するときは、ここを差し替える
export const TRAINING_COURSES = [
  { key: "mugendojo", label: "無限道場", period: "3か月" },
];

/**
 * 項目の定義。
 *   key      … API のキー（camelCase）。column があれば既存の列、無ければ offer_terms のキー
 *   column   … 既存の列（gw_hr_offers）。無ければ offer_terms に入る
 *   kind     … text | textarea | date | number | select
 *   salary   … 給与として扱う（給与を見られない人には出さない・書かせない）
 *   internal … 社内用。本人向けページに出さない
 *   basic    … 通常表示（入力画面で最初から見せる）。それ以外は［詳細設定］の中（§3・§4）
 *   value    … 作成時の既定値（業務委託の「協議のうえ更新」など。§24 Priority 2）
 *   templates… 標準文を選べる（業務内容。DUTY_TEMPLATES）／ presets … 選べる値（育成コース。TRAINING_COURSES）
 *   highlight… 本人向けページで、先にコンパクトに見せる重要条件（§14）／ publicLabel … 本人向けの項目名
 *   hidden   … 入力欄を出さない（報酬のボタンが値を決める。育成中の報酬・給与区分）
 */
const F = {
  jobTitle: { key: "jobTitle", column: "job_title", label: "職種", kind: "text" },
  joinDate: (label) => ({ key: "joinDate", column: "join_date", label, kind: "date" }),
  contractEndDate: (label) => ({ key: "contractEndDate", column: "contract_end_date", label, kind: "date" }),
  probation: { key: "probationMonths", column: "probation_months", label: "試用期間（月）", kind: "number", unit: "か月" },
  workLocation: (label) => ({ key: "workLocation", column: "work_location", label, kind: "text" }),
  weeklyHours: { key: "weeklyHours", column: "weekly_hours", label: "週の勤務時間", kind: "number", unit: "時間" },
  // 給与区分は、報酬のボタン（pay.buttons）で選ぶ。options は受け付ける値（前の版の値も読めるように残す）
  wageType: (label, options) => ({ key: "wageType", column: "wage_type", label, kind: "select", options, salary: true, hidden: true }),
  wageAmount: (label) => ({ key: "wageAmount", column: "wage_amount", label, kind: "number", unit: "円", salary: true, basic: true, highlight: true }),
  term: (key, label, kind = "text", extra = {}) => ({ key, label, kind, ...extra }),
  duties: (label, extra = {}) => ({ key: "duties", label, kind: "textarea", templates: DUTY_TEMPLATES, ...extra }),
};

const btn = (value, label = value) => ({ value, label });

export const OFFER_TYPES = [
  {
    key: "executive_employee",
    label: "正社員・幹部候補", icon: "badge", publicLabel: "正社員",
    summary: "長期的に会社・事業を担ってもらう人材。",
    flow: ["内定条件設定", "内定通知", "労働条件確認", "内定承諾", "雇用契約", "入社手続き"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    // 本人向け：書類名・契約形態・承諾の言い方・承諾後の案内
    offerName: "内定通知", contractLabel: "正社員", acceptLabel: "内定承諾",
    // 合格を本人へ伝えるメール（lib/hr-messages.js）。本人向けの言い方だけ
    hiredPhrase: "内定とさせていただくことになりました。", hiredDetail: "雇用条件などの詳細",
    afterAcceptPublic: "承諾ありがとうございました。次は雇用契約・入社の手続きです。採用担当からご連絡します。",
    employmentType: "正社員",
    documents: ["内定通知書", "労働条件通知書", "雇用契約書", "必要に応じてNDA"],
    // 契約完了（本人が同意）のあとの NEXT ACTION（§18）
    afterAccept: { label: "入社手続きへ進めてください", cta: "入社手続きへ進む" },
    // オファーを送るメール（§13）。件名「【会社名】{title}のご案内」
    mail: { title: "内定", lead: "正社員としての内定をご案内いたします。" },
    // 報酬：ボタンで区分を選び、金額を入れる（§4）
    pay: { label: "給与", buttons: [btn("月給"), btn("年俸")] },
    fields: [
      { ...F.jobTitle, basic: true, highlight: true },
      F.wageType("給与区分", ["月給", "年俸"]),
      F.wageAmount("給与"),
      { ...F.joinDate("入社予定日"), required: true, basic: true, highlight: true },
      { ...F.workLocation("勤務地"), basic: true, highlight: true },
      F.term("position", "役職"),
      F.probation,
      F.term("workHours", "勤務時間", "text", { placeholder: "9:00〜18:00（休憩60分）" }),
      F.term("incentive", "インセンティブ", "textarea", { salary: true }),
      F.term("otherTerms", "その他条件", "textarea"),
      F.duties("業務内容"),
    ],
  },
  {
    key: "training",
    label: "育成枠", icon: "eco", publicLabel: "育成枠",
    summary: "まず育成・研修から参加し、評価後に実案件や契約へ進む。",
    flow: ["育成参加通知", "参加承諾", "LMS登録", "育成", "評価", "実案件", "継続判定"],
    stepFlow: OFFER_TYPE_FLOW.training,
    offerName: "育成参加決定通知", contractLabel: "育成プログラムへの参加", acceptLabel: "参加承諾",
    hiredPhrase: "まずは育成プログラムへのご参加をお願いすることになりました。", hiredDetail: "育成の内容・条件",
    afterAcceptPublic: "参加のご承諾ありがとうございました。次は育成参加の手続きです。採用担当からご連絡します。",
    employmentType: "育成枠",
    documents: ["育成参加決定通知", "育成条件確認書", "参加承諾", "実案件参加時の契約書"],
    afterAccept: { label: "LMS登録・育成開始の手続きへ進めてください", cta: "育成開始手続きへ進む" },
    mail: { title: "育成プログラム", lead: "育成プログラムへの参加をご案内いたします。" },
    // [なし] [時給] [月額]。「なし」は育成中の報酬＝なし（金額欄を出さない）
    pay: { label: "報酬", none: { key: "paidDuringTraining", label: "なし", no: "なし", yes: "あり" }, buttons: [btn("時給"), btn("月額")] },
    fields: [
      { ...F.term("course", "育成コース"), required: true, basic: true, highlight: true, presets: TRAINING_COURSES },
      { ...F.joinDate("育成開始日"), required: true, basic: true, highlight: true, publicLabel: "開始日" },
      // 通常は入力させない（コースの既定。無限道場なら3か月）。評価日は開始日と期間から自動で計算する
      F.term("trainingPeriod", "育成期間", "text", { placeholder: "3か月", highlight: true, publicLabel: "期間" }),
      F.term("paidDuringTraining", "育成中の報酬", "select", { options: ["なし", "あり"], salary: true, hidden: true }),
      F.wageType("報酬区分", ["時給", "月額", "日額"]),
      F.wageAmount("報酬"),
      F.term("instructor", "担当講師"),
      F.term("midReviewOn", "中間評価日", "date", { auto: true }),
      F.term("finalReviewOn", "最終評価日", "date", { auto: true }),
      F.term("projectStartOn", "実案件開始予定", "date"),
      F.term("note", "備考（社内用）", "textarea", { internal: true }),
    ],
  },
  {
    key: "contractor",
    label: "業務委託", icon: "handshake", publicLabel: "業務委託",
    summary: "専門業務・案件単位・継続業務で参画してもらう。",
    flow: ["オファー", "条件確認", "承諾", "業務委託契約", "NDA", "稼働開始"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    offerName: "業務委託オファー", contractLabel: "業務委託", acceptLabel: "オファー承諾",
    hiredPhrase: "業務委託としてご参画をお願いすることになりました。", hiredDetail: "業務内容・報酬などの条件",
    afterAcceptPublic: "承諾ありがとうございました。次は契約手続きです。採用担当からご連絡します。",
    employmentType: "業務委託",
    documents: ["業務委託オファー", "業務委託契約書", "NDA"],
    afterAccept: { label: "稼働開始の準備（契約書・NDA・アカウントなど）へ進めてください", cta: "稼働開始準備へ進む" },
    mail: { title: "業務委託契約", lead: "業務委託としてのご参画をご案内いたします。" },
    pay: { label: "報酬", buttons: [btn("月額"), btn("時給"), btn("案件単価", "案件"), btn("成果報酬")] },
    fields: [
      { ...F.duties("業務内容"), required: true, basic: true },
      // 月額固定・時間単価 は、これまでの版の値（読めるように受け付ける。ボタンには出さない）
      F.wageType("報酬形態", ["月額", "時給", "案件単価", "成果報酬", "月額固定", "時間単価"]),
      F.wageAmount("報酬"),
      { ...F.joinDate("契約開始日"), required: true, basic: true, highlight: true },
      F.term("workHours", "稼働目安", "text", { placeholder: "週20時間程度", basic: true, highlight: true }),
      F.contractEndDate("契約終了日"),
      F.term("renewal", "更新", "select", { options: ["協議のうえ更新", "自動更新", "更新なし"], value: "協議のうえ更新" }),
      F.term("deliverables", "成果物", "textarea"),
      F.term("paymentTerms", "支払条件", "text", { placeholder: "月末締め翌月末払い", value: "月末締め翌月末払い" }),
      F.term("nda", "NDA", "select", { options: YES_NO_NDA, value: "必要" }),
      F.term("workDays", "稼働曜日", "text", { placeholder: "月・水・金" }),
      F.workLocation("稼働場所"),
    ],
  },
  {
    key: "part_time",
    label: "パート・アルバイト", icon: "schedule", publicLabel: "パート・アルバイト",
    summary: "曜日・時間を決めて勤務してもらう。",
    flow: ["採用通知", "労働条件確認", "承諾", "雇用契約", "入社手続き"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    offerName: "採用通知", contractLabel: null, acceptLabel: "採用承諾",
    hiredPhrase: "採用とさせていただくことになりました。", hiredDetail: "勤務条件の詳細",
    afterAcceptPublic: "承諾ありがとうございました。次は雇用契約・入社の手続きです。採用担当からご連絡します。",
    employmentType: null,   // パート／アルバイトは入力で選ぶ（employmentType の項目）
    documents: ["採用通知", "労働条件通知書", "雇用契約書"],
    afterAccept: { label: "入社手続きへ進めてください", cta: "入社手続きへ進む" },
    mail: { title: "採用", lead: "採用をご案内いたします。" },
    // 給与区分は選ばせない（時給だけ）
    pay: { label: "時給", fixed: "時給" },
    fields: [
      { key: "employmentType", column: "employment_type", label: "区分", kind: "select", options: ["パート", "アルバイト"], required: true, basic: true },
      F.wageType("給与区分", ["時給"]),
      F.wageAmount("時給"),
      F.term("workDays", "勤務曜日", "text", { placeholder: "月・火・木", basic: true, highlight: true }),
      F.term("workHours", "勤務時間", "text", { placeholder: "10:00〜15:00", basic: true, highlight: true }),
      { ...F.joinDate("入社予定日"), required: true, basic: true, highlight: true },
      F.weeklyHours,
      F.workLocation("勤務地"),
      F.term("commuteCost", "交通費", "text", { placeholder: "実費支給（上限 月2万円）", salary: true }),
      F.probation,
      F.duties("業務内容"),
    ],
  },
  {
    key: "spot",
    label: "スポット・副業", icon: "bolt", publicLabel: "スポット・副業",
    summary: "単発案件・イベント・営業・講師・制作などで参画。",
    flow: ["案件オファー", "条件確認", "承諾", "NDA/契約", "案件アサイン"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    offerName: "案件オファー", contractLabel: "スポット・副業", acceptLabel: "案件承諾",
    hiredPhrase: "案件へのご参画をお願いすることになりました。", hiredDetail: "案件の内容・条件",
    afterAcceptPublic: "承諾ありがとうございました。次は契約手続きです。採用担当からご連絡します。",
    employmentType: "スポット・副業",
    documents: ["案件オファー", "スポット業務契約", "NDA"],
    afterAccept: { label: "案件へのアサイン（NDA・契約の確認を含む）へ進めてください", cta: "案件アサインへ進む" },
    mail: { title: "案件", lead: "案件へのご参画をご案内いたします。" },
    pay: { label: "報酬", buttons: [btn("日額"), btn("時給"), btn("案件単価", "案件")] },
    fields: [
      { ...F.term("projectName", "案件名"), required: true, basic: true, highlight: true },
      F.duties("業務内容", { basic: true }),
      { ...F.joinDate("実施日"), required: true, basic: true, highlight: true },
      F.term("workHours", "稼働時間", "text", { placeholder: "1日4時間", basic: true, highlight: true }),
      // 時間単価 は、これまでの版の値（読めるように受け付ける。ボタンには出さない）
      F.wageType("報酬形態", ["日額", "時給", "案件単価", "時間単価"]),
      F.wageAmount("報酬"),
      F.term("successCriteria", "成果条件", "textarea"),
      F.term("paymentTerms", "支払条件", "text", { placeholder: "納品月の翌月末払い" }),
      F.term("nda", "NDA", "select", { options: YES_NO_NDA }),
      F.term("contactPerson", "担当者"),
    ],
  },
];

export const OFFER_TYPE_KEYS = OFFER_TYPES.map((t) => t.key);
const BY_KEY = Object.fromEntries(OFFER_TYPES.map((t) => [t.key, t]));
export const offerTypeOf = (key) => BY_KEY[key] || null;
export const offerTypeLabel = (key) => BY_KEY[key]?.label || null;

/** 区分の、offer_terms に入る項目（既存の列ではないもの） */
export const termFieldsOf = (key) => (offerTypeOf(key)?.fields || []).filter((f) => !f.column);

/** 画面へ渡す定義（関数・サーバ専用の値を含めない） */
export const OFFER_TYPES_PUBLIC = OFFER_TYPES.map((t) => ({
  key: t.key, label: t.label, icon: t.icon, summary: t.summary, flow: t.flow, documents: t.documents,
  offerName: t.offerName, employmentType: t.employmentType, pay: t.pay,
  fields: t.fields.map(({ key, column, label, kind, options, placeholder, unit, salary, internal, required,
    basic, value, templates, presets, hidden, auto }) => ({
    key, label, kind, options: options || null, placeholder: placeholder || null, unit: unit || null,
    // term=true は区分にしか無い項目（offerTerms に入る）。false は既存の列（jobTitle・joinDate など）
    term: !column, salary: Boolean(salary), internal: Boolean(internal), required: Boolean(required),
    // basic=false は［詳細設定］の中。value は作成時の既定値。templates・presets は選べる標準文・値
    basic: Boolean(basic), value: value ?? null, templates: templates || null, presets: presets || null,
    hidden: Boolean(hidden), auto: Boolean(auto),
  })),
}));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * offer_terms の入力を、その区分で決めた項目だけに絞って整える。知らないキーは捨てる。
 * @param {string} typeKey
 * @param {object} input  { position: "...", nda: "必要", ... }
 * @param {{salary?: boolean, previous?: object}} [opts]
 *   salary=false … 給与の項目（incentive・commuteCost）は入力から外し、previous の値をそのまま残す
 * @returns {{value: object}|{error: string, detail: string}}
 */
export function normalizeOfferTerms(typeKey, input, { salary = true, previous = {} } = {}) {
  const fields = termFieldsOf(typeKey);
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const f of fields) {
    if (f.salary && !salary) {
      if (previous && previous[f.key] != null) out[f.key] = previous[f.key];
      continue;
    }
    const raw = src[f.key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const v = String(raw).trim();
    if (f.kind === "date" && !DATE_RE.test(v)) return { error: "invalid_body", detail: `${f.label}の日付が正しくありません` };
    if (f.kind === "select" && !f.options.includes(v)) return { error: "invalid_body", detail: `${f.label}は ${f.options.join("／")} から選んでください` };
    out[f.key] = v.slice(0, f.kind === "textarea" ? 2000 : 200);
  }
  return { value: out };
}

/**
 * 区分の必須項目がそろっているか（作成・確定の前に見る）。
 * row は gw_hr_offers の形（既存の列は snake_case、区分の項目は offer_terms）。
 * @returns {string[]} 足りない項目の名前
 */
export function missingRequired(typeKey, row) {
  const t = offerTypeOf(typeKey);
  if (!t) return [];
  const terms = row?.offer_terms || {};
  return t.fields.filter((f) => f.required)
    .filter((f) => {
      const v = f.column ? row?.[f.column] : terms[f.key];
      return v === undefined || v === null || String(v).trim() === "";
    })
    .map((f) => f.label);
}

/** 既存の列の項目で、区分ごとに入力を受け付けるもの（API のキー） */
export const columnKeysOf = (key) => (offerTypeOf(key)?.fields || []).filter((f) => f.column).map((f) => f.key);

// ---- 自動で決まる値（§5・§11） --------------------------------------------------

/** "3か月" "6ヶ月" → 3・6。読めなければ null */
export function periodMonths(text) {
  const m = /^\s*(\d{1,2})\s*(?:か|ヶ|ケ|カ|ヵ|箇)?\s*月/.exec(String(text || ""));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 36 ? n : null;
}

const pad2 = (n) => String(n).padStart(2, "0");
/** 暦の上の日付（UTC の年月日で計算した値）を YYYY-MM-DD に */
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
/**
 * 育成の評価日。開始日から期間（か月）を数えた最終日を「最終評価日」、その中間を「中間評価日」にする。
 * 例：2026-11-01 から 3か月 → 最終 2027-01-31・中間 2026-12-17
 */
export function reviewDates(start, months) {
  if (!DATE_RE.test(String(start || "")) || !months) return null;
  const [y, m, d] = start.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay)));
  end.setUTCDate(end.getUTCDate() - 1);
  const begin = Date.UTC(y, m - 1, d);
  const mid = new Date(begin + Math.round((end.getTime() - begin) / 86400000 / 2) * 86400000);
  return { mid: ymd(mid), final: ymd(end) };
}

/**
 * 育成枠の、入力しなくてよい値を埋める（入っている値は変えない）。
 *   コースの既定の期間（無限道場 → 3か月）・期間と開始日からの評価日
 */
export function deriveTrainingTerms(terms, joinDate) {
  const out = { ...(terms || {}) };
  const course = TRAINING_COURSES.find((c) => c.label === out.course);
  if (course?.period && !out.trainingPeriod) out.trainingPeriod = course.period;
  const dates = reviewDates(joinDate, periodMonths(out.trainingPeriod));
  if (dates) {
    if (!out.midReviewOn) out.midReviewOn = dates.mid;
    if (!out.finalReviewOn) out.finalReviewOn = dates.final;
  }
  return out;
}

/** 回答期限の既定：送る日（今日・日本時間）から3日後（§11） */
export const RESPOND_DAYS = 3;
export function defaultRespondBy(now = Date.now()) {
  return jstYmd(new Date(now + RESPOND_DAYS * 86400000));
}
/** 今日（日本時間）の YYYY-MM-DD */
export const todayJst = (now = Date.now()) => jstYmd(new Date(now));

// ---- 本人向けページ（hr/offer.html） --------------------------------------------

const fmtDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : null;
};
const fmtYen = (n) => (n == null || n === "" || Number.isNaN(Number(n)) ? null : `${Number(n).toLocaleString("ja-JP")}円`);

/**
 * 本人に見せる「条件」の行。区分ごとの項目名で、社内用（internal）を除き、空の項目は出さない。
 * 金額は「給与区分 金額」を1行にまとめる（時給だけの区分は金額だけ）。育成の「報酬なし」は「なし」。
 *   highlight … 先にコンパクトに見せる重要条件（§14）。それ以外は下の「契約・条件」に出す
 *   salary    … 給与にあたる行（社内の確認画面で、給与を見られない人には出さない）
 * @param {object} offer gw_hr_offers の行（給与は attachPay 済み）
 * @returns {{label: string, value: string, highlight: boolean, salary: boolean}[]}
 */
export function publicOfferItems(offer) {
  const t = offerTypeOf(offer?.offer_type);
  if (!t) return [];
  const terms = offer.offer_terms || {};
  const items = [];
  if (t.contractLabel || offer.employment_type) {
    items.push({ label: "契約形態", value: t.contractLabel || offer.employment_type, highlight: false, salary: false });
  }
  for (const f of t.fields) {
    if (f.internal || f.hidden) continue;   // 社内用・ボタンが決める値（給与区分・育成中の報酬）は行にしない
    if (f.key === "employmentType") continue;   // 契約形態の行で出す
    let value;
    if (f.key === "wageAmount") {
      const yen = fmtYen(offer.wage_amount);
      value = yen ? (t.pay?.fixed ? yen : [offer.wage_type, yen].filter(Boolean).join(" ")) : null;
      if (!value && t.pay?.none && terms[t.pay.none.key] === t.pay.none.no) value = t.pay.none.label;
    } else {
      const raw = f.column ? offer[f.column] : terms[f.key];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      value = f.kind === "date" ? fmtDate(raw) : `${raw}${f.unit && f.kind === "number" ? f.unit : ""}`;
    }
    if (value) {
      items.push({ label: f.publicLabel || f.label, value, highlight: Boolean(f.highlight), salary: Boolean(f.salary) });
    }
  }
  return items;
}

/** 本人の同意（§15・§16）。画面の文言はここ1か所 */
export const AGREEMENT = {
  check: "上記の内容を確認し、同意します",
  button: "同意して契約を完了する",
  doneTitle: "契約手続きが完了しました。",
  doneBody: (company) => `ご同意ありがとうございます。\n次の手続きについて${company || "採用担当"}からご案内します。`,
};

/** 本人向けページの見出し・条件の行・同意の文言（区分が無い古い合格通知は null） */
export function publicOfferView(offer, { company = null } = {}) {
  const t = offerTypeOf(offer?.offer_type);
  if (!t) return null;
  return {
    offerType: t.key, offerName: t.offerName, typeLabel: t.publicLabel || t.label, acceptLabel: t.acceptLabel,
    items: publicOfferItems(offer),
    agreeCheck: AGREEMENT.check, agreeButton: AGREEMENT.button,
    doneTitle: AGREEMENT.doneTitle, afterAccept: AGREEMENT.doneBody(company),
  };
}

// ---- オファーを送るメール（§12・§13） -------------------------------------------

/** 本文の、本人専用URLが入る場所。送る直前にサーバーが本物のURLへ差し替える（記録には残さない） */
export const OFFER_URL_TAG = "{{オファーURL}}";

/**
 * オファーを送るメールの下書き。区分ごとに自動で作り、画面で送る直前まで直せる。
 * 区分の無い、これまでの合格通知は「選考結果のご案内」
 * @param {object} offer gw_hr_offers の行
 * @param {{name:string, company?:string|null, senderName?:string|null}} p
 * @returns {{subject:string, body:string}}
 */
export function offerMail(offer, { name, company }) {
  const t = offerTypeOf(offer?.offer_type);
  const c = company || "弊社";
  const lead = !t ? "選考結果および採用条件をご案内いたします。"
    : t.key === "part_time" && offer.employment_type ? `${offer.employment_type}としての採用をご案内いたします。` : t.mail.lead;
  const due = fmtDate(offer?.respond_by);
  return {
    subject: `【${c}】${t ? `${t.mail.title}のご案内` : "選考結果のご案内"}`,
    body: [
      `${name} 様`,
      "",
      "このたびは面談にご参加いただきありがとうございました。",
      "",
      `${c}より、`,
      lead,
      "",
      "下記より内容をご確認いただき、",
      `問題なければ「${t ? AGREEMENT.button : "承諾する"}」を押してください。`,
      "",
      "［内容を確認する］",
      OFFER_URL_TAG,
      ...(due ? ["", `回答期限：${due}`] : []),
      "",
      "ご不明な点がございましたら、このメールにご返信ください。",
      "",
      c,
      "採用担当",
    ].join("\n"),
  };
}

// ---- 社内の言い方（状態・NEXT ACTION） -----------------------------------------

/**
 * 区分つきのときの状態の言い方。区分が無ければ null（既存の STATUS_LABEL を使う）。
 * offer_draft_pending で区分が無いのは「採用区分の選択待ち」。
 * 本人が同意したら（accepted）「契約完了」（§17。内部の状態は既存の accepted のまま）
 */
export function offerStatusLabel(status, typeKey) {
  const t = offerTypeOf(typeKey);
  if (status === "offer_draft_pending") return t ? `${t.offerName}の作成待ち` : "採用区分の選択待ち";
  if (!t) return null;
  const map = {
    offer_review_pending: `${t.offerName}の下書き`,
    offer_send_pending: `${t.offerName}の送付待ち`,
    offer_resend_pending: "URL再送待ち",
    offer_sent: "承諾待ち",
    offer_viewed: "承諾待ち（本人が閲覧済み）",
    offer_response_pending: "承諾待ち（本人が閲覧済み）",
    accepted: "契約完了",
  };
  return map[status] || null;
}

/**
 * 区分つきのときの NEXT ACTION。null なら既存の判定を使う。
 * 契約完了のあとは区分で変わる（正社員・パート → 入社手続き／育成 → LMS・育成開始／業務委託 → 稼働開始準備／スポット → 案件アサイン）
 * @returns {{label:string, cta:string|null, action:string|null}|null}
 */
export function offerNextAction(status, typeKey) {
  const t = offerTypeOf(typeKey);
  if (status === "offer_draft_pending") {
    return t
      ? { label: `${t.offerName}（${t.label}）の条件を入力して、メールで送ってください`, cta: "オファーを作成", action: "createOffer" }
      : { label: "採用区分を選んでください（この方をどの形で迎えますか？）", cta: "採用区分を選ぶ", action: "chooseOfferType" };
  }
  if (!t) return null;
  if (status === "offer_review_pending") return { label: `${t.offerName}の下書きがあります。内容を確認して、メールで送ってください`, cta: "内容を確認して送信", action: "reviewOffer" };
  if (status === "offer_send_pending") return { label: `${t.offerName}を候補者へ送ってください`, cta: "メールで送信", action: "sendOffer" };
  if (status === "accepted") return { label: `契約完了。${t.afterAccept.label}`, cta: t.afterAccept.cta, action: "advance" };
  return null;
}

// ---- ステップバー（候補者詳細の上部。§6） ----------------------------------------

const NORMAL_STEPS = [
  { key: "applied", label: "応募" }, { key: "interview", label: "面談" }, { key: "passed", label: "合格" },
  { key: "offer", label: "オファー" }, { key: "accept", label: "承諾" }, { key: "contract", label: "契約" },
  { key: "start", label: "入社/稼働" },
];
const TRAINING_STEPS = [
  { key: "passed", label: "合格" }, { key: "join", label: "育成参加" }, { key: "training", label: "育成" },
  { key: "project", label: "実案件" }, { key: "review", label: "評価" }, { key: "contract", label: "契約" },
];

const OFFER_MAKING = ["offer_review_pending", "offer_send_pending", "offer_resend_pending"];
const OFFER_WAITING = ["offer_sent", "offer_viewed", "offer_response_pending"];

/**
 * 応募者の、採用フロー上の現在地。
 * @param {{stage:string, status:string, offer_type?:string|null}} a gw_hr_applicants の行
 * @returns {{flow: "normal"|"training", steps: {key:string,label:string,state:"done"|"now"|"todo"}[], ended: string|null}}
 */
export function recruitStepsOf(a) {
  const type = offerTypeOf(a?.offer_type);
  const training = type?.stepFlow === OFFER_TYPE_FLOW.training;
  const steps = training ? TRAINING_STEPS : NORMAL_STEPS;
  const s = a?.status;
  let now;
  if (training) {
    if (s === "offer_draft_pending" || OFFER_MAKING.includes(s) || OFFER_WAITING.includes(s)) now = "join";
    else if (s === "accepted" || s === "done") now = "training";   // 育成の状態は Phase 3 で足す
    else now = "passed";
  } else if (s === "done") now = "start";
  // 区分つきは、本人の同意で契約完了（§17）。区分の無い、これまでの承諾は「契約」の手前のまま
  else if (s === "accepted") now = type ? "start" : "contract";
  else if (OFFER_WAITING.includes(s)) now = "accept";
  else if (OFFER_MAKING.includes(s) || (s === "offer_draft_pending" && type)) now = "offer";
  else if (s === "offer_draft_pending") now = "passed";
  else if (a?.stage === "applied" && ["todo", "scheduling"].includes(s)) now = "applied";
  else now = "interview";
  const idx = steps.findIndex((x) => x.key === now);
  const ended = s === "declined" ? "辞退" : s === "passed" ? "見送り" : null;
  return {
    flow: training ? "training" : "normal",
    steps: steps.map((x, i) => ({
      key: x.key, label: x.label,
      state: s === "done" && !training ? "done" : i < idx ? "done" : i === idx ? (ended ? "todo" : "now") : "todo",
    })),
    ended,
  };
}
