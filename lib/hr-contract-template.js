// 契約書などの「Word雛形から発行する書類」の決まり。純粋な関数だけ。
//
// ■ 書類は用途ごとに別のもの
//   内定通知書・労働条件通知書・雇用契約書・業務委託契約書は、雛形も発行物も別々に管理する（混ぜない・代用しない）。
//
// ■ 差し込みは「HRに登録された採用条件」だけ
//   雛形に書ける {{項目名}} は、下の FIELDS にあるものだけ。知らない項目名が入った雛形は登録させない
//   （登録できてしまうと、発行のたびに誰かが手で埋めることになる）。
//   値が無い項目は、推測で埋めない。足りない項目として返し、発行を止める。
//   ほかの応募者の値・以前の発行物の値は使わない（その応募者・その採用条件だけから作る）。
import { inspectTemplate, fillTemplate, sha256 } from "./hr-docx.js";

/** 書類の種類（用途）。発行物も雛形も、この単位で分ける */
export const DOC_KINDS = Object.freeze({
  employment_contract: "雇用契約書",
  labor_notice: "労働条件通知書",
  offer_letter: "内定通知書",
  contractor_contract: "業務委託契約書",
});
/** 雛形を選ぶための雇用形態（採用区分 lib/hr-offer-types.js のキーに合わせる）。fixed_term_trial が最初の基準雛形 */
export const TEMPLATE_CATEGORIES = Object.freeze({
  fixed_term_trial: "有期雇用契約社員（試用期間）",
  executive_employee: "正社員・幹部候補",
  trial_2weeks: "2週間トライアル",
  part_time: "パート・アルバイト",
  contractor: "業務委託",
  spot: "スポット・副業",
});

/**
 * 雛形に書ける差し込み項目。key が {{…}} の中に書く名前。
 * required: その書類で、値が無ければ発行しない項目（雛形に出てくるものだけを確かめる）
 */
export const FIELDS = Object.freeze([
  { key: "氏名", from: "applicant.name" },
  { key: "住所", from: "applicant.address" },
  { key: "契約締結日", from: "issue.signedOn" },
  { key: "契約開始日", from: "offer.joinDate" },
  { key: "契約終了日", from: "offer.contractEndDate" },
  { key: "契約期間", from: "computed" },
  { key: "試用期間", from: "offer.probationMonths" },
  { key: "雇用形態", from: "offer.employmentType" },
  { key: "職種", from: "offer.jobTitle" },
  { key: "業務内容", from: "offer.offerTerms.duties" },
  { key: "就業場所", from: "offer.workLocation" },
  { key: "始業時刻", from: "offer.offerTerms.startTime" },
  { key: "終業時刻", from: "offer.offerTerms.endTime" },
  { key: "休憩時間", from: "offer.offerTerms.breakTime" },
  { key: "所定労働時間", from: "offer.weeklyHours" },
  { key: "休日", from: "offer.offerTerms.holidays" },
  { key: "賃金形態", from: "offer.wageType" },
  { key: "賃金額", from: "offer.wageAmount" },
  { key: "賃金締切日", from: "offer.offerTerms.payCutoff" },
  { key: "賃金支払日", from: "offer.offerTerms.payDay" },
  { key: "通勤手当", from: "offer.offerTerms.commuteCost" },
  { key: "会社名", from: "company.name" },
  { key: "会社所在地", from: "company.address" },
  { key: "代表者名", from: "company.representative" },
]);
const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

const fail = (code, detail) => { const e = new Error(code); e.code = code; if (detail) e.detail = detail; return e; };
const text = (v) => (v == null ? "" : String(v).trim());
const ymd = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(v)); return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : ""; };
const yen = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && text(v) !== "" ? `${n.toLocaleString("ja-JP")}円` : ""; };

/**
 * 雛形を登録する前の確認。受け付けられなければ理由を投げる。
 * 個人情報が残ったままの雛形を登録しないよう、差し込み項目が1つも無い雛形は受け付けない。
 */
export function validateTemplate(docx, { kind, category } = {}) {
  if (!DOC_KINDS[kind]) throw fail("template_kind_invalid");
  if (!TEMPLATE_CATEGORIES[category]) throw fail("template_category_invalid");
  const info = inspectTemplate(docx);
  const unknown = info.placeholders.filter((k) => !FIELD_KEYS.has(k));
  if (unknown.length) throw fail("template_unknown_fields", unknown);
  if (!info.placeholders.length) throw fail("template_no_fields");
  if ((kind === "employment_contract" || kind === "contractor_contract") && !info.placeholders.includes("氏名")) throw fail("template_name_required");
  return { kind, category, placeholders: info.placeholders, sha256: info.sha256, size: info.size };
}

/**
 * その応募者・その採用条件から、差し込む値を作る。無いものは作らない（空のまま返す）。
 * @param {{applicant:object, offer:object, company?:object, signedOn?:string}} src
 */
export function valuesFor({ applicant, offer, company = {}, signedOn = "" } = {}) {
  if (!applicant?.id || !offer?.id || offer.applicantId !== applicant.id) throw fail("issue_scope");   // 別の人の条件を混ぜない
  const t = offer.offerTerms || {};
  const start = ymd(offer.joinDate), end = ymd(offer.contractEndDate);
  const v = {
    氏名: text(applicant.name),
    住所: text(applicant.address),
    契約締結日: ymd(signedOn),
    契約開始日: start,
    契約終了日: end,
    契約期間: start && end ? `${start}から${end}まで` : "",
    試用期間: Number(offer.probationMonths) > 0 ? `${Number(offer.probationMonths)}か月` : "",
    雇用形態: text(offer.employmentType),
    職種: text(offer.jobTitle),
    業務内容: text(t.duties),
    就業場所: text(offer.workLocation),
    始業時刻: text(t.startTime),
    終業時刻: text(t.endTime),
    休憩時間: text(t.breakTime),
    所定労働時間: Number(offer.weeklyHours) > 0 ? `週${Number(offer.weeklyHours)}時間` : "",
    休日: text(t.holidays),
    賃金形態: text(offer.wageType),
    賃金額: yen(offer.wageAmount),
    賃金締切日: text(t.payCutoff),
    賃金支払日: text(t.payDay),
    通勤手当: text(t.commuteCost),
    会社名: text(company.name),
    会社所在地: text(company.address),
    代表者名: text(company.representative),
  };
  return v;
}

/**
 * 雛形から書類を作る。値が足りなければ作らない。
 * @returns {{ok:true, docx:Buffer, sha256:string, values:object}|{ok:false, missing:string[]}}
 *   values は「この書類に実際に差し込んだ値」だけ（発行の記録として、そのまま保存する）
 */
export function issueDocument({ template, applicant, offer, company, signedOn }) {
  if (!Buffer.isBuffer(template?.docx) || sha256(template.docx) !== template.sha256) throw fail("template_changed");   // 登録時の雛形と同じものだけを使う
  const all = valuesFor({ applicant, offer, company, signedOn });
  const r = fillTemplate(template.docx, all);
  if (!r.docx) return { ok: false, missing: r.missing };
  const values = Object.fromEntries(r.used.map((k) => [k, all[k]]));
  return { ok: true, docx: r.docx, sha256: sha256(r.docx), values };
}

/** 保存するファイル名（氏名は入れない。原本は応募者ごとの保存場所に置く） */
export const issueFilename = (kind, version, ext) => `${DOC_KINDS[kind] || "書類"}_第${version}版.${ext}`;
