// メール送信の窓口。送信サービスは、ここから先だけが知っている（交換できる）。
//
// ■ 設計
//
//   呼ぶ側（api/keiei/onboarding.js）は sendMail() と mailConfig() だけを使う。
//   Resend でも Gmail API でも SES でも、同じ形の部品（lib/mail/<name>.js）を足して
//   ADAPTERS に1行加えれば替えられる。部品は次の形:
//     name                                    … 履歴に残す名前
//     ready(env) → { ok, reason? }            … 使える状態か
//     send({from,to,subject,text,replyTo}, {env, fetchImpl}) → { id }   … 失敗は例外
//
// ■ 設定（環境変数。コードに直接書かない）
//
//   HR_ONBOARDING_FROM   入社案内の送信元。"エイト 人事 <hr@example.com>" か "hr@example.com"
//   HR_RECRUITING_FROM   採用の連絡（選考結果）の送信元。未設定なら HR_ONBOARDING_FROM を使う
//   MAIL_PROVIDER        使う送信サービス（resend など）。空なら実送信しない
//   MAIL_SEND_ENABLED    "1" のときだけ実送信する（既定は止まっている。本番でも、明示するまで送らない）
//   MAIL_REPLY_TO        返信先（任意）
//   RESEND_API_KEY       Resend を使うとき
//   SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
//                        SMTP（Xserver等）を使うとき。推奨: 465 + SMTP_SECURE=1
//
//   どれかが足りなければ「未設定」。実送信はせず、案内URLを管理画面からコピーして渡す。
//   このとき sendMail は例外を投げず、status: "skipped" と理由を返す（履歴にも残る）。
//
// ■ 送らないもの
//
//   パスワードは本文に書かない（呼ぶ側の文面が、期限つきのURLだけを使う）。
//   宛先は1件だけ。改行を含む宛先・件名は断る（ヘッダーの差し込みを防ぐ）。

import * as resend from "./resend.js";
import * as smtp from "./smtp.js";

export const ADAPTERS = { resend, smtp };

/** 用途ごとの送信元の環境変数。用途を足すときは、ここに1行 */
export const SENDER_ENV = { onboarding: "HR_ONBOARDING_FROM", recruiting: "HR_RECRUITING_FROM" };
/** 用途の送信元が未設定のとき、代わりに使う環境変数（採用の連絡は、人事の送信元で送ってよい） */
export const SENDER_FALLBACK_ENV = { recruiting: "HR_ONBOARDING_FROM" };

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
export const isEmail = (s) => EMAIL_RE.test(String(s || "").trim());

/** "名前 <a@b.c>" からアドレスだけを取り出す。取れなければ null */
export function addressOf(from) {
  const s = String(from || "").trim();
  const m = s.match(/<([^<>]+)>\s*$/);
  const a = (m ? m[1] : s).trim();
  return isEmail(a) ? a : null;
}

/**
 * いまの設定で送れるか。画面が「メール送信は未設定です」と出すために使う。
 * @returns {{ configured:boolean, provider:string|null, from:string|null, fromAddress:string|null,
 *             replyTo:string|null, reason:string|null, enabled:boolean }}
 */
export function mailConfig(purpose = "onboarding", env = process.env) {
  const provider = String(env.MAIL_PROVIDER || "").trim().toLowerCase() || null;
  const from = String(env[SENDER_ENV[purpose]] || env[SENDER_FALLBACK_ENV[purpose]] || "").trim() || null;
  const fromAddress = addressOf(from);
  const replyTo = String(env.MAIL_REPLY_TO || "").trim() || null;
  const enabled = String(env.MAIL_SEND_ENABLED || "").trim() === "1";
  const out = { configured: false, provider, from, fromAddress, replyTo, reason: null, enabled };

  const envName = SENDER_ENV[purpose] || "（送信元の環境変数）";
  if (!provider) return { ...out, reason: "MAIL_PROVIDER が設定されていません" };
  const adapter = ADAPTERS[provider];
  if (!adapter) return { ...out, reason: `MAIL_PROVIDER=${provider} に対応する送信部品がありません` };
  if (!from) return { ...out, reason: `${envName} が設定されていません` };
  if (!fromAddress) return { ...out, reason: `${envName} の形式が正しくありません（例: 会社名 <hr@example.com>）` };
  const ready = adapter.ready(env);
  if (!ready.ok) return { ...out, reason: ready.reason };
  if (!enabled) return { ...out, reason: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています" };
  return { ...out, configured: true };
}

/** 添付ファイル（任意）。PDF だけ・合計 5MB まで（採用HRの条件通知書。ほかの送信は添付を使わない） */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_TYPES = ["application/pdf"];
/** 添付を確かめる。問題があれば理由（文字列）、無ければ null */
export function attachmentProblem(list) {
  if (list == null) return null;
  if (!Array.isArray(list) || list.length > 3) return "添付ファイルの指定が正しくありません";
  let total = 0;
  for (const a of list) {
    const name = String(a?.filename || "");
    if (!name || /[\r\n\/\\]/.test(name) || name.length > 120) return "添付ファイル名が正しくありません";
    if (!ATTACHMENT_TYPES.includes(a?.contentType)) return "添付できるのは PDF だけです";
    if (!(a?.content instanceof Uint8Array) || !a.content.length) return "添付ファイルの中身がありません";
    total += a.content.length;
  }
  return total > ATTACHMENT_MAX_BYTES ? "添付ファイルが大きすぎます" : null;
}

/**
 * @param {{purpose?:string, to:string, subject:string, text:string, replyTo?:string,
 *          attachments?:{filename:string, content:Uint8Array, contentType:"application/pdf"}[]}} msg
 *   attachments … 任意。渡さなければ、これまでとまったく同じ送り方
 * @param {{env?:object, fetchImpl?:Function, smtpSendImpl?:Function}} [opts]
 * @returns {Promise<{status:"sent"|"failed"|"skipped", provider:string, from:string|null, replyTo:string|null,
 *                    providerMessageId:string|null, error:string|null}>}
 *   例外は投げない。呼ぶ側は、結果を履歴（gw_mail_messages）に残す
 */
export async function sendMail(msg, { env = process.env, fetchImpl, smtpSendImpl } = {}) {
  const purpose = msg.purpose || "onboarding";
  const cfg = mailConfig(purpose, env);
  const base = { provider: cfg.provider || "none", from: cfg.from, replyTo: msg.replyTo || cfg.replyTo || null,
    providerMessageId: null, error: null };

  const to = String(msg.to || "").trim();
  const subject = String(msg.subject || "");
  if (!isEmail(to)) return { ...base, status: "failed", error: "宛先のメールアドレスの形式が正しくありません" };
  if (/[\r\n]/.test(subject) || /[\r\n]/.test(to)) return { ...base, status: "failed", error: "宛先・件名に改行は使えません" };
  if (!String(msg.text || "").trim()) return { ...base, status: "failed", error: "本文が空です" };
  const badAttachment = attachmentProblem(msg.attachments);
  if (badAttachment) return { ...base, status: "failed", error: badAttachment };

  if (!cfg.configured) return { ...base, provider: "none", status: "skipped", error: cfg.reason };

  try {
    const adapter = ADAPTERS[cfg.provider];
    const r = await adapter.send(
      { from: cfg.from, to, subject, text: String(msg.text), replyTo: base.replyTo || undefined,
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}) },
      { env, ...(fetchImpl ? { fetchImpl } : {}), ...(smtpSendImpl ? { smtpSendImpl } : {}) });
    return { ...base, status: "sent", providerMessageId: r?.id || null };
  } catch (e) {
    return { ...base, status: "failed", error: String(e?.message || e).slice(0, 300) };
  }
}
