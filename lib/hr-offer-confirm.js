// 採用HR：合格通知（内定通知書・労働条件通知書などのPDF）をメールで送る前の「送信内容の確認」。
//
// ■ 何を守るか
//   送る前に画面で、送信元・宛先（To／CC・BCC はなし）・件名・本文・実際に添付するPDFを見せ、人が確認してから送る。
//   確認したあとで宛先・件名・本文・添付PDF（の版）が1つでも変わったら、その確認は無効（もう一度確認してもらう）。
//
// ■ どうやって
//   1) サーバーが「送るもの」の要約（base）を作る：オファーID・版・宛先・送信元・返信先・添付PDFの識別子。
//      添付PDFの識別子は、保存済みならその SHA-256、まだなら作るPDFを決める入力（条件のスナップショット・宛名・会社名・
//      発行者・問い合わせ先・発行日〔日本時間の今日〕）の SHA-256。
//      base はサーバーの鍵で HMAC にしてから画面へ渡す（条件の中身＝給与を、要約から推し量れないようにする）。
//   2) 画面は、確認した件名・本文と base から confirmDigest（SHA-256）を作って送信に付ける（ブラウザの crypto.subtle）。
//   3) サーバーは送る直前に、同じ方法でいまの base と受け取った件名・本文から作り直し、違えば 409（送らない）。
//   ※ 会社印の画像は識別子に入れていない（登録し直すことはまれ。入れると画像を毎回読むことになる）
import { createHash, createHmac } from "node:crypto";

export const CONFIRM_VERSION = "hr-offer-send-v1";
export const CONFIRM_DIGEST_RE = /^[0-9a-f]{64}$/;

/** キーを並べ替えた JSON（同じ中身なら同じ文字列） */
export function canonicalJson(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// 送るたび・読むたびに変わるだけで、PDFの中身を決めない列（時刻・URLの鍵・保存先・承諾や署名の記録）
const VOLATILE = new Set([
  "token_hash", "created_by", "handoff_by", "formal_sent_by", "formal_signed_by",
  "offer_pdf_path", "offer_pdf_sha256", "notice_pdf_path", "notice_pdf_sha256",
  "official_doc_id", "legalsign_url", "legalsign_doc_id", "legalsign_doc_sha256",
  "formal_evidence", "formal_contract_ref", "formal_doc_sha256", "doc_route", "contract_route",
]);
const isVolatile = (k) => VOLATILE.has(k) || /_at$/.test(k) || /^accept(ed)?_/.test(k);

/** PDFの中身を決める、合格通知の行のスナップショット（給与を足した行を渡す） */
export function offerSnapshot(offer) {
  const out = {};
  for (const k of Object.keys(offer || {}).sort()) if (!isVolatile(k)) out[k] = offer[k];
  return out;
}

/** まだ作っていないPDFの識別子：作るPDFを決める入力の SHA-256 */
export function generatedIdentity(kind, offer, meta) {
  return `gen:${sha256Hex(canonicalJson({ kind, offer: offerSnapshot(offer), meta }))}`;
}

/** base を画面へ出せる形（鍵つき HMAC）にする。鍵が無い環境（テストなど）は SHA-256 */
export function sealBase(parts, key = process.env.HR_OFFER_CONFIRM_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "") {
  const text = canonicalJson({ v: CONFIRM_VERSION, ...parts });
  return key ? createHmac("sha256", key).update(text, "utf8").digest("hex") : sha256Hex(text);
}

/** 画面と同じ作り方の confirmDigest（件名は前後の空白を除く・本文の改行は \n にそろえる） */
export function confirmDigestOf(base, subject, body) {
  return sha256Hex(JSON.stringify([CONFIRM_VERSION, String(base || ""), String(subject ?? "").trim(), String(body ?? "").replace(/\r\n/g, "\n")]));
}
