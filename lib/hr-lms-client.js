// 採用HR → 無限道場（LMS）のサーバー間呼び出し。体験の招待（trial-invite）と体験状況（trial-status）。
// LMS 側の仕様：eight-its/lms v3-next/docs/hr-lms-api.md
//
// ■ 設定（どちらか無ければ呼ばない＝ configured:false）
//   MUGENDOJO_HR_LMS_SECRET … LMS と同じ値（32文字以上）。署名にだけ使い、応答・ログには出さない
//   MUGENDOJO_LMS_BASE_URL  … LMS の URL（例：https://mugendojo.jp）。https だけ（手元の試験用に localhost の http は許す）
//
// ■ 署名（応募連携 /api/hr/leads と同じ作り方。ヘッダー名だけ x-hr-*）
//   x-hr-timestamp: UNIX 秒 / x-hr-signature: "v1=" + HMAC-SHA256(秘密, `${ts}.${canonicalJson(body)}`)
//   request_id は呼び出しごとに新しく作る（LMS は同じ値の2回目を 409 で断る）
//
// ■ 結果は例外にしない：{ ok:true, status, data } / { ok:false, status, error, unreachable? }
//   時間切れ・通信の失敗は unreachable:true（招待は LMS 側で reused になるので、やり直してよい）
//   招待URL・秘密は、ここでもログに出さない

import crypto from "node:crypto";
import { signLeadRequest } from "./hr-leads.js";

export const LMS_SECRET_MIN = 32;
const TIMEOUT_MS = 10000;

/** 設定を読む。不足は missing に環境変数名で返す（値は返さない） */
export function lmsConfig(env = process.env) {
  const secret = String(env.MUGENDOJO_HR_LMS_SECRET || "").trim();
  const base = String(env.MUGENDOJO_LMS_BASE_URL || "").trim().replace(/\/+$/, "");
  const missing = [];
  if (secret.length < LMS_SECRET_MIN) missing.push("MUGENDOJO_HR_LMS_SECRET");
  if (!validBase(base)) missing.push("MUGENDOJO_LMS_BASE_URL");
  return { configured: missing.length === 0, missing, baseUrl: missing.includes("MUGENDOJO_LMS_BASE_URL") ? null : base, secret };
}

function validBase(u) {
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname);
  } catch { return false; }
}

export const newLmsRequestId = () => `hr-${crypto.randomUUID()}`;

/**
 * 署名つきで LMS の HR 用 API を呼ぶ
 * @param {string} path  "/api/hr/lms/trial-invite" など
 * @param {object} body  request_id 以外（ここで付ける）
 * @param {{env?:object, fetchImpl?:Function, now?:number}} [opts]
 */
export async function callLms(path, body, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const cfg = lmsConfig(env);
  if (!cfg.configured) return { ok: false, status: 503, error: "not_configured", missing: cfg.missing };
  const payload = { ...body, request_id: newLmsRequestId() };
  const ts = String(Math.floor(now / 1000));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hr-timestamp": ts, "x-hr-signature": signLeadRequest(cfg.secret, ts, payload) },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.ok) return { ok: false, status: r.status, error: String(data?.error || `http_${r.status}`) };
    return { ok: true, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === "AbortError" ? "timeout" : "network", unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 体験の招待URLを受け取る（LMS からはメールを送らない：send_mail:false）。
 * 有効な招待があれば LMS は作らずに同じものを返す（result: "reused"）
 * allow_existing:true … すでにアカウントがある人にも、ログインして参加する URL（/mgn/invite）を返してもらう（existing:true）。
 *   体験版に参加済みなら already_enrolled（招待は作らない）。対応前の LMS はこの項目を見ず already_registered を返す
 */
export function lmsTrialInvite({ email, name }, opts) {
  return callLms("/api/hr/lms/trial-invite", { action: "issue", email, ...(name ? { name } : {}), send_mail: false, allow_existing: true }, opts);
}

/** 体験状況（メールアドレスごと。LMS が正本。HR には保存しない） */
export function lmsTrialStatus(emails, opts) {
  return callLms("/api/hr/lms/trial-status", { emails }, opts);
}
