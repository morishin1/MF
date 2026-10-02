// 送信サービス「Resend」との窓口。lib/mail/index.js が呼ぶ、交換できる部品の1つ。
//
// 設定: MAIL_PROVIDER=resend と RESEND_API_KEY。ほかは lib/mail/index.js（送信元・有効化のスイッチ）。
// ここに、会社の事情（送信元・宛先・文面）は書かない。API の呼び方だけを持つ。
// 別のサービス（Gmail API・SES・SendGrid・SMTP など）へ替えるときは、同じ形のファイルを
// 足して lib/mail/index.js の ADAPTERS に1行加える。呼ぶ側は変わらない。

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10000;

export const name = "resend";

/** 使える状態か。理由は、管理画面に出す言葉 */
export function ready(env = process.env) {
  return String(env.RESEND_API_KEY || "").trim()
    ? { ok: true }
    : { ok: false, reason: "RESEND_API_KEY が設定されていません" };
}

/**
 * @param {{from:string, to:string, subject:string, text:string, replyTo?:string}} m
 * @param {{env?:object, fetchImpl?:Function}} [ctx]
 * @returns {Promise<{id:string|null}>} 失敗は例外（message は、履歴に残す短い説明）
 */
export async function send(m, { env = process.env, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${String(env.RESEND_API_KEY || "").trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: m.from, to: [m.to], subject: m.subject, text: m.text,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
      signal: ac.signal,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`送信サービスが断りました（${r.status}）${body?.message ? `: ${String(body.message).slice(0, 200)}` : ""}`);
    return { id: body?.id || null };
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("送信サービスの応答がありませんでした（時間切れ）");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
