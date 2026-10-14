// 退職証明書の本人申請（db/127）。記載してほしい項目・NDA等の誓約・承認して発行。
//
// ■ 流れ
//   本人（退職手続き中・退職者）が、記載してほしい項目を選び、誓約にチェックして申請する（status = requested）。
//   人事が入退社の画面（チェックリストの「退職証明書の交付」）で中身を確かめ、
//   経営者・管理者が「承認して発行」→ 選んだ項目だけを印字した証明書を発行・押印し、本人に公開する（status = issued）。
//   チェックリストの「退職証明書の交付」は、そのとき完了（日時・対応者）になる。
//
// ■ 労働基準法22条
//   退職証明書は、本人が請求した事項だけを記入する（請求しない事項を記入してはならない）。
//   だから発行の本文は、申請の items から組み立てる（雛形の固定の項目は使わない）。
//
// ■ 誓約の証跡
//   本人に見せた文面そのもの・版・同意した日時・接続元・ブラウザを残す。あとで文面を変えても、残した行は変わらない。

import { dateJa } from "./retire-cert.js";

/** 記載してほしい項目（労働基準法22条の5つ）。並びは証明書の並び */
export const CERT_ITEMS = [
  { key: "period",   label: "在籍期間（使用期間）",            print: "使用期間" },
  { key: "job",      label: "業務の種類",                       print: "業務の種類" },
  { key: "position", label: "役職（その事業における地位）",     print: "その事業における地位" },
  { key: "wage",     label: "賃金",                             print: "賃金" },
  { key: "cause",    label: "退職事由（解雇の場合はその理由を含む）", print: "退職の事由" },
];
export const CERT_ITEM_KEYS = CERT_ITEMS.map((i) => i.key);
export const itemLabel = (k) => CERT_ITEMS.find((i) => i.key === k)?.label || k;

/** 誓約の文面と版。文面を変えたら版を上げる（残した行は、そのときの文面のまま） */
export const NDA_TEXT = "入社時に同意した秘密保持契約（NDA）および就業規則に定める退職後の義務を遵守することを誓約します";
export const NDA_VERSION = "2026-10-08";

/** 申請の入力を確かめる。items は CERT_ITEMS の並びにそろえ、重複を消す */
export function validateRequest(body) {
  const raw = Array.isArray(body?.items) ? body.items.map(String) : [];
  const items = CERT_ITEM_KEYS.filter((k) => raw.includes(k));
  if (raw.some((k) => !CERT_ITEM_KEYS.includes(k))) return { error: "invalid_item", hint: "選べない項目が含まれています" };
  if (!items.length) return { error: "no_items", hint: "証明書に記載してほしい項目を、1つ以上選んでください" };
  if (body?.ndaAgreed !== true) return { error: "nda_required", hint: "誓約にチェックしてから申請してください" };
  return { items };
}

/** 接続元（証跡）。x-forwarded-for の先頭。長さを切る */
export function clientIp(req) {
  const xf = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return (xf || req?.socket?.remoteAddress || "").slice(0, 64) || null;
}
export const userAgent = (req) => String(req?.headers?.["user-agent"] || "").slice(0, 300) || null;

/** 賃金の1行（契約の賃金の種別と金額）。金額が無ければ空 */
export function wageText(contract) {
  const amt = Number(contract?.wage_amount);
  if (!Number.isFinite(amt) || amt <= 0) return "";
  const type = String(contract?.wage_type || "").trim();
  return `${type ? `${type} ` : ""}${Math.round(amt).toLocaleString("ja-JP")}円`;
}

/**
 * 証明書に印字する値（項目ごと）。空の値は missing に入る（発行は止める）
 * @param {{employee:object, contract?:object, reasonLabel?:string}} src
 */
export function itemValues({ employee, contract, reasonLabel }) {
  const from = dateJa(employee?.joined_on), to = dateJa(employee?.left_on);
  return {
    period: from && to ? `${from}から${to}まで` : "",
    job: String(employee?.initial_role || employee?.department || "").trim(),
    position: String(employee?.position || "").trim(),
    wage: wageText(contract),
    cause: String(reasonLabel || "").trim(),
  };
}

/**
 * 発行する本文（選んだ項目だけ）。標題「退職証明書」・会社名・発行日・発行番号は PDF の側で付ける
 * @returns {{text:string, missing:string[]}} missing は値が無い項目の名前（発行できない）
 */
export function requestBody({ items, name, values }) {
  const missing = [];
  const lines = [`${name} 殿`, "", "下記の事項について、相違ないことを証明します。", ""];
  for (const it of CERT_ITEMS) {
    if (!items.includes(it.key)) continue;
    const v = values[it.key];
    if (!v) missing.push(it.label);
    lines.push(`${it.print}：${v || "（未登録）"}`);
  }
  return { text: lines.join("\n"), missing };
}

/** 画面に出す1件（本人・管理側で共通。接続元・ブラウザは管理側だけ） */
export function viewRequest(r, { admin = false } = {}) {
  if (!r) return null;
  return {
    id: r.id, status: r.status,
    items: (r.items || []).map((k) => ({ key: k, label: itemLabel(k) })),
    requestedAt: r.requested_at,
    nda: { text: r.nda_text, version: r.nda_version, agreedAt: r.nda_agreed_at, ...(admin ? { ip: r.nda_ip || null, userAgent: r.nda_user_agent || null } : {}) },
    decidedAt: r.decided_at || null, decidedByName: r.decided_by_name || null, docId: r.doc_id || null,
  };
}
export const REQ_FIELDS = "id, tenant_id, employee_id, items, status, nda_text, nda_version, nda_agreed_at, nda_ip, nda_user_agent, "
  + "requested_by, requested_at, decided_by, decided_by_name, decided_at, decision_note, doc_id, created_at, updated_at";
