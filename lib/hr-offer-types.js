// 面談合格後の「採用区分」（offer_type）。5つの区分ごとの、入力項目・本人への見せ方・必要書類・流れ。
// 値の定義と、純粋な関数だけ（DB・外部に触らない）。画面・API はここを正として使い、別に定義を持たない。
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

export const OFFER_TYPE_FLOW = { normal: "normal", training: "training" };

const YES_NO_NDA = ["必要", "不要"];

/**
 * 項目の定義。
 *   key      … API のキー（camelCase）。column があれば既存の列、無ければ offer_terms のキー
 *   column   … 既存の列（gw_hr_offers）。無ければ offer_terms に入る
 *   kind     … text | textarea | date | number | select
 *   salary   … 給与として扱う（給与を見られない人には出さない・書かせない）
 *   internal … 社内用。本人向けページに出さない
 */
const F = {
  jobTitle: { key: "jobTitle", column: "job_title", label: "職種", kind: "text" },
  joinDate: (label) => ({ key: "joinDate", column: "join_date", label, kind: "date" }),
  contractEndDate: (label) => ({ key: "contractEndDate", column: "contract_end_date", label, kind: "date" }),
  probation: { key: "probationMonths", column: "probation_months", label: "試用期間（月）", kind: "number", unit: "か月" },
  workLocation: (label) => ({ key: "workLocation", column: "work_location", label, kind: "text" }),
  weeklyHours: { key: "weeklyHours", column: "weekly_hours", label: "週の勤務時間", kind: "number", unit: "時間" },
  wageType: (label, options) => ({ key: "wageType", column: "wage_type", label, kind: "select", options, salary: true }),
  wageAmount: (label) => ({ key: "wageAmount", column: "wage_amount", label, kind: "number", unit: "円", salary: true }),
  term: (key, label, kind = "text", extra = {}) => ({ key, label, kind, ...extra }),
};

export const OFFER_TYPES = [
  {
    key: "executive_employee",
    label: "正社員・幹部候補", icon: "badge",
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
    afterAccept: { label: "雇用契約・入社手続きへ進めてください", cta: "入社手続きへ進む" },
    fields: [
      F.jobTitle,
      F.term("position", "役職"),
      F.wageType("給与区分", ["月給", "年俸"]),
      F.wageAmount("給与"),
      F.probation,
      F.term("workHours", "勤務時間", "text", { placeholder: "9:00〜18:00（休憩60分）" }),
      F.workLocation("勤務地"),
      { ...F.joinDate("入社予定日"), required: true },
      F.term("duties", "業務内容", "textarea"),
      F.term("incentive", "インセンティブ", "textarea", { salary: true }),
      F.term("otherTerms", "その他条件", "textarea"),
    ],
  },
  {
    key: "training",
    label: "育成枠", icon: "eco",
    summary: "まず育成・研修から参加し、評価後に実案件や契約へ進む。",
    flow: ["育成参加通知", "参加承諾", "LMS登録", "育成", "評価", "実案件", "継続判定"],
    stepFlow: OFFER_TYPE_FLOW.training,
    offerName: "育成参加決定通知", contractLabel: "育成プログラムへの参加", acceptLabel: "参加承諾",
    hiredPhrase: "まずは育成プログラムへのご参加をお願いすることになりました。", hiredDetail: "育成の内容・条件",
    afterAcceptPublic: "参加のご承諾ありがとうございました。次は育成参加の手続きです。採用担当からご連絡します。",
    employmentType: "育成枠",
    documents: ["育成参加決定通知", "育成条件確認書", "参加承諾", "実案件参加時の契約書"],
    afterAccept: { label: "育成参加の手続き（LMS登録など）へ進めてください", cta: "参加手続きへ進む" },
    fields: [
      { ...F.term("course", "育成コース"), required: true },
      { ...F.joinDate("育成開始日"), required: true },
      F.term("trainingPeriod", "育成期間", "text", { placeholder: "3か月" }),
      F.term("instructor", "担当講師"),
      F.term("midReviewOn", "中間評価日", "date"),
      F.term("finalReviewOn", "最終評価日", "date"),
      F.term("projectStartOn", "実案件開始予定", "date"),
      F.term("paidDuringTraining", "育成中の報酬", "select", { options: ["なし", "あり"] }),
      F.wageType("報酬区分（報酬ありの場合）", ["月額", "時給", "日額"]),
      F.wageAmount("報酬（報酬ありの場合）"),
      F.term("note", "備考（社内用）", "textarea", { internal: true }),
    ],
  },
  {
    key: "contractor",
    label: "業務委託", icon: "handshake",
    summary: "専門業務・案件単位・継続業務で参画してもらう。",
    flow: ["オファー", "条件確認", "承諾", "業務委託契約", "NDA", "稼働開始"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    offerName: "業務委託オファー", contractLabel: "業務委託", acceptLabel: "オファー承諾",
    hiredPhrase: "業務委託としてご参画をお願いすることになりました。", hiredDetail: "業務内容・報酬などの条件",
    afterAcceptPublic: "承諾ありがとうございました。次は契約手続きです。採用担当からご連絡します。",
    employmentType: "業務委託",
    documents: ["業務委託オファー", "業務委託契約書", "NDA"],
    afterAccept: { label: "業務委託契約・NDAの手続きへ進めてください", cta: "契約手続きへ進む" },
    fields: [
      { ...F.term("duties", "委託業務", "textarea"), required: true },
      F.wageType("報酬形態", ["月額固定", "時間単価", "案件単価", "成果報酬"]),
      F.wageAmount("報酬"),
      F.term("workHours", "稼働時間", "text", { placeholder: "週20時間程度" }),
      F.term("workDays", "稼働曜日", "text", { placeholder: "月・水・金" }),
      F.workLocation("稼働場所"),
      { ...F.joinDate("契約開始日"), required: true },
      F.contractEndDate("契約終了日"),
      F.term("renewal", "更新", "select", { options: ["協議のうえ更新", "自動更新", "更新なし"] }),
      F.term("deliverables", "成果物", "textarea"),
      F.term("paymentTerms", "支払条件", "text", { placeholder: "月末締め翌月末払い" }),
      F.term("nda", "NDA", "select", { options: YES_NO_NDA }),
    ],
  },
  {
    key: "part_time",
    label: "パート・アルバイト", icon: "schedule",
    summary: "曜日・時間を決めて勤務してもらう。",
    flow: ["採用通知", "労働条件確認", "承諾", "雇用契約", "入社手続き"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    offerName: "採用通知", contractLabel: null, acceptLabel: "採用承諾",
    hiredPhrase: "採用とさせていただくことになりました。", hiredDetail: "勤務条件の詳細",
    afterAcceptPublic: "承諾ありがとうございました。次は雇用契約・入社の手続きです。採用担当からご連絡します。",
    employmentType: null,   // パート／アルバイトは入力で選ぶ（employmentType の項目）
    documents: ["採用通知", "労働条件通知書", "雇用契約書"],
    afterAccept: { label: "雇用契約・入社手続きへ進めてください", cta: "入社手続きへ進む" },
    fields: [
      { key: "employmentType", column: "employment_type", label: "区分", kind: "select", options: ["パート", "アルバイト"], required: true },
      F.wageType("給与区分", ["時給"]),
      F.wageAmount("時給"),
      F.term("workDays", "勤務曜日", "text", { placeholder: "月・火・木" }),
      F.term("workHours", "勤務時間", "text", { placeholder: "10:00〜15:00" }),
      F.weeklyHours,
      F.workLocation("勤務地"),
      F.term("commuteCost", "交通費", "text", { placeholder: "実費支給（上限 月2万円）", salary: true }),
      F.probation,
      { ...F.joinDate("入社予定日"), required: true },
      F.term("duties", "業務内容", "textarea"),
    ],
  },
  {
    key: "spot",
    label: "スポット・副業", icon: "bolt",
    summary: "単発案件・イベント・営業・講師・制作などで参画。",
    flow: ["案件オファー", "条件確認", "承諾", "NDA/契約", "案件アサイン"],
    stepFlow: OFFER_TYPE_FLOW.normal,
    offerName: "案件オファー", contractLabel: "スポット・副業", acceptLabel: "案件承諾",
    hiredPhrase: "案件へのご参画をお願いすることになりました。", hiredDetail: "案件の内容・条件",
    afterAcceptPublic: "承諾ありがとうございました。次は契約手続きです。採用担当からご連絡します。",
    employmentType: "スポット・副業",
    documents: ["案件オファー", "スポット業務契約", "NDA"],
    afterAccept: { label: "契約（NDA）・案件アサインへ進めてください", cta: "契約手続きへ進む" },
    fields: [
      { ...F.term("projectName", "案件名"), required: true },
      F.term("duties", "業務内容", "textarea"),
      { ...F.joinDate("実施日（開始日）"), required: true },
      F.term("workHours", "稼働時間", "text", { placeholder: "1日4時間" }),
      F.wageType("報酬形態", ["案件単価", "時間単価", "日額"]),
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
  offerName: t.offerName, employmentType: t.employmentType,
  fields: t.fields.map(({ key, column, label, kind, options, placeholder, unit, salary, internal, required }) => ({
    key, label, kind, options: options || null, placeholder: placeholder || null, unit: unit || null,
    // term=true は区分にしか無い項目（offerTerms に入る）。false は既存の列（jobTitle・joinDate など）
    term: !column, salary: Boolean(salary), internal: Boolean(internal), required: Boolean(required),
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

// ---- 本人向けページ（hr/offer.html） --------------------------------------------

const fmtDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : null;
};
const fmtYen = (n) => (n == null || n === "" || Number.isNaN(Number(n)) ? null : `${Number(n).toLocaleString("ja-JP")}円`);

/**
 * 本人に見せる「条件」の行。区分ごとの項目名で、社内用（internal）を除き、空の項目は出さない。
 * 金額は「給与区分 金額」を1行にまとめる。
 * @param {object} offer gw_hr_offers の行（給与は attachPay 済み）
 * @returns {{label: string, value: string}[]}
 */
export function publicOfferItems(offer) {
  const t = offerTypeOf(offer?.offer_type);
  if (!t) return [];
  const terms = offer.offer_terms || {};
  const items = [];
  if (t.contractLabel || offer.employment_type) items.push({ label: "契約形態", value: t.contractLabel || offer.employment_type });
  for (const f of t.fields) {
    if (f.internal || f.key === "wageType") continue;
    if (f.key === "employmentType") continue;   // 契約形態の行で出す
    let value;
    if (f.key === "wageAmount") {
      const yen = fmtYen(offer.wage_amount);
      value = yen ? [offer.wage_type, yen].filter(Boolean).join(" ") : null;
    } else {
      const raw = f.column ? offer[f.column] : terms[f.key];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      value = f.kind === "date" ? fmtDate(raw) : `${raw}${f.unit && f.kind === "number" ? f.unit : ""}`;
    }
    if (value) items.push({ label: f.label.replace(/（報酬ありの場合）$/, ""), value });
  }
  return items;
}

/** 本人向けページの見出し・承諾後の案内（区分が無い古い合格通知は null） */
export function publicOfferView(offer) {
  const t = offerTypeOf(offer?.offer_type);
  if (!t) return null;
  return {
    offerType: t.key, offerName: t.offerName, acceptLabel: t.acceptLabel,
    afterAccept: t.afterAcceptPublic, items: publicOfferItems(offer),
  };
}

// ---- 社内の言い方（状態・NEXT ACTION） -----------------------------------------

/**
 * 区分つきのときの状態の言い方。区分が無ければ null（既存の STATUS_LABEL を使う）。
 * offer_draft_pending で区分が無いのは「採用区分の選択待ち」。
 */
export function offerStatusLabel(status, typeKey) {
  const t = offerTypeOf(typeKey);
  if (status === "offer_draft_pending") return t ? `${t.offerName}の作成待ち` : "採用区分の選択待ち";
  if (!t) return null;
  const map = {
    offer_review_pending: `${t.offerName}の社内確認待ち`,
    offer_send_pending: `${t.offerName}の送付待ち`,
    offer_resend_pending: "URL再送待ち",
    offer_sent: `${t.acceptLabel}待ち`,
    offer_viewed: `${t.acceptLabel}待ち（本人が閲覧済み）`,
    offer_response_pending: `${t.acceptLabel}待ち`,
    accepted: `${t.acceptLabel}済み`,
  };
  return map[status] || null;
}

/**
 * 区分つきのときの NEXT ACTION。null なら既存の判定を使う。
 * @returns {{label:string, cta:string|null, action:string|null}|null}
 */
export function offerNextAction(status, typeKey) {
  const t = offerTypeOf(typeKey);
  if (status === "offer_draft_pending") {
    return t
      ? { label: `${t.offerName}（${t.label}）の条件を入力してください`, cta: "オファーを作成", action: "createOffer" }
      : { label: "採用区分を選んでください（この方をどの形で迎えますか？）", cta: "採用区分を選ぶ", action: "chooseOfferType" };
  }
  if (!t) return null;
  if (status === "offer_review_pending") return { label: `${t.offerName}の内容を確認してください`, cta: "内容を確認する", action: "reviewOffer" };
  if (status === "offer_send_pending") return { label: `${t.offerName}を候補者へ送ってください`, cta: "候補者へ送信", action: "sendOffer" };
  if (status === "accepted") return { label: t.afterAccept.label, cta: t.afterAccept.cta, action: "advance" };
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
  else if (s === "accepted") now = "contract";
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
