/* Service Worker。通知を受け取って出すことだけを担当する。
 *
 * ■ キャッシュはしない
 *   画面のファイルを勝手に取っておくと、直したのに古いままの人が出る。
 *   このアプリは毎回サーバから読む前提（vercel.json の Cache-Control）。
 *   ここでキャッシュを持つと、その前提が崩れる。
 *
 * ■ 置き場所
 *   ルート（/sw.js）に置くこと。下の階層に置くと、そこから下しか担当できない。
 *
 * ■ 通知を押したとき
 *   同じ画面をもう開いていればそれを前に出す。無ければ新しく開く。
 *   タブが増え続けないように。
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (_) {
    d = { title: (event.data && event.data.text()) || "エイト" };
  }

  const title = d.title || "エイト";
  const options = {
    body: d.body || "",
    icon: d.icon || "/img/logo.svg",
    badge: "/img/logo.svg",
    lang: "ja",
    // 同じ tag の通知は積み上がらず、新しいもので置き換わる。
    // 声かけが3つも4つも並んでいる状態にしない
    tag: d.tag || "kp",
    renotify: true,
    // 締切やブロッカーだけ、押すまで消えないようにする
    requireInteraction: !!d.sticky,
    data: { url: d.url || "/home.html" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/home.html";
  const target = new URL(url, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        // 同じ画面が開いていれば、それを前に出して移動させる
        if (c.url.split("#")[0] === target.split("#")[0] && "focus" in c) {
          if ("navigate" in c && c.url !== target) c.navigate(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
