/* エイト アクセス計測タグ
 *
 * 各サイトの </body> の直前に1行だけ入れる:
 *   <script src="https://mf.8grp.co.jp/js/beacon.js" data-key="ここに合鍵" defer></script>
 *
 * 合鍵は 社内ポータル →「アクセス分析」でサイトごとに発行する。
 *
 * 何を送るか
 *   ・ページのパス（?以降は落とす）
 *   ・参照元のホスト名
 *   ・その日はじめての訪問かどうか
 * これだけ。IPアドレスも、個人を追う印も持たない。
 *
 * 何を送らないか
 *   URLのパラメータ、入力内容、Cookie、他サイトでの行動。
 *
 * 失敗しても、そのページの表示には何も影響しない。
 */
(function () {
  var el = document.currentScript;
  var key = el && el.getAttribute("data-key");
  if (!key) return;

  // 送り先は、このタグを配っているところ（= 社内ポータル）
  var endpoint = new URL("/api/collect", el.src).toString();

  // その日はじめてかどうかの印。日付だけを残し、誰かは残さない。
  // sessionStorage ではなく localStorage なのは、同じ日に開き直した人を
  // 二重に数えないため
  var first = 0;
  try {
    var today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem("kp_seen") !== today) {
      localStorage.setItem("kp_seen", today);
      first = 1;
    }
  } catch (e) {
    // プライベートモードなどで書けない場合は、毎回「はじめて」として数える。
    // 訪問者数が多めに出るが、動かなくなるよりよい
    first = 1;
  }

  var payload = JSON.stringify({
    k: key,
    p: location.pathname,
    r: document.referrer || "",
    n: first,
  });

  try {
    // ページを離れる直前でも届くので sendBeacon を先に試す
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
      return;
    }
  } catch (e) { /* 下の fetch に落ちる */ }

  try {
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
      mode: "cors",
    }).catch(function () { /* 届かなくても構わない */ });
  } catch (e) { /* 同上 */ }
})();
