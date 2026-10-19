// 採用HR：契約手続き（社労士への作成依頼 → 正式PDFの受領・承認 → 本人へ案内 → 条件同意 → 正式契約 → Office 引き渡し）。
// 値の定義と純粋な関数だけ（DB・外部に触らない）。API（api/hr/offers/contract.js・index.js）と画面はここを正として使う。
//
// ■ 運用の正本（docs/hr-contract-procedure.md・db/139）
//   HR は進捗と証跡の正本。社労士が作った正式な通知書PDFが書類の正本。
//   HR が作る条件通知書PDFは「社労士へ依頼するときの条件案」で、本人へは送らない（送付ルートを二重にしない）。
//   本人へ案内した正式PDFは gw_hr_offers.notice_* にそのまま入る（承諾の記録・承諾済みPDF・Office の閲覧はこの版）。
//
// ■ 条件同意と正式契約は別の事実
//   条件同意＝本人が HR の画面で同意（accepted_at）。正式契約＝LegalSign（または例外ルート）で締結（formal_signed_at）。
//   どちらが先でもよい。Office への引き渡しは、両方（正式契約が要らない版は同意だけ）がそろってから。
//
// ■ Slack へは送らない
//   作るのは、Slack に貼る依頼文だけ。送るのは担当者。「依頼済み」は担当者がボタンを押したときだけ記録する。

import { offerTypeOf, formalRequiredOf, documentWarnings, publicOfferItems } from "./hr-offer-types.js";

/** 正式PDFの流れで進める区分（育成枠は HR の条件通知書のまま。区分の無い古い合格通知も対象外） */
export const OFFICIAL_TYPES = ["executive_employee", "part_time", "contractor", "spot"];
/** 正式PDFの大きさの上限（社労士への依頼の既存の上限と同じ 15MB。db/139 の CHECK と同じ） */
export const OFFICIAL_MAX_BYTES = 15 * 1024 * 1024;

/** 書類の種類（db/139 の CHECK と同じ値） */
export const DOC_KINDS = [
  { key: "labor_notice", label: "労働条件通知書" },
  { key: "labor_notice_contract", label: "労働条件通知書兼雇用契約書" },
  { key: "employment_contract", label: "雇用契約書" },
  { key: "contractor_contract", label: "業務委託契約書" },
  { key: "contractor_terms", label: "業務委託条件通知書" },
  { key: "other", label: "その他" },
];
const DOC_KIND_LABEL = Object.fromEntries(DOC_KINDS.map((k) => [k.key, k.label]));
export const docKindLabel = (key) => DOC_KIND_LABEL[key] || null;

const EMPLOYMENT = ["executive_employee", "part_time"];
/** 区分ごとに選べる書類の種類（業務委託・スポットで「労働条件通知書」と呼ばない） */
export function docKindsOf(typeKey) {
  const keys = EMPLOYMENT.includes(typeKey)
    ? ["labor_notice", "labor_notice_contract", "employment_contract", "other"]
    : ["contractor_contract", "contractor_terms", "other"];
  return DOC_KINDS.filter((k) => keys.includes(k.key));
}
export const defaultDocKind = (typeKey) => (EMPLOYMENT.includes(typeKey) ? "labor_notice" : "contractor_contract");

/** 依頼先（業務委託・スポットは、必要に応じて法務も確認する） */
export const attorneyLabelOf = (typeKey) => (EMPLOYMENT.includes(typeKey) ? "社労士" : "社労士・法務");
/** 依頼文で頼む書類の名前 */
export const requestDocNameOf = (typeKey) => (EMPLOYMENT.includes(typeKey) ? "労働条件通知書（雇用契約書）" : "業務委託契約書（条件通知書）");

/** 契約ルート（db/139 の CHECK と同じ値） */
export const CONTRACT_ROUTES = [
  { key: "legalsign", label: "LegalSign（電子契約）" },
  { key: "other", label: "例外ルート（紙・対面など）" },
];
export const CONTRACT_ROUTE_KEYS = CONTRACT_ROUTES.map((r) => r.key);

/** 承認する前に照合する項目（全部に✓が要る）。区分で言い方を変える */
export function reviewChecksOf(typeKey) {
  const emp = EMPLOYMENT.includes(typeKey);
  return [
    { key: "person", label: "氏名・書類の種類が合っている" },
    { key: "dates", label: emp ? "入社日・雇用期間・試用期間が条件と同じ" : "契約開始日・契約期間が条件と同じ" },
    { key: "work", label: emp ? "勤務場所・業務内容・勤務時間・休憩・休日が条件と同じ" : "業務内容・稼働場所・稼働時間が条件と同じ" },
    { key: "pay", label: emp ? "給与・手当・締日・支払日が条件と同じ" : "報酬・支払条件・経費の扱いが条件と同じ" },
    { key: "legal", label: emp ? "法定の明示事項に漏れがない（社労士の確認済み）" : "契約に必要な事項に漏れがない（必要に応じて法務の確認済み）" },
  ];
}

// ---- どの流れで進めるか ----------------------------------------------------------

/** db/139 の列があるか（PostgREST は select("*") で列を全部返すので、行にキーがあるかで分かる） */
export const contractReady = (offer) => Boolean(offer) && Object.prototype.hasOwnProperty.call(offer, "doc_route");

/**
 * この版を、社労士の正式PDFで本人へ案内するか。
 *   db/139 が無い・区分が無い・育成枠 … これまでどおり（HR の条件通知書）
 *   doc_route が入っていればその値（作成時に API が入れる。一度決めたら DB が変えさせない）
 *   空（db/139 より前に作った版）… まだ送っていない・承諾も無効化もしていない版だけを正式PDFの流れにする
 * @returns {"official"|"generated"}
 */
export function docRouteOf(offer) {
  if (!offer || !contractReady(offer) || !OFFICIAL_TYPES.includes(offer.offer_type)) return "generated";
  if (offer.doc_route === "official" || offer.doc_route === "generated") return offer.doc_route;
  if (offer.sent_at || offer.notice_pdf_path || offer.accepted_at || offer.revoked_at || offer.declined_at) return "generated";
  // 再発行で足された版（第2版以降）で流れが空 ＝ db/139 を流す前に、HR の条件通知書で送った版の続き。途中で流れを変えない
  // （db/139 のあとに作る版は、作成・再発行のときに流れを入れる）
  if (Number(offer.version) > 1) return "generated";
  return "official";
}
export const usesOfficial = (offer) => docRouteOf(offer) === "official";
/** 作成するときに入れる値（区分つき・育成枠以外は正式PDFの流れ） */
export const initialDocRoute = (typeKey) => (OFFICIAL_TYPES.includes(typeKey) ? "official" : "generated");

// ---- 社労士への依頼文（Slack に貼る下書き。送るのは担当者） ---------------------------

const MISSING = "【要確認】";
const blank = (v) => v === undefined || v === null || String(v).trim() === "";
const fmtDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : null;
};
const yen = (n) => (blank(n) || Number.isNaN(Number(n)) ? null : `${Number(n).toLocaleString("ja-JP")}円`);
const oneLine = (s) => String(s ?? "").replace(/\s*\n\s*/g, " ／ ").trim();

/**
 * 1行ぶんの値。parts の中の空でないものを「・」でつなぐ。全部空なら null
 * @param {(string|null|undefined)[]} parts
 */
const joinParts = (parts, sep = "・") => {
  const xs = parts.map((p) => (blank(p) ? null : oneLine(p))).filter(Boolean);
  return xs.length ? xs.join(sep) : null;
};

/**
 * 依頼文の行（ラベル・値・給与かどうか）。値が null なら【要確認】にする。区分ごとに並べ方を変える。
 * 値は HR に登録した条件だけ（推測で埋めない）。
 */
function requestLines(offer, applicantName) {
  const t = offerTypeOf(offer?.offer_type);
  const terms = offer?.offer_terms || {};
  const term = (k) => terms[k];
  const pay = [offer.wage_type && !t?.pay?.fixed ? offer.wage_type : null, yen(offer.wage_amount)].filter(Boolean).join(" ") || null;
  if (EMPLOYMENT.includes(t?.key)) {
    // 有期なのに終了日が無ければ、終了日を【要確認】にする（「期間の定めあり」だけで確定扱いにしない）
    const fixedTerm = term("contractPeriod") === "期間の定めあり";
    const period = fixedTerm
      ? `期間の定めあり（${offer.contract_end_date ? `${fmtDate(offer.contract_end_date)}まで` : `終了日${MISSING}`}）`
      : term("contractPeriod") || null;
    const periodMissing = !term("contractPeriod") || (fixedTerm && !offer.contract_end_date);
    return [
      { label: "氏名", value: applicantName || null },
      { label: "雇用区分", value: joinParts([t.label, offer.employment_type && offer.employment_type !== t.employmentType ? offer.employment_type : null]) },
      { label: "入社予定日", value: fmtDate(offer.join_date) },
      { label: "雇用期間", value: period, forceMissing: periodMissing },
      { label: "勤務場所", value: joinParts([offer.work_location, term("workplaceType"), term("workStyle") ? `働き方：${term("workStyle")}` : null,
        term("workLocationChange") ? `変更の範囲：${term("workLocationChange")}` : null]) },
      { label: "業務内容", value: joinParts([offer.job_title, term("duties"), term("dutiesChange") ? `変更の範囲：${term("dutiesChange")}` : null]) },
      { label: "勤務曜日・勤務時間", value: joinParts([term("workDays"), term("workHours"), offer.weekly_hours ? `週${offer.weekly_hours}時間` : null,
        term("overtime") ? `時間外労働：${term("overtime")}` : null]) },
      { label: "休憩・休日", value: joinParts([term("breakTime") ? `休憩 ${term("breakTime")}` : null, term("holidays")]) },
      { label: "給与・報酬", salary: true, value: joinParts([pay, term("allowances") ? `手当：${term("allowances")}` : null,
        term("commuteCost") ? `交通費：${term("commuteCost")}` : null, term("incentive") ? `インセンティブ：${term("incentive")}` : null,
        term("wagePayment") ? `締日・支払日：${term("wagePayment")}` : null]) },
      { label: "試用期間", value: blank(offer.probation_months) ? null : Number(offer.probation_months) === 0 ? "なし" : `${offer.probation_months}か月` },
      { label: "その他の確認事項", optional: true, value: joinParts([term("position") ? `役職：${term("position")}` : null, term("otherTerms")]) },
    ];
  }
  if (t?.key === "contractor") {
    return [
      { label: "氏名", value: applicantName || null },
      { label: "契約区分", value: t.label },
      { label: "契約開始日", value: fmtDate(offer.join_date) },
      { label: "契約期間", value: joinParts([offer.join_date ? `${fmtDate(offer.join_date)}から` : null,
        offer.contract_end_date ? `${fmtDate(offer.contract_end_date)}まで` : null, term("renewal") ? `更新：${term("renewal")}` : null], "") },
      { label: "稼働場所", value: joinParts([offer.work_location, term("workStyle") ? `働き方：${term("workStyle")}` : null]) },
      { label: "業務内容", value: joinParts([term("duties"), term("deliverables") ? `成果物：${term("deliverables")}` : null]) },
      { label: "稼働曜日・稼働目安", value: joinParts([term("workDays"), term("workHours")]) },
      { label: "報酬", salary: true, value: joinParts([pay, term("paymentTerms") ? `支払条件：${term("paymentTerms")}` : null,
        term("expenseHandling") ? `経費：${term("expenseHandling")}` : null]) },
      { label: "中途終了・解約", value: term("terminationRule") || null },
      { label: "その他の確認事項", optional: true, value: joinParts([term("nda") ? `NDA：${term("nda")}` : null]) },
    ];
  }
  // スポット・副業
  return [
    { label: "氏名", value: applicantName || null },
    { label: "契約区分", value: t?.label || null },
    { label: "案件名", value: term("projectName") || null },
    { label: "実施日", value: fmtDate(offer.join_date) },
    { label: "業務内容", value: joinParts([term("duties"), term("successCriteria") ? `成果条件：${term("successCriteria")}` : null]) },
    { label: "稼働時間", value: term("workHours") || null },
    { label: "報酬", salary: true, value: joinParts([pay, term("paymentTerms") ? `支払条件：${term("paymentTerms")}` : null,
      term("expenseHandling") ? `経費：${term("expenseHandling")}` : null]) },
    { label: "変更・キャンセル時の扱い", value: term("cancellationPolicy") || null },
    { label: "その他の確認事項", optional: true, value: joinParts([term("nda") ? `NDA：${term("nda")}` : null, term("contactPerson") ? `担当者：${term("contactPerson")}` : null]) },
  ];
}

/**
 * 社労士（業務委託は社労士・法務）へ Slack で送る依頼文を作る。送らない（下書きだけ）。
 *   ・値は HR に登録した条件だけ。空の項目は【要確認】にして missing に入れる（架空の確定値で埋めない）
 *   ・給与を見られない人が作るときは、給与・報酬の行を伏せて【要確認】にする（missing に「給与・報酬（権限者が記入）」）
 *   ・kind="revision" は差し戻し・条件の修正のあとの再依頼（修正してほしい点を先に書く）
 * @param {{offer:object, applicantName:string, salary?:boolean, kind?:"initial"|"revision", reason?:string|null, note?:string|null, contractRoute?:string|null}} input
 * @returns {{text:string, missing:string[], docName:string, recipient:string, lines:{label:string,value:string|null,missing:boolean}[]}}
 */
export function requestText({ offer, applicantName, salary = true, kind = "initial", reason = null, note = null, contractRoute = null }) {
  const t = offerTypeOf(offer?.offer_type);
  const docName = requestDocNameOf(t?.key);
  const recipient = attorneyLabelOf(t?.key);
  const lines = requestLines(offer, applicantName).map((l) => {
    if (l.salary && !salary) return { label: l.label, value: null, missing: true, hidden: true };
    if (l.label === "その他の確認事項") {
      const v = joinParts([l.value, note], " ／ ");
      return { label: l.label, value: v || "特になし", missing: false };
    }
    if (l.forceMissing && !blank(l.value)) return { label: l.label, value: l.value, missing: true, keep: true };
    return { label: l.label, value: l.value, missing: blank(l.value) && !l.optional };
  });
  const missing = lines.filter((l) => l.missing).map((l) => (l.hidden ? `${l.label}（権限者が記入）` : l.label));
  const valueOf = (l) => (l.hidden ? `${MISSING}（給与・報酬は、権限のある担当者が記入してください）` : (l.missing && !l.keep ? MISSING : l.value));
  const routeText = contractRoute === "other" ? "契約手続き（紙・対面など）" : "LegalSignによる契約手続き";
  const docShort = EMPLOYMENT.includes(t?.key) ? "通知書" : "契約書";
  const head = kind === "revision"
    ? [`先日ご依頼した${applicantName || ""}様の${docName}について、修正をお願いいたします。`,
      ...(blank(reason) ? [] : ["", `【修正をお願いしたい点】`, oneLine(reason)]),
      "", "現在の条件は下記のとおりです。"]
    : [`下記の方の${docName}の作成をお願いいたします。`];
  const text = [
    "お世話になっております。",
    "",
    ...head,
    "",
    "【対象者】",
    ...lines.map((l) => `- ${l.label}：${valueOf(l)}`),
    "",
    `上記内容をご確認いただき、必要事項を反映した${docShort}をPDFで作成いただけますでしょうか。`,
    "不足事項や確認が必要な点がございましたらお知らせください。",
    `完成したPDFは弊社で確認し、本人への同意案内と${routeText}を進めます。`,
    "",
    "どうぞよろしくお願いいたします。",
  ].join("\n");
  return { text, missing, docName, recipient, lines: lines.map(({ label, value, missing: m, hidden }) => ({ label, value: hidden ? null : value, missing: m })) };
}

// ---- 入力の確かめ ------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max) => {
  const s = String(v ?? "").replace(/\r\n/g, "\n").trim();
  return s ? s.slice(0, max) : null;
};
/** 依頼済みの記録の入力（メモは任意・1000字まで） */
export function normalizeRequestInput(body) {
  const kind = body?.kind === "revision" ? "revision" : "initial";
  const note = clean(body?.note, 1000);
  const missing = Array.isArray(body?.missingLabels)
    ? body.missingLabels.map((x) => clean(x, 60)).filter(Boolean).slice(0, 40) : [];
  return { kind, note, missing };
}

/** 正式PDFの受け取りの入力（書類の種類・書類名・受領日・作成者） */
export function normalizeOfficialInput(body, typeKey, today) {
  const kinds = docKindsOf(typeKey).map((k) => k.key);
  const docKind = kinds.includes(body?.docKind) ? body.docKind : null;
  if (!docKind) return { error: "invalid_body", hint: `書類の種類は ${docKindsOf(typeKey).map((k) => k.label).join("／")} から選んでください` };
  const title = clean(body?.title, 100) || docKindLabel(docKind);
  const receivedOn = String(body?.receivedOn || "").trim();
  if (!DATE_RE.test(receivedOn)) return { error: "invalid_body", hint: "受領日を入れてください" };
  if (today && receivedOn > today) return { error: "invalid_body", hint: "受領日に未来の日付は入れられません" };
  const authorName = clean(body?.authorName, 100);
  const fileName = clean(String(body?.fileName || "").split(/[\\/]/).pop(), 200);
  return { value: { docKind, title, receivedOn, authorName, fileName } };
}

/** 照合の結果（全部に✓が無ければ承認しない） */
export function normalizeChecks(body, typeKey) {
  const items = reviewChecksOf(typeKey);
  const src = body?.checks && typeof body.checks === "object" ? body.checks : {};
  const checks = Object.fromEntries(items.map((c) => [c.key, src[c.key] === true]));
  const missing = items.filter((c) => !checks[c.key]).map((c) => c.label);
  return { checks, missing };
}

/** 締結の証跡（何を確かめたか。必須）・LegalSign の文書ID（任意） */
export function normalizeEvidence(body) {
  const evidence = clean(body?.evidence, 1000);
  if (!evidence) return { error: "invalid_body", hint: "何を確かめて締結済みにしたか（締結完了の通知・締結済みPDF など）を入れてください" };
  const contractRef = clean(body?.contractRef, 200);
  if (body?.sameDoc !== true) return { error: "invalid_body", hint: "締結した書類が、本人へ案内した正式PDFと同じ版であることを確かめてください" };
  return { value: { evidence, contractRef } };
}

/** PDF の中身か（先頭が %PDF-） */
export const isPdfBytes = (bytes) => Boolean(bytes) && bytes.length >= 5
  && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;

// ---- 進み具合（7つのステップ・いまの状態・次の担当・主ボタン） --------------------------

export const CONTRACT_STEPS = [
  { key: "conditions", label: "条件を整理" },
  { key: "request", label: "社労士に作成依頼" },
  { key: "receive", label: "正式PDFを受領" },
  { key: "guide", label: "本人へ案内" },
  { key: "consent", label: "本人が条件に同意" },
  { key: "formal", label: "LegalSign正式契約" },
  { key: "handoff", label: "Officeへ引き渡し" },
];

/** いまの状態の言い方（要件 §3 の最小ステータス） */
export const CONTRACT_STATUS_LABEL = {
  conditions: "条件作成中",
  request_pending: "社労士へ依頼待ち",
  requested: "社労士へ依頼済み",
  review_pending: "書類受領・確認待ち",
  returned: "差し戻し（再依頼待ち）",
  guide_prep: "本人への案内準備中",
  approved: "正式版確認済み",
  guided: "本人へ案内済み",
  expired: "回答期限切れ",
  consented: "条件同意済み",
  formal_waiting: "正式契約待ち",
  signed_before_consent: "正式契約済み（条件同意待ち）",
  signed: "正式契約済み",
  handed_off: "Office引き渡し済み",
  declined: "辞退",
};

const PRE_SEND = ["offer_review_pending", "offer_send_pending", "offer_resend_pending"];

/**
 * 契約手続きの状態のかぎ（一覧・NEXT ACTION・カードで同じ判定）。正式PDFの流れでない版は null。
 * @param {{offer:object|null, status:string, docs?:object[], requests?:object[], now?:number}} input
 *   offer    … いま有効な版（gw_hr_offers の行）
 *   status   … 応募者の状態（gw_hr_applicants.status）
 *   docs     … その版の正式PDFの受領記録（gw_hr_offer_official_docs）
 *   requests … その版の依頼の記録（gw_hr_attorney_requests）
 */
export function contractStateOf({ offer, status, docs = [], requests = [], now = Date.now() }) {
  if (!offer || !usesOfficial(offer)) return null;
  const formal = formalRequiredOf(offer) !== false;
  if (offer.handoff_at) return "handed_off";
  if (offer.declined_at || status === "declined") return "declined";
  if (offer.accepted_at) {
    if (!formal || offer.formal_signed_at) return formal ? "signed" : "consented";
    return "formal_waiting";
  }
  if (offer.sent_at && offer.official_doc_id) {
    if (offer.formal_signed_at) return "signed_before_consent";
    if (offer.expires_at && new Date(offer.expires_at).getTime() < now) return "expired";
    return "guided";
  }
  if (status === "offer_review_pending" || !PRE_SEND.includes(status)) return "conditions";
  const approved = docs.find((d) => d.status === "approved");
  if (approved) {
    const legalReady = !formal || offer.contract_route === "other"
      || (offer.legalsign_url && offer.legalsign_doc_sha256 && offer.legalsign_doc_sha256 === approved.file_sha256);
    return legalReady ? "approved" : "guide_prep";
  }
  const lastRequest = [...requests].sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))[0] || null;
  const pending = docs.filter((d) => d.status === "received");
  if (pending.length) return "review_pending";
  const lastReturn = docs.filter((d) => d.status === "returned")
    .sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)))[0] || null;
  if (lastReturn && (!lastRequest || String(lastRequest.requested_at) < String(lastReturn.reviewed_at))) return "returned";
  if (lastRequest) return "requested";
  return "request_pending";
}

/** 次の担当（画面の「次の担当」） */
export const CONTRACT_OWNER = {
  conditions: "人事", request_pending: "人事", requested: "社労士", review_pending: "人事（照合・承認）",
  returned: "人事", guide_prep: "人事", approved: "人事", guided: "本人", expired: "人事",
  consented: "人事", formal_waiting: "本人（LegalSign）・人事（締結の確認）", signed_before_consent: "本人",
  signed: "人事", handed_off: "Office", declined: "—",
};

const shortSha = (sha) => (sha ? String(sha).slice(0, 12) : null);

/**
 * 版の照合（承認した正式版 ＝ 本人に案内した版 ＝ 本人が同意した版 ＝ LegalSign に登録した版 ＝ 締結を確かめた版）。
 * 記録の無い行は match=null（まだ）。1つでも食い違えば ok=false（Office へ引き渡せない）
 */
export function reconcileOf(offer, approvedDoc) {
  const base = approvedDoc?.file_sha256 || (offer?.official_doc_id ? offer.notice_pdf_sha256 : null) || null;
  const row = (key, label, sha) => ({ key, label, sha: sha || null, short: shortSha(sha), match: sha ? sha === base : null });
  const rows = [
    row("approved", "承認した正式版", base),
    row("guided", "本人へ案内した版", offer?.official_doc_id ? offer.notice_pdf_sha256 : null),
    row("consent", "本人が同意した版", offer?.accepted_at && offer?.official_doc_id ? offer.notice_pdf_sha256 : null),
    row("legalsign", "LegalSign に登録した版", offer?.legalsign_doc_sha256 || null),
    row("signed", "締結を確かめた版", offer?.formal_doc_sha256 || null),
  ];
  return { base, rows, ok: rows.every((r) => r.match !== false) };
}

/**
 * Office へ引き渡せるか（正式PDFの版）。理由の文を返す（空なら引き渡せる）
 */
export function handoffBlockers(offer, approvedDoc) {
  const out = [];
  if (!offer?.official_doc_id) out.push("正式PDFを本人へ案内していません");
  if (!offer?.accepted_at) out.push("本人が条件に同意していません");
  if (formalRequiredOf(offer) !== false && !offer?.formal_signed_at) out.push("正式契約（LegalSign）の締結を記録していません");
  const rec = reconcileOf(offer, approvedDoc);
  if (!rec.ok) out.push(`版が食い違っています（${rec.rows.filter((r) => r.match === false).map((r) => r.label).join("・")}）`);
  return out;
}

/**
 * 契約手続きのカードに出す内容（7つのステップ・いまの状態・次の担当・主ボタン1つ・照合）。
 * @param {object} input
 *   offer, status, docs, requests … contractStateOf と同じ
 *   perms { review:boolean, handoff:boolean, signed:boolean, salary:boolean } … 照合・承認、引き渡し、締結の記録、給与が見えるか
 */
export function procedureOf({ offer, status, docs = [], requests = [], perms = {}, now = Date.now() }) {
  const state = contractStateOf({ offer, status, docs, requests, now });
  if (!state) return null;
  const t = offerTypeOf(offer.offer_type);
  const formal = formalRequiredOf(offer) !== false;
  const approved = docs.find((d) => d.status === "approved") || null;
  const sentDoc = offer.official_doc_id ? (docs.find((d) => d.id === offer.official_doc_id) || null) : null;
  const lastRequest = [...requests].sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))[0] || null;
  const reviewDone = Boolean(approved || sentDoc);
  const sent = Boolean(offer.sent_at && offer.official_doc_id);

  const st = (key) => {
    switch (key) {
      case "conditions": return state === "conditions" ? "now" : "done";
      case "request": return state === "conditions" ? "todo"
        : ["request_pending", "returned"].includes(state) ? "now" : "done";
      case "receive": return reviewDone || sent ? "done" : ["requested", "review_pending"].includes(state) ? "now" : "todo";
      case "guide": return sent ? "done" : ["guide_prep", "approved"].includes(state) ? "now" : "todo";
      case "consent": return offer.accepted_at ? "done" : state === "declined" ? "ended" : sent ? "wait" : "todo";
      case "formal": return !formal ? "skip" : offer.formal_signed_at ? "done"
        : state === "formal_waiting" ? "now" : sent ? "wait" : "todo";
      case "handoff": return offer.handoff_at ? "done" : ["consented", "signed"].includes(state) ? "now" : "todo";
      default: return "todo";
    }
  };
  const at = {
    request: lastRequest?.requested_at || null,
    receive: (approved || sentDoc)?.reviewed_at || null,
    guide: sent ? offer.sent_at : null,
    consent: offer.accepted_at || null,
    formal: offer.formal_signed_at || null,
    handoff: offer.handoff_at || null,
  };
  const note = {
    request: state === "returned" ? "差し戻し：修正の依頼を送ってください" : null,
    receive: state === "review_pending" ? "確認待ちのPDFがあります" : (approved || sentDoc) ? `第${(approved || sentDoc).revision}版を承認` : null,
    guide: state === "guide_prep" ? "LegalSign への登録（または例外ルートの選択）が先です" : null,
    formal: !formal ? "このオファーは正式契約なし" : offer.contract_route === "other" ? "例外ルート（紙・対面など）" : null,
  };
  const steps = CONTRACT_STEPS.map((s) => ({ ...s, label: s.key === "request" ? `${attorneyLabelOf(t?.key)}に作成依頼` : s.label,
    state: st(s.key), at: at[s.key] || null, note: note[s.key] || null }));

  // 主ボタン（1つ）。押せない人には理由（disabledReason）を出す
  let primary = null;
  const need = (ok, reason) => (ok ? null : reason);
  switch (state) {
    case "conditions": primary = { action: "editConditions", label: "条件を確認して確定する" }; break;
    case "request_pending": primary = { action: "request", label: `${attorneyLabelOf(t?.key)}への依頼文を作成` }; break;
    case "returned": primary = { action: "request", kind: "revision", label: "修正の依頼文を作成" }; break;
    case "requested": primary = { action: "upload", label: `${attorneyLabelOf(t?.key)}作成のPDFをアップロード` }; break;
    case "review_pending": primary = { action: "review", label: "PDFと条件を照合して承認",
      disabledReason: need(perms.review, "照合と承認は、給与を見られる人事・管理者が行います") }; break;
    case "guide_prep": primary = { action: "legalsign", label: "LegalSign の登録を記録する" }; break;
    case "approved": primary = { action: "guide", label: "内容を確認して本人へ案内" }; break;
    case "formal_waiting": primary = { action: "signed", label: offer.contract_route === "other" ? "締結を確かめて記録する" : "LegalSign の締結を確かめて記録",
      disabledReason: need(perms.signed, "締結の記録は、社長・管理者・人事が行います") }; break;
    case "consented":
    case "signed": primary = { action: "handoff", label: "Officeへ引き渡す",
      disabledReason: need(perms.handoff, "Office への引き渡しは、社長・管理者・人事が行います") }; break;
    default: primary = null;
  }
  // 補助の操作（主ボタンとは別。押せる段階だけ）
  const secondary = [];
  if (["request_pending", "requested", "review_pending", "returned"].includes(state)) secondary.push({ action: "reopen", label: "条件を直す" });
  if (["requested", "review_pending"].includes(state)) secondary.push({ action: "request", kind: lastRequest ? "revision" : "initial", label: "依頼文をもう一度作る" });
  if (state === "review_pending") secondary.push({ action: "upload", label: "別のPDFをアップロード" });
  if (["approved", "guide_prep"].includes(state) && formal) secondary.push({ action: "legalsign", label: state === "approved" ? "LegalSign の登録を見直す" : "例外ルートにする" });
  if (["guided", "signed_before_consent"].includes(state) && formal && !offer.formal_signed_at && (offer.legalsign_url || offer.contract_route === "other")) {
    secondary.push({ action: "signed", label: "締結を記録する", disabledReason: need(perms.signed, "締結の記録は、社長・管理者・人事が行います") });
  }
  if (["guided", "formal_waiting", "signed_before_consent"].includes(state) && formal && offer.legalsign_url && !offer.formal_sent_at && offer.contract_route !== "other") {
    secondary.push({ action: "formalMail", label: "LegalSign の案内メールを送る" });
  }

  const reconcile = reconcileOf(offer, approved || sentDoc);
  return {
    state, statusLabel: CONTRACT_STATUS_LABEL[state], owner: CONTRACT_OWNER[state],
    route: "official", typeKey: t?.key || null, typeLabel: t?.label || null, employmentType: offer.employment_type || null,
    attorneyLabel: attorneyLabelOf(t?.key), requestDocName: requestDocNameOf(t?.key),
    formalRequired: formal, contractRoute: offer.contract_route || null,
    legalsign: { registered: Boolean(offer.legalsign_url), docSha: offer.legalsign_doc_sha256 || null,
      matchesApproved: Boolean(offer.legalsign_doc_sha256 && (approved || sentDoc) && offer.legalsign_doc_sha256 === (approved || sentDoc).file_sha256) },
    steps, primary, secondary, reconcile,
    handoffBlockers: offer.accepted_at ? handoffBlockers(offer, approved || sentDoc) : [],
    // 依頼の前に埋めておきたい項目（確認推奨。給与は見られる人にだけ）
    recommended: documentWarnings(offer.offer_type, offer, { salary: perms.salary !== false }),
  };
}

/** 条件の要約（カードの［採用条件の詳細を見る］。給与は見られる人だけ） */
export const conditionItemsOf = (offer, { salary = true } = {}) => publicOfferItems(offer).filter((it) => salary || !it.salary);

// ---- 応募者の一覧・NEXT ACTION（応募者の行に API が contract_state を載せる） -------------------------

/** 応募者の行に載せた契約手続きの状態（正式PDFの流れでなければ null） */
export const contractStateOfApplicant = (a) => a?.contract_state ?? a?.contractState ?? null;

// 一覧の「状態」を契約手続きの言い方にする状態（それ以外は、これまでの言い方＝承諾待ち・正式契約済み・引き渡し済み など）
const LIST_LABEL_STATES = ["conditions", "request_pending", "requested", "review_pending", "returned", "guide_prep", "approved",
  "formal_waiting", "signed_before_consent"];
export const contractListLabel = (state) => (LIST_LABEL_STATES.includes(state) ? CONTRACT_STATUS_LABEL[state] : null);

// NEXT ACTION（ドロワーの上）。主導線は書類タブの「契約手続き」カードなので、ボタンはそこを開く
const NEXT = {
  conditions: "条件を確認して確定してください（確定したら社労士へ依頼します）",
  request_pending: "社労士への依頼文を作って Slack で送り、「依頼済みにする」を押してください",
  requested: "社労士の書類を待っています。届いたPDFをアップロードしてください",
  review_pending: "受け取ったPDFを、HR の条件と照合して承認してください",
  returned: "差し戻した点を社労士へ伝え、修正を依頼してください",
  guide_prep: "LegalSign に承認した正式PDFを登録して記録してください（または例外ルート）",
  approved: "正式版を確認済みです。内容を確認して本人へ案内してください",
  formal_waiting: "正式契約待ち：LegalSign の締結を確かめて記録してください",
};
/** 契約手続きの NEXT ACTION。null なら、これまでの判定を使う（本人の回答待ち・引き渡し など） */
export function contractNextAction(state) {
  if (!NEXT[state]) return null;
  return { label: `${CONTRACT_STATUS_LABEL[state]}：${NEXT[state]}`, cta: "契約手続きを開く", action: "openContract" };
}
