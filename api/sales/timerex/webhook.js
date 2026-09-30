// POST /api/sales/timerex/webhook … 営業（Sales）の TimeRex Webhook。いまは DEBUG 受信だけ。
//
// ■ いまの動き（DEBUG）
//   DB には一切書かない（gw_sales_meetings・企業・監査ログのどれも触らない）。
//   届いた payload の「形」（キー名・型・有無と、個人情報を含まない識別子）だけを
//   Vercel のログへ出して 200 を返す（TimeRex に再送させない）。形の中身は lib/sales-timerex-debug.js。
//   実データで webhook の種類・日程変更・キャンセルの形を確かめてから、gw_sales_meetings への反映を実装する。
//
// ■ 認証（採用HRとは別の Secret）
//   ヘッダー x-timerex-authorization（TimeRex 管理画面の「セキュリティトークン」）が
//   TIMEREX_SALES_WEBHOOK_SECRET と一致しなければ 401。未設定なら 503（常に拒否）。
//   採用HRの TIMEREX_WEBHOOK_SECRET・api/hr/timerex/webhook.js は使わない。Secret はログへ出さない。

import { readJson, methodNotAllowed, json } from "../../../lib/http.js";
import { verifySalesSecret, salesDebugSummary } from "../../../lib/sales-timerex-debug.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const auth = verifySalesSecret(req.headers);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  // 読めない body でも DEBUG は 200（形の記録だけ。TimeRex に再送させない）
  let body = {};
  try { body = await readJson(req); } catch { body = {}; }
  const summary = salesDebugSummary(body);
  // payload 全体・ヘッダー・個人情報・URL・日時の値は出さない（summary は形と安全な識別子だけ）
  console.log("[sales-timerex-webhook][debug]", JSON.stringify(summary));
  return json(res, 200, { ok: true, mode: "debug", webhookType: summary.webhook_type });
}
