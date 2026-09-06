// ブラウザのプッシュ通知を送る。
//
// ■ 仕組み
//   ブラウザが「宛先（endpoint）」と鍵を発行する。それを預かっておいて、
//   サーバから Google / Mozilla などの配信先へ暗号化して投げると、
//   相手の端末の Service Worker（sw.js）が受け取って通知を出す。
//   mf のタブが閉じていても届く。ブラウザ自体が終了していると届かない。
//
// ■ VAPID
//   「どのサーバから送ったか」を示す鍵の組。公開鍵はブラウザに渡す。
//   秘密鍵は Vercel の環境変数に置く（Sensitive）。
//     VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT（mailto:）
//   鍵の作り方:  npx web-push generate-vapid-keys
//   公開鍵を後から変えると、いま許可している端末は全部届かなくなる。
//
// ■ 届かなくなった宛先
//   許可を取り消された端末は 404 / 410 を返す。その行は消してよい。
//   gone:true で返すので、呼んだ側が消す。
//
// ■ 未設定でも落とさない
//   鍵が無い環境では configured:false を返すだけ。
//   通知が出ないだけで、ベル（gw_notifications）は動く。

import webpush from "web-push";

let ready = false;

export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function init() {
  if (ready) return true;
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@8grp.co.jp",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  ready = true;
  return true;
}

/**
 * 1つの端末へ送る。
 *
 * @param {{endpoint:string, p256dh:string, auth:string}} sub
 * @param {{title:string, body?:string, url?:string, tag?:string, sticky?:boolean}} payload
 * @returns {Promise<{ok:boolean, gone?:boolean, error?:string}>}
 */
export async function sendPush(sub, payload) {
  if (!init()) return { ok: false, error: "not_configured" };
  if (!sub?.endpoint || !sub?.p256dh || !sub?.auth) return { ok: false, error: "bad_subscription" };

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      // 端末が落ちていても、4時間は配信先で預かってもらう。
      // それより古い声かけは、届いても意味がない
      { TTL: 4 * 3600, urgency: "normal" },
    );
    return { ok: true };
  } catch (e) {
    const code = e?.statusCode || 0;
    // 404 / 410 … その宛先はもう無い（許可を取り消した・ブラウザを消した）
    return { ok: false, gone: code === 404 || code === 410, error: `${code || ""} ${e?.message || e}`.trim() };
  }
}

/**
 * 何台かへまとめて送り、届かなくなった宛先を消す。
 *
 * @param {object} sb           service_role の Supabase クライアント
 * @param {object[]} subs       gw_push_subs の行
 * @param {object} payload
 * @returns {Promise<{sent:number, removed:number}>}
 */
export async function sendToDevices(sb, subs, payload) {
  let sent = 0;
  const dead = [];

  for (const s of subs || []) {
    const r = await sendPush(s, payload);
    if (r.ok) {
      sent++;
      await sb.from("gw_push_subs")
        .update({ last_ok_at: new Date().toISOString(), fail_count: 0 })
        .eq("id", s.id);
    } else if (r.gone) {
      dead.push(s.id);
    } else {
      // 一時的な失敗。3回続いたら諦める
      await sb.from("gw_push_subs")
        .update({ fail_count: (s.fail_count || 0) + 1 })
        .eq("id", s.id);
      if ((s.fail_count || 0) + 1 >= 3) dead.push(s.id);
      console.error("[push] 送れませんでした:", r.error);
    }
  }

  if (dead.length) await sb.from("gw_push_subs").delete().in("id", dead);
  return { sent, removed: dead.length };
}
