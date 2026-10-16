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

/**
 * 条件通知書に表示する会社印。
 * 既存の印影マスタを使い、通知書では角印を優先する。
 * 印影は視覚的な表示であり、本人の電子承諾・正式契約の証跡とは別。
 * 印影マスタが未設定・未適用でも通知書の発行は止めない。
 */
async function noticeSeal(offer) {
  if (!offer?.tenant_id) return null;
  try {
    const sb = admin();
    const { data, error } = await sb.from("gw_seals")
      .select("name,seal_type,image_path,image_mime,is_active,sort_order")
      .eq("tenant_id", offer.tenant_id).eq("is_active", true)
      .order("sort_order", { ascending: true }).limit(50);
    if (error) return null;
    const order = { square: 0, representative: 1, contract: 2, other: 3 };
    const selected = (data || [])
      .filter((s) => s.image_path && ["image/png", "image/jpeg"].includes(s.image_mime) && s.seal_type !== "certificate")
      .sort((a, b) => (order[a.seal_type] ?? 9) - (order[b.seal_type] ?? 9) || (a.sort_order ?? 0) - (b.sort_order ?? 0))[0];
    if (!selected) return null;
    const { data: file, error: dlError } = await sb.storage.from(OFFER_DOC_BUCKET).download(selected.image_path);
    if (dlError || !file) return null;
    return {
      name: selected.name || "会社印",
      mime: selected.image_mime,
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
  } catch {
    return null;
  }
}

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
 * 条件通知書の本文（PDF に入れる文章）。
 * 本人に見せる条件の行（publicOfferItems）を使い、社内用の状態・評価結果は出さない。
 * 育成枠では「評価結果」ではなく、評価の方法と今後の進め方だけを案内する。
 */
const noticePurpose = (t) => {
  if (!t) return "本書は、採用・参画にあたってご確認いただく条件をお知らせするための通知書です。";
  if (t.key === "training") return "本書は、育成プログラムへの参加にあたり、参加期間・報酬・評価・今後の流れなどをご確認いただくための通知書です。";
  if (t.key === "contractor") return "本書は、業務委託としてのご参画にあたり、業務内容・期間・報酬などの主な条件をご確認いただくための通知書です。";
  if (t.key === "spot") return "本書は、スポット・副業案件へのご参画にあたり、案件内容・実施条件・報酬などをご確認いただくための通知書です。";
  if (t.key === "part_time") return "本書は、パート・アルバイトとしての採用にあたり、勤務日・勤務時間・給与などの主な労働条件をご確認いただくための通知書です。";
  return "本書は、採用にあたり、入社前にご確認いただく主な労働条件をお知らせするための通知書です。";
};

const compensationNote = (t) => {
  if (t?.key === "contractor" || t?.key === "spot") {
    return "消費税、経費、請求方法、締日・支払日など、上記に記載のない事項は、必要に応じて正式契約または担当者からの案内で定めます。";
  }
  return "報酬・給与の対象範囲、締日・支払日、交通費等について上記に記載がない場合は、承諾前に担当者へご確認ください。";
};

const evaluationNote = (t) => t?.key === "training"
  ? "育成期間中は、中間評価および最終評価を行います。受講状況、課題提出、理解度、実践状況等を総合的に確認し、評価結果を踏まえて実案件への参加や次のステップを個別にご案内します。"
  : null;

/**
 * 条件通知書の本文。
 * 「項目の羅列」ではなく、本人が
 *   何の書類か / 何を確認するか / 報酬 / 回答方法 / 承諾後 / 変更・辞退 / 問い合わせ
 * を1枚で追える順番にする。送付済みの版は作り直さないので、既存PDFは変わらない。
 */
export function noticeBody(offer, { candidateName, company, issuerName, contactEmail } = {}) {
  const t = offerTypeOf(offer.offer_type);
  const c = company || "当社";
  const items = publicOfferItems(offer);
  const compensation = items.filter((it) => it.salary);
  const basics = items.filter((it) => !it.salary);
  const lines = [
    `${candidateName || ""} 様`,
    "",
    "このたびは、当社の選考・面談にお時間をいただき、ありがとうございます。",
    `${c}より、${t?.mail?.lead || "採用・参画に関する条件をご案内いたします。"}`,
    "",
    "■ 本書について",
    noticePurpose(t),
    "内容に不明点や変更希望がある場合は、承諾前に採用担当へご確認ください。",
  ];

  if (basics.length) {
    lines.push("", "■ 主な条件", ...basics.map((it) => `${it.label}：${it.value}`));
  }
  if (compensation.length) {
    lines.push("", "■ 報酬・給与", ...compensation.map((it) => `${it.label}：${it.value}`), compensationNote(t));
  }
  const evalText = evaluationNote(t);
  if (evalText) lines.push("", "■ 評価と今後の進め方", evalText);

  if (offer.message_to_candidate) {
    lines.push("", "■ 採用担当からの補足", String(offer.message_to_candidate));
  }

  lines.push(
    "",
    "■ 回答期限・承諾方法",
    `回答期限：${fmtJa(offer.respond_by) || "—"}`,
    `専用ページで本書と条件をご確認のうえ、問題がなければ「${AGREEMENT.button}」を押してください。`,
    "回答期限までのご判断が難しい場合や、条件の確認・相談が必要な場合は、期限前に採用担当へご連絡ください。",
    "",
    "■ 承諾後の流れ",
    afterAcceptText(offer),
    "承諾後に条件の変更が必要になった場合は、変更内容をあらためてご案内し、必要に応じて再確認・再承諾をお願いすることがあります。",
    "",
    "■ 変更・辞退について",
    "本書の内容について変更希望がある場合、またはご辞退を希望される場合は、承諾前に採用担当へご連絡ください。",
    "本書は条件の通知・確認を目的とするもので、正式な契約が必要な場合は別途契約手続きを行います。",
    "",
    "■ 発行元・お問い合わせ",
    `会社名：${c}`,
  );
  if (issuerName) lines.push(`担当者：${issuerName}`);
  if (contactEmail) lines.push(`メール：${contactEmail}`);
  lines.push("ご不明な点は、上記担当者または本書をご案内したメールへの返信にてお問い合わせください。");
  return lines.join("\n");
}

/**
 * 条件通知書PDF（renderContractPdf）。
 * @returns {Promise<{bytes:Uint8Array, sha256:string, title:string}>}
 */
export async function buildNoticePdf(offer, { candidateName, company, issuerName, contactEmail, issuedOn } = {}) {
  const title = noticeTitleOf(offer) || "条件通知書";
  const seal = await noticeSeal(offer);
  const bytes = await renderContractPdf({
    title, body: noticeBody(offer, { candidateName, company, issuerName, contactEmail }), docId: offer.id, company: company || "",
    issuedOn: issuedOn || jstDate(new Date()), employeeName: candidateName ? `${candidateName} 様` : "", version: offer.version,
    seal,
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
