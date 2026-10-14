// 採用HR：カジュアル面談のお礼＋無限道場体験のご案内（1通）と、無限道場の体験状況。採用HRを使える人（canRecruit）だけ。
//
// GET  /api/hr/applicants/lms-trial?id=…
//        … 使えるか（連携の設定・カジュアル面談の実施）・下書き・このご案内の送信記録・体験状況（LMS から、その場で読む）
// POST /api/hr/applicants/lms-trial { id, action:"send", subject, body, requestKey, resend?, variant? }
//        … LMS で本人専用の招待URLを受け取り（LMS からはメールを送らない）、お礼の本文に入れて MF から1通送る
// POST /api/hr/applicants/lms-trial { id, action:"link" }
//        … 本人専用の招待URLを、担当者が手で渡すために受け取る（画面でコピーするだけ。どこにも残さない）
//
// ■ 呼べる条件
//   無限道場を運営する会社（HR_LEAD_TENANT_ID）だけ。ほかの会社には出さない（available:false / 403）
//   連携の設定（MUGENDOJO_HR_LMS_SECRET・MUGENDOJO_LMS_BASE_URL）が無ければ 503 not_configured（LMS を呼ばない）
//   送る・URL を受け取るのは、カジュアル面談を実施済みにした後だけ（409 interview_not_done）
//
// ■ 1通だけ・二重に送らない
//   requestKey は画面が「送信」を押す前に1つ作る鍵。同じ鍵の2回目は送らず、1回目の結果を返す（duplicate: true）
//   このご案内を送った（送信中・結果不明を含む）記録があれば、resend:true が無い限り送らない（409 already_sent）
//   招待は LMS で同じ人に有効なものがあれば使い回す（reused）ので、送り直しても招待は増えない
//   送れなかった（failed）ときは、もう一度送れる（同じURLが返る）
//
// ■ すでに無限道場のアカウントがある応募者（受講生として登録済み・体験版は未参加）
//   LMS に allow_existing:true で頼み、登録URLではなく参加用URL（ログインして［このコースに参加する］）を受け取る。
//   新しいアカウントは作らない（二重登録なし）・パスワードや学習の記録はそのまま。文面は「ログインして参加」の版（draft.existing）
//   体験版に参加済みなら 409 lms_already_enrolled（招待もメールも作らない）
//   画面の文面の版（variant: "new" | "existing"）と LMS の答え（existing）が食い違ったら、送らずに 409 lms_variant_changed
//   （登録URLのつもりの文面に参加用URLを入れて送らない。招待は LMS に残り、開き直して送ると同じURLを使い回す）
//
// ■ 残さないもの
//   招待URL（トークン）・秘密は、送信記録の本文・タイムライン・監査ログ・ログに残さない（送信記録の本文は URL を伏せる）

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { sendMail, mailConfig, isEmail } from "../../../lib/mail/index.js";
import { sendProblems, sendOutcome } from "../../../lib/hr-mail-template.js";
import { lmsConfig, lmsTrialInvite, lmsTrialStatus } from "../../../lib/hr-lms-client.js";
import {
  LMS_TRIAL_MAIL_NAME, TRIAL_URL_TAG, TRIAL_EXPIRY_TAG, trialDraft, trialMailProblems, fillTrialMail,
  casualDone, shapeTrialStatus, lmsErrorHint,
} from "../../../lib/hr-lms-trial.js";
import { shapeSend } from "./mail.js";

const SQL = "db/124_hr_mail_templates.sql";
const SEND_FIELDS = "id, applicant_id, to_email, to_name, from_email, reply_to, template_id, template_version, template_name, subject, body, status, provider, provider_message_id, error, sent_by_name, created_at, finished_at";
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const LIVE = ["sent", "sending", "unknown"];
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  res.setHeader?.("Cache-Control", "no-store");
  const sb = admin();
  try {
    if (req.method === "GET") {
      const q = new URL(req.url || "/", "http://localhost").searchParams;
      return await overview(res, sb, ctx, q.get("id"));
    }
    if (req.method === "POST") {
      const b = await readJson(req);
      if (b?.action === "send") return await send(res, sb, ctx, user, b);
      if (b?.action === "link") return await link(res, sb, ctx, user, b);
      return json(res, 400, { error: "invalid_action" });
    }
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[hr/applicants/lms-trial]", e?.message || e);
    return json(res, 500, { error: "lms_trial_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** 無限道場を運営する会社か（LMS は1社分。ほかの会社の応募者を LMS へ送らない） */
function tenantGate(ctx, env = process.env) {
  const owner = String(env.HR_LEAD_TENANT_ID || "").trim();
  if (!owner) return { ok: false, missing: ["HR_LEAD_TENANT_ID"] };
  return owner === ctx.tenantId ? { ok: true } : { ok: false, other: true };
}

function setup(ctx) {
  const gate = tenantGate(ctx);
  const cfg = lmsConfig();
  const missing = [...(gate.missing || []), ...cfg.missing];
  return { other: Boolean(gate.other), configured: !gate.other && missing.length === 0, missing };
}

async function loadApplicant(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_hr_applicants").select("id, tenant_id, name, email")
    .eq("id", String(id)).eq("tenant_id", ctx.tenantId).maybeSingle());
}

async function interviewDone(sb, ctx, a) {
  const rows = await must(sb.from("gw_hr_interviews").select("id, kind, conducted_at, canceled_at")
    .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id));
  return casualDone(rows);
}

async function trialSends(sb, ctx, a) {
  const rows = await must(sb.from("gw_hr_mail_sends").select(SEND_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id).eq("template_name", LMS_TRIAL_MAIL_NAME)
    .order("created_at", { ascending: false }).limit(20));
  return rows || [];
}

function mailView(a) {
  const cfg = mailConfig("recruiting");
  const hasEmail = isEmail(a.email);
  return { configured: cfg.configured && hasEmail, reason: !hasEmail ? "応募者のメールアドレスが登録されていません" : cfg.reason, from: cfg.from || null };
}

async function overview(res, sb, ctx, id) {
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });
  const s = setup(ctx);
  if (s.other) return json(res, 200, { available: false });
  const a = await loadApplicant(sb, ctx, id);
  if (!a) return json(res, 404, { error: "not_found" });
  const [done, sends] = await Promise.all([interviewDone(sb, ctx, a), trialSends(sb, ctx, a)]);

  let lms;
  if (!s.configured) lms = { ok: false, error: "not_configured", hint: lmsErrorHint({ ok: false, error: "not_configured", missing: s.missing }) };
  else if (!isEmail(a.email)) lms = { ok: false, error: "no_email", hint: "メールアドレスが無いため、体験状況を調べられません" };
  else {
    const r = await lmsTrialStatus([String(a.email).trim().toLowerCase()]);
    lms = r.ok ? { ok: true, ...shapeTrialStatus(r.data.items?.[0] || null), course: r.data.trial_course?.title || null }
      : { ok: false, error: r.error, hint: lmsErrorHint(r) };
  }

  return json(res, 200, {
    available: true,
    configured: s.configured, missing: s.missing,
    applicant: { id: a.id, name: a.name, email: a.email || null },
    interviewDone: done,
    mail: mailView(a),
    draft: { ...trialDraft(a, { existing: Boolean(lms.ok && lms.existing) }), tags: [TRIAL_URL_TAG, TRIAL_EXPIRY_TAG] },
    sends: sends.map(shapeSend),
    lms,
  });
}

/** 送る・URL を受け取る前の共通の確かめ。問題があれば応答を返す */
async function precheck(res, sb, ctx, b) {
  const s = setup(ctx);
  if (s.other) { json(res, 403, { error: "forbidden", hint: "この会社では無限道場の体験を案内できません" }); return null; }
  if (!s.configured) {
    json(res, 503, { error: "not_configured", missing: s.missing, hint: lmsErrorHint({ ok: false, error: "not_configured", missing: s.missing }) });
    return null;
  }
  const a = await loadApplicant(sb, ctx, b?.id);
  if (!a) { json(res, 404, { error: "not_found" }); return null; }
  if (!isEmail(a.email)) { json(res, 400, { error: "no_email", hint: "応募者のメールアドレスが登録されていません。登録してから案内してください" }); return null; }
  if (!(await interviewDone(sb, ctx, a))) {
    json(res, 409, { error: "interview_not_done", hint: "カジュアル面談を実施済みにしてから案内してください" });
    return null;
  }
  return a;
}

/** LMS で招待URLを受け取る。参加済み・対応前の LMS・失敗は応答を返して null */
async function inviteFor(res, ctx, user, a, action) {
  const r = await lmsTrialInvite({ email: String(a.email).trim().toLowerCase(), name: a.name || undefined });
  if (!r.ok) {
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action, target: `hr_applicant:${a.id}`, detail: { status: "lms_error", lms: r.error } });
    json(res, r.unreachable || r.status >= 500 || r.status === 0 ? 503 : 502, { error: "lms_error", lms: r.error, hint: lmsErrorHint(r) });
    return null;
  }
  const d = r.data;
  if (d.result === "already_enrolled") {
    json(res, 409, { error: "lms_already_enrolled",
      hint: "この方は、すでに無限道場の体験版に参加しています。新しい案内は不要です（体験の状況は［最新にする］で確かめられます）" });
    return null;
  }
  if (d.result === "already_registered" || !d.invite?.url) {
    // 既存アカウントへの案内（allow_existing）に対応する前の LMS
    json(res, 409, { error: "lms_already_registered",
      hint: "この方は、すでに無限道場のアカウントを持っています。新しく登録してもらう必要はありません。ログインして体験版を開くよう案内してください（体験版の受講登録は無限道場の管理画面で行います）" });
    return null;
  }
  return { url: d.invite.url, expiresAt: d.invite.expires_at || null, result: d.result, existing: d.existing === true };
}

async function send(res, sb, ctx, user, b) {
  const requestKey = String(b?.requestKey || "");
  if (!REQUEST_KEY_RE.test(requestKey)) return json(res, 400, { error: "invalid_body", hint: "送信の鍵がありません。画面を開き直してください" });

  // 同じ鍵で送ったことがあれば、送らずに前の結果を返す（二度押し・通信のやり直し）
  const prev = await must(sb.from("gw_hr_mail_sends").select(SEND_FIELDS).eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle());
  if (prev) return json(res, 200, { duplicate: true, send: shapeSend(prev), status: prev.status });

  const a = await precheck(res, sb, ctx, b);
  if (!a) return;

  // 1人に1通（送り直しは、担当者が「再送する」を選んだときだけ）
  const live = (await trialSends(sb, ctx, a)).find((s) => LIVE.includes(s.status));
  if (live?.status === "sending") return json(res, 409, { error: "in_progress", hint: "このご案内は送信中です。少し待ってから開き直してください" });
  if (live && b?.resend !== true) {
    return json(res, 409, { error: "already_sent", send: shapeSend(live),
      hint: live.status === "unknown"
        ? "前回の送信は、届いたかどうか分かりません。相手に届いていないことを確かめてから［再送する］を使ってください"
        : "このご案内はすでに送っています。届いていない・期限が切れた場合は［再送する］を使ってください" });
  }

  const subject = String(b?.subject ?? "").trim();
  const body = String(b?.body ?? "").replace(/\r\n/g, "\n");
  // URL を受け取る前に断れるものは、ここで断る（LMS に招待を作らせない）
  const pre = [...trialMailProblems({ subject, body }),
    ...sendProblems({ subject, body: fillTrialMail({ subject, body, name: a.name, url: "https://example.invalid/" }).text, applicantId: a.id })];
  if (pre.length) return json(res, 400, { error: "cannot_send", hint: pre[0], problems: pre });

  const cfg = mailConfig("recruiting");
  if (!cfg.configured) return json(res, 409, { error: "mail_not_configured", hint: `メール送信の設定がありません（${cfg.reason}）` });

  const inv = await inviteFor(res, ctx, user, a, "hr.lms_trial_mail");
  if (!inv) return;
  // 文面の版（登録URL／ログインして参加）と、LMS が返した URL の種類が合わなければ送らない
  if (b?.variant === "new" || b?.variant === "existing") {
    if ((b.variant === "existing") !== inv.existing) {
      return json(res, 409, { error: "lms_variant_changed", existing: inv.existing,
        hint: inv.existing
          ? "この方は、すでに無限道場のアカウントを持っています。「ログインして参加」の文面に切り替えたので、内容を確かめてから送ってください（メールは送っていません）"
          : "この方は、まだ無限道場のアカウントを持っていません。登録URLの文面に切り替えたので、内容を確かめてから送ってください（メールは送っていません）" });
    }
  }
  const m = fillTrialMail({ subject, body, name: a.name, url: inv.url, expiresAt: inv.expiresAt });
  const problems = sendProblems({ subject: m.subject, body: m.text, applicantId: a.id });
  if (problems.length) return json(res, 400, { error: "cannot_send", hint: problems[0], problems });

  // 先に「送信中」で記録する（同じ鍵の同時の2回目は、一意の索引で入れられない＝送らない）。本文は URL を伏せる
  const { data: row, error: insErr } = await sb.from("gw_hr_mail_sends").insert({
    tenant_id: ctx.tenantId, applicant_id: a.id, to_email: a.email, to_name: a.name,
    from_email: cfg.from, reply_to: cfg.replyTo, template_id: null, template_version: null, template_name: LMS_TRIAL_MAIL_NAME,
    subject: m.subject, body: m.recordBody, status: "sending", request_key: requestKey,
    sent_by: user.id, sent_by_name: ctx.employee?.display_name || null,
  }).select(SEND_FIELDS).single();
  if (insErr) {
    if (insErr.code === "23505") {
      const same = await must(sb.from("gw_hr_mail_sends").select(SEND_FIELDS).eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle());
      return json(res, 200, { duplicate: true, send: same ? shapeSend(same) : null, status: same?.status || "sending" });
    }
    throw insErr;
  }

  const mail = await sendMail({ purpose: "recruiting", to: a.email, subject: m.subject, text: m.text });
  const outcome = sendOutcome(mail);
  const done = await must(sb.from("gw_hr_mail_sends").update({
    status: outcome, provider: mail.provider || null, provider_message_id: mail.providerMessageId || null,
    from_email: mail.from || cfg.from, reply_to: mail.replyTo || cfg.replyTo,
    error: outcome === "sent" ? null : String(mail.error || "").slice(0, 300) || null, finished_at: new Date().toISOString(),
  }).eq("id", row.id).eq("tenant_id", ctx.tenantId).select(SEND_FIELDS).single());

  if (outcome === "sent") {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: a.id, event_key: "mail_sent",
      label: `メールを送信：${LMS_TRIAL_MAIL_NAME}${b?.resend === true ? "（再送）" : ""}`, detail: m.subject, created_by: user.id,
    });
  }
  // 本文・宛先・URL は監査ログに残さない
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.lms_trial_mail", target: `hr_applicant:${a.id}`,
    detail: { send: row.id, status: outcome, invite: inv.result, existing: inv.existing, resend: b?.resend === true, providerMessageId: mail.providerMessageId || null } });

  const shaped = shapeSend(done);
  const invite = { result: inv.result, expiresAt: inv.expiresAt, existing: inv.existing };
  if (outcome === "sent") return json(res, 200, { status: "sent", send: shaped, invite });
  if (outcome === "unknown") {
    return json(res, 202, { status: "unknown", send: shaped, invite,
      hint: "送信サービスの応答がなく、送れたかどうか分かりません。相手に届いているか確かめるまで、送り直さないでください" });
  }
  if (outcome === "not_sent") return json(res, 409, { status: "not_sent", send: shaped, invite, hint: `送っていません（${mail.error || "設定がありません"}）` });
  return json(res, 502, { status: "failed", send: shaped, invite,
    hint: `送れませんでした（${mail.error || "原因不明"}）。もう一度送ると、同じ招待URLで送ります` });
}

/** 担当者が手で渡すための URL（画面でコピーするだけ。記録・ログには URL を残さない） */
async function link(res, sb, ctx, user, b) {
  const a = await precheck(res, sb, ctx, b);
  if (!a) return;
  const inv = await inviteFor(res, ctx, user, a, "hr.lms_trial_link");
  if (!inv) return;
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.lms_trial_link", target: `hr_applicant:${a.id}`, detail: { invite: inv.result, existing: inv.existing } });
  return json(res, 200, { url: inv.url, expiresAt: inv.expiresAt, result: inv.result, existing: inv.existing });
}

/** 画面が「送信」を押す前に作る鍵（テスト用にも出す） */
export const newRequestKey = () => crypto.randomBytes(16).toString("base64url");
