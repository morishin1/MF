// POST /api/hr/timerex/webhook … TimeRexからの予約確定・変更Webhookを受ける。
//
// ■ 認証
//   TimeRex側の管理画面で設定する固定ヘッダー方式（TimeRex設定画面のHTTP Header欄）。
//   署名方式は公式に確認できていないため推測実装しない（採用HR Phase 4A指示書「最重要」）。
//     ヘッダー: X-HR-Timerex-Secret
//     値      : TIMEREX_WEBHOOK_SECRET と同じ値
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
//   TIMEREX_WEBHOOK_DEBUG_LOG=1 のときだけ、届いたpayloadをログへ出す
//   （実payload確認用。認証ヘッダーの値は常に除いてログする）。
//   実payloadの確認は完了したため、通常運用ではこの環境変数を外しておくこと。

import crypto from "node:crypto";
import { readJson, methodNotAllowed, json } from "../../../lib/http.js";
import { parseTimerexWebhook, applyTimerexEvent } from "../../../lib/hr-timerex.js";

const AUTH_HEADER = "x-hr-timerex-secret";

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
  applicant_not_found: 404, interview_not_found: 404,
  ambiguous_applicant: 409, already_conducted: 409,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const auth = verifySecret(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  const body = await readJson(req);

  if (process.env.TIMEREX_WEBHOOK_DEBUG_LOG === "1") {
    // 実payload確認用の一時ログ。Secretは絶対に出さない
    const headers = { ...(req.headers || {}) };
    delete headers[AUTH_HEADER];
    console.log("[timerex-webhook][debug] headers:", JSON.stringify(headers));
    console.log("[timerex-webhook][debug] body:", JSON.stringify(body));
  }

  const parsed = await parseTimerexWebhook(body);
  if (parsed.error) {
    return json(res, ERROR_STATUS[parsed.error] || 500, { ok: false, error: parsed.error, detail: parsed.detail });
  }

  const result = await applyTimerexEvent(parsed.event);
  if (result.error) {
    return json(res, ERROR_STATUS[result.error] || 500, { ok: false, error: result.error, detail: result.detail });
  }

  return json(res, 200, { ok: true, action: result.action });
}
