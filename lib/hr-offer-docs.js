// 採用HR：条件通知書PDF・電子承諾記録・LegalSign の URL（db/132。応募者ドロワー・条件通知書PDF・電子承諾・LegalSign 連携 仕様）。
//
// ■ 新しい PDF の仕組みは作らない
//   条件通知書は lib/pdf-jp.js の renderContractPdf（契約書と同じ組み方）、承諾済みPDFは appendSignaturePage
//   （kind: "acceptance"＝「電子承諾記録」のページ。正式な電子署名とは呼ばない）を使う。
//
// ■ 送った時点の版から作る・あとで変えない
//   条件通知書は、内容が確定した版（gw_hr_offers の1行。送ったあとは直せない）から作り、
//   Storage（private バケット hr）に置いて、パスと SHA-256 を gw_hr_offers に一度だけ書く（db/132 の trigger が書き換えを止める）。
//   同時に2回作られても取り違えないよう、ファイル名には毎回ちがう印を付ける（先に書けた方を正とし、もう片方は消す）。
//
// ■ 本人の承諾は「条件の承諾」。正式な契約は LegalSign（この PDF には、そう書く）
//
// ■ LegalSign の URL
//   https:// だけ。javascript: data: http: 空白・改行・ID とパスワード入りは断る。特定のドメインはコードに書かない。
//   LEGALSIGN_ALLOWED_HOSTS（"sign.example.jp,*.example.jp" のようにカンマ区切り）があれば、そのホストだけにする。
//   URL は gw_hr_offers.legalsign_url にだけ持つ。監査ログ・タイムライン・console には書かない（呼ぶ側）。

import crypto from "node:crypto";
import { renderContractPdf, appendSignaturePage, sha256 } from "./pdf-jp.js";
import { offerTypeOf, publicOfferItems, AGREEMENT, afterAcceptText } from "./hr-offer-types.js";
import { date as jstDate, dateTime as jstDateTime } from "./jst.js";
import { admin } from "./supabase.js";

export const OFFER_DOC_BUCKET = "hr";

/** db/132 の列があるか（PostgREST は select("*") で列を全部返すので、行にキーがあるかで分かる） */
export const offerDocsReady = (offer) => Boolean(offer) && Object.prototype.hasOwnProperty.call(offer, "notice_pdf_path");

/** 条件通知書の書類名（区分ごと。§25）。区分の無い、これまでの合格通知は作らない（null） */
export const noticeTitleOf = (offer) => offerTypeOf(offer?.offer_type)?.noticeTitle || null;

const rand = () => crypto.randomBytes(6).toString("hex");
/** Storage のパス（応募書類と同じく先頭はテナント）。応募者・版ごとに分け、毎回ちがう印を付ける（上書きしない） */
export const noticePathOf = (offer) =>
  `${offer.tenant_id}/offers/${offer.applicant_id}/${offer.id}/notice-v${offer.version}-${rand()}.pdf`;
export const acceptedPathOf = (offer) =>
  `${offer.tenant_id}/offers/${offer.applicant_id}/${offer.id}/accepted-v${offer.version}-${rand()}.pdf`;

/** ダウンロードの名前（日本語のまま。Content-Disposition は filename* で渡す） */
export const pdfFileName = (title, version, accepted = false) =>
  `${title || "条件通知書"}_第${version || 1}版${accepted ? "_承諾済み" : ""}.pdf`;
export const contentDisposition = (name) =>
  `attachment; filename="offer.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`;

const fmtJa = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : null;
};

/**
 * 条件通知書の本文（PDF に入れる文章）。本人に見せる条件の行（publicOfferItems）をそのまま使う。
 * 社内用の項目・社内の状態・評価は入らない。
 */
export function noticeBody(offer, { candidateName, company }) {
  const t = offerTypeOf(offer.offer_type);
  const c = company || "当社";
  const items = publicOfferItems(offer);
  const lines = [
    `${candidateName || ""} 様`,
    "",
    `${c}は、次の条件をご案内します。内容をご確認のうえ、専用ページから承諾してください。`,
    "",
    "■ 条件",
    ...items.map((it) => `${it.label}：${it.value}`),
    "",
    "■ 回答期限",
    fmtJa(offer.respond_by) || "—",
  ];
  if (offer.message_to_candidate) lines.push("", "■ 採用担当からのメッセージ", String(offer.message_to_candidate));
  lines.push(
    "",
    "■ ご注意",
    `本書は${t ? `「${t.noticeTitle}」` : "条件の通知"}です。承諾は、専用ページの「${AGREEMENT.button}」で行います。`,
    // 正式契約（LegalSign）が要るオファーだけ「別途締結」と書く。要らなければ、区分ごとの次の手続き（db/133 の要否）
    afterAcceptText(offer),
  );
  return lines.join("\n");
}

/**
 * 条件通知書PDF（renderContractPdf）。
 * @returns {Promise<{bytes:Uint8Array, sha256:string, title:string}>}
 */
export async function buildNoticePdf(offer, { candidateName, company, issuedOn }) {
  const title = noticeTitleOf(offer) || "条件通知書";
  const bytes = await renderContractPdf({
    title, body: noticeBody(offer, { candidateName, company }), docId: offer.id, company: company || "",
    issuedOn: issuedOn || jstDate(new Date()), employeeName: candidateName ? `${candidateName} 様` : "", version: offer.version,
  });
  return { bytes, sha256: sha256(bytes), title };
}

/**
 * 承諾済みPDF：条件通知書PDF ＋「電子承諾記録」のページ（本人氏名・承諾日時・文書ID・文書ハッシュ・メール・IP・利用環境・同意の文言）。
 * 記録の値は gw_hr_offers に残したものだけを使う（あとで作り直しても同じ内容になる）。
 * @returns {Promise<{bytes:Uint8Array, sha256:string}>}
 */
export async function buildAcceptedPdf(noticeBytes, offer) {
  const bytes = await appendSignaturePage(noticeBytes, {
    kind: "acceptance",
    signerName: offer.accept_name || "", signerEmail: offer.accept_email || "",
    signedAt: jstDateTime(offer.accepted_at), docId: offer.id, docHash: offer.notice_pdf_sha256 || sha256(noticeBytes),
    title: offer.notice_title || noticeTitleOf(offer) || "条件通知書",
    agreedText: offer.accept_text || "", ip: offer.accept_ip || "", userAgent: offer.accept_ua || "",
  });
  return { bytes, sha256: sha256(bytes) };
}

// ---- LegalSign の URL ----------------------------------------------------------

/** "a.example.jp, *.example.jp" → 照合用の一覧（空なら制限しない） */
export function allowedHosts(env = process.env) {
  return String(env.LEGALSIGN_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}
const hostAllowed = (host, list) => !list.length || list.some((p) => (p.startsWith("*.")
  ? host.endsWith(p.slice(1)) && host.length > p.length - 1
  : host === p));

/**
 * LegalSign の URL を確かめる。問題が無ければ { url }（前後の空白を除いたもの）、あれば { error }。
 * https:// だけ。javascript: data: http: など、ほかのスキームは断る。
 */
export function checkLegalSignUrl(input, env = process.env) {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "LegalSign の URL を入力してください" };
  if (raw.length > 2000) return { error: "URL が長すぎます" };
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return { error: "URL に空白や改行は使えません" };
  let u;
  try { u = new URL(raw); } catch { return { error: "URL の形が正しくありません" }; }
  if (u.protocol !== "https:" || !/^https:\/\//i.test(raw)) return { error: "https:// で始まる URL だけ登録できます" };
  if (u.username || u.password) return { error: "ID・パスワード入りの URL は登録できません" };
  if (!u.hostname || !u.hostname.includes(".")) return { error: "URL の形が正しくありません" };
  if (!hostAllowed(u.hostname.toLowerCase(), allowedHosts(env))) return { error: "この URL のドメインは登録できません（LEGALSIGN_ALLOWED_HOSTS）" };
  // スキームとホストは小文字にそろえた形で持つ（DB の制約も https:// を見る）
  return { url: u.href };
}

// ---- Storage（private バケット hr）と、一度だけ書く記録 ----------------------------------

const bucket = () => admin().storage.from(OFFER_DOC_BUCKET);

/** PDF を読む（Uint8Array） */
export async function readPdf(path) {
  const { data, error } = await bucket().download(path);
  if (error || !data) throw error || new Error("pdf_not_found");
  return new Uint8Array(await data.arrayBuffer());
}
async function putPdf(path, bytes) {
  const { error } = await bucket().upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (error) throw error;
}
async function dropPdf(path) {
  try { await bucket().remove([path]); } catch { /* 残っても読まれない（記録に無いパス） */ }
}

/**
 * この版の条件通知書PDFを用意する（無ければ作って置き、パス・SHA-256・書類名を一度だけ書く）。
 * 区分の無い版・db/132 が未適用の環境では null（これまでどおり PDF なしで動く）。
 * @param {object} sb gw_hr_offers を更新できるクライアント
 * @param {object} offer gw_hr_offers の行（給与は呼ぶ側で attachPay 済み。本人に届く書面なので給与も入れる）
 * @returns {Promise<{title:string, path:string, sha256:string, bytes:Uint8Array}|null>}
 */
export async function ensureNoticePdf(sb, offer, { candidateName, company }) {
  if (!offerDocsReady(offer) || !noticeTitleOf(offer)) return null;
  if (offer.notice_pdf_path) {
    return { title: offer.notice_title, path: offer.notice_pdf_path, sha256: offer.notice_pdf_sha256, bytes: await readPdf(offer.notice_pdf_path) };
  }
  const built = await buildNoticePdf(offer, { candidateName, company });
  const path = noticePathOf(offer);
  await putPdf(path, built.bytes);
  const { data: set, error } = await sb.from("gw_hr_offers")
    .update({ notice_title: built.title, notice_pdf_path: path, notice_pdf_sha256: built.sha256 })
    .eq("id", offer.id).eq("tenant_id", offer.tenant_id).is("notice_pdf_path", null)
    .select("id, notice_title, notice_pdf_path, notice_pdf_sha256").maybeSingle();
  if (error || !set) {
    // 同時に作られた（先に書かれた方を正とする）。こちらのファイルは消して、書かれた方を読む
    await dropPdf(path);
    const { data: now } = await sb.from("gw_hr_offers").select("notice_title, notice_pdf_path, notice_pdf_sha256")
      .eq("id", offer.id).eq("tenant_id", offer.tenant_id).maybeSingle();
    if (!now?.notice_pdf_path) throw error || new Error("notice_not_saved");
    Object.assign(offer, now);
    return { title: now.notice_title, path: now.notice_pdf_path, sha256: now.notice_pdf_sha256, bytes: await readPdf(now.notice_pdf_path) };
  }
  Object.assign(offer, set);
  return { title: built.title, path, sha256: built.sha256, bytes: built.bytes };
}

/**
 * 承諾済みPDF（条件通知書PDF＋電子承諾記録）を用意する。承諾していない版・条件通知書の無い版・db/132 未適用では null。
 * 記録の値は承諾のときに残したもの（accept_*）だけを使うので、あとで作っても同じ内容になる。
 * @returns {Promise<{path:string, sha256:string, bytes:Uint8Array}|null>}
 */
export async function ensureAcceptedPdf(sb, offer) {
  if (!offerDocsReady(offer) || !offer.accepted_at || !offer.notice_pdf_path) return null;
  if (offer.accepted_pdf_path) {
    return { path: offer.accepted_pdf_path, sha256: offer.accepted_pdf_sha256, bytes: await readPdf(offer.accepted_pdf_path) };
  }
  const built = await buildAcceptedPdf(await readPdf(offer.notice_pdf_path), offer);
  const path = acceptedPathOf(offer);
  await putPdf(path, built.bytes);
  const { data: set, error } = await sb.from("gw_hr_offers")
    .update({ accepted_pdf_path: path, accepted_pdf_sha256: built.sha256 })
    .eq("id", offer.id).eq("tenant_id", offer.tenant_id).is("accepted_pdf_path", null)
    .select("id, accepted_pdf_path, accepted_pdf_sha256").maybeSingle();
  if (error || !set) {
    await dropPdf(path);
    const { data: now } = await sb.from("gw_hr_offers").select("accepted_pdf_path, accepted_pdf_sha256")
      .eq("id", offer.id).eq("tenant_id", offer.tenant_id).maybeSingle();
    if (!now?.accepted_pdf_path) throw error || new Error("accepted_not_saved");
    Object.assign(offer, now);
    return { path: now.accepted_pdf_path, sha256: now.accepted_pdf_sha256, bytes: await readPdf(now.accepted_pdf_path) };
  }
  Object.assign(offer, set);
  return { path, sha256: built.sha256, bytes: built.bytes };
}

/** PDF をそのまま返す（ダウンロード。キャッシュさせない） */
export function sendPdf(res, bytes, fileName) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDisposition(fileName));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(Buffer.from(bytes));
}
