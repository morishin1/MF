// GET  /api/hr/offers/public?token=…
//        … 候補者本人が、確定した合格通知（そのtokenに紐づくoffer versionだけ）を見る。
//          ログイン不要。gwContext() は使わない（README Stage 6 §16）
// POST /api/hr/offers/public { token, action, declineReason?, agreed? }
//        "accept"  … 本人が承諾する。採用区分つきのオファーは「上記の内容を確認し、同意します」に
//                    チェックした（agreed: true）ときだけ。承諾＝条件の承諾（HR では「条件承諾済み」。正式契約は LegalSign）
//        "decline" … 本人が辞退する（理由は任意）
//
// GET  /api/hr/offers/public?token=…&file=notice|accepted
//        … 条件通知書PDF・承諾済みPDF（条件通知書＋電子承諾記録）を本人が保存する（db/132）。閲覧の記録は変えない
//
// ■ 承諾した版は、回答期限を過ぎても見られる（条件・PDF・正式契約の案内を確かめられるように。回答はもうできない）
//
// ■ 同意の証跡（新しい表は作らない）
//   どの版（gw_hr_offers.version。送った後は内容を変えない）に・いつ（accepted_at）同意したかを、
//   その版の行・選考タイムライン・監査ログに残す。db/132 があれば、本人の氏名・メール・IP・利用環境・同意の文言
//   （accept_*）も同じ行に一度だけ残し、条件通知書PDF＋「電子承諾記録」のページ＝承諾済みPDFを作る（書き換えは DB が止める）
//   ログイン不要。「承諾した」だけで gw_employees は作らない（README Stage 7）。
//   本採用へ進めるのは、HRが「本採用へ進める」を押してから（次のステージ）
//
// ■ 本人には、送った時点のスナップショットだけを返す
//   gw_hr_applicants の最新値ではなく gw_hr_offers を見る。ランク・5項目評価・
//   社内メモ・推薦理由・CEO REVIEWコメント・employee_id・tenant内部IDは
//   絶対に含めない（README Stage 6 §17・§21）。理由を問わず「開けません」で
//   統一する（billing-submission/publicと同じ考え方。在職/期限切れ/無効化を
//   外の人に区別させない）。採用担当の連絡先（氏名・メール）だけは例外
//   （本人が質問で連絡できることが目的そのものなので。README Stage 7）
//
// ■ 初回閲覧の記録
//   viewed_atが空なら、この時点でviewed_atを立てる。sent_atが（HRの押し忘れで）
//   まだ空でも、実際に開けた＝届いた証拠なのでここで一緒に埋める

import { json, readJson, dbSetupHint } from "../../../lib/http.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import { sha256, TOKEN_RE, shapePublicOffer, decisionMakerEmployeeIds } from "../../../lib/hr.js";
import { attachPay } from "../../../lib/hr-pay.js";
import { offerTypeOf, AGREEMENT } from "../../../lib/hr-offer-types.js";
import { offerDocsReady, ensureAcceptedPdf, readPdf, sendPdf, pdfFileName } from "../../../lib/hr-offer-docs.js";
import { ipOf, uaOf } from "../../../lib/sign-audit.js";

// 書類の呼び方（採用区分つきなら「業務委託オファー」など。区分が無い、これまでの版は「合格通知」）
const docName = (offer) => offerTypeOf(offer?.offer_type)?.offerName || "合格通知";

const SQL = "db/081_hr_recruiting.sql";
const CANT_OPEN = { error: "invalid_token", hint: "このURLは開けません。採用担当までお問い合わせください。" };
const EXPIRED = { error: "expired", hint: "このご案内の回答期限を過ぎています。恐れ入りますが、採用担当までお問い合わせください。" };

export default async function handler(req, res) {
  if (req.method === "GET") {
    if (new URL(req.url, "http://localhost").searchParams.get("file")) return file(req, res);
    return view(req, res);
  }
  if (req.method === "POST") return respond(req, res);
  return json(res, 405, { error: "method_not_allowed" });
}

// token → { offer, applicant, tenant, recruiter } を引く。無効な理由は問わず
// CANT_OPEN / EXPIRED のどちらかに統一する（呼び出し側で使い分ける）
async function findByToken(sb, token) {
  if (!TOKEN_RE.test(token)) return { deny: CANT_OPEN };

  const { data: offer, error } = await sb.from("gw_hr_offers").select("*")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return { deny: { status: 503, body: { error: "not_ready", message: hint } } };
    return { deny: { status: 500, body: { error: "db_query_failed" } } };
  }
  if (!offer || offer.revoked_at) return { deny: CANT_OPEN };
  // 承諾した版は、期限を過ぎても見られる（回答はもうできない）
  if (!offer.accepted_at && new Date(offer.expires_at).getTime() < Date.now()) return { deny: EXPIRED, status: 410 };

  const { data: applicant } = await sb.from("gw_hr_applicants")
    .select("id, tenant_id, name, email, recruiter_id")
    .eq("id", offer.applicant_id).maybeSingle();
  if (!applicant) return { deny: CANT_OPEN };

  const [{ data: tenant }, { data: recruiter }] = await Promise.all([
    sb.from("tenants").select("name").eq("id", applicant.tenant_id).maybeSingle(),
    applicant.recruiter_id
      ? sb.from("gw_employees").select("display_name, email").eq("id", applicant.recruiter_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return { offer, applicant, tenant, recruiter };
}

async function view(req, res) {
  const token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
  const sb = admin();

  const found = await findByToken(sb, token);
  if (found.deny) return json(res, found.status || 404, found.deny);
  const { offer, applicant, tenant, recruiter } = found;

  if (!offer.viewed_at) {
    const now = new Date().toISOString();
    await sb.from("gw_hr_offers").update({ viewed_at: now, sent_at: offer.sent_at || now }).eq("id", offer.id);
    // 閲覧できた＝以後は「本人の回答を待っています」（承諾待ち）。
    // 「閲覧した」という事実そのものはoffer.viewed_at・選考タイムラインに残す。
    // すでに回答（承諾・辞退）した版なら、状態は戻さない（条件承諾済みを承諾待ちにしない）
    if (!offer.accepted_at && !offer.declined_at) {
      await sb.from("gw_hr_applicants").update({ status: "offer_response_pending", updated_at: now })
        .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    }
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_viewed",
      label: `本人が${docName(offer)}を確認`, detail: `第${offer.version}版`, created_by: null,
    });
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_viewed",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
    });
    // 採用担当へ「本人がオファーを閲覧」（HRフロー仕様 §16。版ごとに1回）
    if (applicant.recruiter_id) {
      await notify([{
        tenantId: applicant.tenant_id, employeeId: applicant.recruiter_id, kind: "hr",
        title: "本人がオファーを閲覧しました", body: `${applicant.name}（${docName(offer)}・第${offer.version}版）`,
        link: `/hr/applicants.html?id=${applicant.id}`, dedupeKey: `hr_offer_viewed:${offer.id}`,
      }]);
    }
    offer.viewed_at = now; // レスポンスにも反映する
  }

  // 本人に届く合格通知の給与。分けている設定（HR_PAY_SPLIT=1）では、専用の表から読む
  await attachPay(applicant.tenant_id, offer, "offer");
  return json(res, 200, { ...shapePublicOffer(offer, applicant, tenant, recruiter), ...docsView(offer) });
}

/** 条件通知書PDF・承諾済みPDF・正式契約（LegalSign）の案内（db/132 が無ければ出さない） */
function docsView(offer) {
  if (!offerDocsReady(offer)) return { noticePdf: false, acceptedPdf: false, formal: null };
  return {
    noticePdf: Boolean(offer.notice_pdf_path),
    acceptedPdf: Boolean(offer.accepted_at && offer.notice_pdf_path),
    // 正式契約の URL は、HR が本人へ案内したあと・正式契約済みになる前だけ見せる
    formal: offer.accepted_at ? {
      url: offer.formal_sent_at && !offer.formal_signed_at ? offer.legalsign_url : null,
      sent: Boolean(offer.formal_sent_at), signed: Boolean(offer.formal_signed_at),
    } : null,
  };
}

/** 本人が PDF を保存する（条件通知書・承諾済み）。閲覧の記録・状態は変えない */
async function file(req, res) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const kind = q.get("file");
  if (!["notice", "accepted"].includes(kind)) return json(res, 400, { error: "invalid_query" });
  const sb = admin();
  const found = await findByToken(sb, q.get("token") || "");
  if (found.deny) return json(res, found.status || 404, found.deny);
  const { offer, applicant } = found;
  if (!offerDocsReady(offer) || !offer.notice_pdf_path) return json(res, 404, { error: "no_file", hint: "PDFはありません。採用担当までお問い合わせください。" });
  try {
    if (kind === "accepted") {
      const acc = await ensureAcceptedPdf(sb, offer);
      if (!acc) return json(res, 404, { error: "no_file", hint: "承諾済みのPDFはまだありません。" });
      await gwLog({ tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_pdf_saved", target: `hr_offer:${offer.id}`, detail: { file: kind } });
      return sendPdf(res, acc.bytes, pdfFileName(offer.notice_title, offer.version, true));
    }
    const bytes = await readPdf(offer.notice_pdf_path);
    await gwLog({ tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_pdf_saved", target: `hr_offer:${offer.id}`, detail: { file: kind } });
    return sendPdf(res, bytes, pdfFileName(offer.notice_title, offer.version));
  } catch (e) {
    console.error("[hr/offers/public] pdf", e?.message || e);
    return json(res, 500, { error: "pdf_failed", hint: "PDFを用意できませんでした。時間をおいてお試しください。" });
  }
}

const DECLINE_REASON_MAX = 500;

async function respond(req, res) {
  const body = await readJson(req);
  const sb = admin();

  const found = await findByToken(sb, body?.token);
  if (found.deny) return json(res, found.status || 404, found.deny);
  const { offer, applicant } = found;

  // 本人の対応（承諾/辞退）を、担当（いなければ判断できる人）へ知らせる。
  // 通知は増やしすぎない：本人の動きのうち、ここだけ（README Stage 4と同じ考え方）
  const notifyOnResponse = async (title) => {
    const targets = applicant.recruiter_id
      ? [applicant.recruiter_id]
      : await decisionMakerEmployeeIds(sb, applicant.tenant_id);
    await notify(targets.map((employeeId) => ({
      tenantId: applicant.tenant_id, employeeId, kind: "hr", title,
      body: applicant.name, link: "/hr/applicants.html", dedupeKey: `hr_offer_response:${offer.id}`,
    })));
  };

  if (!["accept", "decline"].includes(body?.action)) {
    return json(res, 400, { error: "invalid_body", detail: "actionはaccept/declineのいずれかです" });
  }
  if (offer.accepted_at || offer.declined_at) {
    return json(res, 409, { error: "already_responded", hint: "すでに回答済みです" });
  }

  const typed = Boolean(offerTypeOf(offer.offer_type));
  if (body.action === "accept" && typed && body.agreed !== true) {
    return json(res, 400, { error: "agreement_required", hint: `「${AGREEMENT.check}」にチェックしてください` });
  }

  const now = new Date().toISOString();
  let acceptedPdf = false;
  if (body.action === "accept") {
    // 承諾の記録（db/132）：本人の氏名・メール（承諾した時点）・IP・利用環境・画面の同意の文言。承諾日時と同じ更新で一度だけ
    const evidence = typed && offerDocsReady(offer) ? {
      accept_name: applicant.name || null, accept_email: applicant.email || null,
      accept_ip: ipOf(req), accept_ua: uaOf(req), accept_text: AGREEMENT.check,
    } : {};
    const { data: done, error: accErr } = await sb.from("gw_hr_offers").update({ accepted_at: now, ...evidence })
      .eq("id", offer.id).is("accepted_at", null).is("declined_at", null).select("*").maybeSingle();
    if (accErr) {
      console.error("[hr/offers/public] accept", accErr.message);
      return json(res, 500, { error: "accept_failed", hint: "承諾を記録できませんでした。時間をおいてお試しください。" });
    }
    if (!done) return json(res, 409, { error: "already_responded", hint: "すでに回答済みです" });
    await sb.from("gw_hr_applicants").update({ status: "accepted", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_accepted",
      label: typed ? `本人が${docName(offer)}の条件を承諾` : "本人が承諾", detail: `第${offer.version}版`, created_by: null,
    });
    // 承諾済みPDF（条件通知書＋電子承諾記録）。作れなくても承諾は記録済み（保存するときに作り直す）
    if (typed) {
      try { acceptedPdf = Boolean(await ensureAcceptedPdf(sb, done)); }
      catch (e) { console.error("[hr/offers/public] accepted pdf", e?.message || e); }
    }
    // IP・利用環境・メールは監査ログに残さない（承諾の記録は gw_hr_offers の行と承諾済みPDF）
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_accepted",
      target: `hr_offer:${offer.id}`,
      detail: { applicantId: applicant.id, version: offer.version, agreed: typed ? true : undefined,
        noticeSha256: done.notice_pdf_sha256 || undefined, acceptedPdf: acceptedPdf || undefined },
    });
    await notifyOnResponse(typed ? `候補者が条件を承諾しました（${docName(offer)}）` : `候補者が${docName(offer)}を承諾しました`);
  } else {
    const reason = String(body.declineReason ?? "").trim().slice(0, DECLINE_REASON_MAX) || null;
    await sb.from("gw_hr_offers").update({ declined_at: now, decline_reason: reason }).eq("id", offer.id);
    await sb.from("gw_hr_applicants").update({ status: "declined", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_declined",
      label: "本人が辞退", detail: reason, created_by: null,
    });
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_declined",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id, hasReason: Boolean(reason) },
    });
    await notifyOnResponse(`候補者が${docName(offer)}を辞退しました`);
  }

  return json(res, 200, { ok: true, responseStatus: body.action === "accept" ? "accepted" : "declined", acceptedPdf });
}
