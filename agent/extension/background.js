// EIGHT 端末管理 — ブラウザ側。
//
// ■ 何をするものか
//   いま見ているタブの「ドメイン」と「ページの場所」を、見ていた秒数とともに
//   数える。数えた結果だけを、このパソコンの中のソフト（EIGHT Agent）へ渡す。
//   サーバへは直接つながない。鍵もこの拡張には持たせない。
//
// ■ 読まないもの（読む口をそもそも持たない）
//   ・ページの中身        … content_scripts が無い。host_permissions が空。
//                            どのページにもコードを差し込めない。
//   ・入力した内容・フォーム・パスワード
//                          … 同上。ページの中に入れないので読めない。
//   ・Cookie・ログインの鍵 … cookies 権限が無い。
//   ・通信の中身          … webRequest 権限が無い。
//   ・ページの題（タイトル）… tab.title に触らない。下の keep() が url しか見ない。
//
//   manifest.json の permissions に、これらを読むためのものを1つも入れていない。
//   「入れる場所を作らない」のが、いちばん確実な歯止め。
//
// ■ URL は、ここで削ってから外に出す
//   ? から後ろ（検索語・メールアドレス・一度きりの鍵が入る）と
//   # から後ろは、この関数を出る前に捨てる。
//   一度きりのリンクに見える区切りは伏せる。
//   削る前の文字列は、変数の外へ一切渡さない。
//
// ■ 「開いていた」ではなく「見ていた」を数える
//   前面のウィンドウの、選ばれているタブだけ。
//   ほかのウィンドウを見ているあいだ、裏のタブは数えない。
//   何も触らなくなったら（既定5分）止める。

const NATIVE_HOST = "jp.co.eightgrp.agent";

// 何分ごとに、溜めたぶんを渡すか
const FLUSH_MIN = 1;
// 何秒触らなければ「見ていない」とみなすか。Agent 側の既定と合わせる
const IDLE_SEC = 300;
// 1つの滞在をこれ以上は伸ばさない。長く開きっぱなしのタブを1件にしない
const MAX_SEGMENT_SEC = 30 * 60;

// 伏せる区切り（一度きりのリンクに見えるもの）
const SECRETY = /^[A-Za-z0-9_-]{16,}$/;
const HEXY = /^[0-9a-f]{8,}$/i;

let current = null;   // { host, path, startedAt, activeSec, browser }
let pending = [];     // 渡し待ち
let idle = false;
let lastTick = Date.now();

// ---- URL を、残してよい形にする ---------------------------------------------

/** ホスト名だけ。読めないものは null */
function hostOf(u) {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    if (!h || !h.includes(".") || /\s/.test(h)) return null;
    if (!/^[a-z0-9.-]+$/.test(h)) return null;
    return h;
  } catch (e) { return null; }
}

/** パスだけ。? と # から後ろは、ここで捨てる */
function pathOf(u) {
  let p;
  try { p = new URL(u).pathname; } catch (e) { return null; }
  if (!p || p === "/") return null;
  const segs = p.split("/").filter(Boolean).slice(0, 6).map((seg) => {
    const v = seg.slice(0, 40);
    if (!v) return null;
    const secret = (SECRETY.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) || HEXY.test(v);
    return secret ? "…" : v;
  }).filter(Boolean);
  return segs.length ? `/${segs.join("/")}`.slice(0, 120) : null;
}

/**
 * このタブを数えてよいか、数えるなら何として数えるか。
 *
 * 引数の url は、この関数の中でしか使わない。
 * 呼び出し側へ返すのは host と path だけ
 */
function keep(url) {
  if (!url) return null;
  // 拡張・設定・ローカルのファイルは数えない。仕事とは関係がない
  if (!/^https?:\/\//i.test(url)) return null;
  const host = hostOf(url);
  if (!host) return null;
  return { host, path: pathOf(url) };
}

// ---- 数える -----------------------------------------------------------------

function closeCurrent(now) {
  if (!current) return;
  if (current.activeSec > 0) {
    pending.push({
      host: current.host,
      path: current.path,
      startedAt: new Date(current.startedAt).toISOString(),
      endedAt: new Date(now).toISOString(),
      activeSec: Math.round(current.activeSec),
      browser: current.browser,
    });
    if (pending.length > 500) pending = pending.slice(-500);
  }
  current = null;
}

function switchTo(info, now) {
  if (current && info && current.host === info.host && current.path === info.path
      && now - current.startedAt < MAX_SEGMENT_SEC * 1000) {
    return;   // 同じページのまま。数え続ける
  }
  closeCurrent(now);
  if (info) {
    current = {
      host: info.host, path: info.path,
      startedAt: now, activeSec: 0, browser: whichBrowser(),
    };
  }
}

/** Chrome か Edge か。どちらも同じ拡張が動くので、自分で名乗る */
function whichBrowser() {
  const ua = (self.navigator && self.navigator.userAgent) || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Brave/.test(ua)) return "brave";
  return "chrome";
}

/** いま前面で見ているタブを見る */
async function look() {
  const now = Date.now();
  const dt = Math.min(Math.max((now - lastTick) / 1000, 0), 120);
  lastTick = now;

  if (idle) { closeCurrent(now); return; }

  let tab = null;
  try {
    // 前面のウィンドウの、選ばれているタブだけ。
    // ほかのウィンドウを見ているあいだ、裏のタブは数えない
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch (e) { /* 取れない瞬間がある。次の回に任せる */ }

  if (!tab || tab.discarded) { closeCurrent(now); return; }

  const info = keep(tab.url);
  switchTo(info, now);
  if (current) current.activeSec += dt;
}

// ---- このパソコンのソフトへ渡す ---------------------------------------------
//
// サーバへは直接つながない。鍵をこの拡張に持たせないため。
// ソフトが止まっていれば、溜めたまま次に回す
function flush() {
  const now = Date.now();
  // 見ている途中のぶんも、いったん締めて渡す。
  // 締めたあと、同じページを見続けていれば次の回でまた始まる
  const keepCurrent = current ? { ...current } : null;
  closeCurrent(now);
  if (keepCurrent) {
    current = { ...keepCurrent, startedAt: now, activeSec: 0 };
  }

  if (!pending.length) {
    // 何も無くても、生きていることは伝える。
    // 伝えないと、管理画面で「未通信」になる
    send({ kind: "alive", browser: whichBrowser(), version: chrome.runtime.getManifest().version });
    return;
  }
  const batch = pending;
  pending = [];
  send({
    kind: "visits", browser: whichBrowser(),
    version: chrome.runtime.getManifest().version,
    visits: batch,
  }, () => { pending = batch.concat(pending).slice(-500); });
}

function send(msg, onFail) {
  try {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, () => {
      if (chrome.runtime.lastError && onFail) onFail();
    });
  } catch (e) {
    if (onFail) onFail();
  }
}

// ---- 起こす -----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

function setup() {
  chrome.idle.setDetectionInterval(IDLE_SEC);
  chrome.alarms.create("tick", { periodInMinutes: 0.25 });
  chrome.alarms.create("flush", { periodInMinutes: FLUSH_MIN });
}

chrome.idle.onStateChanged.addListener((state) => {
  idle = state !== "active";
  if (idle) closeCurrent(Date.now());
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tick") return void look();
  if (a.name === "flush") return void flush();
});

// タブを切り替えた瞬間も見る。次の tick を待つと、短い滞在を取りこぼす
chrome.tabs.onActivated.addListener(() => { look(); });
chrome.windows.onFocusChanged.addListener(() => { look(); });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url && tab.active) look();
});

setup();
