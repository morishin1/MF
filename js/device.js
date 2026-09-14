/* この端末の印と、開いているあいだの合図。
 *
 * ■ この端末に置くもの
 *   localStorage に device_uid を1つだけ。乱数で、それ以外の意味はない。
 *   これを消せば、サーバからは別の端末に見える。それでよい。
 *   ここで防ぎたいのは「見慣れない端末から社内システムに入られること」で、
 *   本人が自分の端末を隠すことではない。
 *
 * ■ 送るもの
 *   端末の印と、端末の種類（OS・ブラウザ・画面の大きさ）だけ。
 *   どの画面を開いていたかは送らない。送ると、それは行動の記録になる。
 *
 * ■ 送るとき
 *   画面を開いたときと、そのあと5分ごと。画面が裏に回っているあいだは止める。
 *   タブを10枚開いていても、送るのは1枚ぶん（同じ端末の印なので、
 *   サーバ側は「開いていた」としか数えない）。
 *
 * ■ 本人が確認するまで
 *   サーバは合図を受け取っても、利用時間を1分も数えない。
 *   止めているのはサーバ側で、ここではない。ここで止めると、
 *   「見慣れない端末から入られた」ことも分からなくなる。
 */
window.KPDevice = (function () {
  "use strict";

  var KEY = "kp_device_uid";
  var BEAT_MS = 5 * 60 * 1000;
  var timer = null;
  var last = 0;
  var state = { uid: null, confirmed: false, notReady: false };

  /** この端末の印。無ければ作る */
  function uid() {
    try {
      var v = localStorage.getItem(KEY);
      if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) return v;
      v = make();
      localStorage.setItem(KEY, v);
      return v;
    } catch (e) {
      // プライベートウィンドウなど、保存できないことがある。
      // その場合は毎回ちがう端末に見えるが、動きは止めない
      return null;
    }
  }

  function make() {
    var a = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = "";
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** 端末の種類。Client Hints があれば、UAの文字列より正確に取れる */
  async function hints() {
    var h = {
      screen: (screen.width || 0) + "x" + (screen.height || 0),
      mobile: /Mobi|Android|iPhone|iPad/.test(navigator.userAgent),
    };
    try {
      var d = navigator.userAgentData;
      if (d) {
        h.mobile = !!d.mobile;
        var hi = await d.getHighEntropyValues(["platform", "platformVersion", "model"]);
        h.platform = hi.platform || d.platform || null;
        h.platformVersion = hi.platformVersion || null;
        h.model = hi.model || null;
        // brands には "Not_A Brand" のような偽物が混ざる。それは外す
        var b = (d.brands || []).filter(function (x) {
          return !/not.a.brand/i.test(x.brand);
        });
        // Edge は Chromium も名乗る。名前の長いほうが実体に近い
        if (b.length) {
          h.browser = b.sort(function (x, y) { return y.brand.length - x.brand.length; })[0].brand;
        }
      }
    } catch (e) { /* 取れなくても動く */ }
    return h;
  }

  async function beat(force) {
    var now = Date.now();
    if (!force && now - last < BEAT_MS - 5000) return state;
    last = now;
    try {
      var r = await API.deviceBeat({ deviceUid: state.uid || uid(), hints: await hints() });
      if (r && r.deviceUid) {
        state.uid = r.deviceUid;
        // サーバが作り直した印は、こちらにも残す
        try { localStorage.setItem(KEY, r.deviceUid); } catch (e) { /* 保存できなくても動く */ }
      }
      state.confirmed = !!(r && r.confirmed);
      state.notReady = !!(r && r.notReady);
      // 表がまだ無い環境で5分ごとに叩き続けない
      if (state.notReady) stop();
    } catch (e) {
      // 合図が届かないことより、画面が止まるほうが困る。黙って次に回す
    }
    return state;
  }

  function start() {
    if (timer) return;
    state.uid = uid();
    beat(true);
    timer = setInterval(function () {
      if (document.visibilityState === "visible") beat(false);
    }, 60 * 1000);
    document.addEventListener("visibilitychange", function () {
      // 裏から戻ってきたら、間が空いていれば1回送る
      if (document.visibilityState === "visible") beat(false);
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ---- ブラウザ拡張 ----------------------------------------------------------
  //
  // ■ なぜ画面の側から話しかけるのか
  //
  //   拡張は、社員のログイン（localStorage のトークン）を読めない。別のオリジンなので、
  //   Cookie も見えない。読めてしまうほうが困る。
  //
  //   そこで、ログインしているこの画面が
  //     1. サーバから1回きりの合言葉をもらい
  //     2. 拡張へ渡す
  //   だけをする。拡張はそれを端末専用の資格情報に換える。
  //
  //   社員がすることは「ログインする」「拡張を入れる」の2つだけ。
  //   EXE も、登録コードの打ち込みも要らない。
  //
  // ■ 拡張のIDは、組み立てのときに決まる
  //   window.KP_EXT_ID に入れておく（なければ何もしない）。

  var EXT_ID = (typeof window !== "undefined" && window.KP_EXT_ID) || null;
  var ext = { checked: false, installed: false, paired: false, version: null };

  /** 拡張に話しかける。入っていなければ null が返る */
  function ask(msg) {
    return new Promise(function (done) {
      if (!EXT_ID || !window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        return done(null);
      }
      var settled = false;
      var finish = function (v) { if (!settled) { settled = true; done(v); } };
      // 入っていないと、返事が来ないまま終わることがある
      setTimeout(function () { finish(null); }, 1500);
      try {
        chrome.runtime.sendMessage(EXT_ID, msg, function (r) {
          // 入っていなければ lastError が立つ。読まないと警告が出る
          void chrome.runtime.lastError;
          finish(r || null);
        });
      } catch (e) { finish(null); }
    });
  }

  /**
   * 拡張が入っているか、つながっているか。
   * 画面はこれを見て「拡張を入れてください」を出す
   */
  async function extState() {
    var r = await ask({ type: "eight-hello" });
    ext = {
      checked: true,
      installed: Boolean(r && r.ok),
      paired: Boolean(r && r.paired),
      version: (r && r.version) || null,
      browser: (r && r.browser) || null,
    };
    return ext;
  }

  /**
   * 拡張をつなぐ。
   *
   * ■ 自動ではつながない。本人に押してもらう
   *
   *   画面が勝手につないでしまえば、手順としてはいちばん短い。
   *   ところがそれだと、本人は「いつのまにか記録が始まっていた」になる。
   *
   *   端末管理は、知らないうちに始めてよいものではない。
   *   **押すという行為が、管理されていると分かる瞬間**になる。
   *   何を記録するかを読んで、自分で押す。そこまでが登録。
   *
   *   だから、ここは画面のボタンからしか呼ばない。
   *   すでにつながっていれば何もしない。入っていなければ false
   */
  async function extPair() {
    var st = await extState();
    if (!st.installed) return { ok: false, reason: "not_installed" };
    if (st.paired) return { ok: true, already: true };

    var got;
    try {
      got = await API.browserCode({ deviceUid: state.uid || uid() });
    } catch (e) {
      return { ok: false, reason: "code_failed", message: e.hint || e.message };
    }
    var r = await ask({ type: "eight-pair", code: got.code });
    if (!r || !r.ok) {
      return { ok: false, reason: (r && r.error) || "pair_failed", message: r && r.message };
    }
    ext.paired = true;
    return { ok: true, collect: r.collect, consentUrl: r.consentUrl || null };
  }

  /** アプリとして入っているか（PWA） */
  function installed() {
    return window.matchMedia
      && (window.matchMedia("(display-mode: standalone)").matches
          || window.navigator.standalone === true);
  }

  return {
    uid: uid, start: start, stop: stop, beat: beat, installed: installed, state: state,
    extState: extState, extPair: extPair, ext: ext,
  };
})();
