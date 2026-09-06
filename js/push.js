/* デスクトップ通知の許可・解除。
 *
 * ■ 許可はボタンからしか求めない
 *   画面を開いた瞬間に許可を聞くと、たいてい「ブロック」を押される。
 *   いちど拒否されると、ブラウザの設定画面から戻すしかない。
 *   だから、本人が「受け取る」を押したときにだけ聞く。
 *
 * ■ 使い方
 *   KPPush.state()    … { supported, permission, subscribed }
 *   KPPush.enable()   … 許可を求めて、宛先をサーバに預ける
 *   KPPush.disable()  … この端末だけ止める
 *   KPPush.test()     … 自分に1件送ってみる
 */
(function () {
  "use strict";

  const SW = "/sw.js";

  const supported = () =>
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  async function register() {
    if (!supported()) return null;
    // 同じスコープなら二重に登録されない
    return navigator.serviceWorker.register(SW, { scope: "/" });
  }

  async function current() {
    if (!supported()) return null;
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  async function state() {
    if (!supported()) {
      return { supported: false, permission: "unsupported", subscribed: false };
    }
    const sub = await current().catch(() => null);
    return {
      supported: true,
      permission: Notification.permission,   // default / granted / denied
      subscribed: !!sub,
    };
  }

  // VAPID の公開鍵は base64url。ブラウザには Uint8Array で渡す
  function toBytes(base64url) {
    const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
    const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // どの端末かが後で分かるように。詳しい情報は要らない
  function label() {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? "Edge"
      : /Chrome\//.test(ua) ? "Chrome"
        : /Firefox\//.test(ua) ? "Firefox"
          : /Safari\//.test(ua) ? "Safari" : "ブラウザ";
    const os = /Windows/.test(ua) ? "Windows"
      : /Mac OS X/.test(ua) ? "Mac"
        : /Android/.test(ua) ? "Android"
          : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : "";
    return os ? `${browser} / ${os}` : browser;
  }

  async function enable() {
    if (!supported()) throw new Error("このブラウザは通知に対応していません");

    const conf = await API.pushConfig();
    if (!conf.configured || !conf.publicKey) {
      throw new Error("サーバ側の通知設定がまだです。管理者にお知らせください");
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error(permission === "denied"
        ? "通知がブロックされています。ブラウザのアドレス欄の左にある鍵アイコンから、通知を「許可」に変えてください"
        : "通知が許可されませんでした");
    }

    const reg = await register();
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,           // 見えない通知は使わない（ブラウザの決まり）
        applicationServerKey: toBytes(conf.publicKey),
      });
    }

    const j = sub.toJSON();
    await API.pushSubscribe({
      endpoint: j.endpoint,
      p256dh: j.keys?.p256dh,
      auth: j.keys?.auth,
      label: label(),
    });
    return true;
  }

  async function disable() {
    const sub = await current();
    if (!sub) return true;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await API.pushUnsubscribe(endpoint).catch(() => {});
    return true;
  }

  // ログイン済みの画面で、そっと Service Worker だけ登録しておく。
  // 許可は求めない（登録しておかないと、通知を押したときの動きが決まらない）
  async function warm() {
    if (!supported()) return;
    if (Notification.permission !== "granted") return;
    try { await register(); } catch (_) { /* 失敗しても画面は動く */ }
  }

  window.KPPush = { supported, state, enable, disable, warm, label };
})();
