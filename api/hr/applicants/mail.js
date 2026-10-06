// 採用HR：応募者へ、ひな型からメールを送る（db/124・lib/hr-mail-template.js）。採用HRを使える人（canRecruit）だけ。
//
// GET  /api/hr/applicants/mail?id=…[&templateId=…]
//        … 宛先（氏名・メールアドレス）・使用中のひな型・選んだひな型の差し込み結果（足りない項目と理由）・
//          送信の設定（送信元・返信先）・この応募者へ送った記録。templateId が無ければ「応募受付」の既定
// POST /api/hr/applicants/mail { id, templateId, templateVersion, subject, body, requestKey }
//        … 画面で確かめた（直した）件名・本文を、この応募者1人へ送る。ひな型そのものは変えない
//
// ■ 送る前に断るもの（400）
//   件名・本文が空／件名の改行／長さ／差し込まれていない {{…}}／ほかの応募者の予約URL（applicant_id が違う）
//   ひな型が非表示・他社のもの・版が変わった（409。開き直してもらう）／送信の設定が無い（409）
//
// ■ 二重送信を防ぐ
//   requestKey は画面が「送信」を押す前に1つ作る鍵。同じ鍵の2回目は送らず、1回目の結果を返す（duplicate: true）。
//   記録を「送信中」で先に入れてから送る（一意の索引で、同時の2回目は入れられない）。
//
// ■ 結果
//   sent（200）… メールサービスが受け付けた（相手に届いた・開いた、ではない）
//   failed（502）… 送れなかった／unknown（202）… 時間切れなどで、受け付けられたか分からない（すぐに送り直さない）
//   送った記録（gw_hr_mail_sends）には、送った時点の件名・本文・ひな型の ID と版を固定で残す。
//   監査ログには本文・宛先を残さない。
//
// ■ 予約URL
//   {{面談予約URL}} はサーバーで、この応募者の ID を付けて作る（lib/hr.js schedulingUrlFor）。
//   画面から渡された本文に、ほかの応募者の ID の予約URLがあれば送らない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { sendMail, mailConfig, isEmail } from "../../../lib/mail/index.js";
import { mailValues, renderMail, sendProblems, sendOutcome, MAIL_FIELDS } from "../../../lib/hr-mail-template.js";
import { ensureStandard, shapeTemplate } from "../mail-templates.js";

const SQL = "db/124_hr_mail_templates.sql";
const TPL_FIELDS = "id, tenant_id, name, purpose, subject, body, is_active, is_default, version, seed_key, updated_at, created_at";
const SEND_FIELDS = "id, applicant_id, to_email, to_name, from_email, reply_to, template_id, template_version, template_name, subject, body, status, provider, provider_message_id, error, sent_by_name, created_at, finished_at";
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = admin();
  try {
    if (req.method === "GET") {
      const q = new URL(req.url || "/", "http://localhost").searchParams;
      return await draft(res, sb, ctx, q.get("id"), q.get("templateId"));
    }
    if (req.method === "POST") return await send(req, res, sb, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[hr/applicants/mail]", e?.message || e);
    return json(res, 500, { error: "applicant_mail_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

export const shapeSend = (s) => ({
  id: s.id, toEmail: s.to_email, toName: s.to_name, from: s.from_email, replyTo: s.reply_to,
  templateId: s.template_id, templateVersion: s.template_version, templateName: s.template_name,
  subject: s.subject, body: s.body, status: s.status, provider: s.provider, providerMessageId: s.provider_message_id,
  error: s.error, sentByName: s.sent_by_name, createdAt: s.created_at, finishedAt: s.finished_at,
});

async function loadApplicant(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_hr_applicants").select("id, tenant_id, name, email, job_title, recruiter_id, lead_category")
    .eq("id", String(id)).eq("tenant_id", ctx.tenantId).maybeSingle());
}

/** 差し込みの値（会社名・担当者名）。担当者は応募者の採用担当、無ければ送る人 */
async function valuesFor(sb, ctx, a, purpose) {
  const tenant = await must(sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle());
  let ownerName = null;
  if (a.recruiter_id) {
    const e = await must(sb.from("gw_employees").select("display_name").eq("id", a.recruiter_id).eq("tenant_id", ctx.tenantId).maybeSingle());
    ownerName = e?.display_name || null;
  }
  return mailValues({ applicant: a, purpose, companyName: tenant?.name, ownerName, senderName: ctx.employee?.display_name });
}

function configView(a) {
  const cfg = mailConfig("recruiting");
  const hasEmail = isEmail(a.email);
  return {
    configured: cfg.configured && hasEmail,
    reason: !hasEmail ? "応募者のメールアドレスが登録されていません" : cfg.reason,
    from: cfg.from || null, replyTo: cfg.replyTo || null,
  };
}

async function history(sb, ctx, a) {
  const rows = await must(sb.from("gw_hr_mail_sends").select(SEND_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id).order("created_at", { ascending: false }).limit(30));
  return (rows || []).map(shapeSend);
}

async function draft(res, sb, ctx, id, templateId) {
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });
  const a = await loadApplicant(sb, ctx, id);
  if (!a) return json(res, 404, { error: "not_found" });
  await ensureStandard(sb, ctx);
  const rows = await must(sb.from("gw_hr_mail_templates").select(TPL_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("is_active", true).order("updated_at", { ascending: false }).limit(300));
  const templates = (rows || []).map(shapeTemplate);
  const chosen = templateId
    ? templates.find((t) => t.id === templateId)
    : (templates.find((t) => t.isDefault && t.purpose === "application") || templates.find((t) => t.isDefault) || templates[0]);
  if (templateId && !chosen) return json(res, 404, { error: "template_not_found", hint: "このひな型は非表示にされたか、ありません。一覧を開き直してください" });

  let rendered = null;
  if (chosen) {
    const r = renderMail(chosen, await valuesFor(sb, ctx, a, chosen.purpose));
    rendered = { templateId: chosen.id, templateVersion: chosen.version, templateName: chosen.name, ...r };
  }
  return json(res, 200, {
    applicant: { id: a.id, name: a.name, email: a.email || null, jobTitle: a.job_title || null },
    templates: templates.map(({ body, subject, ...t }) => t),
    rendered, mail: configView(a), fields: MAIL_FIELDS, sends: await history(sb, ctx, a),
  });
}

async function send(req, res, sb, ctx, user) {
  const b = await readJson(req);
  const requestKey = String(b?.requestKey || "");
  if (!REQUEST_KEY_RE.test(requestKey)) return json(res, 400, { error: "invalid_body", hint: "送信の鍵がありません。画面を開き直してください" });

  // 同じ鍵で送ったことがあれば、送らずに前の結果を返す（二度押し・通信のやり直し）
  const prev = await must(sb.from("gw_hr_mail_sends").select(SEND_FIELDS).eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle());
  if (prev) return json(res, 200, { duplicate: true, send: shapeSend(prev), status: prev.status });

  const a = await loadApplicant(sb, ctx, b?.id);
  if (!a) return json(res, 404, { error: "not_found" });
  if (!isEmail(a.email)) return json(res, 400, { error: "no_email", hint: "応募者のメールアドレスが登録されていません" });

  const t = b?.templateId ? await must(sb.from("gw_hr_mail_templates").select(TPL_FIELDS)
    .eq("id", String(b.templateId)).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  if (!t) return json(res, 404, { error: "template_not_found", hint: "ひな型がありません。開き直してください" });
  if (!t.is_active) return json(res, 409, { error: "template_inactive", hint: "このひな型は非表示になりました。別のひな型を選んでください" });
  if (Number(b.templateVersion) !== t.version) {
    return json(res, 409, { error: "template_changed", hint: "送る前にひな型が直されました。ひな型を選び直して、内容を確かめてから送ってください" });
  }

  const subject = String(b?.subject ?? "").trim();
  const text = String(b?.body ?? "").replace(/\r\n/g, "\n");
  const problems = sendProblems({ subject, body: text, applicantId: a.id });
  if (problems.length) return json(res, 400, { error: "cannot_send", hint: problems[0], problems });

  const cfg = mailConfig("recruiting");
  if (!cfg.configured) return json(res, 409, { error: "mail_not_configured", hint: `メール送信の設定がありません（${cfg.reason}）` });

  // 先に「送信中」で記録する（同じ鍵の同時の2回目は、一意の索引で入れられない＝送らない）
  const { data: row, error: insErr } = await sb.from("gw_hr_mail_sends").insert({
    tenant_id: ctx.tenantId, applicant_id: a.id, to_email: a.email, to_name: a.name,
    from_email: cfg.from, reply_to: cfg.replyTo, template_id: t.id, template_version: t.version, template_name: t.name,
    subject, body: text, status: "sending", request_key: requestKey,
    sent_by: user.id, sent_by_name: ctx.employee?.display_name || null,
  }).select(SEND_FIELDS).single();
  if (insErr) {
    if (insErr.code === "23505") {
      const same = await must(sb.from("gw_hr_mail_sends").select(SEND_FIELDS).eq("tenant_id", ctx.tenantId).eq("request_key", requestKey).maybeSingle());
      return json(res, 200, { duplicate: true, send: same ? shapeSend(same) : null, status: same?.status || "sending" });
    }
    throw insErr;
  }

  const mail = await sendMail({ purpose: "recruiting", to: a.email, subject, text });
  const outcome = sendOutcome(mail);
  const done = await must(sb.from("gw_hr_mail_sends").update({
    status: outcome, provider: mail.provider || null, provider_message_id: mail.providerMessageId || null,
    from_email: mail.from || cfg.from, reply_to: mail.replyTo || cfg.replyTo,
    error: outcome === "sent" ? null : String(mail.error || "").slice(0, 300) || null, finished_at: new Date().toISOString(),
  }).eq("id", row.id).eq("tenant_id", ctx.tenantId).select(SEND_FIELDS).single());

  if (outcome === "sent") {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: a.id, event_key: "mail_sent",
      label: `メールを送信：${t.name}`, detail: subject, created_by: user.id,
    });
  }
  // 本文・宛先は監査ログに残さない
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_mail", target: `hr_applicant:${a.id}`,
    detail: { send: row.id, template: t.id, version: t.version, status: outcome, providerMessageId: mail.providerMessageId || null } });

  const shaped = shapeSend(done);
  if (outcome === "sent") return json(res, 200, { status: "sent", send: shaped });
  if (outcome === "unknown") {
    return json(res, 202, { status: "unknown", send: shaped,
      hint: "送信サービスの応答がなく、送れたかどうか分かりません。相手に届いているか確かめるまで、送り直さないでください" });
  }
  if (outcome === "not_sent") return json(res, 409, { status: "not_sent", send: shaped, hint: `送っていません（${mail.error || "設定がありません"}）` });
  return json(res, 502, { status: "failed", send: shaped, hint: `送れませんでした（${mail.error || "原因不明"}）。内容はそのまま残っています` });
}

/** 画面が「送信」を押す前に作る鍵（テスト用にも出す） */
export const newRequestKey = () => crypto.randomBytes(16).toString("base64url");
