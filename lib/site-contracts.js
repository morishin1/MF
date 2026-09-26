// SES現場契約（社員/BP → 現場契約）の、値の定義と正規化。
// db/076_site_contracts.sql と1対1。api/site-contracts/index.js から使う。

export const ENGAGEMENT_KINDS = ["pp", "bp"];
export const ENGAGEMENT_LABEL = { pp: "PP（自社プロパー）", bp: "BP（協力会社）" };

export const UNIT_PRICE_TYPES = ["月額", "時給", "日給"];

export const RENEWAL_STATUSES = ["pending", "confirmed", "ending", "renewed"];
export const RENEWAL_LABEL = {
  pending: "未確認", confirmed: "更新確認済み・継続", ending: "終了予定", renewed: "更新手続き済み",
};

const str = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };
const num = (v) => (v === "" || v == null ? null : Number(v));

/**
 * @param {object} body
 * @param {{partial?: boolean}} [opts]  partial=true は更新（PATCH）用。渡された項目だけ検証する
 */
export function normalizeSiteContract(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("engagementKind")) {
    if (!ENGAGEMENT_KINDS.includes(body.engagementKind)) {
      return { error: "invalid_body", detail: "engagementKind は pp か bp で指定してください" };
    }
    v.engagement_kind = body.engagementKind;
  }
  if (!partial || has("siteCompany")) {
    const name = str(body.siteCompany, 200);
    if (!name) return { error: "invalid_body", detail: "siteCompany（所属会社）は必須です" };
    v.site_company = name;
  }
  if (has("primeCompany")) v.prime_company = str(body.primeCompany, 200);

  if (!partial || has("periodFrom")) {
    if (!body.periodFrom) return { error: "invalid_body", detail: "periodFrom は必須です" };
    v.period_from = body.periodFrom;
  }
  if (has("periodTo")) v.period_to = body.periodTo || null;

  if (has("unitPrice")) {
    const n = num(body.unitPrice);
    if (n != null && (!Number.isFinite(n) || n < 0)) {
      return { error: "invalid_body", detail: "unitPrice は0以上の数値で指定してください" };
    }
    v.unit_price = n;
  }
  if (has("unitPriceType")) {
    if (!UNIT_PRICE_TYPES.includes(body.unitPriceType)) {
      return { error: "invalid_body", detail: `unitPriceType は ${UNIT_PRICE_TYPES.join("/")} のいずれかです` };
    }
    v.unit_price_type = body.unitPriceType;
  }
  if (has("settlementCondition")) v.settlement_condition = str(body.settlementCondition, 500);

  if (has("renewalStatus")) {
    if (!RENEWAL_STATUSES.includes(body.renewalStatus)) {
      return { error: "invalid_body", detail: `renewalStatus は ${RENEWAL_STATUSES.join("/")} のいずれかです` };
    }
    v.renewal_status = body.renewalStatus;
  }
  if (has("note")) v.note = str(body.note, 1000);

  if (v.period_to && v.period_from && v.period_to < v.period_from) {
    return { error: "invalid_body", detail: "契約終了日は開始日より後にしてください" };
  }
  return { value: v };
}
