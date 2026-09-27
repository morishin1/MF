// POST /api/hr/timerex/webhook … TimeRexからの予約確定・変更・キャンセルWebhookを受ける。
//
// ■ まだ「実装できていない」理由（採用HR Phase 4A指示書「最重要」）
//   TimeRex公式の実event名・payloadのフィールドパス・署名/認証方式を、
//   実際のテスト予約1件のpayloadでまだ確認できていない。推測でこれらを
//   実装すると、誤った応募者へ面談を紐付けたり、公式仕様と食い違う認証方式
//   （独自のTIMEREX_WEBHOOK_SECRET方式など）を作ってしまうおそれがあるため、
//   確認できるまではDBへ一切書き込まない。
//
// ■ このエンドポイントが今できること
//   ・GWログイン認証（requireUser）は使わない（TimeRexからのサーバー間通信のため）。
//     ただし「無認証で何でも書ける」ことはない。DB書き込みを一切しないので、
//     何が送られてきても実害が起きない状態にしてある
//   ・TIMEREX_WEBHOOK_DEBUG_LOG=1 のときだけ、届いたpayloadをサーバーログへ出す
//     （実際のテスト予約1件のpayload確認用。確認が終わったら環境変数を戻すこと。
//     候補者の個人情報を含むため、常時は有効にしない）
//
// ■ 実payload・認証方式を確認できたら、ここでやること
//   1. TimeRex公式の署名/認証方式で、このリクエストを検証する
//   2. 確認できたpayload構造から、lib/hr-timerex.js の applyTimerexEvent() が
//      受け取る正規化イベント { type, eventId, previousEventId?, applicantId,
//      scheduledAt?, meetingUrl? } を組み立てる
//   3. applyTimerexEvent() を呼び、結果に応じて200/4xxを返す
//   （lib/hr-timerex.js 側のDB反映・冪等性・応募者状態遷移・手動運用との共存は
//    実装・テスト済み。ここでの残作業は「生payloadを読む層」だけ）

import { readJson, methodNotAllowed, json } from "../../../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const body = await readJson(req);

  if (process.env.TIMEREX_WEBHOOK_DEBUG_LOG === "1") {
    // 実payload確認用の一時ログ。確認が終わったら必ずTIMEREX_WEBHOOK_DEBUG_LOGを外すこと
    console.log("[timerex-webhook][debug] headers:", JSON.stringify(req.headers || {}));
    console.log("[timerex-webhook][debug] body:", JSON.stringify(body));
  }

  return json(res, 503, {
    error: "not_implemented",
    message: "TimeRex Webhookの実payload・認証方式をまだ確認できていないため、自動反映は未実装です。"
      + "日程調整の手動設定・日時変更・キャンセル・録画URL登録は引き続き使えます。",
  });
}
