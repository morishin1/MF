// POST /api/hr/timerex/webhook … TimeRexからの予約確定・変更Webhookを受ける。
//   カジュアル面談・社長面談の両方。どちらかは予約枠（calendar_url_path）で決める
//   （lib/hr-timerex-calendars.js。知らない予約枠は 422 unknown_timerex_calendar で止める）。
//
// ■ 認証
//   TimeRex標準で送信される固定ヘッダー（TimeRex管理画面の「セキュリティトークン」）。
//   署名方式ではなく、独自ヘッダーの追加設定も不要（採用HR Phase 4A指示書「最重要」・
//   TimeRex Webhook認証ヘッダー修正指示で実機確認済み）。
//     ヘッダー: x-timerex-authorization
//     値      : TIMEREX_WEBHOOK_SECRET と同じ値（TimeRex管理画面の「セキュリティトークン」）
//   一致しなければ401。TIMEREX_WEBHOOK_SECRET未設定なら503（安全側に倒して常に拒否）。
//   Secret値はログへ出さない。
//
// ■ 応募者識別・DB反映
//   実payloadの解析は lib/hr-timerex.js の parseTimerexWebhook()、DB反映は
//   同ファイルの applyTimerexEvent() が行う（ここでは薄いHTTP層のみ）。
//
// ■ 冪等性
//   同じevent_idのWebhookが複数回届いても（TimeRexは5xxを再送する）、
//   applyTimerexEvent()側でtimerex_event_idの一意制約により重複作成しない。
//   成功時は必ず200を返す。
//
// ■ DEBUGログ
//   TIMEREX_WEBHOOK_DEBUG_LOG=1 のときだけ、payloadの「形」をログへ出す（debugSummary）。
//   出すのは webhook_type・calendar_url_path・event.id・is_changed・old/new_event_id・
//   form の field_type 一覧だけ。payload全体・ヘッダーは出さない。
//   メールアドレス・氏名・Meet URL・取消/リスケURL・Webhook Secret は DEBUG 時も絶対に出さない。

import crypto from "node:crypto";
import { readJson, methodNotAllowed, json } from "../../../lib/http.js";
import { parseTimerexWebhook, applyTimerexEvent } from "../../../lib/hr-timerex.js";

const AUTH_HEADER = "x-timerex-authorization";

// ログに出してよい ID・フラグだけ（英数字と記号の短い値。URL・メールらしいものは落とす）
const safeId = (v) => {
  if (v == null || v === "") return null;
  const s = String(v).slice(0, 80);
  return /^[A-Za-z0-9_.:-]+$/.test(s) ? s : "(redacted)";
};

/** DEBUG用：payload の形だけ。個人情報・URL・トークンを含めない */
export function debugSummary(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const ev = b.event && typeof b.event === "object" ? b.event : {};
  return {
    webhook_type: safeId(b.webhook_type),
    calendar_url_path: safeId(b.calendar_url_path ?? ev.calendar_url_path),
    event_id: safeId(ev.id),
    is_changed: typeof ev.is_changed === "boolean" ? ev.is_changed : null,
    old_event_id: safeId(ev.old_event_id),
    new_event_id: safeId(ev.new_event_id),
    form_field_types: Array.isArray(ev.form) ? ev.form.map((f) => safeId(f && f.field_type)) : null,
  };
}

function verifySecret(req) {
  const configured = process.env.TIMEREX_WEBHOOK_SECRET || "";
  if (!configured) return { ok: false, status: 503, error: "not_configured" };
  const given = req.headers && req.headers[AUTH_HEADER];
  if (!given || typeof given !== "string") return { ok: false, status: 401, error: "unauthorized" };

  const a = Buffer.from(given);
  const b = Buffer.from(configured);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

const ERROR_STATUS = {
  invalid_body: 400, unsupported_webhook_type: 400, missing_applicant_id: 400,
  missing_event_id: 400, missing_scheduled_at: 400, unknown_event_type: 400, invalid_event: 400,
  applicant_not_found: 404, interview_not_found: 404, unknown_timerex_calendar: 422,
  ambiguous_applicant: 409, already_conducted: 409, category_mismatch: 409,
  lead_tenant_not_configured: 503,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const auth = verifySecret(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  const body = await readJson(req);

  if (process.env.TIMEREX_WEBHOOK_DEBUG_LOG === "1") {
    // payload全体・ヘッダーは出さない（メール・氏名・URL・Secretを残さない）
    console.log("[timerex-webhook][debug]", JSON.stringify(debugSummary(body)));
  }

  const parsed = await parseTimerexWebhook(body);
  if (parsed.error === "unsupported_webhook_type") {
    // キャンセル等、まだ実ログで確認していない event。名前だけ残す（payload・URL・メールは出さない）。
    // 実際の event 名が分かったら TIMEREX_CANCEL_WEBHOOK_TYPES に入れる（lib/hr-timerex.js）
    console.warn("[timerex-webhook] unsupported webhook_type:", parsed.webhookType);
  }
  if (parsed.error) {
    return json(res, ERROR_STATUS[parsed.error] || 500, { ok: false, error: parsed.error, detail: parsed.detail });
  }

  const result = await applyTimerexEvent(parsed.event);
  if (result.error) {
    return json(res, ERROR_STATUS[result.error] || 500, { ok: false, error: result.error, detail: result.detail });
  }

  return json(res, 200, { ok: true, action: result.action });
}
