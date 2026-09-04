// Slack への通知（Incoming Webhook）。
//
// 使いどころ:
//   すぐ気づいてほしいもの（申請が来た、承認された）だけを流す。
//   一覧で追えるものまで流すと、誰も読まないチャンネルになる。
//
// SLACK_WEBHOOK_URL が未設定なら何もしない。設定しなくてもシステムは動く。
// アプリ内のベル通知が本体で、Slack はその写しという位置づけ。
//
// 失敗しても本処理は止めない。Slack が落ちていることを理由に
// 申請そのものが通らなくなるほうが困るため。3秒で見切りをつける。

const TIMEOUT_MS = 3000;

export function isConfigured() {
  return Boolean((process.env.SLACK_WEBHOOK_URL || "").trim());
}

/** 画面のURL。通知から直接その画面へ飛べるようにする */
function baseUrl() {
  const explicit = (process.env.PUBLIC_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = (process.env.VERCEL_URL || "").trim();
  return vercel ? `https://${vercel}` : "https://mf.8grp.co.jp";
}

/**
 * @param {{text:string, lines?:(string|null)[], link?:string}} msg
 *   text  … 1行目。誰が何をしたか
 *   lines … 補足（null は捨てる）
 *   link  … 画面のパス（"admin-expenses.html" など）
 */
export async function notifySlack({ text, lines, link }) {
  const url = (process.env.SLACK_WEBHOOK_URL || "").trim();
  if (!url || !text) return { sent: false, skipped: "not_configured" };

  const body = [
    text,
    ...(lines || []).filter(Boolean),
    link ? `${baseUrl()}/${String(link).replace(/^\/+/, "")}` : null,
  ].filter(Boolean).join("\n");

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { sent: true };
  } catch (e) {
    console.error("[slack] failed:", e?.message || e);
    return { sent: false, error: String(e?.message || e) };
  }
}
