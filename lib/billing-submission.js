// 月初業務 D1 — 外部提出フォーム。値の定義・トークン・正規化。
// db/080_billing_submission.sql と1対1。api/billing-submission/*.js から使う。
//
// ■ トークンは、外部メンバー招待（lib/guests.js）と同じ考え方
//   平文は発行・再発行のときだけ返す。DBには sha256 のハッシュだけを持つ。
//   違うのは使い切りにしないこと（毎月同じURLを使い回す）

import crypto from "node:crypto";

export const KIND = ["timesheet", "invoice"];
export const KIND_LABEL = { timesheet: "勤務表", invoice: "請求書" };

export const LINK_TTL_DAYS = 365; // 「必ず期限付きトークンで」の指示どおり。長めにして毎月の再発行は強いない

export const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
export const newSubmissionToken = () => crypto.randomBytes(32).toString("base64url");
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/** 'YYYY-MM' の形か（lib/billing-progress.js と同じ） */
export const isBillingMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));

/** 窓口（gw_submission_links）1本の、いまの状態 */
export function linkStatus(link) {
  if (!link) return "none";
  if (link.revoked_at) return "revoked";
  if (new Date(link.expires_at).getTime() < Date.now()) return "expired";
  return "active";
}
export const LINK_STATUS_LABEL = { none: "未発行", active: "発行済み", expired: "期限切れ", revoked: "無効" };

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
export const MAX_BYTES = 10 * 1024 * 1024; // 10MB

/** 届いた1件の入力チェック（公開フォーム側） */
export function normalizeSubmission(body) {
  if (!isBillingMonth(body?.targetMonth)) {
    return { error: "invalid_body", detail: "対象年月（targetMonth）は YYYY-MM の形で指定してください" };
  }
  if (!KIND.includes(body?.kind)) {
    return { error: "invalid_body", detail: `区分（kind）は ${KIND.join("/")} のいずれかです` };
  }
  if (!body?.siteContractId) {
    return { error: "invalid_body", detail: "siteContractId は必須です" };
  }
  const filename = String(body?.filename || "").trim().slice(0, 200);
  if (!filename) return { error: "invalid_body", detail: "ファイル名が必要です" };
  const mimeType = String(body?.mimeType || "");
  if (!ALLOWED_MIME.has(mimeType)) return { error: "unsupported_mime", detail: "PDF・JPEG・PNG のいずれかにしてください" };
  const sizeBytes = Number(body?.sizeBytes);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { error: "invalid_body", detail: "sizeBytes が不正です" };
  if (sizeBytes > MAX_BYTES) return { error: "file_too_large", detail: "10MBまでです", max: MAX_BYTES };

  return {
    value: {
      targetMonth: body.targetMonth, kind: body.kind,
      siteContractId: body.siteContractId, filename, mimeType, sizeBytes,
    },
  };
}

// 届いた種類を、既存の進捗（gw_billing_progress、5段階）のどの印に立てるか。
// 請求書は「BP請求書受領」。勤務表は「勤務表受領」まで（稼働確認はD2・人の目）
export const PROGRESS_STAGE = { timesheet: "timesheet_received", invoice: "bp_invoice_received" };
