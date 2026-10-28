// HR採用メール：画面の「最新メールを取り込む」からGASを即時起動する。
// ブラウザにGoogle権限/秘密鍵を渡さない。GAS側でGmailを読み、既存HMAC付きingest APIで保存する。
// POSTのみ。採用HR権限・EIGHT tenant固定・手動起動専用鍵が必須。
import crypto from "node:crypto";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { json, methodNotAllowed } from "../../lib/http.js";

export const config = { maxDuration: 45 };
const APP_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finiteCount = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 100 ? n : 0;
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private,no-store");
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canRecruit(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "採用HRの権限が必要です" });
  }
  const tenant = process.env.HR_INBOX_TENANT_ID;
  const url = process.env.HR_INBOX_GAS_WEBAPP_URL || "";
  const secret = process.env.HR_INBOX_MANUAL_SECRET || "";
  if (process.env.HR_INBOX_SYNC_ENABLED !== "1" || !UUID.test(tenant || "") ||
      ctx.tenantId !== tenant || !APP_URL.test(url) || secret.length < 32) {
    return json(res, 503, { error: "sync_not_configured",
      hint: "即時取込の初期設定が未完了です。管理者がGASのWebアプリとHR_INBOX_GAS_WEBAPP_URL・HR_INBOX_MANUAL_SECRETを設定してください" });
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = timestamp + "." + nonce + ".hr-inbox-sync-now";
  const signature = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  let response, data;
  try {
    response = await fetch(url, {
      method: "POST", redirect: "follow",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: JSON.stringify({ timestamp, nonce, signature }),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await response.text();
    if (raw.length > 4096) throw new Error("unexpected_response");
    data = JSON.parse(raw);
  } catch (error) {
    // GASは既に受け取っている可能性があるので「失敗」と断言せず一覧再読込を促す。
    console.error("[hr/inbox-sync-now] GAS call failed", error?.name || "unknown");
    return json(res, 502, { error: "sync_result_unknown",
      hint: "取り込み結果を確認できませんでした。メール一覧を更新してください。重複登録は防止されます" });
  }
  if (!response.ok || data?.ok !== true) {
    const code = String(data?.code || "sync_failed");
    const busy = code === "busy";
    return json(res, busy ? 409 : 502, { error: code,
      hint: busy ? "別の取込が実行中です。完了後に一覧を更新してください" :
        "Google Apps Scriptで取込を完了できませんでした。設定とGASの実行履歴を確認してください" });
  }
  return json(res, 200, {
    ok: true, dryRun: data.dryRun === true,
    inserted: finiteCount(data.inserted), duplicates: finiteCount(data.duplicates),
    processed: finiteCount(data.processed ?? data.candidates),
  });
}
