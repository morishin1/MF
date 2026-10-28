// 採用メール新着受付。採用HR権限でのみ閲覧・レビュー・応募者紐づけ。
// Gmailへの接続はここでは行わない。import は認証済みHRの明示操作だけ。
//
// GET  /api/hr/inbox             … 一覧（本文は含めない。開いたときに ?id= で取る）
// GET  /api/hr/inbox?id=<uuid>   … 1通の詳細（本文・紐づけ先・最終操作者）
// GET  /api/hr/inbox?count=1     … 件数だけ（ダッシュボードのバッジ用）：未対応・新着・自分の未読
// POST { action:"import" }        … 手動で受信候補を登録
// POST { action:"read", id }      … 本文を表示できたあとに、自分の既読を記録（未対応かどうかは変えない）
// POST { action:"review", id, status:"review"|"ignored"|"new", note }  … 確認中／対応終了（理由必須）／未対応に戻す
// POST { action:"link", id, applicantId }  … 既存の応募者に紐づける
// POST { action:"register", id, expectUpdatedAt, applicant:{...}, seenDuplicateIds:[...] }
//      … 応募者を新規登録して紐づける（登録できたときだけ「登録済み」にする。再試行で二重登録しない）
//
// ■ 未読と未対応は別
//   未対応 = 状態が「新着」「確認中」（担当者が登録・対応終了するまで）。全員で同じ。
//   未読   = その人がまだ本文を開いていない（人ごと。開いただけでは対応済みにしない）。
//   既読の表（db/proposal_hr_inbox_reads.sql）が未適用なら、未読は「確認できない」と返す（0件にしない）。
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary } from "../../lib/gw.js";
import { admin, userClient } from "../../lib/supabase.js";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { gwLog } from "../../lib/gw-audit.js";
import { payFailed } from "../../lib/hr-pay.js";
import { createApplicant } from "../../lib/hr-applicant-create.js";

const TABLE = "gw_hr_inbound_mail";
const READS = "gw_hr_inbound_mail_reads";
const SQL = "db/147_hr_inbound_mail.sql";
const READS_SQL = "db/proposal_hr_inbox_reads.sql";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX = 500;
const OPEN = ["new", "review"];
const LIST_COLUMNS = "id,provider,received_at,subject,sender_address,reply_to,source_guess,candidate_name_guess,job_title_guess,status,applicant_id,review_note,reviewed_by,reviewed_at,created_at,updated_at";
const DETAIL_COLUMNS = LIST_COLUMNS + ",provider_message_id,recipient,body_text";
// 受信メールから登録した応募者の目印（応募タイムラインの補足）。再試行で同じメールから二重に登録しないために使う
export const registeredMark = (mailId) => `採用メール新着受付から登録（受付ID: ${mailId}）`;

const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
const missing = (e) => ["42P01", "PGRST205"].includes(e?.code) || /schema cache/i.test(String(e?.message || ""));
function dbFail(res, e) {
  console.error("[hr/inbox] DB error", e?.code || "unknown");
  return json(res, missing(e) ? 503 : 500, {
    error: missing(e) ? "not_ready" : "db_failed",
    message: missing(e) ? "新着受付のデータベースが未設定です。管理者が " + SQL + " を適用してください" : "新着受付の保存・読込に失敗しました。管理者に連絡してください",
  });
}
const validEmail = (s) => !s || EMAIL.test(s);
const isDate = (s) => !!s && Number.isFinite(Date.parse(s));

/** 自分が既読にしたメールID。表が無ければ ready:false（未読数は「確認できない」） */
async function readIds(sb, tenantId, userId, mailIds) {
  if (!mailIds.length) return { ready: true, ids: new Set() };
  const { data, error } = await sb.from(READS).select("mail_id")
    .eq("tenant_id", tenantId).eq("user_id", userId).in("mail_id", mailIds);
  if (error) {
    if (!missing(error)) console.error("[hr/inbox] reads error", error.code || "unknown");
    return { ready: false, ids: new Set() };
  }
  return { ready: true, ids: new Set((data || []).map((r) => r.mail_id)) };
}

async function employeeNames(sb, tenantId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await sb.from("gw_employees").select("user_id,display_name").eq("tenant_id", tenantId).in("user_id", ids);
  return new Map((data || []).map((e) => [e.user_id, e.display_name]));
}

export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canRecruit(ctx)) return json(res, 403, { error: "forbidden", message: "HR採用権限が必要です" });
  res.setHeader("Cache-Control", "private,no-store");
  const sb = admin();

  if (req.method === "GET") {
    const q = new URL(req.url || "/", "http://localhost").searchParams;
    if (q.get("count")) return counts(res, sb, ctx, user);
    if (q.get("id")) return detail(res, sb, ctx, user, q.get("id"));
    const { data, error: e } = await sb.from(TABLE).select(LIST_COLUMNS)
      .eq("tenant_id", ctx.tenantId).order("received_at", { ascending: false }).limit(MAX);
    if (e) return dbFail(res, e);
    const rows = data || [];
    const reads = await readIds(sb, ctx.tenantId, user.id, rows.map((r) => r.id));
    const names = await employeeNames(sb, ctx.tenantId, rows.map((r) => r.reviewed_by));
    // 受信用サーバの設定状況のみ返す。Gmailトリガーが動いている証明ではない。
    const syncConfigured = process.env.HR_INBOX_SYNC_ENABLED === "1"
      && ctx.tenantId === process.env.HR_INBOX_TENANT_ID
      && String(process.env.HR_INBOX_SYNC_SECRET || "").length >= 32;
    const manualSyncReady = syncConfigured &&
      /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(process.env.HR_INBOX_GAS_WEBAPP_URL || "") &&
      String(process.env.HR_INBOX_MANUAL_SECRET || "").length >= 32;
    const lastGmailImportedAt = rows.filter((x) => x.provider === "gmail" && x.created_at)
      .map((x) => x.created_at).sort().at(-1) || null;
    const mails = rows.map((r) => ({ ...r, read: reads.ready ? reads.ids.has(r.id) : null, reviewed_by_name: names.get(r.reviewed_by) || null }));
    return json(res, 200, {
      mails, newCount: rows.filter((x) => x.status === "new").length,
      openCount: rows.filter((x) => OPEN.includes(x.status)).length,
      unreadCount: reads.ready ? mails.filter((x) => OPEN.includes(x.status) && !x.read).length : null,
      readsReady: reads.ready, readsSql: reads.ready ? null : READS_SQL,
      capped: rows.length === MAX, syncConfigured, manualSyncReady, lastGmailImportedAt,
    });
  }
  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const b = await readJson(req); if (!b || typeof b !== "object") return json(res, 400, { error: "invalid_body" });

  if (b.action === "import") {
    // 外部メールからの情報は推測で応募者情報に上書きしない。
    // Gmail実連携は認証済みの別プロバイダ接続ができるまで禁止。
    // HR担当による手動貼り付けを「Gmail由来の確定データ」と偽装させない。
    if (b.provider === "gmail") return json(res, 409, { error: "source_not_connected",
      message: "Gmailの自動取り込みは未接続です。現在は手動受付を使用してください" });
    if (b.provider !== "manual") return json(res, 400, { error: "invalid_provider" });
    const providerMessageId = str(b.providerMessageId, 200);
    const originalId = String(b.providerMessageId || "").trim();
    if (!providerMessageId || originalId !== providerMessageId)
      return json(res, 400, { error: "invalid_message_id", message: "受信メールIDが必要です" });
    const recipient = str(b.recipient, 254).toLowerCase();
    if (recipient !== "saiyou@8grp.co.jp") return json(res, 400, { error: "invalid_recipient", message: "採用窓口宛メールのみ取り込めます" });
    const receivedAt = str(b.receivedAt, 40);
    const senderAddress = str(b.senderAddress, 254);
    const replyTo = str(b.replyTo, 254);
    if (!isDate(receivedAt) || !validEmail(senderAddress) || !validEmail(replyTo))
      return json(res, 400, { error: "invalid_mail", message: "受信日時・送信元アドレスを確認してください" });
    const { data, error: e } = await sb.from(TABLE).insert({
      tenant_id: ctx.tenantId, provider: b.provider, provider_message_id: providerMessageId,
      recipient, received_at: new Date(receivedAt).toISOString(),
      subject: str(b.subject, 300), sender_address: senderAddress.toLowerCase(),
      reply_to: replyTo ? replyTo.toLowerCase() : null, body_text: str(b.bodyText, 5000) || null,
      source_guess: str(b.source, 80) || null, candidate_name_guess: str(b.candidateName, 100) || null,
      job_title_guess: str(b.jobTitle, 180) || null, created_by: user.id,
    }).select("id,status").single();
    if (e?.code === "23505") {
      const old = await sb.from(TABLE).select("id,status").eq("tenant_id", ctx.tenantId)
        .eq("provider", b.provider).eq("provider_message_id", providerMessageId).maybeSingle();
      if (old.error) return dbFail(res, old.error);
      return json(res, 200, { ok: true, duplicate: true, mail: old.data || null });
    }
    if (e) return dbFail(res, e);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.inbound_import",
      target: "hr_mail:" + data.id, detail: { provider: b.provider } });
    return json(res, 201, { ok: true, duplicate: false, mail: data });
  }

  const id = str(b.id, 40);
  if (!UUID.test(id)) return json(res, 400, { error: "invalid_id" });
  const { data: current, error: oneErr } = await sb.from(TABLE).select("id,status,applicant_id,updated_at")
    .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (oneErr) return dbFail(res, oneErr);
  if (!current) return json(res, 404, { error: "not_found" });

  // 既読は、紐づけ済みのメールでも付けてよい（状態は変えない）
  if (b.action === "read") return markRead(res, sb, ctx, user, id);

  if (current.status === "linked") return json(res, 409, { error: "already_linked",
    message: "応募者に紐づけ済みの受信記録は変更できません" });

  if (b.action === "review") {
    if (!["review", "ignored", "new"].includes(b.status)) return json(res, 400, { error: "invalid_status" });
    const note = str(b.note, 1000);
    // 対応終了（登録しない）は、あとから見て分かるよう理由を必須にする
    if (b.status === "ignored" && !note) return json(res, 400, { error: "reason_required",
      message: "対応終了にする理由（例：営業メール、重複、スポット人材として別に登録）をメモに書いてください" });
    if (b.status === current.status && b.status !== "review") return json(res, 409, { error: "no_change", message: "すでにその状態です" });
    const now = new Date().toISOString();
    const next = { status: b.status, review_note: note || null, reviewed_by: user.id, reviewed_at: now, updated_at: now };
    const { data, error: e } = await sb.from(TABLE).update(next).eq("tenant_id", ctx.tenantId)
      .eq("id", id).eq("status", current.status).select("id,status,updated_at").maybeSingle();
    if (e) return dbFail(res, e);
    if (!data) return json(res, 409, { error: "stale_record", message: "別の担当者が更新しました。読み直してください" });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.inbound_review",
      target: "hr_mail:" + id, detail: { from: current.status, status: data.status } });
    return json(res, 200, { ok: true, mail: data });
  }
  if (b.action === "link") {
    const applicantId = str(b.applicantId, 40);
    if (!UUID.test(applicantId)) return json(res, 400, { error: "invalid_applicant" });
    const { data: applicant, error: check } = await sb.from("gw_hr_applicants")
      .select("id").eq("tenant_id", ctx.tenantId).eq("id", applicantId).maybeSingle();
    if (check) return dbFail(res, check);
    if (!applicant) return json(res, 404, { error: "applicant_not_found", message: "同じ組織に登録済みの応募者を指定してください" });
    return linkTo(res, sb, ctx, user, current, applicantId, { created: false });
  }
  if (b.action === "register") return register(req, res, sb, ctx, user, current, b);
  return json(res, 400, { error: "invalid_action" });
}

/** 紐づけ。状態と「まだ誰にも紐づいていない」ことを条件に、1回だけ書く */
async function linkTo(res, sb, ctx, user, current, applicantId, { created }) {
  const now = new Date().toISOString();
  const { data, error: e } = await sb.from(TABLE).update({
    status: "linked", applicant_id: applicantId, reviewed_by: user.id, reviewed_at: now, updated_at: now,
  }).eq("tenant_id", ctx.tenantId).eq("id", current.id).eq("status", current.status)
    .is("applicant_id", null).select("id,status,applicant_id,updated_at").maybeSingle();
  if (e) return dbFail(res, e);
  if (!data) return json(res, 409, { error: "stale_record", applicantId: created ? applicantId : undefined,
    message: created
      ? "応募者は登録しましたが、メールの紐づけ前に別の操作で更新されました。読み直して「既存の応募者に紐づける」で登録済みの応募者を選んでください"
      : "紐づけ状態が更新されています。読み直してください" });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.inbound_link",
    target: "hr_mail:" + current.id, detail: { applicantId, created } });
  return json(res, 200, { ok: true, created, applicantId, mail: data });
}

const normName = (s) => String(s || "").normalize("NFKC").replace(/[\s　・･.]/g, "").toLowerCase();

/**
 * 応募者を新規登録して、このメールを紐づける。
 *   1) 画面が見ていた版（updated_at）と同じときだけ受け付ける。二重クリック・同時操作は2回目を止める
 *   2) このメールから既に登録した応募者がいれば（前回、登録だけ成功して紐づけに失敗した等）、新しく作らずそれに紐づける
 *   3) 同じメール・同じ氏名の応募者がいて、画面でまだ見せていなければ止める（人が本人を選ぶ）
 *   4) 登録できたときだけ「登録済み」にする（登録の前にメールを処理済みにしない）
 */
async function register(req, res, sb, ctx, user, current, b) {
  const expect = str(b.expectUpdatedAt, 40);
  if (!expect) return json(res, 400, { error: "expect_required", message: "画面を読み直してから登録してください" });
  // 表記（+00:00 と Z）の違いでは止めない。同じ時刻かどうかで見る（最後の判定は DB の比較で厳密に行う）
  const sameInstant = Number.isFinite(Date.parse(expect)) && Date.parse(expect) === Date.parse(current.updated_at || "");
  if (!sameInstant) return json(res, 409, { error: "stale_record", message: "このメールは別の操作で更新されています。読み直してから登録してください" });
  const a = b.applicant && typeof b.applicant === "object" ? b.applicant : {};

  // 2) このメールから登録済みの応募者（応募タイムラインの目印）
  const { data: marked, error: markErr } = await sb.from("gw_hr_timeline").select("applicant_id")
    .eq("tenant_id", ctx.tenantId).eq("event_key", "applied").eq("detail", registeredMark(current.id)).limit(2);
  if (markErr) return dbFail(res, markErr);
  if (marked?.length) return linkTo(res, sb, ctx, user, current, marked[0].applicant_id, { created: false });

  // 3) 重複の候補（同じメール・同じ氏名）。画面で見せたものは seenDuplicateIds に入っている
  const seen = new Set(Array.isArray(b.seenDuplicateIds) ? b.seenDuplicateIds.map(String) : []);
  const { data: people, error: pe } = await sb.from("gw_hr_applicants").select("id,name,email")
    .eq("tenant_id", ctx.tenantId).limit(2000);
  if (pe) return dbFail(res, pe);
  const email = str(a.email, 200).toLowerCase(), name = normName(a.name);
  const dups = (people || []).filter((p) => (email && String(p.email || "").trim().toLowerCase() === email)
    || (name && normName(p.name) === name));
  const unseen = dups.filter((p) => !seen.has(p.id));
  if (unseen.length) return json(res, 409, { error: "duplicate_candidates",
    message: "同じ人の可能性がある応募者がいます。本人なら「既存の応募者に紐づける」を、別人なら確認のうえ登録してください",
    candidates: dups.map((p) => ({ id: p.id, name: p.name, email: p.email })) });

  // 1) 同時操作の札（updated_at を書き換えられた人だけが先へ進む）
  const claimAt = new Date(Math.max(Date.now(), Date.parse(current.updated_at || 0) + 1)).toISOString();
  const { data: claimed, error: ce } = await sb.from(TABLE).update({ updated_at: claimAt, reviewed_by: user.id })
    .eq("tenant_id", ctx.tenantId).eq("id", current.id).eq("updated_at", current.updated_at).is("applicant_id", null)
    .select("id,status,updated_at").maybeSingle();
  if (ce) return dbFail(res, ce);
  if (!claimed) return json(res, 409, { error: "stale_record", message: "別の担当者が操作中です。読み直してください" });

  const salary = canSeeSalary(ctx);
  const body = {
    name: a.name, jobTitle: a.jobTitle, source: a.source,
    ...(a.email ? { email: a.email } : {}), ...(a.phone ? { phone: a.phone } : {}),
    ...(a.employmentType ? { employmentType: a.employmentType } : {}),
    ...(a.recruiterId !== undefined ? { recruiterId: a.recruiterId || null } : {}),
    ...(a.note ? { note: a.note } : {}),
  };
  const r = await createApplicant({ sb: userClient(req), ctx, user, body, salary, appliedDetail: registeredMark(current.id) });
  if (r.payError) return payFailed(res, r.payError, r.rollback);
  if (r.status !== 200) return json(res, r.status, { ...r.body, updatedAt: claimAt, mailUnchanged: true });
  return linkTo(res, sb, ctx, user, { ...current, updated_at: claimAt }, r.row.id, { created: true });
}

async function markRead(res, sb, ctx, user, id) {
  const now = new Date().toISOString();
  const { error } = await sb.from(READS).insert({ tenant_id: ctx.tenantId, mail_id: id, user_id: user.id, read_at: now });
  if (error && error.code !== "23505") {
    if (missing(error)) return json(res, 200, { ok: false, readsReady: false,
      message: "既読の記録はまだ使えません（管理者が " + READS_SQL + " を適用すると使えます）" });
    console.error("[hr/inbox] read mark failed", error.code || "unknown");
    return json(res, 500, { error: "db_failed", message: "既読を記録できませんでした" });
  }
  return json(res, 200, { ok: true, readsReady: true });
}

async function detail(res, sb, ctx, user, id) {
  if (!UUID.test(String(id))) return json(res, 400, { error: "invalid_id" });
  const { data, error } = await sb.from(TABLE).select(DETAIL_COLUMNS).eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (error) return dbFail(res, error);
  if (!data) return json(res, 404, { error: "not_found" });
  let applicant = null;
  if (data.applicant_id) {
    const r = await sb.from("gw_hr_applicants").select("id,name,job_title").eq("tenant_id", ctx.tenantId).eq("id", data.applicant_id).maybeSingle();
    applicant = r.data ? { id: r.data.id, name: r.data.name, jobTitle: r.data.job_title } : null;
  }
  const reads = await readIds(sb, ctx.tenantId, user.id, [data.id]);
  const names = await employeeNames(sb, ctx.tenantId, [data.reviewed_by]);
  return json(res, 200, { mail: { ...data, read: reads.ready ? reads.ids.has(data.id) : null,
    reviewed_by_name: names.get(data.reviewed_by) || null }, applicant, readsReady: reads.ready });
}

async function counts(res, sb, ctx, user) {
  const { data, error } = await sb.from(TABLE).select("id,status").eq("tenant_id", ctx.tenantId).in("status", OPEN).limit(1000);
  if (error) return dbFail(res, error);
  const open = data || [];
  const reads = await readIds(sb, ctx.tenantId, user.id, open.map((r) => r.id));
  return json(res, 200, {
    openCount: open.length, newCount: open.filter((r) => r.status === "new").length,
    unreadCount: reads.ready ? open.filter((r) => !reads.ids.has(r.id)).length : null,
    readsReady: reads.ready, capped: open.length === 1000,
  });
}
