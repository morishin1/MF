// POST  /api/hr/offers { applicantId, respondBy, messageToCandidate, ... }
//         … 合格通知の下書きを作る（応募者の現在の採用条件をスナップショット）。
//           応募者の状態を「社内確認待ち」へ進める。status=offer_draft_pendingのときだけ
// PATCH /api/hr/offers { id, action }
//         "update"     … 社内確認待ちの間だけ、内容を直す（状態は動かさない）
//         "confirm"    … 内容を確定し、応募者の状態を「本人送付待ち」へ進める
//         "issueLink"  … 本人専用URLのtokenを発行する（平文は一度だけ返す。Stage 6）
//         "markSent"   … 実際に本人へ送ったことを明示的に記録する（Stage 6 §12）
//         "send"       … ［内容を確認してメールで送信］（オファー作成・メール送信・同意完結 UI/UX改善仕様 §12）。
//                         1回で 内容の確定 → 本人専用URLの発行 → メール送信 → sent_at → タイムライン → 承諾待ち まで行う
//         "handoff"    … ［承諾内容を確認してOfficeへ引き渡す］（db/133）。承諾した版を Office の入社準備キューへ載せる（社員にはしない）
// GET   /api/hr/offers?id=…
//         … 送る前の確認画面：本人に見える条件の行・区分ごとのメールの下書き（{{オファーURL}} 入り）・メールで送れるか
// GET   /api/hr/offers?id=…&file=notice|accepted        … 条件通知書PDF・承諾済みPDFを開く
//         採用HR（canRecruit）… どの版でも。Office の人事・労務（canOfficeHr。採用HRの権限が無い人）… 閲覧専用（officeFile）：
//         「Office へ引き渡した版」（handoff_at が入っている）だけ。同一テナント・給与を見られる人だけ（PDF に給与・報酬が入る）。
//         作成・更新・送付・正式契約・引き渡しは、採用HR（canRecruit）だけ。Office からは見るだけ（PDFの生成・保存もしない）
//
// ■ 1 offer version = 1 公開token（README Stage 6 §5・§20）
//   Stage 5作成時にNOT NULL制約対応のプレースホルダーtokenを発行しているが、
//   候補者には一切公開していない。issueLink・sendで初めて「本人へ渡してよいtoken」を
//   発行する：まだ一度も送っていない行（sent_atが空）ならその行のtokenを
//   差し替えるだけ、すでに送付済みの行なら新しい版を足して古い行を無効化する
//   （db/081のコメントどおり、送付済みの内容は上書きしない）。
//
// ■ 手で送るとき（メール送信の設定が無い・本人のメールアドレスが無い）
//   issueLinkはURLを発行するだけ。sent_atは「送付済みにする」をHRが明示的に
//   押した時点（markSent）でしか立てない（README Stage 6 §12）
//
// ■ メールで送るとき（send）。新しいメール基盤は作らない
//   送信は lib/mail（採用の送信元）、送った記録は gw_hr_mail_sends（db/124。ひな型ではないので template_id は空）。
//   requestKey で二重送信を防ぐ（同じ鍵の2回目は送らず、1回目の結果を返す）。
//   本人専用URLは送る直前にサーバーで作り、本文の {{オファーURL}} に入れる。送った記録・監査ログには URL（token）を残さない。
//   送れなかった（失敗・結果不明）ときは、そのURLを一度だけ返す（手で送って「送付済みにする」へ）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary, canAdvanceHire, canOfficeHr } from "../../../lib/gw.js";
import { guardSalaryOutput, dropSalaryInput } from "../../../lib/salary.js";
import { paySplit, splitWage, attachPay, savePay, copyPayToOffer, payFailed, WAGE_COLUMNS } from "../../../lib/hr-pay.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  normalizeOffer, shapeOffer, sha256, newOfferToken, offerExpiresAt,
} from "../../../lib/hr.js";
import {
  offerTypeOf, missingRequired, documentWarnings, offerMail, publicOfferItems, OFFER_URL_TAG, todayJst, formalRequiredOf,
} from "../../../lib/hr-offer-types.js";
import { readHandoffOffers } from "../../../lib/hire-handoff.js";
import { notify } from "../../../lib/notify.js";
import { adminSideEmployeeIds } from "../../../lib/messages-admin.js";
import { sendMail, mailConfig, isEmail } from "../../../lib/mail/index.js";
import { sendProblems, sendOutcome } from "../../../lib/hr-mail-template.js";
import { publicBaseUrl } from "../../../lib/onboard-guide.js";
import {
  offerDocsReady, noticeTitleOf, buildNoticePdf, ensureNoticePdf, ensureAcceptedPdf, readPdf, sendPdf, pdfFileName,
  checkLegalSignUrl,
} from "../../../lib/hr-offer-docs.js";

// 書類の呼び方（採用区分つきなら「業務委託オファー」など。区分が無い、これまでの版は「合格通知」）
const docName = (row) => offerTypeOf(row?.offer_type)?.offerName || "合格通知";
// 区分の必須項目が足りないときの応答
const missingResponse = (res, missing) => json(res, 400, {
  error: "invalid_body", detail: `次の項目を入力してください：${missing.join("・")}`, missing,
});

const SQL = "db/081_hr_recruiting.sql・086_hr_offer_public_link.sql";

// gw_hr_offers・gw_hr_applicants どちらも同じ列名を持つ、合格通知のスナップショット項目
// （lib/hr.jsのsnapshotOfferFieldsと同じ考え方。再発行で、そのまま次の版へ引き継ぐ）
const OFFER_SNAPSHOT_COLUMNS = [
  "job_title", "employment_type", "contract_type", "contract_end_date", "join_date",
  "probation_months", "wage_type", "wage_amount", "weekly_hours", "work_location",
  "message_to_candidate", "respond_by",
  // 採用区分と区分ごとの条件（db/129。列が無い環境・区分の無い版では undefined のまま＝送らない）
  "offer_type", "offer_terms",
  // 正式契約（LegalSign）の要否（db/133。列が無い環境では undefined のまま＝送らない）
  "formal_contract_required",
];

// db/133（formal_contract_required）が未適用の環境では、その列を外して書き直す（要否は区分の既定で扱う）
const FORMAL_COL = "formal_contract_required";
const missingFormalCol = (e) => Boolean(e) && String(e.message || "").includes(FORMAL_COL) && ["PGRST204", "42703"].includes(e.code);
const withoutFormal = (row) => { const out = { ...row }; delete out[FORMAL_COL]; return out; };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 採用HR（canRecruit）以外は、Office の人事・労務が「引き渡された版のPDFを見る」ことだけできる（officeFile）。ほかは 403
  if (!canRecruit(ctx)) return officeFile(req, res, ctx, user);

  const sb = userClient(req);
  // 給与は、見られる人（lib/gw.js canSeeSalary）にだけ返す・書かせる。
  // 採用担当・責任者は、給与が見えないまま合格通知を作れる（応募者の条件は、サーバ側でそのまま引き継ぐ）
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") {
    const q = new URL(req.url || "/", "http://localhost").searchParams;
    if (q.get("file")) return offerFile(res, sb, ctx, user, q.get("id"), q.get("file"), salary);
    return sendDraft(req, res, sb, ctx, salary);
  }
  if (req.method === "POST") return create(req, res, sb, ctx, user, salary);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user, salary);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

async function create(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  const { data: applicant } = await sb.from("gw_hr_applicants").select("*")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  if (applicant.status !== "offer_draft_pending") {
    return json(res, 409, { error: "invalid_state", hint: "いまは合格通知を作成できる状態ではありません" });
  }
  // 給与が見えない人の操作でも、応募者の条件は、サーバの中でそのまま引き継ぐ（応答には載らない）
  await attachPay(ctx.tenantId, applicant, "applicant");

  // 給与を見られない人は、給与の欄を書き換えられない。応募者に入っている条件は、そのまま引き継ぐ
  const row = normalizeOffer(salary ? body : dropSalaryInput(body), applicant,
    { offerType: applicant.offer_type || null, salary });
  if (row.error) return json(res, 400, row);
  if (applicant.offer_type) {
    const missing = missingRequired(applicant.offer_type, row.value);
    if (missing.length) return missingResponse(res, missing);
  }

  const { data: existing } = await sb.from("gw_hr_offers").select("version")
    .eq("applicant_id", applicant.id).order("version", { ascending: false }).limit(1);
  const version = (existing?.[0]?.version || 0) + 1;
  const token = newOfferToken();

  // 給与は、分けている設定なら専用の表へ（元の行には入れない）
  const { base, wage } = splitWage(row.value);
  const insertRow = {
    ...base, tenant_id: ctx.tenantId, applicant_id: applicant.id, version,
    token_hash: sha256(token), created_by: user.id,
  };
  let { data, error } = await sb.from("gw_hr_offers").insert(insertRow).select("*").single();
  if (error && missingFormalCol(error)) {
    ({ data, error } = await sb.from("gw_hr_offers").insert(withoutFormal(insertRow)).select("*").single());
  }
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  try {
    await savePay(ctx.tenantId, { applicantId: applicant.id, offerId: data.id, wage });
  } catch (e) {
    // 給与の無い合格通知の版を残さない
    return payFailed(res, e, () => sb.from("gw_hr_offers").delete().eq("id", data.id));
  }

  const now = new Date().toISOString();
  await sb.from("gw_hr_applicants").update({ status: "offer_review_pending", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_drafted",
    label: `${docName(data)}を作成`, detail: `第${version}版`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_create",
    target: `hr_offer:${data.id}`, detail: { applicantId: applicant.id, version },
  });

  return json(res, 200, { offer: await shape(ctx, data, salary), status: "offer_review_pending" });
}

async function act(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { data: offer } = await sb.from("gw_hr_offers").select("*")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!offer) return json(res, 404, { error: "not_found" });

  if (body.action === "update") return update(res, sb, ctx, user, offer, salary ? body : dropSalaryInput(body), salary);
  if (body.action === "confirm") return confirm(res, sb, ctx, user, offer, salary);
  if (body.action === "issueLink") return issueLink(res, sb, ctx, user, offer, salary);
  if (body.action === "markSent") return markSent(res, sb, ctx, user, offer, salary);
  if (body.action === "send") return sendOffer(req, res, sb, ctx, user, offer, body, salary);
  if (body.action === "setLegalSign") return setLegalSign(res, sb, ctx, user, offer, body, salary);
  if (body.action === "sendFormal") return sendFormal(req, res, sb, ctx, user, offer, body, salary);
  if (body.action === "markFormalSigned") return markFormalSigned(res, sb, ctx, user, offer, salary);
  if (body.action === "handoff") return handoff(res, sb, ctx, user, offer, salary);
  return json(res, 400, { error: "unknown_action" });
}

async function update(res, sb, ctx, user, offer, body, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || applicant.status !== "offer_review_pending") {
    return json(res, 409, { error: "invalid_state", hint: "社内確認待ちの間だけ、内容を直せます" });
  }
  // 条件通知書PDFを作った版は直さない（送った書面と中身がずれないように。db/132）
  if (offer.notice_pdf_path) return json(res, 409, { error: "invalid_state", hint: "条件通知書を作った版は直せません" });

  const row = normalizeOffer(body, null, {
    partial: true, offerType: offer.offer_type || null, salary, previousTerms: offer.offer_terms || {},
    previousJoinDate: offer.join_date || null,
  });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  // 給与は、分けている設定なら専用の表へ。元の行に残る項目がなければ、行そのものは触らない
  const { base, wage } = splitWage(row.value);
  let data = offer;
  if (Object.keys(base).length) {
    let r = await sb.from("gw_hr_offers").update(base).eq("id", offer.id).select("*").single();
    if (r.error && missingFormalCol(r.error)) {
      const rest = withoutFormal(base);
      r = Object.keys(rest).length ? await sb.from("gw_hr_offers").update(rest).eq("id", offer.id).select("*").single() : { data: offer };
    }
    if (r.error) return lockedResponse(res, r.error) || json(res, 500, { error: "db_update_failed", detail: r.error.message });
    data = r.data;
  }
  try {
    await savePay(ctx.tenantId, { applicantId: offer.applicant_id, offerId: offer.id, wage });
  } catch (e) {
    return payFailed(res, e);
  }

  return json(res, 200, { offer: await shape(ctx, data, salary) });
}

async function confirm(res, sb, ctx, user, offer, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || applicant.status !== "offer_review_pending") {
    return json(res, 409, { error: "invalid_state", hint: "社内確認待ちの合格通知だけ確定できます" });
  }

  if (offer.offer_type) {
    const missing = missingRequired(offer.offer_type, offer);
    if (missing.length) return missingResponse(res, missing);
  }

  const now = new Date().toISOString();
  await sb.from("gw_hr_applicants").update({ status: "offer_send_pending", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_confirmed",
    label: `${docName(offer)}の内容を確定`, detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_confirm",
    target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
  });

  return json(res, 200, { offer: await shape(ctx, offer, salary), status: "offer_send_pending" });
}

// 応答用の形にする。給与を見られる人にだけ、給与（分けている設定では専用の表から）を足す
async function shape(ctx, offer, salary) {
  if (salary) await attachPay(ctx.tenantId, offer, "offer");
  return shapeOffer(offer);
}

const LINKABLE_STATUSES = [
  "offer_send_pending", "offer_sent", "offer_viewed", "offer_response_pending", "offer_resend_pending",
];

// 本人専用URLのtokenを発行する。平文は、ここでしか返さない
async function issueLink(res, sb, ctx, user, offer, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || !LINKABLE_STATUSES.includes(applicant.status)) {
    return json(res, 409, { error: "invalid_state", hint: "いまはURLを発行できる状態ではありません" });
  }
  if (offer.revoked_at) return json(res, 409, { error: "invalid_state", hint: "この合格通知はすでに無効です" });

  const token = newOfferToken();
  const now = new Date().toISOString();

  // まだ一度も本人へ送っていなければ、その行のtokenを差し替えるだけでよい。
  // 送付済みの行を差し替えるときは、新しい版を足して古い行を無効化する
  // （db/081の設計どおり。送付済みの内容は上書きしない＝旧URLは必ず失効する）
  if (!offer.sent_at) {
    const { data, error } = await sb.from("gw_hr_offers")
      .update({ token_hash: sha256(token), expires_at: offerExpiresAt(offer.respond_by) })
      .eq("id", offer.id).select("*").single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_link_issued",
      label: "候補者URLを発行", detail: `第${offer.version}版`, created_by: user.id,
    });
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_issue",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id, version: offer.version },
    });
    await noticeForManual(sb, ctx, data);
    return json(res, 200, { offer: await shape(ctx, data, salary), token });
  }

  const nextVersion = offer.version + 1;
  // 給与を分けている設定では、元の行には給与を入れない（新しい版へは、専用の表から引き継ぐ）
  const snapshot = Object.fromEntries(OFFER_SNAPSHOT_COLUMNS
    .filter((k) => !(paySplit() && WAGE_COLUMNS.includes(k))).map((k) => [k, offer[k]]));
  const { data: made, error } = await sb.from("gw_hr_offers")
    .insert({
      ...snapshot, tenant_id: ctx.tenantId, applicant_id: applicant.id, version: nextVersion,
      token_hash: sha256(token), expires_at: offerExpiresAt(offer.respond_by), created_by: user.id,
    })
    .select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  try {
    await copyPayToOffer(ctx.tenantId, { applicantId: applicant.id, fromOfferId: offer.id, toOfferId: made.id });
  } catch (e) {
    // 給与を引き継げなかった新しい版は残さない（前の版は、有効のまま）
    return payFailed(res, e, () => sb.from("gw_hr_offers").delete().eq("id", made.id));
  }
  await sb.from("gw_hr_offers").update({ revoked_at: now }).eq("id", offer.id);
  await sb.from("gw_hr_applicants").update({ status: "offer_resend_pending", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_link_reissued",
    label: "URLを再発行", detail: `第${nextVersion}版（第${offer.version}版は失効）`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_reissue",
    target: `hr_offer:${made.id}`, detail: { applicantId: applicant.id, revokedOfferId: offer.id, version: nextVersion },
  });

  await noticeForManual(sb, ctx, made);
  return json(res, 200, { offer: await shape(ctx, made, salary), token, status: "offer_resend_pending" });
}

// 実際に本人へ送ったことを、HRが明示的に記録する（URLを発行しただけではsent_atにしない）
async function markSent(res, sb, ctx, user, offer, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || !["offer_send_pending", "offer_resend_pending"].includes(applicant.status)) {
    return json(res, 409, { error: "invalid_state", hint: "いまは送付済みにできる状態ではありません" });
  }
  if (offer.revoked_at) return json(res, 409, { error: "invalid_state", hint: "この合格通知はすでに無効です" });

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_offers")
    .update({ sent_at: offer.sent_at || now }).eq("id", offer.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await sb.from("gw_hr_applicants").update({ status: "offer_sent", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_sent",
    label: `${docName(offer)}を本人へ送付`, detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_sent",
    target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
  });

  return json(res, 200, { offer: await shape(ctx, data, salary), status: "offer_sent" });
}

// ---- ［内容を確認してメールで送信］（§12） ------------------------------------------

const MAIL_SQL = "db/124_hr_mail_templates.sql";
const SEND_FIELDS = "id, applicant_id, to_email, template_name, subject, body, status, error, sent_by_name, created_at, finished_at";
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
// 送った記録（gw_hr_mail_sends）の本文には、本人専用URLを残さない（token を持つ人は本人として同意できるため）
const URL_IN_RECORD = "（本人専用URL・記録には残しません）";
const SENDABLE_STATUSES = ["offer_review_pending", "offer_send_pending"];

const shapeSendRow = (r) => ({
  id: r.id, toEmail: r.to_email, templateName: r.template_name, subject: r.subject, body: r.body, status: r.status,
  error: r.error, sentByName: r.sent_by_name, createdAt: r.created_at, finishedAt: r.finished_at,
});
const offerUrl = (req, token) => `${publicBaseUrl(req)}/hr/offer.html?token=${encodeURIComponent(token)}`;

/** 本人がメールで受け取れるか（受け取れなければ、画面は「URLを発行して手で送る」を出す） */
function mailReady(applicant) {
  const cfg = mailConfig("recruiting");
  const hasEmail = isEmail(applicant?.email);
  return {
    configured: cfg.configured && hasEmail,
    reason: !hasEmail ? "候補者のメールアドレスが登録されていません" : cfg.configured ? null : cfg.reason,
    from: cfg.from || null,
  };
}

async function loadSendContext(sb, ctx, offer) {
  const [{ data: applicant }, { data: tenant }] = await Promise.all([
    sb.from("gw_hr_applicants").select("id, name, email, status, recruiter_id")
      .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle(),
    sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle(),
  ]);
  return { applicant, company: tenant?.name || null };
}

const addressOnly = (v) => {
  const s = String(v || "").trim();
  const m = s.match(/<([^<>]+)>\s*$/);
  return (m ? m[1] : s).trim() || null;
};

// 条件通知書の発行元。値そのものはPDFにだけ入り、監査ログには残さない。
function noticeMeta(ctx) {
  const cfg = mailConfig("recruiting");
  return {
    issuerName: ctx.employee?.display_name || "採用担当",
    contactEmail: addressOnly(cfg.replyTo || cfg.from),
  };
}

// 送る前の確認画面：本人に見える条件・メールの下書き・メールで送れるか
async function sendDraft(req, res, sb, ctx, salary) {
  const id = new URL(req.url || "/", "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });
  const { data: offer } = await sb.from("gw_hr_offers").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!offer) return json(res, 404, { error: "not_found" });
  const { applicant, company } = await loadSendContext(sb, ctx, offer);
  if (!applicant) return json(res, 404, { error: "not_found" });

  await attachPay(ctx.tenantId, offer, "offer");
  // 本人に見える条件の行。給与を見られない人には、給与の行を出さない（行の値は文字列なので、出口の伏せ字が効かない）
  const items = publicOfferItems(offer).filter((it) => salary || !it.salary);
  // 条件通知書PDF（db/132 があり、区分つきの版だけ）。送るときに作ってメールに添付する
  const noticeTitle = offerDocsReady(offer) ? (offer.notice_title || noticeTitleOf(offer)) : null;
  const mail = offerMail(offer, { name: applicant.name, company, attachment: noticeTitle });
  // offer の給与は、見られない人には出口（json）で外れる。送った記録は、応募者のメールの履歴（api/hr/applicants/mail.js）に並ぶ
  return json(res, 200, {
    offer: shapeOffer(offer), items, to: applicant.email || null, candidateName: applicant.name,
    subject: mail.subject, body: mail.body, urlTag: OFFER_URL_TAG, mail: mailReady(applicant),
    canSend: SENDABLE_STATUSES.includes(applicant.status) && !offer.sent_at && !offer.revoked_at,
    // ready=false は db/132 未適用・区分の無い版（PDF なしで、これまでどおり送る）。stored は作成済み（送った時点の版）
    notice: {
      ready: Boolean(noticeTitle), title: noticeTitle, stored: Boolean(offer.notice_pdf_path), salaryVisible: salary,
      warnings: documentWarnings(offer.offer_type, offer, { salary }),
    },
    // 正式契約（LegalSign）の要否（db/133。列が無ければ区分の既定）。送ったあとは変わらない
    formalRequired: formalRequiredOf(offer),
  });
}

async function sendOffer(req, res, sb, ctx, user, offer, body, salary) {
  const requestKey = String(body?.requestKey || "");
  if (!REQUEST_KEY_RE.test(requestKey)) return json(res, 400, { error: "invalid_body", hint: "送信の鍵がありません。画面を開き直してください" });
  const sbAdmin = admin();

  // 同じ鍵で送ったことがあれば、送らずに前の結果を返す（二度押し・通信のやり直し）
  const prev = await sbAdmin.from("gw_hr_mail_sends").select(SEND_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle();
  if (prev.error) {
    const hint = dbSetupHint(prev.error, MAIL_SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed" });
  }
  if (prev.data) return json(res, 200, { duplicate: true, status: prev.data.status, send: shapeSendRow(prev.data) });

  const { applicant, company } = await loadSendContext(sb, ctx, offer);
  if (!applicant || !SENDABLE_STATUSES.includes(applicant.status)) {
    return json(res, 409, { error: "invalid_state", hint: "いまはメールで送れる状態ではありません。画面を開き直してください" });
  }
  if (offer.revoked_at) return json(res, 409, { error: "invalid_state", hint: "この合格通知はすでに無効です" });
  if (offer.sent_at) return json(res, 409, { error: "already_sent", hint: "このオファーはすでに送っています（送り直すときは、URLを再発行してください）" });
  if (offer.offer_type) {
    const missing = missingRequired(offer.offer_type, offer);
    if (missing.length) return missingResponse(res, missing);
  }
  if (!offer.respond_by || offer.respond_by < todayJst()) {
    return json(res, 400, { error: "invalid_body", hint: "回答期限が過ぎています。回答期限を直してから送ってください" });
  }

  const subject = String(body?.subject ?? "").trim();
  const text = String(body?.body ?? "").replace(/\r\n/g, "\n");
  if (!text.includes(OFFER_URL_TAG)) {
    return json(res, 400, { error: "cannot_send", hint: `本文に ${OFFER_URL_TAG} を残してください（本人専用URLが入る場所です）` });
  }
  const recordBody = text.split(OFFER_URL_TAG).join(URL_IN_RECORD);
  const problems = sendProblems({ subject, body: recordBody, applicantId: applicant.id });
  if (problems.length) return json(res, 400, { error: "cannot_send", hint: problems[0], problems });

  const ready = mailReady(applicant);
  if (!ready.configured) {
    return json(res, 409, { error: isEmail(applicant.email) ? "mail_not_configured" : "no_email", hint: `メールで送れません（${ready.reason}）。URLを発行して、手で送ってください` });
  }

  // 1) 送った記録を「送信中」で先に入れる（同じ鍵の同時の2回目は、一意の索引で入れられない＝送らない）
  const cfg = mailConfig("recruiting");
  const docLabel = docName(offer);
  const { data: rec, error: insErr } = await sbAdmin.from("gw_hr_mail_sends").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, to_email: applicant.email, to_name: applicant.name,
    from_email: cfg.from || null, reply_to: cfg.replyTo || null,
    template_id: null, template_version: null,
    template_name: `オファー送付（${docLabel}・第${offer.version}版${offerDocsReady(offer) && noticeTitleOf(offer) ? "・条件通知書PDF添付" : ""}）`,
    subject, body: recordBody, status: "sending", request_key: requestKey,
    sent_by: user.id, sent_by_name: ctx.employee?.display_name || null,
  }).select(SEND_FIELDS).single();
  if (insErr) {
    if (insErr.code === "23505") {
      const { data: same } = await sbAdmin.from("gw_hr_mail_sends").select(SEND_FIELDS)
        .eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle();
      return json(res, 200, { duplicate: true, status: same?.status || "sending", send: same ? shapeSendRow(same) : null });
    }
    const hint = dbSetupHint(insErr, MAIL_SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed" });
  }
  const finish = async (patch) => {
    const { data } = await sbAdmin.from("gw_hr_mail_sends").update({ ...patch, finished_at: new Date().toISOString() })
      .eq("id", rec.id).eq("tenant_id", ctx.tenantId).select(SEND_FIELDS).single();
    return shapeSendRow(data || { ...rec, ...patch });
  };

  // 2) 本人専用URL（この版の token を差し替え）と sent_at を、まだ送っていない行にだけ一度に入れる（同時に送られても1回だけ）
  const now = new Date().toISOString();
  const token = newOfferToken();
  const { data: claimed, error: claimErr } = await sb.from("gw_hr_offers")
    .update({ token_hash: sha256(token), expires_at: offerExpiresAt(offer.respond_by), sent_at: now })
    .eq("id", offer.id).eq("tenant_id", ctx.tenantId).is("sent_at", null).is("revoked_at", null)
    .select("*").maybeSingle();
  if (claimErr || !claimed) {
    await finish({ status: "not_sent", error: "このオファーは、ほかの画面から送られました" });
    return json(res, 409, { error: "already_sent", hint: "このオファーは、ほかの画面からすでに送られています。画面を開き直してください" });
  }

  // 3) 内容の確定（社内確認待ち → 送付待ち）。送れなくても、確定した版は直さない（手で送るときも同じ版）
  if (applicant.status === "offer_review_pending") {
    await sb.from("gw_hr_applicants").update({ status: "offer_send_pending", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_confirmed",
      label: `${docLabel}の内容を確定`, detail: `第${offer.version}版`, created_by: user.id,
    });
  }

  // 4) 条件通知書PDF（確定したこの版から作る。db/132 が無い・区分の無い版は PDF なしで、これまでどおり送る）
  let notice = null;
  try {
    const payOffer = { ...claimed };
    await attachPay(ctx.tenantId, payOffer, "offer");
    notice = await ensureNoticePdf(sb, payOffer, { candidateName: applicant.name, company, ...noticeMeta(ctx) });
    if (notice) Object.assign(claimed, { notice_title: notice.title, notice_pdf_path: notice.path, notice_pdf_sha256: notice.sha256 });
  } catch (e) {
    console.error("[hr/offers] notice pdf", e?.message || e);
    await sb.from("gw_hr_offers").update({ sent_at: null }).eq("id", offer.id).eq("tenant_id", ctx.tenantId);
    await finish({ status: "not_sent", error: "条件通知書PDFを作れませんでした" });
    return json(res, 500, { error: "notice_failed", hint: "条件通知書PDFを作れませんでした。時間をおいて、もう一度送ってください（内容は確定したままです）" });
  }

  // 5) メールを送る（本文の {{オファーURL}} に本人専用URLを入れて。条件通知書PDFを添付）
  const url = offerUrl(req, token);
  const mail = await sendMail({
    purpose: "recruiting", to: applicant.email, subject, text: text.split(OFFER_URL_TAG).join(url),
    ...(notice ? { attachments: [{ filename: pdfFileName(notice.title, offer.version), content: notice.bytes, contentType: "application/pdf" }] } : {}),
  });
  const outcome = sendOutcome(mail);
  const send = await finish({
    status: outcome, provider: mail.provider || null, provider_message_id: mail.providerMessageId || null,
    from_email: mail.from || cfg.from || null, reply_to: mail.replyTo || cfg.replyTo || null,
    error: outcome === "sent" ? null : String(mail.error || "").slice(0, 300) || null,
  });
  // 本文・宛先・URL は監査ログに残さない
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: outcome === "sent" ? "hr.offer_sent" : "hr.offer_send_failed",
    target: `hr_offer:${offer.id}`,
    detail: { applicantId: applicant.id, version: offer.version, channel: "email", send: rec.id, status: outcome, providerMessageId: mail.providerMessageId || null },
  });

  if (outcome === "sent") {
    // 6) 承諾待ちへ。タイムラインに「メールで送付」（件名まで）
    await sb.from("gw_hr_applicants").update({ status: "offer_sent", updated_at: new Date().toISOString() })
      .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_sent",
      label: `${docLabel}をメールで送付`, detail: `第${offer.version}版${notice ? `・${notice.title}（PDF）添付` : ""}　件名：${subject}`, created_by: user.id,
    });
    return json(res, 200, { status: "sent", offer: await shape(ctx, claimed, salary), send, applicantStatus: "offer_sent" });
  }

  // 送れなかった：送付済みにはしない（結果不明は、届いているかもしれないので sent_at を残す）。
  // URL は、ここで一度だけ返す（手で送って「送付済みにする」）
  if (outcome !== "unknown") await sb.from("gw_hr_offers").update({ sent_at: null }).eq("id", offer.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_send_failed",
    label: outcome === "unknown" ? `${docLabel}のメール送信（結果不明）` : `${docLabel}のメールを送れませんでした`,
    detail: `第${offer.version}版`, created_by: user.id,
  });
  const fresh = { ...claimed, sent_at: outcome === "unknown" ? claimed.sent_at : null };
  const common = { offer: await shape(ctx, fresh, salary), send, token, url, applicantStatus: "offer_send_pending" };
  if (outcome === "unknown") {
    return json(res, 202, { status: "unknown", ...common,
      hint: "送信サービスの応答がなく、送れたかどうか分かりません。候補者に届いているか確かめてから「送付済みにする」を押してください（すぐに送り直さないでください）" });
  }
  return json(res, 502, { status: outcome, ...common,
    hint: `メールを送れませんでした（${mail.error || "原因不明"}）。下のURLと文面をコピーして手で送り、「送付済みにする」を押してください` });
}

// ---- 条件通知書PDF・承諾済みPDF（db/132） ------------------------------------------------

/** 手で送るとき（URL を発行）にも、本人が保存できるよう条件通知書PDFを用意しておく。作れなくても URL の発行は止めない */
async function noticeForManual(sb, ctx, offer) {
  if (!offerDocsReady(offer) || !noticeTitleOf(offer) || offer.notice_pdf_path) return;
  try {
    const { applicant, company } = await loadSendContext(sb, ctx, offer);
    const payOffer = { ...offer };
    await attachPay(ctx.tenantId, payOffer, "offer");
    const n = await ensureNoticePdf(sb, payOffer, { candidateName: applicant?.name, company, ...noticeMeta(ctx) });
    if (n) Object.assign(offer, { notice_title: n.title, notice_pdf_path: n.path, notice_pdf_sha256: n.sha256 });
  } catch (e) { console.error("[hr/offers] notice pdf (manual)", e?.message || e); }
}

/**
 * Office の人事・労務（採用HRの権限が無い人）が、Office へ引き渡された版の条件通知書PDF・承諾済みPDFを「見る」だけの口。
 * 採用HRの DB 権限（RLS）を持たないことがあるので、service role で読む。そのため認可を先にすべて確かめる（見てよくなければ何も読まない）：
 *   ① Office の人事権限（canOfficeHr）かつ GET の file=notice|accepted だけ。更新・送付・引き渡しは 403
 *   ② 給与を見られる人だけ（条件通知書には給与・報酬が入る。canSeeSalary）
 *   ③ 同一テナント（版・応募者のどちらも tenant_id で絞る）
 *   ④ 引き渡した版（handoff_at が入っていて、承諾済みで、無効化・辞退でなく、育成枠でない。readHandoffOffers と同じ）
 * PDF は保管済みのものを読むだけ（作らない・書き込まない。承諾済みPDFが無ければ 404）。誰がいつ開いたかは監査ログに残す
 */
async function officeFile(req, res, ctx, user) {
  if (req.method !== "GET" || !canOfficeHr(ctx)) return json(res, 403, { error: "forbidden" });
  const q = new URL(req.url || "/", "http://localhost").searchParams;
  const id = q.get("id"), file = q.get("file");
  if (!id || !["notice", "accepted"].includes(file)) return json(res, 403, { error: "forbidden" });
  if (!canSeeSalary(ctx)) return json(res, 403, { error: "forbidden", hint: "条件通知書には給与・報酬が入るため、権限のある方が確認します" });

  const sb = admin();
  const { data: offer, error } = await sb.from("gw_hr_offers").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed" });
  if (!offer) return json(res, 404, { error: "not_found" });
  const { ready, offers } = await readHandoffOffers(sb, ctx.tenantId, { applicantIds: [offer.applicant_id] });
  const handed = ready && offers.some((o) => o.id === offer.id && o.tenant_id === ctx.tenantId);
  if (!handed) {
    return json(res, 403, { error: "not_handed_off", hint: "Office へ引き渡された方の書類だけ、Office から見られます（採用HRで引き渡しを済ませてください）" });
  }
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id").eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  if (!offerDocsReady(offer)) return json(res, 503, { error: "not_ready", message: "db/132_hr_offer_documents.sql を Supabase に流してください" });
  const path = file === "accepted" ? offer.accepted_pdf_path : offer.notice_pdf_path;
  if (!path) return json(res, 404, { error: "no_file", hint: file === "accepted" ? "承諾済みPDFはまだありません" : "条件通知書はまだ作っていません" });
  try {
    const bytes = await readPdf(path);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_pdf_download", target: `hr_offer:${offer.id}`, detail: { file, via: "office" } });
    return sendPdf(res, bytes, pdfFileName(offer.notice_title, offer.version, file === "accepted"));
  } catch (e) {
    console.error("[hr/offers] office pdf", e?.message || e);
    return json(res, 500, { error: "pdf_failed", hint: "PDFを用意できませんでした" });
  }
}

/**
 * GET /api/hr/offers?id=…&file=preview|notice|accepted … PDF を返す（採用HRを使える人。PDF には給与が入るので、給与を見られる人だけ）
 *   preview  … 送る前の確認用（作るだけで置かない）。作成済みなら、置いたもの
 *   notice   … 送った条件通知書（その版のまま）
 *   accepted … 承諾済みPDF（条件通知書＋電子承諾記録）。まだ無ければ、承諾の記録から作って置く
 */
async function offerFile(res, sb, ctx, user, id, file, salary) {
  if (!id || !["preview", "notice", "accepted"].includes(file)) return json(res, 400, { error: "invalid_query" });
  if (!salary) return json(res, 403, { error: "forbidden", hint: "条件通知書には給与・報酬が入るため、権限のある方が確認します" });
  const { data: offer } = await sb.from("gw_hr_offers").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!offer) return json(res, 404, { error: "not_found" });
  if (!offerDocsReady(offer)) return json(res, 503, { error: "not_ready", message: "db/132_hr_offer_documents.sql を Supabase に流してください" });
  if (!noticeTitleOf(offer)) return json(res, 404, { error: "no_notice", hint: "区分の無い合格通知には条件通知書がありません" });
  try {
    if (file === "accepted") {
      const acc = await ensureAcceptedPdf(sb, offer);
      if (!acc) return json(res, 404, { error: "no_file", hint: "承諾済みPDFはまだありません" });
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_pdf_download", target: `hr_offer:${offer.id}`, detail: { file } });
      return sendPdf(res, acc.bytes, pdfFileName(offer.notice_title, offer.version, true));
    }
    if (offer.notice_pdf_path) {
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_pdf_download", target: `hr_offer:${offer.id}`, detail: { file: "notice" } });
      return sendPdf(res, await readPdf(offer.notice_pdf_path), pdfFileName(offer.notice_title, offer.version));
    }
    if (file === "notice") return json(res, 404, { error: "no_file", hint: "条件通知書はまだ作っていません（送るときに作ります）" });
    const { applicant, company } = await loadSendContext(sb, ctx, offer);
    await attachPay(ctx.tenantId, offer, "offer");
    const built = await buildNoticePdf(offer, { candidateName: applicant?.name, company, ...noticeMeta(ctx) });
    // プレビューは確定しない（置かない・db/132 の列は入れない）。見たという事実だけ残す
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_pdf_preview", target: `hr_offer:${offer.id}`, detail: { version: offer.version } });
    return sendPdf(res, built.bytes, `確認用_${pdfFileName(built.title, offer.version)}`);
  } catch (e) {
    console.error("[hr/offers] pdf", e?.message || e);
    return json(res, 500, { error: "pdf_failed", hint: "PDFを用意できませんでした" });
  }
}

// ---- 正式契約（LegalSign。db/132） ----------------------------------------------------
// URL は gw_hr_offers.legalsign_url にだけ持つ。監査ログ・タイムライン・console には書かない（事実だけ）

const formalNotReady = (res) => json(res, 503, { error: "not_ready", message: "db/132_hr_offer_documents.sql を Supabase に流してください" });
// 正式契約（LegalSign）が要らないオファー（db/133。送ったときに決まっている）では、LegalSign の操作をしない
const formalNotRequired = (res) => json(res, 409, { error: "not_required", hint: "このオファーは「正式契約（LegalSign）不要」として送っています" });
const lockedResponse = (res, e) => (e?.code === "55000"
  ? json(res, 409, { error: "locked", hint: "確定した記録は変更できません" }) : null);

async function loadAccepted(sb, ctx, offer) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, email, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return applicant;
}

/** LegalSign の URL を登録・直す（本人へ正式契約を案内する前まで） */
async function setLegalSign(res, sb, ctx, user, offer, body, salary) {
  if (!offerDocsReady(offer)) return formalNotReady(res);
  if (formalRequiredOf(offer) === false) return formalNotRequired(res);
  if (!offer.accepted_at) return json(res, 409, { error: "invalid_state", hint: "本人が条件を承諾してから登録できます" });
  if (offer.formal_sent_at) return json(res, 409, { error: "locked", hint: "本人へ案内したあとは、URL を変えられません" });
  const checked = checkLegalSignUrl(body?.url);
  if (checked.error) return json(res, 400, { error: "invalid_body", hint: checked.error });
  const { data, error } = await sb.from("gw_hr_offers").update({ legalsign_url: checked.url })
    .eq("id", offer.id).eq("tenant_id", ctx.tenantId).is("formal_sent_at", null).select("*").maybeSingle();
  if (error) return lockedResponse(res, error) || json(res, 500, { error: "db_update_failed" });
  if (!data) return json(res, 409, { error: "locked", hint: "本人へ案内したあとは、URL を変えられません" });
  const first = !offer.legalsign_url;
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: offer.applicant_id, event_key: "formal_url_set",
    label: first ? "正式契約（LegalSign）の URL を登録" : "正式契約（LegalSign）の URL を変更", detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_legalsign_url_set",
    target: `hr_offer:${offer.id}`, detail: { applicantId: offer.applicant_id, version: offer.version, changed: !first } });
  return json(res, 200, { offer: await shape(ctx, data, salary) });
}

/** 正式契約の案内メールの下書き（{{正式契約URL}} の位置に、送るときサーバーが URL を入れる） */
const FORMAL_URL_TAG = "{{正式契約URL}}";
function formalMail(offer, { name, company }) {
  const c = company || "弊社";
  return {
    subject: `【${c}】正式なご契約のお手続きのご案内`,
    body: [
      `${name} 様`, "",
      "このたびは条件をご承諾いただき、ありがとうございます。", "",
      "正式なご契約は、電子契約サービス（LegalSign）で行います。",
      "下記より内容をご確認のうえ、署名のお手続きをお願いいたします。", "",
      "［正式契約の手続きへ］", FORMAL_URL_TAG, "",
      "ご不明な点がございましたら、このメールにご返信ください。", "",
      c, "採用担当",
    ].join("\n"),
  };
}

/**
 * 本人へ正式契約（LegalSign）を案内する。
 *   channel "email" … 既存の採用メールで送る（送った記録には URL を残さない）／ "manual" … 自分で送った、という記録だけ
 *   GET 用の下書きは body.preview=true で返す（送らない）
 */
async function sendFormal(req, res, sb, ctx, user, offer, body, salary) {
  if (!offerDocsReady(offer)) return formalNotReady(res);
  if (formalRequiredOf(offer) === false) return formalNotRequired(res);
  if (!offer.accepted_at) return json(res, 409, { error: "invalid_state", hint: "本人が条件を承諾してから案内できます" });
  if (!offer.legalsign_url) return json(res, 400, { error: "invalid_body", hint: "先に LegalSign の URL を登録してください" });
  if (offer.formal_signed_at) return json(res, 409, { error: "invalid_state", hint: "すでに正式契約済みです" });
  const applicant = await loadAccepted(sb, ctx, offer);
  if (!applicant) return json(res, 404, { error: "not_found" });
  const { company } = await loadSendContext(sb, ctx, offer);

  if (body?.preview) {
    const m = formalMail(offer, { name: applicant.name, company });
    return json(res, 200, { subject: m.subject, body: m.body, urlTag: FORMAL_URL_TAG, to: applicant.email || null, mail: mailReady(applicant) });
  }

  const channel = body?.channel === "manual" ? "manual" : "email";
  let send = null;
  if (channel === "email") {
    const requestKey = String(body?.requestKey || "");
    if (!REQUEST_KEY_RE.test(requestKey)) return json(res, 400, { error: "invalid_body", hint: "送信の鍵がありません。画面を開き直してください" });
    const sbAdmin = admin();
    const prev = await sbAdmin.from("gw_hr_mail_sends").select(SEND_FIELDS).eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle();
    if (prev.data) return json(res, 200, { duplicate: true, status: prev.data.status, send: shapeSendRow(prev.data) });
    const subject = String(body?.subject ?? "").trim();
    const text = String(body?.body ?? "").replace(/\r\n/g, "\n");
    if (!text.includes(FORMAL_URL_TAG)) return json(res, 400, { error: "cannot_send", hint: `本文に ${FORMAL_URL_TAG} を残してください（LegalSign の URL が入る場所です）` });
    const recordBody = text.split(FORMAL_URL_TAG).join("（LegalSign の URL・記録には残しません）");
    const problems = sendProblems({ subject, body: recordBody, applicantId: applicant.id });
    if (problems.length) return json(res, 400, { error: "cannot_send", hint: problems[0], problems });
    const ready = mailReady(applicant);
    if (!ready.configured) return json(res, 409, { error: isEmail(applicant.email) ? "mail_not_configured" : "no_email", hint: `メールで送れません（${ready.reason}）` });
    const cfg = mailConfig("recruiting");
    const { data: rec, error: insErr } = await sbAdmin.from("gw_hr_mail_sends").insert({
      tenant_id: ctx.tenantId, applicant_id: applicant.id, to_email: applicant.email, to_name: applicant.name,
      from_email: cfg.from || null, reply_to: cfg.replyTo || null, template_id: null, template_version: null,
      template_name: `正式契約の案内（LegalSign・第${offer.version}版）`, subject, body: recordBody, status: "sending",
      request_key: requestKey, sent_by: user.id, sent_by_name: ctx.employee?.display_name || null,
    }).select(SEND_FIELDS).single();
    if (insErr) {
      if (insErr.code === "23505") return json(res, 200, { duplicate: true, status: "sending" });
      return json(res, 500, { error: "db_insert_failed" });
    }
    const mail = await sendMail({ purpose: "recruiting", to: applicant.email, subject, text: text.split(FORMAL_URL_TAG).join(offer.legalsign_url) });
    const outcome = sendOutcome(mail);
    const { data: done } = await sbAdmin.from("gw_hr_mail_sends").update({
      status: outcome, provider: mail.provider || null, provider_message_id: mail.providerMessageId || null,
      error: outcome === "sent" ? null : String(mail.error || "").slice(0, 300) || null, finished_at: new Date().toISOString(),
    }).eq("id", rec.id).eq("tenant_id", ctx.tenantId).select(SEND_FIELDS).single();
    send = shapeSendRow(done || rec);
    if (outcome !== "sent") {
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_formal_send_failed",
        target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id, version: offer.version, status: outcome } });
      return json(res, outcome === "unknown" ? 202 : 502, { status: outcome, send,
        hint: outcome === "unknown" ? "送れたかどうか分かりません。届いているか確かめてから、必要なら「自分で送った」として記録してください"
          : `メールを送れませんでした（${mail.error || "原因不明"}）` });
    }
  }

  // 案内した（初回の日時・人だけ残す。2回目以降の案内は、記録を変えない）
  let data = offer;
  if (!offer.formal_sent_at) {
    const r = await sb.from("gw_hr_offers").update({ formal_sent_at: new Date().toISOString(), formal_sent_by: user.id })
      .eq("id", offer.id).eq("tenant_id", ctx.tenantId).is("formal_sent_at", null).select("*").maybeSingle();
    if (r.error) return lockedResponse(res, r.error) || json(res, 500, { error: "db_update_failed" });
    data = r.data || offer;
  }
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "formal_sent",
    label: channel === "email" ? "正式契約（LegalSign）を本人へメールで案内" : "正式契約（LegalSign）を本人へ案内（自分で送付）",
    detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_formal_sent",
    target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id, version: offer.version, channel, again: Boolean(offer.formal_sent_at) } });
  return json(res, 200, { status: "sent", channel, send, offer: await shape(ctx, data, salary) });
}

/** 正式契約済みにする（LegalSign で署名が終わったのを、HR が確かめて押す。誰が・いつ。取り消せない） */
async function markFormalSigned(res, sb, ctx, user, offer, salary) {
  if (!offerDocsReady(offer)) return formalNotReady(res);
  if (formalRequiredOf(offer) === false) return formalNotRequired(res);
  if (!offer.accepted_at) return json(res, 409, { error: "invalid_state", hint: "本人が条件を承諾していません" });
  if (offer.formal_signed_at) return json(res, 409, { error: "locked", hint: "すでに正式契約済みです" });
  const { data, error } = await sb.from("gw_hr_offers")
    .update({ formal_signed_at: new Date().toISOString(), formal_signed_by: user.id })
    .eq("id", offer.id).eq("tenant_id", ctx.tenantId).is("formal_signed_at", null).select("*").maybeSingle();
  if (error) return lockedResponse(res, error) || json(res, 500, { error: "db_update_failed" });
  if (!data) return json(res, 409, { error: "locked", hint: "すでに正式契約済みです" });
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: offer.applicant_id, event_key: "formal_signed",
    label: "正式契約済み（LegalSign）", detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_formal_signed",
    target: `hr_offer:${offer.id}`, detail: { applicantId: offer.applicant_id, version: offer.version } });
  return json(res, 200, { offer: await shape(ctx, data, salary) });
}

// ---- 承諾内容を確認して Office へ引き渡す（db/133） ---------------------------------------
// 「Office へ引き渡す」＝ Office 担当者の入社準備キュー（admin-hr.html の「HRから引き渡し」）に載せること。
// 本人を社員にはしない（社員名簿・アカウントは Office が既存の社員登録で作る）。本人に Office の権限も与えない。
// 押せるのは社長・管理者・人事（canAdvanceHire。社員登録の事前入力・完了と同じ）。
// 二度押しても1回だけ（handoff_at が空のときだけ書く。DB でも書き換えを止める）

const handoffNotReady = (res) => json(res, 503, { error: "not_ready", message: "db/133_hr_offer_handoff.sql を Supabase に流してください" });

async function handoff(res, sb, ctx, user, offer, salary) {
  if (!canAdvanceHire(ctx)) return json(res, 403, { error: "forbidden", hint: "Office へ引き渡せるのは社長・管理者・人事です" });
  if (!Object.prototype.hasOwnProperty.call(offer, "handoff_at")) return handoffNotReady(res);
  const t = offerTypeOf(offer.offer_type);
  if (!t) return json(res, 409, { error: "invalid_state", hint: "区分の無い合格通知は、これまでどおり［本採用へ進める］で進めてください" });
  if (t.key === "training") {
    return json(res, 409, { error: "training", hint: "育成枠は Office へ引き渡しません。LMS・育成開始の手続きへ進めてください" });
  }
  if (offer.handoff_at) return json(res, 200, { already: true, offer: await shape(ctx, offer, salary) });
  if (!offer.accepted_at || offer.declined_at || offer.revoked_at) {
    return json(res, 409, { error: "invalid_state", hint: "本人が条件を承諾した版だけ、Office へ引き渡せます" });
  }
  const required = formalRequiredOf(offer);
  if (required && !offer.formal_signed_at) {
    return json(res, 409, { error: "formal_required", hint: "このオファーは正式契約（LegalSign）が必要です。正式契約済みにしてから引き渡してください" });
  }
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, status, employee_id")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  if (applicant.employee_id) return json(res, 409, { error: "already_advanced", hint: "すでに社員登録が済んでいます" });
  if (applicant.status !== "accepted") return json(res, 409, { error: "invalid_state", hint: "条件承諾済みの方だけ、Office へ引き渡せます" });

  const { data, error } = await sb.from("gw_hr_offers")
    .update({ handoff_at: new Date().toISOString(), handoff_by: user.id })
    .eq("id", offer.id).eq("tenant_id", ctx.tenantId).is("handoff_at", null).select("*").maybeSingle();
  if (error) {
    if (error.code === "23514") return json(res, 409, { error: "invalid_state", hint: "この版は Office へ引き渡せません（承諾・正式契約の状態を確認してください）" });
    return lockedResponse(res, error) || json(res, 500, { error: "db_update_failed" });
  }
  if (!data) {
    // 同時に押された：先に入った引き渡しをそのまま返す
    const { data: now } = await sb.from("gw_hr_offers").select("*").eq("id", offer.id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (now?.handoff_at) return json(res, 200, { already: true, offer: await shape(ctx, now, salary) });
    return json(res, 409, { error: "conflict", hint: "直前に状態が変わりました。開き直してください" });
  }

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "office_handoff",
    label: "承諾内容を確認して Office へ引き渡し",
    detail: `第${offer.version}版・${required ? "正式契約済み" : "正式契約なし"}`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_handoff", target: `hr_offer:${offer.id}`,
    detail: { applicantId: applicant.id, version: offer.version, offerType: t.key, formalRequired: required, formalSigned: Boolean(offer.formal_signed_at) },
  });
  // Office の人事・労務（社長・人事・管理者）へ知らせる。行き先は入退社の画面（本人の情報・URL は書かない）
  try {
    const ids = await adminSideEmployeeIds(admin(), ctx.tenantId);
    await notify(ids.map((employeeId) => ({
      tenantId: ctx.tenantId, employeeId, kind: "hr",
      title: `入社準備：HRから引き渡し（${applicant.name}さん・${t.label}）`,
      body: "承諾内容の確認が済みました。Office の入退社で社員登録へ進めてください。",
      link: "/admin-hr.html", dedupeKey: `hr_handoff:${applicant.id}`,
    })));
  } catch (e) { console.error("[hr/offers] handoff notify", e?.message || e); }

  return json(res, 200, { offer: await shape(ctx, data, salary) });
}
