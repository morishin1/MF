// GET  /api/hr/applicants/message?id=…&kind=hired|hold|rejected
//        … 採用判断のあと本人へ伝える文面の下書き（lib/hr-messages.js）と、メールで送れるか
// POST /api/hr/applicants/message { id, kind, channel: "email"|"manual", subject, body }
//        … email：本人のメールアドレスへ送る（lib/mail。送信の設定が無ければ 409 で理由を返す）
//          manual：自分のメールソフト等で送った、という記録だけを残す
//
// ■ 残すもの
//   選考タイムライン（いつ・何を・どの方法で伝えたか。件名まで）と監査ログ（本文は残さない）。
//   本人への文面は画面で直してから送れる。内定の条件は書かない（合格通知で渡す）。
//
// ■ 権限
//   採用HRを使える人（canRecruit）。社長が CEO REVIEW で判断したあと、そのまま送れる。

import { json, readJson, methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { sendMail, mailConfig, isEmail } from "../../../lib/mail/index.js";
import { decisionMessage, DECISION_MESSAGE_KINDS, DECISION_MESSAGE_LABEL } from "../../../lib/hr-messages.js";

const SUBJECT_MAX = 200;
const BODY_MAX = 5000;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  if (req.method === "GET") {
    const q = new URL(req.url || "/", "http://localhost").searchParams;
    return draft(res, sb, ctx, q.get("id"), q.get("kind"));
  }
  if (req.method === "POST") return send(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function loadApplicant(sb, ctx, id) {
  if (!id) return null;
  const { data } = await sb.from("gw_hr_applicants")
    .select("id, tenant_id, name, email, job_title, decision, decision_due_on")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}

async function draft(res, sb, ctx, id, kind) {
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });
  if (!DECISION_MESSAGE_KINDS.includes(kind)) {
    return json(res, 400, { error: "invalid_query", detail: `kind は ${DECISION_MESSAGE_KINDS.join(" / ")} のいずれかです` });
  }
  const a = await loadApplicant(sb, ctx, id);
  if (!a) return json(res, 404, { error: "not_found" });
  const { data: tenant } = await sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle();
  const msg = decisionMessage(kind, {
    name: a.name, tenantName: tenant?.name || null, senderName: ctx.employee?.display_name || null,
    jobTitle: a.job_title, dueOn: a.decision_due_on,
  });
  const cfg = mailConfig("recruiting");
  return json(res, 200, {
    kind, label: DECISION_MESSAGE_LABEL[kind], to: a.email || null, subject: msg.subject, body: msg.body,
    // メールで送れるか（送れなければ、画面はコピー・メールソフトで開く・送付済みの記録だけを出す）
    mail: { configured: cfg.configured && isEmail(a.email), reason: !isEmail(a.email) ? "本人のメールアドレスが登録されていません" : cfg.reason },
  });
}

async function send(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!DECISION_MESSAGE_KINDS.includes(body?.kind)) return json(res, 400, { error: "invalid_body", detail: "kind が不正です" });
  if (!["email", "manual"].includes(body.channel)) return json(res, 400, { error: "invalid_body", detail: "channel は email か manual です" });
  const subject = String(body.subject ?? "").trim();
  const text = String(body.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!subject || subject.length > SUBJECT_MAX || /[\r\n]/.test(subject)) {
    return json(res, 400, { error: "invalid_body", detail: `件名は1行・${SUBJECT_MAX}文字以内で入力してください` });
  }
  if (!text || text.length > BODY_MAX) return json(res, 400, { error: "invalid_body", detail: `本文は${BODY_MAX}文字以内で入力してください` });

  const a = await loadApplicant(sb, ctx, body.id);
  if (!a) return json(res, 404, { error: "not_found" });

  let mail = null;
  if (body.channel === "email") {
    if (!isEmail(a.email)) return json(res, 400, { error: "no_email", hint: "本人のメールアドレスが登録されていません" });
    mail = await sendMail({ purpose: "recruiting", to: a.email, subject, text });
    if (mail.status === "skipped") {
      return json(res, 409, { error: "mail_not_configured", hint: `メール送信の設定がありません（${mail.error}）。文面をコピーして送ってください` });
    }
    if (mail.status !== "sent") {
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_message",
        target: `hr_applicant:${a.id}`, detail: { kind: body.kind, channel: "email", status: mail.status, error: mail.error } });
      return json(res, 502, { error: "mail_failed", hint: `メールを送れませんでした（${mail.error || "原因不明"}）` });
    }
  }

  const label = `本人へ連絡：${DECISION_MESSAGE_LABEL[body.kind]}（${body.channel === "email" ? "メール送信" : "送付済みとして記録"}）`;
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: a.id, event_key: `message_${body.kind}`,
    label, detail: subject, created_by: user.id,
  });
  // 本文・宛先は監査ログに残さない（件名の有無と結果だけ）
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_message", target: `hr_applicant:${a.id}`,
    detail: { kind: body.kind, channel: body.channel, status: mail ? mail.status : "recorded", providerMessageId: mail?.providerMessageId || null },
  });
  return json(res, 200, { ok: true, channel: body.channel, status: mail ? mail.status : "recorded" });
}
