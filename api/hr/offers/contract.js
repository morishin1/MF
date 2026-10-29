import { assertLegacyPdfFlowAbsent } from "../../../lib/hr-pdf-flow-guard.js";
// 採用HR：契約手続き（社労士への作成依頼 → 正式PDFの受領・照合・承認 → LegalSign の登録 → 締結の記録）。db/139。
//
// GET  /api/hr/offers/contract?applicantId=…                       … 契約手続きのカード（いま有効な版の7ステップ・状態・次の担当・主ボタン1つ・
//                                                                     受領した正式PDF・依頼の記録・版の照合）
// GET  /api/hr/offers/contract?offerId=…&draft=request[&kind=revision] … 社労士へ Slack で送る依頼文の下書き（送らない・記録しない）
// GET  /api/hr/offers/contract?docId=…&file=1                      … 正式PDFを開く（給与を見られる人だけ。SHA-256 を確かめてから返す）
// POST /api/hr/offers/contract { offerId, action, … }
//   markRequested { kind?, note?, missingLabels? } … 担当者が「依頼済みにする」を押したときだけ記録（コピーしただけでは記録しない）
//   uploadUrl     { fileName, size }              … 正式PDFの置き場所（署名つきアップロードURL）
//   attach        { path, docKind, title?, receivedOn, authorName?, fileName? } … 置いたPDFを確かめて受け取る（版・SHA-256）
//   approve       { docId, checks }               … HR の条件と照合して承認（給与を見られる人だけ・全項目に✓）
//   return        { docId, reason }               … 差し戻し（給与を見られる人だけ・理由が要る）
//   reopen        { reason? }                     … 条件を直す（本人へ案内する前だけ。受け取った版は使わなくなる）
//   legalsign     { route, url?, sameDoc? }       … LegalSign に登録した版の記録（承認した正式PDFと同じ版）／例外ルート
//   signed        { evidence, contractRef?, sameDoc } … 締結を確かめて記録（社長・管理者・人事。本人の同意の前でもよい）
//
// ■ Slack へは送らない（依頼文を作るだけ。送るのは担当者）。「Slack 送信済み」と言わない（担当者が依頼済みと記録）
// ■ 書き込みは service role（db/139 の表はログインした人からは読むだけ）。権限と状態はここで先に確かめる
// ■ 本人へ案内するのは index.js の send / issueLink（承認した正式PDFを notice_* に固定する）。引き渡しは index.js の handoff

import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary, canAdvanceHire } from "../../../lib/gw.js";
import { guardSalaryOutput } from "../../../lib/salary.js";
import { attachPay } from "../../../lib/hr-pay.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { activeOffer } from "../../../lib/hr.js";
import { offerTypeOf, formalRequiredOf, todayJst } from "../../../lib/hr-offer-types.js";
import { sha256 as bytesSha256 } from "../../../lib/pdf-jp.js";
import { OFFER_DOC_BUCKET, checkLegalSignUrl, sendPdf } from "../../../lib/hr-offer-docs.js";
import {
  usesOfficial, contractReady, OFFICIAL_TYPES, OFFICIAL_MAX_BYTES, procedureOf, contractStateOf, requestText,
  normalizeRequestInput, normalizeOfficialInput, normalizeChecks, normalizeEvidence, isPdfBytes,
  docKindsOf, defaultDocKind, docKindLabel, reviewChecksOf, CONTRACT_ROUTES, CONTRACT_ROUTE_KEYS,
  attorneyLabelOf, conditionItemsOf,
} from "../../../lib/hr-contract.js";

const SQL = "db/139_hr_contract_procedure.sql";
const DOC_FIELDS = "id, tenant_id, applicant_id, offer_id, revision, doc_kind, title, file_path, file_sha256, file_size, file_name, "
  + "received_on, author_name, uploaded_by, uploaded_at, status, reviewed_by, reviewed_at, review_note, checks, carried_from, created_at";
const REQ_FIELDS = "id, tenant_id, applicant_id, offer_id, kind, note, missing_labels, requested_at, requested_by";
// ID の形（uuid を想定。英数字・ハイフン・下線だけ。それ以外は読まない）
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PRE_SEND = ["offer_send_pending", "offer_resend_pending"];

const notReady = (res) => json(res, 503, { error: "not_ready", message: `契約手続きを使うには ${SQL} を Supabase に流してください` });
const conflict = (res, hint, extra = {}) => json(res, 409, { error: "invalid_state", hint, ...extra });

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = userClient(req);
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") {
    const q = new URL(req.url || "/", "http://localhost").searchParams;
    if (q.get("docId")) return officialFile(res, sb, ctx, user, q.get("docId"), salary);
    if (q.get("draft") === "request") return requestDraft(res, sb, ctx, q.get("offerId"), q.get("kind"), salary);
    return card(res, sb, ctx, q.get("applicantId"), salary);
  }
  if (req.method === "POST") return act(req, res, sb, ctx, user, salary);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み込み ----------------------------------------------------------------------

async function loadOffer(sb, ctx, offerId) {
  if (!ID_RE.test(String(offerId || ""))) return null;
  const { data } = await sb.from("gw_hr_offers").select("*").eq("id", offerId).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}
async function loadApplicant(sb, ctx, id) {
  const { data } = await sb.from("gw_hr_applicants").select("id, name, status, offer_type, employee_id")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}
/** その版の受領記録・依頼の記録。表が無ければ ready=false */
async function loadTrail(sb, ctx, { offerId = null, applicantId = null }) {
  const by = (q) => (offerId ? q.eq("offer_id", offerId) : q.eq("applicant_id", applicantId));
  const [d, r] = await Promise.all([
    by(sb.from("gw_hr_offer_official_docs").select(DOC_FIELDS).eq("tenant_id", ctx.tenantId)).order("revision", { ascending: false }),
    by(sb.from("gw_hr_attorney_requests").select(REQ_FIELDS).eq("tenant_id", ctx.tenantId)).order("requested_at", { ascending: false }),
  ]);
  if (d.error || r.error) {
    const hint = dbSetupHint(d.error || r.error, SQL);
    return { ready: false, hint, error: d.error || r.error, docs: [], requests: [] };
  }
  return { ready: true, docs: d.data || [], requests: r.data || [] };
}
async function actorNames(sb, ctx, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { data } = await sb.from("gw_employees").select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", list);
  return new Map((data || []).map((e) => [e.user_id, e.display_name]));
}
const perms = (ctx, salary) => ({ review: salary, handoff: canAdvanceHire(ctx), signed: canAdvanceHire(ctx), salary });

const shapeDoc = (d, names, offer) => ({
  id: d.id, offerId: d.offer_id, revision: d.revision, docKind: d.doc_kind, docKindLabel: docKindLabel(d.doc_kind), title: d.title,
  fileName: d.file_name, fileSize: d.file_size, sha256: d.file_sha256, receivedOn: d.received_on, authorName: d.author_name,
  uploadedAt: d.uploaded_at, uploadedByName: names.get(d.uploaded_by) || null, status: d.status,
  reviewedAt: d.reviewed_at, reviewedByName: d.reviewed_by ? (names.get(d.reviewed_by) || null) : null, reviewNote: d.review_note,
  carried: Boolean(d.carried_from), sent: Boolean(offer?.official_doc_id && offer.official_doc_id === d.id),
});
const shapeRequest = (r, names) => ({
  id: r.id, offerId: r.offer_id, kind: r.kind, note: r.note, missingLabels: r.missing_labels || [],
  requestedAt: r.requested_at, requestedByName: names.get(r.requested_by) || null,
});

/** GET ?applicantId= … 契約手続きのカード */
async function card(res, sb, ctx, applicantId, salary) {
  if (!ID_RE.test(String(applicantId || ""))) return json(res, 400, { error: "invalid_query", required: ["applicantId"] });
  const applicant = await loadApplicant(sb, ctx, applicantId);
  if (!applicant) return json(res, 404, { error: "not_found" });
  const { data: offers } = await sb.from("gw_hr_offers").select("*").eq("applicant_id", applicant.id).eq("tenant_id", ctx.tenantId);
  const offer = activeOffer(offers);
  // 正式PDFの流れでない（オファーが無い・育成枠・区分の無い合格通知・db/139 より前に送った版）なら、カードは出さない
  if (!offer || !OFFICIAL_TYPES.includes(offer.offer_type)) return json(res, 200, { applicable: false });
  if (!contractReady(offer)) {
    // db/139 が未適用：まだ送っていない区分つきの版だけ「流してください」と知らせる（ほかはこれまでどおり）
    return json(res, 200, { applicable: false, notReady: !offer.sent_at && !offer.accepted_at, message: `契約手続き（社労士の正式PDF）を使うには ${SQL} を Supabase に流してください` });
  }
  if (!usesOfficial(offer)) return json(res, 200, { applicable: false });
  const trail = await loadTrail(sb, ctx, { applicantId: applicant.id });
  if (!trail.ready) return json(res, 200, { applicable: false, notReady: true, message: trail.hint || `${SQL} を Supabase に流してください` });
  const docs = trail.docs.filter((d) => d.offer_id === offer.id);
  const requests = trail.requests.filter((r) => r.offer_id === offer.id);
  const names = await actorNames(sb, ctx, [...trail.docs.flatMap((d) => [d.uploaded_by, d.reviewed_by]), ...trail.requests.map((r) => r.requested_by)]);
  if (salary) await attachPay(ctx.tenantId, offer, "offer");
  const procedure = procedureOf({ offer, status: applicant.status, docs, requests, perms: perms(ctx, salary) });
  const t = offerTypeOf(offer.offer_type);
  return json(res, 200, {
    applicable: true,
    offer: {
      id: offer.id, version: offer.version, offerType: t.key, offerTypeLabel: t.label, employmentType: offer.employment_type || null,
      applicantStatus: applicant.status, sentAt: offer.sent_at, acceptedAt: offer.accepted_at, respondBy: offer.respond_by,
      expiresAt: offer.expires_at, formalRequired: formalRequiredOf(offer) !== false, contractRoute: offer.contract_route || null,
      legalsignUrl: offer.legalsign_url || null, formalSentAt: offer.formal_sent_at || null, formalSignedAt: offer.formal_signed_at || null,
      formalEvidence: offer.formal_evidence || null, formalContractRef: offer.formal_contract_ref || null, handoffAt: offer.handoff_at || null,
      noticeTitle: offer.official_doc_id ? offer.notice_title : null,
    },
    procedure,
    // 受領した正式PDF（この版のもの＋前の版のもの。新しい順）・依頼の記録
    docs: trail.docs.map((d) => shapeDoc(d, names, offer)),
    requests: trail.requests.map((r) => shapeRequest(r, names)),
    conditions: conditionItemsOf(offer, { salary }),
    docKinds: docKindsOf(t.key), defaultDocKind: defaultDocKind(t.key), reviewChecks: reviewChecksOf(t.key),
    contractRoutes: CONTRACT_ROUTES, attorneyLabel: attorneyLabelOf(t.key),
    perms: perms(ctx, salary), maxBytes: OFFICIAL_MAX_BYTES, today: todayJst(),
  });
}

/** GET ?offerId=&draft=request … 依頼文の下書き（送らない・記録しない） */
async function requestDraft(res, sb, ctx, offerId, kindQ, salary) {
  const offer = await loadOffer(sb, ctx, offerId);
  if (!offer) return json(res, 404, { error: "not_found" });
  if (!contractReady(offer)) return notReady(res);
  if (!usesOfficial(offer)) return conflict(res, "このオファーは社労士の正式PDFで進める流れではありません");
  const applicant = await loadApplicant(sb, ctx, offer.applicant_id);
  if (!applicant) return json(res, 404, { error: "not_found" });
  const trail = await loadTrail(sb, ctx, { offerId: offer.id });
  if (!trail.ready) return notReady(res);
  const state = contractStateOf({ offer, status: applicant.status, docs: trail.docs, requests: trail.requests });
  if (!["request_pending", "returned", "requested", "review_pending"].includes(state)) {
    return conflict(res, state === "conditions" ? "先に条件を確定してください" : "いまは依頼文を作る段階ではありません");
  }
  // 給与を見られる人だけ、依頼文に給与・報酬を入れる（見られない人には伏せて【要確認】）
  const payOffer = { ...offer };
  if (salary) await attachPay(ctx.tenantId, payOffer, "offer");
  const lastReturn = trail.docs.find((d) => d.status === "returned") || null;
  const kind = kindQ === "revision" || state === "returned" ? "revision" : (kindQ === "initial" ? "initial" : (trail.requests.length ? "revision" : "initial"));
  const draft = requestText({
    offer: payOffer, applicantName: applicant.name, salary, kind,
    reason: kind === "revision" ? lastReturn?.review_note || null : null, contractRoute: offer.contract_route || null,
  });
  return json(res, 200, { ...draft, kind, state, salaryVisible: salary,
    notice: "これは送信用の下書きです。Slack へは送っていません。内容を確かめてから、ご自身で Slack に貼り付けて送ってください。" });
}

/** GET ?docId=&file=1 … 正式PDFを開く（給与を見られる人だけ。記録のハッシュと違えば返さない） */
async function officialFile(res, sb, ctx, user, docId, salary) {
  if (!ID_RE.test(String(docId || ""))) return json(res, 400, { error: "invalid_query" });
  if (!salary) return json(res, 403, { error: "forbidden", hint: "正式な通知書には給与・報酬が入るため、給与を見られる方が確認します" });
  const { data: doc, error } = await sb.from("gw_hr_offer_official_docs").select(DOC_FIELDS).eq("id", docId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) return dbSetupHint(error, SQL) ? notReady(res) : json(res, 500, { error: "db_query_failed" });
  if (!doc) return json(res, 404, { error: "not_found" });
  let bytes;
  try { bytes = await readStored(doc.file_path); } catch { return json(res, 404, { error: "no_file", hint: "PDFを読めませんでした" }); }
  if (bytesSha256(bytes) !== doc.file_sha256) {
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.official_doc_mismatch", target: `hr_offer:${doc.offer_id}`, detail: { docId: doc.id, revision: doc.revision } });
    return conflict(res, "保存されているPDFが受け取ったときの記録（SHA-256）と違います。人事・管理者に確認してください");
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.official_doc_view", target: `hr_offer:${doc.offer_id}`, detail: { docId: doc.id, revision: doc.revision } });
  return sendPdf(res, bytes, `${doc.title}_受領第${doc.revision}版.pdf`);
}

const storage = () => admin().storage.from(OFFER_DOC_BUCKET);
async function readStored(path) {
  const { data, error } = await storage().download(path);
  if (error || !data) throw error || new Error("not_found");
  return new Uint8Array(await data.arrayBuffer());
}

// ---- 操作 ----------------------------------------------------------------------------

async function act(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  const offer = await loadOffer(sb, ctx, body?.offerId);
  if (!offer) return json(res, 404, { error: "not_found" });
  const gate = await assertLegacyPdfFlowAbsent(admin(), ctx.tenantId, offer.applicant_id);
  if (!gate.ok) return json(res, gate.status, gate.body);
  if (!contractReady(offer)) return notReady(res);
  if (!usesOfficial(offer)) return conflict(res, "このオファーは社労士の正式PDFで進める流れではありません");
  const applicant = await loadApplicant(sb, ctx, offer.applicant_id);
  if (!applicant) return json(res, 404, { error: "not_found" });
  const trail = await loadTrail(sb, ctx, { offerId: offer.id });
  if (!trail.ready) return notReady(res);
  const state = contractStateOf({ offer, status: applicant.status, docs: trail.docs, requests: trail.requests });
  const c = { req, res, sb, ctx, user, salary, body, offer, applicant, trail, state, t: offerTypeOf(offer.offer_type) };
  switch (body?.action) {
    case "markRequested": return markRequested(c);
    case "uploadUrl": return uploadUrl(c);
    case "attach": return attach(c);
    case "approve": return review(c, "approve");
    case "return": return review(c, "return");
    case "reopen": return reopen(c);
    case "legalsign": return legalsign(c);
    case "signed": return signed(c);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

/** この版を正式PDFの流れに確定する（最初の操作のとき。一度入ったら DB が変えさせない＝db/139） */
async function pinRoute(c) {
  if (c.offer.doc_route) return;
  await c.sb.from("gw_hr_offers").update({ doc_route: "official" }).eq("id", c.offer.id).eq("tenant_id", c.ctx.tenantId).is("doc_route", null);
  c.offer.doc_route = "official";
}

async function timeline(c, event_key, label, detail = null) {
  await c.sb.from("gw_hr_timeline").insert({
    tenant_id: c.ctx.tenantId, applicant_id: c.applicant.id, event_key, label,
    detail: [`第${c.offer.version}版`, detail].filter(Boolean).join("・"), created_by: c.user.id,
  });
}
const audit = (c, action, detail = {}) => gwLog({
  tenantId: c.ctx.tenantId, actorId: c.user.id, action, target: `hr_offer:${c.offer.id}`,
  detail: { applicantId: c.applicant.id, version: c.offer.version, ...detail },
});
const ok = async (c, extra = {}) => json(c.res, 200, { ok: true, ...extra });

/** 担当者が Slack で送ったあと「依頼済みにする」を押した（コピーしただけでは記録しない） */
async function markRequested(c) {
  if (!["request_pending", "returned", "requested", "review_pending"].includes(c.state)) {
    return conflict(c.res, c.state === "conditions" ? "先に条件を確定してください" : "いまは依頼済みにできる段階ではありません");
  }
  const input = normalizeRequestInput(c.body);
  const kind = c.state === "returned" || c.trail.requests.length ? "revision" : input.kind;
  await pinRoute(c);
  const { data, error } = await admin().from("gw_hr_attorney_requests").insert({
    tenant_id: c.ctx.tenantId, applicant_id: c.applicant.id, offer_id: c.offer.id, kind,
    note: input.note, missing_labels: input.missing, requested_by: c.user.id,
  }).select(REQ_FIELDS).single();
  if (error) return json(c.res, 500, { error: "db_insert_failed" });
  const who = attorneyLabelOf(c.t?.key);
  await timeline(c, "attorney_requested", `${who}へ${kind === "revision" ? "修正を依頼" : "作成を依頼"}（担当者が依頼済みと記録）`,
    input.missing.length ? `要確認 ${input.missing.length}件のまま依頼` : null);
  await audit(c, "hr.attorney_requested", { kind, requestId: data.id, missing: input.missing.length });
  return ok(c, { request: { id: data.id, kind, requestedAt: data.requested_at } });
}

/** 正式PDFの置き場所（署名つきアップロードURL）。置き場所はこの応募者・この版の中だけ */
async function uploadUrl(c) {
  const okState = ["requested", "review_pending"].includes(c.state);
  if (!okState) {
    return conflict(c.res, ["request_pending", "returned"].includes(c.state)
      ? `先に${attorneyLabelOf(c.t?.key)}へ依頼し、「依頼済みにする」を押してください`
      : "いまは正式PDFを受け取る段階ではありません");
  }
  const size = Number(c.body?.size);
  if (!Number.isFinite(size) || size <= 0) return json(c.res, 400, { error: "invalid_body", hint: "ファイルを選んでください" });
  if (size > OFFICIAL_MAX_BYTES) return json(c.res, 400, { error: "too_large", hint: "15MB までのPDFを選んでください" });
  if (!/\.pdf$/i.test(String(c.body?.fileName || ""))) return json(c.res, 400, { error: "invalid_body", hint: "PDF（.pdf）を選んでください" });
  const path = `${c.ctx.tenantId}/offers/${c.applicant.id}/${c.offer.id}/official-${crypto.randomUUID()}.pdf`;
  const { data, error } = await storage().createSignedUploadUrl(path);
  if (error) return json(c.res, 500, { error: "sign_failed" });
  return ok(c, { path, uploadUrl: data.signedUrl, token: data.token });
}

/** 置いたPDFを確かめて受け取る（PDFの中身・大きさ・パスワード無し・SHA-256）。版は 1, 2, 3 … */
async function attach(c) {
  if (!["requested", "review_pending"].includes(c.state)) return conflict(c.res, "いまは正式PDFを受け取る段階ではありません");
  const path = String(c.body?.path || "");
  const prefix = `${c.ctx.tenantId}/offers/${c.applicant.id}/${c.offer.id}/official-`;
  // 置き場所を自分で指定できると、ほかの応募者・ほかの版・ほかの会社のファイルを掴める
  if (!path.startsWith(prefix) || !/^[0-9a-f-]{36}\.pdf$/i.test(path.slice(prefix.length))) return json(c.res, 403, { error: "forbidden" });
  const input = normalizeOfficialInput(c.body, c.t?.key, todayJst());
  if (input.error) return json(c.res, 400, input);
  let bytes;
  try { bytes = await readStored(path); } catch { return json(c.res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした。もう一度アップロードしてください" }); }
  const drop = async () => { try { await storage().remove([path]); } catch { /* 記録に無いパスは読まれない */ } };
  if (!isPdfBytes(bytes)) { await drop(); return json(c.res, 400, { error: "not_pdf", hint: "PDFではないファイルです" }); }
  if (bytes.length > OFFICIAL_MAX_BYTES) { await drop(); return json(c.res, 400, { error: "too_large", hint: "15MB までのPDFを選んでください" }); }
  // 本人の承諾記録のページを足せるPDFか（パスワード付き・壊れたPDFは、承諾済みPDFを作れない）
  try { await PDFDocument.load(bytes, { ignoreEncryption: false }); }
  catch { await drop(); return json(c.res, 400, { error: "unreadable_pdf", hint: "パスワード付き、または壊れたPDFは受け付けられません。パスワードを外したPDFをもらってください" }); }
  const sha = bytesSha256(bytes);
  await pinRoute(c);
  const sbAdmin = admin();
  const next = (c.trail.docs.reduce((m, d) => Math.max(m, d.revision), 0) || 0) + 1;
  let inserted = null, lastErr = null;
  for (const revision of [next, next + 1]) {   // 同時に受け取ったとき（版の番号がぶつかった）は1回だけ番号を進めて入れ直す
    const r = await sbAdmin.from("gw_hr_offer_official_docs").insert({
      tenant_id: c.ctx.tenantId, applicant_id: c.applicant.id, offer_id: c.offer.id, revision,
      doc_kind: input.value.docKind, title: input.value.title, file_path: path, file_sha256: sha, file_size: bytes.length,
      file_name: input.value.fileName, received_on: input.value.receivedOn, author_name: input.value.authorName, uploaded_by: c.user.id,
    }).select(DOC_FIELDS).single();
    if (!r.error) { inserted = r.data; break; }
    lastErr = r.error;
    if (r.error.code !== "23505") break;
  }
  if (!inserted) { await drop(); return json(c.res, 500, { error: "db_insert_failed", detail: lastErr?.message }); }
  // 確認待ちは1つだけにする（前に受け取った確認待ちの版は使わなくなる）
  const older = c.trail.docs.filter((d) => d.status === "received").map((d) => d.id);
  if (older.length) await sbAdmin.from("gw_hr_offer_official_docs").update({ status: "superseded" }).in("id", older).eq("status", "received");
  await timeline(c, "official_received", `${attorneyLabelOf(c.t?.key)}作成の${input.value.title}（PDF）を受領`, `受領第${inserted.revision}版`);
  await audit(c, "hr.official_doc_received", { docId: inserted.id, revision: inserted.revision, sha256: sha, size: bytes.length, superseded: older.length });
  return ok(c, { doc: { id: inserted.id, revision: inserted.revision, sha256: sha, status: inserted.status } });
}

/** 照合して承認／差し戻し（給与を見られる人だけ） */
async function review(c, kind) {
  if (!c.salary) return json(c.res, 403, { error: "forbidden", hint: "照合と承認は、給与を見られる人事・管理者が行います" });
  if (c.offer.official_doc_id || c.offer.sent_at) return conflict(c.res, "本人へ案内したあとは、正式PDFを差し替えられません（条件を変えるときは再発行します）");
  if (!PRE_SEND.includes(c.applicant.status)) return conflict(c.res, "いまは正式PDFを確認する段階ではありません");
  const doc = c.trail.docs.find((d) => d.id === c.body?.docId);
  if (!doc) return json(c.res, 404, { error: "not_found" });
  if (doc.status !== "received") return conflict(c.res, "確認待ちの版だけ、承認・差し戻しできます");
  const now = new Date().toISOString();
  const sbAdmin = admin();
  if (kind === "return") {
    const reason = String(c.body?.reason ?? "").trim().slice(0, 1000);
    if (!reason) return json(c.res, 400, { error: "invalid_body", hint: "差し戻す理由（直してほしい点）を入れてください" });
    const { data, error } = await sbAdmin.from("gw_hr_offer_official_docs")
      .update({ status: "returned", reviewed_by: c.user.id, reviewed_at: now, review_note: reason })
      .eq("id", doc.id).eq("status", "received").select("id").maybeSingle();
    if (error) return json(c.res, 500, { error: "db_update_failed" });
    if (!data) return conflict(c.res, "直前に状態が変わりました。開き直してください");
    await timeline(c, "official_returned", `${doc.title}（受領第${doc.revision}版）を差し戻し`, null);
    await audit(c, "hr.official_doc_returned", { docId: doc.id, revision: doc.revision });
    return ok(c, { status: "returned" });
  }
  const { checks, missing } = normalizeChecks(c.body, c.t?.key);
  if (missing.length) return json(c.res, 400, { error: "invalid_body", hint: `照合が済んでいない項目があります：${missing.join("・")}`, missing });
  // 保存されているPDFが、受け取ったときと同じか（Storage を直接書き換えられていないか）
  let bytes;
  try { bytes = await readStored(doc.file_path); } catch { return conflict(c.res, "PDFを読めませんでした。もう一度アップロードしてください"); }
  if (bytesSha256(bytes) !== doc.file_sha256) return conflict(c.res, "保存されているPDFが受け取ったときの記録（SHA-256）と違います。もう一度アップロードしてください");
  const { data, error } = await sbAdmin.from("gw_hr_offer_official_docs")
    .update({ status: "approved", reviewed_by: c.user.id, reviewed_at: now, checks })
    .eq("id", doc.id).eq("status", "received").select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") return conflict(c.res, "この版にはすでに承認した正式PDFがあります。開き直してください");
    return json(c.res, 500, { error: "db_update_failed" });
  }
  if (!data) return conflict(c.res, "直前に状態が変わりました。開き直してください");
  // LegalSign に別の版を登録していたら、登録を外す（承認した版と同じPDFを登録し直す）
  if (c.offer.legalsign_doc_sha256 && c.offer.legalsign_doc_sha256 !== doc.file_sha256 && !c.offer.formal_sent_at) {
    await c.sb.from("gw_hr_offers").update({ legalsign_doc_id: null, legalsign_doc_sha256: null })
      .eq("id", c.offer.id).eq("tenant_id", c.ctx.tenantId);
  }
  await timeline(c, "official_approved", `${doc.title}（受領第${doc.revision}版）を条件と照合して承認`, null);
  await audit(c, "hr.official_doc_approved", { docId: doc.id, revision: doc.revision, sha256: doc.file_sha256 });
  return ok(c, { status: "approved" });
}

/** 条件を直す（本人へ案内する前だけ）。受け取った正式PDFは使わなくなり、社労士へ依頼し直す */
async function reopen(c) {
  if (c.offer.sent_at || c.offer.official_doc_id) return conflict(c.res, "本人へ案内したあとは、この版の条件を直せません（再発行します）");
  if (c.applicant.status !== "offer_send_pending") return conflict(c.res, "条件を確定したあと・本人へ案内する前だけ、条件を直せます");
  const now = new Date().toISOString();
  const { error } = await c.sb.from("gw_hr_applicants").update({ status: "offer_review_pending", updated_at: now })
    .eq("id", c.applicant.id).eq("tenant_id", c.ctx.tenantId).eq("status", "offer_send_pending");
  if (error) return json(c.res, 500, { error: "db_update_failed" });
  const stale = c.trail.docs.filter((d) => ["received", "approved"].includes(d.status)).map((d) => d.id);
  if (stale.length) await admin().from("gw_hr_offer_official_docs").update({ status: "superseded" }).in("id", stale);
  if (c.offer.legalsign_doc_sha256 && !c.offer.formal_sent_at) {
    await c.sb.from("gw_hr_offers").update({ legalsign_doc_id: null, legalsign_doc_sha256: null }).eq("id", c.offer.id).eq("tenant_id", c.ctx.tenantId);
  }
  const reason = String(c.body?.reason ?? "").trim().slice(0, 300);
  await timeline(c, "conditions_reopened", "条件を直すため、確定を取り消し", reason || null);
  await audit(c, "hr.offer_conditions_reopened", { supersededDocs: stale.length });
  return ok(c, { status: "offer_review_pending" });
}

/** LegalSign に登録した版の記録（承認した正式PDFと同じ版）／例外ルート（紙・対面など） */
async function legalsign(c) {
  if (formalRequiredOf(c.offer) === false) return conflict(c.res, "このオファーは正式契約なしで進めます");
  if (c.offer.formal_sent_at || c.offer.formal_signed_at) return json(c.res, 409, { error: "locked", hint: "本人へ正式契約を案内した・締結したあとは、登録を変えられません" });
  const doc = c.offer.official_doc_id
    ? c.trail.docs.find((d) => d.id === c.offer.official_doc_id)
    : c.trail.docs.find((d) => d.status === "approved");
  if (!doc) return conflict(c.res, "先に正式PDFを照合して承認してください（LegalSign には承認した版を登録します）");
  const route = CONTRACT_ROUTE_KEYS.includes(c.body?.route) ? c.body.route : null;
  if (!route) return json(c.res, 400, { error: "invalid_body", hint: "契約ルートを選んでください" });
  let patch;
  if (route === "legalsign") {
    const checked = checkLegalSignUrl(c.body?.url);
    if (checked.error) return json(c.res, 400, { error: "invalid_body", hint: checked.error });
    if (c.body?.sameDoc !== true) return json(c.res, 400, { error: "invalid_body", hint: `LegalSign に登録したのが、承認した正式PDF（受領第${doc.revision}版）と同じであることを確かめてください` });
    patch = { contract_route: "legalsign", legalsign_url: checked.url, legalsign_doc_id: doc.id, legalsign_doc_sha256: doc.file_sha256 };
  } else {
    patch = { contract_route: "other", legalsign_url: null, legalsign_doc_id: null, legalsign_doc_sha256: null };
  }
  const { data, error } = await c.sb.from("gw_hr_offers").update(patch)
    .eq("id", c.offer.id).eq("tenant_id", c.ctx.tenantId).is("formal_sent_at", null).select("id").maybeSingle();
  if (error) {
    if (error.code === "55000") return json(c.res, 409, { error: "locked", hint: "確定した記録は変更できません" });
    if (error.code === "23514") return conflict(c.res, "本人へ案内した正式PDFと違う版は登録できません");
    return json(c.res, 500, { error: "db_update_failed" });
  }
  if (!data) return json(c.res, 409, { error: "locked", hint: "本人へ正式契約を案内したあとは、登録を変えられません" });
  // URL は監査ログ・タイムラインに残さない（事実だけ）
  await timeline(c, route === "legalsign" ? "formal_url_set" : "contract_route_set",
    route === "legalsign" ? `LegalSign に正式PDF（受領第${doc.revision}版）を登録` : "正式契約を例外ルート（紙・対面など）で進める", null);
  await audit(c, route === "legalsign" ? "hr.offer_legalsign_url_set" : "hr.offer_contract_route_set",
    { route, docId: doc.id, revision: doc.revision, changed: Boolean(c.offer.legalsign_url || c.offer.contract_route) });
  return ok(c, { contractRoute: route });
}

/** 締結を確かめて記録（社長・管理者・人事。本人の同意の前でもよい。Office への引き渡しは同意と締結がそろってから） */
async function signed(c) {
  if (!canAdvanceHire(c.ctx)) return json(c.res, 403, { error: "forbidden", hint: "締結の記録は、社長・管理者・人事が行います" });
  if (formalRequiredOf(c.offer) === false) return conflict(c.res, "このオファーは正式契約なしで進めます");
  if (c.offer.formal_signed_at) return json(c.res, 409, { error: "locked", hint: "すでに正式契約済みです" });
  if (!c.offer.sent_at || !c.offer.official_doc_id) return conflict(c.res, "正式PDFを本人へ案内してから、締結を記録します");
  if (c.offer.declined_at || c.offer.revoked_at) return conflict(c.res, "辞退・無効化した版には記録できません");
  if (!c.offer.legalsign_url && c.offer.contract_route !== "other") return conflict(c.res, "先に LegalSign への登録（または例外ルート）を記録してください");
  const ev = normalizeEvidence(c.body);
  if (ev.error) return json(c.res, 400, ev);
  const { data, error } = await c.sb.from("gw_hr_offers").update({
    formal_signed_at: new Date().toISOString(), formal_signed_by: c.user.id,
    formal_evidence: ev.value.evidence, formal_contract_ref: ev.value.contractRef, formal_doc_sha256: c.offer.notice_pdf_sha256,
  }).eq("id", c.offer.id).eq("tenant_id", c.ctx.tenantId).is("formal_signed_at", null).select("id").maybeSingle();
  if (error) {
    if (error.code === "55000") return json(c.res, 409, { error: "locked", hint: "すでに正式契約済みです" });
    if (error.code === "23514") return conflict(c.res, "この版は締結を記録できません（案内した正式PDF・LegalSign の登録を確認してください）");
    return json(c.res, 500, { error: "db_update_failed" });
  }
  if (!data) return json(c.res, 409, { error: "locked", hint: "すでに正式契約済みです" });
  const other = c.offer.contract_route === "other";
  await timeline(c, "formal_signed", other ? "正式契約済み（例外ルート・締結を確認）" : "正式契約済み（LegalSign の締結を確認）",
    c.offer.accepted_at ? null : "本人のHRでの条件同意はまだ");
  await audit(c, "hr.offer_formal_signed", { via: "contract", route: c.offer.contract_route || "legalsign", beforeConsent: !c.offer.accepted_at, hasRef: Boolean(ev.value.contractRef) });
  return ok(c, { formalSigned: true });
}
