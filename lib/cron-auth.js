// 定期実行（api/cron/*）の入口の認証。
//
//   CRON_SECRET があれば、Authorization: Bearer <CRON_SECRET> を要求する（Vercel Cron が付けて送る）。
//   本番（VERCEL_ENV=production）で CRON_SECRET が未設定なら、503 で常に断る。
//     … 未設定のまま誰でも叩けると、通知・督促・削除（retention）などを service_role で動かせてしまう。
//     採用HR・営業の TimeRex Webhook、admin/setup と同じく「未設定なら閉じる」に倒す。
//   手元・テスト（VERCEL_ENV が production でない）は、これまでどおり CRON_SECRET が無ければ通す。
import { json } from "./http.js";

/** 通してよければ true。断ったときは応答を返して false */
export function cronAuthorized(req, res, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    if (env.VERCEL_ENV === "production") {
      json(res, 503, { error: "not_configured", hint: "CRON_SECRET が未設定です（Vercel の環境変数に設定してください）" });
      return false;
    }
    return true;
  }
  const given = (req.headers && req.headers.authorization) || "";
  if (given !== `Bearer ${secret}`) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}
