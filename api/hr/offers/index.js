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
//
// ■ 社労士の正式PDFで進める版（db/139・lib/hr-contract.js usesOfficial）
//   社労士・依頼・受領・承認・LegalSign の登録・締結の記録は /api/hr/offers/contract。ここ（send・issueLink）は
//   「承認した正式PDF」を、送る（URLを出す）と同時に notice_* と official_doc_id に固定する（同じ版を本人・承諾記録・Office が使う）。
//   承認した正式PDFが無い・LegalSign の登録（または例外ルート）が無い・保存されたPDFが記録と違う、ときは送らない。
//   HR が作る条件通知書PDFは「社労士へ依頼するときの条件案」（プレビューだけ。本人へは送らない）
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

import { json, readJson, methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary, canOfficeHr } from "../../../lib/gw.js";
import { guardSalaryOutput, dropSalaryInput } from "../../../lib/salary.js";
import { activeIntakeIds } from "../../../lib/hr-office-intake.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { readHandoffOffers } from "../../../lib/hire-handoff.js";
import {
  offerDocsReady, offerLetterReady, offerTitleOf, readPdf, sendPdf, pdfFileName,
} from "../../../lib/hr-offer-docs.js";
// 操作の本体は lib/hr-offer-ops.js（Office の api/hr/office-intakes.js も同じ関数を呼ぶ）
import { createOffer, actOffer, offerSendDraft, offerFile } from "../../../lib/hr-offer-ops.js";

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
    return offerSendDraft(req, res, sb, ctx, salary);
  }
  if (req.method !== "POST" && req.method !== "PATCH") return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
  const body = await readJson(req);
  // Office へ早期引き渡し済み（db/143）の応募者の条件の版は、HR からは書き換えない（見るのはよい）。
  // 契約の手続きは Office（api/hr/office-intakes.js）が同じ関数で進める
  const moved = await movedToOffice(sb, ctx, req.method === "POST" ? body?.applicantId : null, req.method === "PATCH" ? body?.id : null);
  if (moved) return json(res, moved.status, moved.body);
  if (req.method === "POST") return createOffer(res, sb, ctx, user, salary, body);
  return actOffer(req, res, sb, ctx, user, salary, body);
}


const MOVED = { status: 409, body: { error: "moved_to_office",
  hint: "Office へ引き渡し済みです。条件の版・契約の手続きは Office（人事・労務の「HRからの引き継ぎ」）で進めます（HR では見るだけです）" } };
/** 書き込む前に：対象の応募者が Office へ引き渡し済みなら 409（版の ID から応募者をたどる。読めないときは止める） */
async function movedToOffice(sb, ctx, applicantId, offerId) {
  let id = applicantId || null;
  if (!id && offerId) {
    const { data } = await sb.from("gw_hr_offers").select("applicant_id").eq("id", offerId).eq("tenant_id", ctx.tenantId).maybeSingle();
    id = data?.applicant_id || null;
  }
  if (!id) return null;
  try {
    return (await activeIntakeIds(admin(), ctx.tenantId, [id])).has(id) ? MOVED : null;
  } catch (e) {
    return { status: 500, body: { error: "db_query_failed", detail: e?.message || String(e) } };
  }
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
  if (!id || !["offer", "notice", "accepted"].includes(file)) return json(res, 403, { error: "forbidden" });
  if (file !== "offer" && !canSeeSalary(ctx)) return json(res, 403, { error: "forbidden", hint: "条件通知書には給与・報酬が入るため、権限のある方が確認します" });

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
  if (file === "offer" && !offerLetterReady(offer)) return json(res, 503, { error: "not_ready", message: "db/137_hr_finish.sql を Supabase に流してください" });
  if (file !== "offer" && !offerDocsReady(offer)) return json(res, 503, { error: "not_ready", message: "db/132_hr_offer_documents.sql を Supabase に流してください" });
  const path = file === "offer" ? offer.offer_pdf_path : file === "accepted" ? offer.accepted_pdf_path : offer.notice_pdf_path;
  if (!path) return json(res, 404, { error: "no_file", hint: file === "offer" ? "オファー通知PDFはまだありません" : file === "accepted" ? "承諾済みPDFはまだありません" : "条件通知書はまだ作っていません" });
  try {
    const bytes = await readPdf(path);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_pdf_download", target: `hr_offer:${offer.id}`, detail: { file, via: "office" } });
    const title = file === "offer" ? (offer.offer_title || offerTitleOf(offer)) : offer.notice_title;
    return sendPdf(res, bytes, pdfFileName(title, offer.version, file === "accepted"));
  } catch (e) {
    console.error("[hr/offers] office pdf", e?.message || e);
    return json(res, 500, { error: "pdf_failed", hint: "PDFを用意できませんでした" });
  }
}

