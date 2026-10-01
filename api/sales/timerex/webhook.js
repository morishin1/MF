// POST /api/sales/timerex/webhook … 営業（Sales）の TimeRex Webhook。
//   営業の初回商談カレンダー（TIMEREX_SALES_MEETING_URL）の予約確定を、gw_sales_meetings に反映する。
//   中身は lib/sales-timerex.js（商談の特定・反映）。ここは薄い HTTP 層だけ。
//
// ■ 認証（採用HRとは別の Secret）
//   ヘッダー x-timerex-authorization（TimeRex 管理画面の「セキュリティトークン」）が
//   TIMEREX_SALES_WEBHOOK_SECRET と一致しなければ 401。未設定なら 503（常に拒否）。
//   採用HRの TIMEREX_WEBHOOK_SECRET・api/hr/timerex/webhook.js・gw_hr_interviews は使わない。Secret はログへ出さない。
//
// ■ 返すもの
//   200 … 反映した（scheduled）／再送で何もしない（resynced）／日時・URLを直した（updated）／
//         今回扱わない種類（日程変更・キャンセルなど。ignored。後続で対応）
//   404 meeting_not_found … 日程調整中の商談で、企業のメールアドレスが guest_email と一致するものが無い
//   409 ambiguous_meeting … 一致する商談が2件以上（自動で選ばない。何も書かない）
//   422 not_sales_calendar … 営業の初回商談カレンダー以外（採用HRの面談など）。何も書かない
//   TimeRex は 5xx を再送する。反映済みの再送は resynced で 200 を返すので、二重にならない
//
// ■ DEBUG ログ
//   TIMEREX_SALES_WEBHOOK_DEBUG_LOG=1 のときだけ、payload の「形」（キーと型・安全な識別子）をログへ出す。
//   氏名・メール・会社名・Meet URL・日時の値・payload 全文は出さない（lib/sales-timerex-debug.js）。

import { readJson, methodNotAllowed, json } from "../../../lib/http.js";
import { admin } from "../../../lib/supabase.js";
import { verifySalesSecret, salesDebugSummary } from "../../../lib/sales-timerex-debug.js";
import { parseSalesTimerex, applySalesBooking } from "../../../lib/sales-timerex.js";

const ERROR_STATUS = {
  invalid_body: 400, missing_guest_email: 400, not_sales_calendar: 422, not_configured: 503,
  meeting_not_found: 404, ambiguous_meeting: 409,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const auth = verifySalesSecret(req.headers);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  let body = {};
  try { body = await readJson(req); } catch { body = {}; }
  if (process.env.TIMEREX_SALES_WEBHOOK_DEBUG_LOG === "1") {
    console.log("[sales-timerex-webhook][debug]", JSON.stringify(salesDebugSummary(body)));
  }

  const parsed = parseSalesTimerex(body);
  if (parsed.skip) {
    // 日程変更・キャンセルなどは今回は扱わない（何も書かない）。種類の名前だけ残す
    console.log("[sales-timerex-webhook] ignored:", parsed.skip, parsed.webhookType || "");
    return json(res, 200, { ok: true, ignored: parsed.skip });
  }
  if (parsed.error) {
    return json(res, ERROR_STATUS[parsed.error] || 400, { ok: false, error: parsed.error, detail: parsed.detail });
  }

  const result = await applySalesBooking(admin(), parsed.event);
  if (result.error) {
    // メールアドレス・氏名は出さない
    console.warn("[sales-timerex-webhook]", result.error, result.count ? `count=${result.count}` : "");
    return json(res, ERROR_STATUS[result.error] || 500, { ok: false, error: result.error });
  }
  return json(res, 200, { ok: true, action: result.action, meetingId: result.meeting?.id || null });
}
