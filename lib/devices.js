// 端末管理の計算と判定。
//
// ■ 端末の載り方が2つある
//   source='browser' … ブラウザが持つID。社内システムに入ると自動で載る。
//                       分かるのは「社内システムを開いていた時間」だけ。
//                       パソコンの稼働時間ではない。
//   source='agent'   … PCに入れた常駐ソフト。起動終了・稼働・アプリ・
//                       見たサイト・USB・ソフトの出入りが分かる。
//   同じPCで両方載る。見ているものが違うので、混ぜない。
//   人から見れば1台なので、管理画面では1行にまとめて出す（linked_device_id）。
//
// ■ どちらでも取らないもの
//   キー入力・パスワード・メール本文・チャット本文・画面・
//   ウィンドウのタイトル・ページの中身・フォーム・Cookie。
//
// ■ サイトは、ドメインとページの場所まで（057〜）
//   URLの問い合わせ（?…）と断片（#…）は、端末の中で捨ててから送る。
//   検索語・メールアドレス・一度きりの鍵は、ほぼそこに入る。
//   cleanHost / cleanPath が最後の関門。エージェント側の
//   collect.HostOnly / collect.PathOnly と同じ形に削る。
//   片方だけ緩いと、緩いほうから入る。
//
// ■ 判定はサーバでやる
//   何をアラートにするかは会社が決める。ブラウザ側で決めさせない。
//
// ■ 日本時間で数える
//   サーバは UTC で動く。日付が絡むところは必ず +9時間してから見る。

import crypto from "node:crypto";

const JST = 9 * 3600000;

export const jstDate = (t = Date.now()) =>
  new Date((t instanceof Date ? t.getTime() : new Date(t).getTime()) + JST)
    .toISOString().slice(0, 10);

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/** その時刻の、日本時間での「時:分」を分に直したもの（深夜の判定に使う） */
export const jstMinutes = (t) => {
  const d = new Date(new Date(t).getTime() + JST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** 土日か（日本時間）。祝日は見ていない。祝日表を持つ手間に見合わない */
export function isWeekend(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

export const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// ---- 資格情報（エージェント用） ----------------------------------------------------

/** 端末シークレット。長さは推測を諦めさせるのに十分あればよい */
export const newSecret = () => crypto.randomBytes(32).toString("base64url");

/** 登録トークン。人が画面から写して端末に入れるので、短く・紛らわしくない字だけ */
export function newEnrollToken() {
  // 0/O、1/I/l のような取り違えやすい字は使わない。
  // 打ち間違えて「登録できません」と出るのは、いちばん無駄な時間
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = () => A[crypto.randomInt(A.length)];
  const g = () => Array.from({ length: 4 }, pick).join("");
  return `${g()}-${g()}-${g()}`;
}

/** エージェントが既定のブラウザを開くときに渡す、1回きりの合言葉 */
export const newLinkCode = () => crypto.randomBytes(16).toString("base64url");

/**
 * 端末登録の札。人は打たない（ファイル名とURLにだけ入る）ので、
 * 読みやすさより当てにくさを取る。
 *
 * インストーラが作るものと同じ長さ・同じ字の並びにしてある
 * （agent/cmd/eight-agent-setup の newToken）。
 * 片方だけ変えると、ファイル名から読んだ札が弾かれる
 */
export const newPairToken = () => crypto.randomBytes(32).toString("base64url");

/** 札の形。ファイル名から読んだものを、そのまま信じない */
export const PAIR_TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/**
 * 送られてきた資格情報を読む。
 * Authorization: Device <deviceId>:<secret>
 */
export function readDeviceAuth(header) {
  const m = /^Device\s+([0-9a-f-]{36}):(\S+)$/i.exec(String(header || "").trim());
  return m ? { deviceId: m[1], secret: m[2] } : null;
}

// ---- 端末の見分け ----------------------------------------------------------------

/**
 * ブラウザが送ってきたIDを確かめる。
 *
 * 中身は見ない（ブラウザが作った乱数）。長さと文字種だけ見て、
 * 変なものが device_uid の列に入らないようにする。
 */
export function cleanUid(v) {
  const s = String(v || "").trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(s) ? s : null;
}

/** サーバ側で作るとき（ブラウザが作れなかった場合の保険） */
export const newDeviceUid = () => crypto.randomBytes(18).toString("base64url");

const OS_RULES = [
  [/Windows NT 10\.0.*(Win64|WOW64)/, "Windows"],
  [/Windows NT/, "Windows"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

// 見る順番が大事。Edge も Chrome を名乗るし、Chrome も Safari を名乗る
const BROWSER_RULES = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const pickRule = (rules, ua) => (rules.find(([re]) => re.test(ua)) || [])[1] || null;

/**
 * 「Windows 11 の Chrome」のような名前を組み立てる。
 *
 * ブラウザはPCの名前を教えてくれない。だから、こちらで見当のつく名前を付けて、
 * 本人に直してもらう。「名前のない端末」が並ぶより、直すほうが速い。
 *
 * @param {object} hints ブラウザから送られたもの
 *   { userAgent, platform, platformVersion, model, browser, browserVersion, screen, mobile }
 */
export function describeDevice(hints = {}) {
  const ua = String(hints.userAgent || "");

  // User-Agent Client Hints があればそちらを使う。UAの文字列より正確
  let os = hints.platform ? String(hints.platform).trim() : pickRule(OS_RULES, ua);
  let osVersion = hints.platformVersion ? String(hints.platformVersion).trim() : null;

  // Windows の platformVersion は 13 以上が Windows 11。
  // そのまま出すと「Windows 15.0.0」になって、誰も知らない名前になる
  if (os === "Windows" && osVersion) {
    const major = parseInt(osVersion.split(".")[0], 10);
    osVersion = Number.isFinite(major) ? (major >= 13 ? "11" : major > 0 ? "10" : null) : null;
  }
  if (os === "Windows" && !osVersion && /Windows NT 10\.0/.test(ua)) {
    // UAだけでは 10 と 11 を見分けられない。分からないものを断定しない
    osVersion = null;
  }
  if (!os) os = "不明";

  const browser = hints.browser
    ? String(hints.browser).trim()
    : pickRule(BROWSER_RULES, ua) || "ブラウザ";

  const osLabel = osVersion ? `${os} ${osVersion}` : os;
  return {
    os,
    osVersion: osVersion || null,
    browser,
    model: hints.model ? String(hints.model).trim().slice(0, 60) || null : null,
    screen: /^\d{3,5}x\d{3,5}$/.test(String(hints.screen || "")) ? String(hints.screen) : null,
    userAgent: ua ? ua.slice(0, 300) : null,
    mobile: Boolean(hints.mobile),
    osLabel,
    // これが端末の既定の名前。本人があとから変えられる
    label: `${osLabel} の ${browser}`,
  };
}

// ---- サイトのカテゴリ（エージェント用） ---------------------------------------------

// 並び順は、そのまま画面の並び順になる。
// 上ほど「仕事をしていた」に近く、下ほど「そうでないかもしれない」。
// ただし下にあるから悪い、ではない。調べものでも動画は見る
export const CATEGORIES = [
  "internal", "work", "search", "ai", "research", "sns", "video", "shopping", "other",
];
export const CATEGORY_LABEL = {
  internal: "社内システム", work: "業務", search: "検索", ai: "AI",
  research: "調べもの", sns: "SNS", video: "動画",
  shopping: "ショッピング", other: "その他",
};

/** 勤務中に長く続くと「要確認」にするもの。悪いと決めつけるためではない */
export const DISTRACT_CATEGORIES = ["sns", "video", "shopping"];

/**
 * 既定のカテゴリ表。会社ごとに gw_device_policies.site_categories で足せる。
 *
 * ここに無いものは other。分類できないものを「怪しい」とはしない。
 */
export const DEFAULT_SITES = {
  // 社内システム
  "mf.8grp.co.jp": "internal", "8grp.co.jp": "internal", "8sp.jp": "internal",
  "mugendojo.jp": "internal",
  // 業務
  "github.com": "work", "gitlab.com": "work",
  "docs.google.com": "work", "drive.google.com": "work", "mail.google.com": "work",
  "calendar.google.com": "work", "meet.google.com": "work",
  "slack.com": "work", "teams.microsoft.com": "work", "zoom.us": "work",
  "notion.so": "work", "backlog.com": "work", "chatwork.com": "work",
  "moneyforward.com": "work", "freee.co.jp": "work",
  "canva.com": "work", "figma.com": "work", "wantedly.com": "work",
  // 検索
  "google.com": "search", "google.co.jp": "search", "bing.com": "search",
  "yahoo.co.jp": "search", "duckduckgo.com": "search",
  // AI
  "chatgpt.com": "ai", "openai.com": "ai", "claude.ai": "ai", "anthropic.com": "ai",
  "gemini.google.com": "ai", "perplexity.ai": "ai", "copilot.microsoft.com": "ai",
  // 調べもの
  "stackoverflow.com": "research", "qiita.com": "research", "zenn.dev": "research",
  "wikipedia.org": "research", "developer.mozilla.org": "research",
  "note.com": "research",
  // SNS
  "x.com": "sns", "twitter.com": "sns", "facebook.com": "sns",
  "instagram.com": "sns", "line.me": "sns", "tiktok.com": "sns",
  // 動画
  "youtube.com": "video", "nicovideo.jp": "video", "netflix.com": "video",
  "abema.tv": "video", "twitch.tv": "video",
  // ショッピング
  "amazon.co.jp": "shopping", "rakuten.co.jp": "shopping",
  "mercari.com": "shopping", "askul.co.jp": "shopping",
};

/**
 * ホスト名 → カテゴリ。
 *
 * これはエージェント側で使うためのもの（サーバはカテゴリしか受け取らない）。
 * サーバにも置いてあるのは、エージェントへ配る表を組み立てるため。
 *
 * 「www.」や国別のサブドメインは落として、後ろから見ていく。
 * mail.google.com は google.com より先に当てる（より具体的なほうが勝つ）。
 */
export function categoryOf(host, extra = {}) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return "other";
  const table = { ...DEFAULT_SITES, ...extra };

  if (table[h]) return table[h];
  // 後ろから1段ずつ削って探す。a.b.example.com → b.example.com → example.com
  const parts = h.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join(".");
    if (table[suffix]) return table[suffix];
  }
  return "other";
}

// ---- 利用時間 ---------------------------------------------------------------------

/** 分 → 「6:12」 */
export function clock(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** 合図の間隔（分）。これより長く空いたら、そこで一度切れたとみなす */
export const BEAT_MIN = 5;
export const BEAT_GAP_MAX = 12;

/**
 * 合図を1回ぶん、その日の集計に足す。
 *
 * ■ なぜ足し算で持つのか
 *   「何時から何時まで画面を開いていたか」を分単位で持つと、
 *   それは1日の行動の記録になる。合計だけ持てば足りる。
 *
 * ■ つなぎ方
 *   前の合図から BEAT_GAP_MAX 分以内なら、その間はずっと開いていたとみなす。
 *   それより空いていたら、閉じていた時間なので数えない（今回ぶんの1分だけ）。
 *
 * @param {object|null} prev 既にある gw_device_usage の行（無ければ null）
 * @param {string|Date}  at   合図が届いた時刻
 * @param {object} policy { night_from, night_to }
 * @returns {object} 保存する値（camelCase）
 */
export function applyBeat(prev, at, policy = {}) {
  const now = new Date(at);
  const t = now.getTime();
  const workDate = jstDate(t);

  const last = prev?.last_at ? Date.parse(prev.last_at) : 0;
  const gapMin = last ? (t - last) / 60000 : 0;

  // 巻き戻った合図は数えない（端末の時計がずれている、順番が入れ替わった）
  if (last && t <= last) {
    return {
      workDate,
      activeMin: prev.active_min || 0,
      nightMin: prev.night_min || 0,
      holidayMin: prev.holiday_min || 0,
      beats: (prev.beats || 0) + 1,
      firstAt: prev.first_at || now.toISOString(),
      lastAt: prev.last_at,
      addedMin: 0,
    };
  }

  const add = !last ? 1
    : gapMin <= BEAT_GAP_MAX ? Math.round(gapMin)
    : 1;

  const night = inNight(t, policy) ? add : 0;
  const holiday = isWeekend(workDate) ? add : 0;

  return {
    workDate,
    activeMin: Math.min((prev?.active_min || 0) + add, 1440),
    nightMin: Math.min((prev?.night_min || 0) + night, 1440),
    holidayMin: Math.min((prev?.holiday_min || 0) + holiday, 1440),
    beats: (prev?.beats || 0) + 1,
    firstAt: prev?.first_at || now.toISOString(),
    lastAt: now.toISOString(),
    addedMin: add,
  };
}

/** 深夜か。22:00〜05:00 のように日をまたぐ設定を扱う */
export function inNight(at, policy = {}) {
  const from = hhmmToMin(policy.night_from, 22 * 60);
  const to = hhmmToMin(policy.night_to, 5 * 60);
  const m = jstMinutes(at);
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

function hhmmToMin(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ""));
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---- エージェントが送ってきたものをそろえる ------------------------------------------
//
//   端末は改ざんできる。あり得ない値はここで落とす。

/**
 * 送られてきた日別の集計をそろえる。
 * 端末は改ざんできるので、あり得ない値はここで落とす。
 */
export function normalizeUsage(u) {
  if (!u || !isDate(u.workDate)) return null;
  const m = (v) => {
    const n = Math.round(Number(v) || 0);
    // 1日は 1440分。それを超える値は壊れている
    return n > 0 ? Math.min(n, 1440) : 0;
  };
  return {
    workDate: u.workDate,
    activeMin: m(u.activeMin),
    idleMin: m(u.idleMin),
    lockedMin: m(u.lockedMin),
    nightMin: m(u.nightMin),
    holidayMin: m(u.holidayMin),
    firstAt: u.firstAt || null,
    lastAt: u.lastAt || null,
  };
}

/** アプリ別。1日 × 1アプリで 1440分を超えることはない */
export function normalizeApps(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && isDate(a.workDate) && String(a.exeName || "").trim())
    .map((a) => ({
      workDate: a.workDate,
      // 実行ファイル名だけ。パスは受け取らない（ユーザー名が入る）
      exeName: String(a.exeName).trim().split(/[\\/]/).pop().slice(0, 120),
      product: a.product ? String(a.product).slice(0, 120) : null,
      minutes: Math.min(Math.max(Math.round(Number(a.minutes) || 0), 0), 1440),
    }))
    .filter((a) => a.minutes > 0)
    .slice(0, 200);
}

/**
 * ドメインとして受け取ってよい形か。
 *
 * ここが緩いと、アドレスバーに打った検索語がそのまま入ってくる。
 * 「空白を含む」「点が無い」「英数字とハイフンと点以外がある」のどれかなら捨てる。
 * エージェント側（collect.HostOnly）と同じ判定にしてある。
 * どちらか片方が緩いと、緩いほうから入る
 */
export function cleanHost(v) {
  const s = String(v ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!s || s.length > 120) return "";
  if (/\s/.test(s)) return "";              // 検索語
  if (!s.includes(".")) return "";          // localhost など
  if (!/^[a-z0-9.-]+$/.test(s)) return "";  // 日本語・記号・パス・クエリ
  if (s.startsWith(".") || s.endsWith(".") || s.includes("..")) return "";
  return s;
}

/**
 * サイト。ドメインとカテゴリと時間だけ。
 *
 * URLのパス・問い合わせ・ページの題・中身は、ここに入れる場所が無い。
 * host を省いたものは、057 より前と同じ「カテゴリだけ」の行として通す
 */
export function normalizeWeb(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list) {
    if (!w || !isDate(w.workDate)) continue;
    const host = cleanHost(w.host);
    // カテゴリが無ければ、ドメインから引く（表に無ければ other）
    const category = CATEGORIES.includes(w.category)
      ? w.category
      : (host ? categoryOf(host) : null);
    if (!category) continue;
    const minutes = Math.min(Math.max(Math.round(Number(w.minutes) || 0), 0), 1440);
    if (minutes <= 0) continue;
    out.push({
      workDate: w.workDate,
      host,
      category,
      browser: BROWSER_KEYS.includes(w.browser) ? w.browser : null,
      minutes,
    });
    if (out.length >= 300) break;
  }
  return out;
}

// ---- ブラウザ（1台のPCの中） -------------------------------------------------
//
// 1台のパソコンに、エージェントと、いくつかのブラウザがぶら下がる。
// 「入っている」と「つながっている」は別のこと。
// Chrome が入っているのに拡張が動いていない、が分かるようにする。

export const BROWSERS = [
  { key: "chrome",  label: "Chrome" },
  { key: "edge",    label: "Edge" },
  { key: "firefox", label: "Firefox" },
  { key: "brave",   label: "Brave" },
  { key: "opera",   label: "Opera" },
];
export const BROWSER_KEYS = BROWSERS.map((b) => b.key);
export const browserLabel = (k) => BROWSERS.find((b) => b.key === k)?.label || k;

/** 実行ファイル名 → ブラウザの鍵。エージェントが見た exe 名から引く */
export const BROWSER_OF_EXE = {
  "chrome.exe": "chrome", "msedge.exe": "edge", "firefox.exe": "firefox",
  "brave.exe": "brave", "opera.exe": "opera",
};

/** つながっていないと見なすまで。拡張は動いていれば数分おきに届く */
export const BROWSER_SILENT_MIN = 180;

/**
 * ブラウザ1つぶんの状態。
 *
 *   linked    … 拡張が届いている（●連携済）
 *   silent    … つながっていたが、しばらく届いていない
 *   installed … 入っているが、まだつながっていない
 *   gone      … 入っていない
 */
export function browserState(b, now = Date.now()) {
  if (!b) return { key: "gone", label: "未導入" };
  const seen = b.last_seen_at ? Date.parse(b.last_seen_at) : 0;
  if (b.linked && seen && now - seen <= BROWSER_SILENT_MIN * 60000) {
    return { key: "linked", label: "連携済" };
  }
  if (b.linked || seen) {
    return {
      key: "silent", label: "未通信",
      note: "つながっていましたが、しばらく届いていません。ブラウザの拡張が止まっているかもしれません",
    };
  }
  if (b.installed) {
    return {
      key: "installed", label: "未連携",
      note: "このパソコンに入っていますが、まだ拡張から届いていません",
    };
  }
  return { key: "gone", label: "未導入" };
}

// ---- URLのパス --------------------------------------------------------------
//
// ■ 何を落とすか
//   問い合わせ（?q=…）と断片（#…）は、まるごと落とす。
//   検索語・メールアドレス・認証トークン・招待リンクは、ほぼここに入る。
//
// ■ パスにも混ざる
//   /reset/9f3c8a2b… のような一度きりのリンクは、パスに鍵が乗っている。
//   長い英数字だけの区切りは伏せる。短い日本語や英単語は残す
//   （/recruit/apply のように、何のページかは残さないと意味が無い）。
//
// ■ それでもパスは重い
//   /psychiatry/ や /tenshoku/ は、病歴や転職活動を映す。
//   落としきれないので、**見たことが本人に残る** 側で釣り合いを取っている
//   （管理者が開くと gw_device_views に残り、本人の画面に出る）。

const SECRETY = /^[A-Za-z0-9_-]{16,}$/;         // 一度きりのリンクに見える区切り
const HEXY = /^[0-9a-f]{8,}$/i;

/** パスの1区切りが、鍵やトークンに見えるか */
const looksSecret = (seg) =>
  (SECRETY.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) || HEXY.test(seg);

/**
 * URL から、残してよいパスだけを取り出す。
 * 問い合わせ・断片・ユーザー情報は必ず落とす。戻り値は "/a/b" か null
 */
export function cleanPath(raw, max = 120) {
  let s = String(raw ?? "").trim();
  if (!s) return null;

  // 完全なURLで来たら、パスから先だけ見る
  if (s.includes("://")) {
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(s);
    s = m ? m[1] : "";
  }
  // 念のためもう一度。ホスト名だけで来た場合はパス無し
  s = s.split("?")[0].split("#")[0];
  if (!s || s === "/") return null;
  if (!s.startsWith("/")) s = `/${s}`;

  const segs = s.split("/").filter(Boolean).slice(0, 6).map((seg) => {
    let v = seg.slice(0, 40);
    // 制御文字と空白を落とす。
    //
    // 本物のURLのパスに、生の空白は入らない（%20 になる）。
    // 空白が入っているのは、アドレスバーに打った検索語を
    // パスとして読んでしまったとき。そこだけ通すわけにいかない
    v = v.replace(/[\s\u0000-\u001f\u007f]/g, "");
    if (!v) return null;
    return looksSecret(v) ? "…" : v;
  }).filter(Boolean);

  if (!segs.length) return null;
  return `/${segs.join("/")}`.slice(0, max);
}

/**
 * WEB利用の履歴。1回の滞在＝1件。
 *
 * host が読めないものは丸ごと捨てる。
 * 「実際に見ていた秒数」が0のものは入れない（開いていただけの時間は数えない）
 */
export function normalizeVisits(list, { policy = {} } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (!v) continue;
    const host = cleanHost(v.host);
    if (!host) continue;

    const started = Date.parse(v.startedAt || "");
    if (!Number.isFinite(started)) continue;
    const ended = Date.parse(v.endedAt || "");

    // そのタブを実際に見ていた秒数。滞在の長さを超えないようにする
    const span = Number.isFinite(ended) && ended > started
      ? Math.round((ended - started) / 1000) : null;
    let activeSec = Math.round(Number(v.activeSec) || 0);
    if (activeSec <= 0) continue;
    if (span != null) activeSec = Math.min(activeSec, span);
    activeSec = Math.min(activeSec, 12 * 3600);

    const category = CATEGORIES.includes(v.category)
      ? v.category
      : categoryOf(host, policy.site_categories || {});

    out.push({
      host,
      path: cleanPath(v.path ?? v.url),
      category,
      browser: BROWSER_KEYS.includes(v.browser) ? v.browser : null,
      startedAt: new Date(started).toISOString(),
      endedAt: Number.isFinite(ended) ? new Date(ended).toISOString() : null,
      activeSec,
      workDate: isDate(v.workDate) ? v.workDate : jstDate(started),
    });
    if (out.length >= 500) break;
  }
  return out;
}

// ---- 勤務時間 ---------------------------------------------------------------

/** "HH:MM" を、その日の0時からの分に直す。読めなければ null */
export function hhmmMin(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * その時刻が勤務時間の中か。
 *
 * 打刻（gw_time_entries）があればそれを使う。無ければ会社の既定（9:00〜18:00）。
 * 「勤務中のWEB利用を見る」のが目的なので、ここを入れるときに決めておく。
 * あとから見るたびに突き合わせると、解釈がぶれる
 */
export function inWorkHours(at, { entry = null, policy = {} } = {}) {
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return null;

  if (entry?.clock_in) {
    const from = Date.parse(entry.clock_in);
    // まだ退勤していなければ、いままで
    const to = entry.clock_out ? Date.parse(entry.clock_out) : Date.now();
    if (!Number.isFinite(from)) return null;
    return t >= from && t <= to;
  }

  const mins = jstMinutes(t);
  const from = hhmmMin(policy.work_from) ?? 9 * 60;
  const to = hhmmMin(policy.work_to) ?? 18 * 60;
  // 夜勤のように日をまたぐ設定でも読めるようにしておく
  return from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
}

/** エージェントが送ってくるブラウザの状態。知らない鍵は捨てる */
export function normalizeBrowsers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const b of list) {
    const key = String(b?.browser || "").toLowerCase();
    if (!BROWSER_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      browser: key,
      installed: Boolean(b.installed),
      linked: Boolean(b.linked),
      extVersion: b.extVersion ? String(b.extVersion).slice(0, 20) : null,
    });
  }
  return out;
}

// ---- できごと ---------------------------------------------------------------------

// ブラウザ側。台帳に載る・本人が確認する、といった節目
export const BROWSER_EVENT_KINDS = [
  "first_seen", "confirmed", "installed", "renamed",
  "suspended", "resumed", "retired", "forgotten", "linked",
];

// エージェント側。端末から送られてくる
export const AGENT_EVENT_KINDS = [
  "boot", "shutdown", "logon", "logoff", "lock", "unlock", "sleep", "wake",
  "usb_attach", "usb_detach", "app_install", "app_uninstall",
  "agent_start", "agent_update", "agent_error",
];

export const EVENT_KINDS = [...BROWSER_EVENT_KINDS, ...AGENT_EVENT_KINDS];

export const EVENT_LABEL = {
  first_seen: "はじめてこの端末から使いました",
  confirmed: "本人がこの端末だと確認しました",
  installed: "アプリとして入れました",
  renamed: "名前を変えました",
  suspended: "停止しました",
  resumed: "再開しました",
  retired: "使用終了にしました",
  forgotten: "本人がこの端末を外しました",
  linked: "このパソコンのブラウザとつなぎました",

  boot: "起動", shutdown: "シャットダウン",
  logon: "ログオン", logoff: "ログオフ",
  lock: "ロック", unlock: "ロック解除",
  sleep: "スリープ", wake: "復帰",
  usb_attach: "USB接続", usb_detach: "USB取り外し",
  app_install: "ソフトのインストール", app_uninstall: "ソフトのアンインストール",
  agent_start: "エージェント起動", agent_update: "エージェント更新",
  agent_error: "エージェントのエラー",
};

/**
 * エージェントが送ってきたできごとをそろえる。
 *
 * detail に入れてよいものを、ここで絞る。
 * 端末が何を送ってきても、決めた鍵しか通さない。
 * ファイル名・URL・ウィンドウのタイトルが紛れ込む道を作らない。
 */
const DETAIL_KEYS = ["vid", "pid", "class", "label", "name", "version", "publisher", "message"];

export function normalizeEvents(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && AGENT_EVENT_KINDS.includes(e.kind)
      && Number.isFinite(Number(e.seq)) && e.at)
    .map((e) => {
      const detail = {};
      for (const k of DETAIL_KEYS) {
        if (e.detail?.[k] != null) detail[k] = String(e.detail[k]).slice(0, 200);
      }
      const at = new Date(e.at);
      if (!Number.isFinite(at.getTime())) return null;
      return {
        seq: Math.round(Number(e.seq)),
        at: at.toISOString(),
        workDate: jstDate(at),
        kind: e.kind,
        detail,
      };
    })
    .filter(Boolean)
    .slice(0, 500);
}

// ---- アラートの判定 ---------------------------------------------------------------

export const SEVERITY_LABEL = { info: "情報", warn: "要確認", critical: "重大" };

export const RULE_LABEL = {
  unknown_device: "未登録端末／私物端末の可能性",
  night_access: "深夜の利用",
  holiday_access: "休日の利用",
  no_access: "使われていない端末",
  unapproved_software: "未承認のソフト",
  usb_attach: "USBメモリの接続",
  agent_error: "エージェントのエラー",
  night_work: "深夜の稼働",
  holiday_work: "休日の稼働",
  agent_silent: "エージェントから届いていない",
  browser_silent: "ブラウザ連携が止まっている",
  distract_in_work: "勤務中に別のことが続いた",
  night_web: "深夜のWEB利用",
  no_activity: "勤務時間なのに操作がない",
  confirm_waiting: "本人の確認待ちのまま",
};

/**
 * その日の「△ 要確認」を、アラートの種にする。
 *
 * ■ 「不正」とは判定しない
 *   どれも **管理者に確認を促す** ためのもの。
 *   SNSを見ていた＝サボり、ではない。調べものでSNSを見ることも、
 *   休憩時間が打刻に入っていないこともある。
 *   だから severity は warn までにして、critical にしない。
 *
 * ■ dayVerdict と同じ条件にしてある
 *   画面で △ が出ているのに、確認する先が無い（またはその逆）が起きないように、
 *   判定のしきい値をここと dayVerdict で共通にしている。
 *   片方だけ直すと、見えているものと残るものがずれる。
 *
 * @param {{date:string, distractSec:number, nightSec:number,
 *          workedMin?:number, activeMin?:number,
 *          label?:string, policy?:object}} p
 */
export function webAlerts({ date, distractSec = 0, nightSec = 0,
                            workedMin = 0, activeMin = null,
                            label = "", policy = {} }) {
  const out = [];
  const limit = Math.max(Number(policy.distract_min_minutes) || 90, 5);

  if (distractSec >= limit * 60) {
    out.push({
      severity: "warn", rule: "distract_in_work",
      title: `勤務時間中に SNS・動画・買い物が ${clock(Math.round(distractSec / 60))} ありました`,
      detail: { date, minutes: Math.round(distractSec / 60), label },
      occurredAt: `${date}T09:00:00+09:00`,
      dedupeKey: `distract:${date}`,
    });
  }
  if (nightSec >= 60 * 60) {
    out.push({
      severity: "warn", rule: "night_web",
      title: `深夜のWEB利用が ${clock(Math.round(nightSec / 60))} ありました`,
      detail: { date, minutes: Math.round(nightSec / 60), label },
      occurredAt: `${date}T23:00:00+09:00`,
      dedupeKey: `nightweb:${date}`,
    });
  }
  // 勤務しているのに、パソコンがほとんど動いていない。
  // 外出・来客・会議のこともあるので、決めつけずに確認を促すだけにする
  if (workedMin >= 240 && activeMin != null && activeMin < 60) {
    out.push({
      severity: "warn", rule: "no_activity",
      title: `勤務 ${clock(workedMin)} のうち、パソコンの操作が ${clock(activeMin)} でした`,
      detail: { date, workedMin, activeMin, label },
      occurredAt: `${date}T12:00:00+09:00`,
      dedupeKey: `noact:${date}`,
    });
  }
  return out;
}

/**
 * 1日の様子を、一覧に出す3段階にまとめる。
 *
 * ■ 一覧には細かい履歴を出さない
 *   ○ / △ / × だけ。中身は、管理者がその人を開いたときに見る。
 *   一覧に並べると、見る用が無いのに毎日目に入ることになる。
 *
 * ■ × は「異常」ではなく「届いていない」
 *   記録が取れていない状態を × にする。人の行いを × とはしない。
 */
export function dayVerdict({ usage = null, distractSec = 0, silent = false, workedMin = 0,
                             policy = {} } = {}) {
  if (silent) {
    return { key: "bad", mark: "×", label: "異常",
             note: "この日の記録が届いていません。エージェントかブラウザ連携が止まっている可能性があります" };
  }
  const limit = Math.max(Number(policy.distract_min_minutes) || 90, 5);
  const reasons = [];

  if (distractSec >= limit * 60) {
    reasons.push(`勤務中に SNS・動画・買い物が ${clock(Math.round(distractSec / 60))}`);
  }
  // 勤務時間があるのに、PCがほとんど動いていない。
  // 外出・来客・会議のこともあるので、決めつけずに「要確認」にとどめる
  if (workedMin >= 240 && usage && (usage.active_min || 0) < 60) {
    reasons.push("勤務時間のわりに、パソコンの操作がほとんどありません");
  }
  if ((usage?.night_min || 0) >= 60) reasons.push("深夜の稼働があります");

  if (reasons.length) {
    return { key: "check", mark: "△", label: "要確認", note: reasons.join("／") };
  }
  return { key: "ok", mark: "○", label: "正常", note: "" };
}

/**
 * 本人が「このパソコンです」を押さないまま置かれている。
 *
 * ■ なぜ知らせるのか
 *   押すまで、利用時間は1分も数えない（そう作ってある）。
 *   つまり押されない端末は、台帳に載っているのに中身が空のまま溜まる。
 *   週1回ゼロにする運用にするなら、溜まっていることが見えないと回らない。
 *
 * ■ 責めるためのものではない
 *   たいていは「押すのを忘れた」か「案内が届いていない」。
 *   severity は warn までにして、声をかける材料にする。
 */
export function confirmWaitingAlert(device, { policy = {}, now = Date.now() } = {}) {
  const days = Number(policy.confirm_wait_days);
  // 0 を入れたら知らせない、という設定にしてある
  if (days === 0) return null;
  const wait = Number.isFinite(days) && days > 0 ? days : 3;

  if (device.notified_at) return null;
  const since = Date.parse(device.first_seen_at || device.created_at || "");
  if (!since || now - since < wait * 86400000) return null;

  const waited = Math.floor((now - since) / 86400000);
  return {
    severity: "warn", rule: "confirm_waiting",
    title: `${device.hostname || device.label} は、本人の確認待ちのまま ${waited}日たっています`,
    detail: { days: waited, label: device.label, source: device.source },
    occurredAt: new Date(now).toISOString(),
    // 1台につき1回だけ。毎日出しても、声をかける回数は増えない
    dedupeKey: `confirmwait:${device.id}`,
  };
}

/**
 * 台帳に無いパソコンから社内システムに入られた。
 *
 * ■ 業務は原則、会社貸与PCだけ
 *   私物PCでの業務利用は禁止している。
 *   会社貸与PCには端末管理ソフトが入るので、台帳に載る。
 *   載っていないものから入られたら、私物の可能性がある。
 *
 * ■ それでも「違反」とは書かない
 *   買い替えたばかりのPC、貸出機、承認を受けた私物のこともある。
 *   出たものを人が見て決める。severity は warn までにする。
 */
export function unknownDeviceAlert(device, { known = 0, policy = {}, at = Date.now() } = {}) {
  if (policy.unknown_alert === false) return null;
  // その人にとって最初の端末なら、比べるものが無い。入社した日に出しても意味がない
  if (known < 1) return null;
  return {
    severity: "warn",
    rule: "unknown_device",
    title: `台帳に無いパソコンから社内システムに入りました（${device.label}）`,
    detail: { label: device.label, os: device.os, browser: device.browser },
    occurredAt: new Date(at).toISOString(),
    dedupeKey: `unknown:${device.device_uid || device.id}`,
  };
}

/** 端末の持ち主区分 */
export const OWNERSHIP = [
  { key: "company", label: "会社貸与", note: "業務に使ってよいパソコン" },
  { key: "personal", label: "私物", note: "業務利用は禁止。承認があるときだけ" },
  { key: "unknown", label: "未確認", note: "会社貸与か私物か、まだ分かっていない" },
];
export const OWNERSHIP_LABEL =
  Object.fromEntries(OWNERSHIP.map((o) => [o.key, o.label]));

/**
 * その端末を、業務に使ってよいか。
 *
 * ■ 「だめ」を出すだけにしない
 *   禁止だけ突きつけると、現場は黙って使う。
 *   承認を受ければ通る道があることを、同じ場所に出す。
 *
 * @param {object} device   gw_devices の行
 * @param {object[]} exceptions その人に出ている私物利用の承認
 */
export function ownershipState(device, { exceptions = [], today = jstDate() } = {}) {
  const own = device?.ownership || "unknown";
  if (own === "company") {
    return { key: "ok", label: "会社貸与", note: "" };
  }

  // 期限内で、取り消されていない承認があるか
  const live = (exceptions || []).find((e) =>
    !e.revoked_at && String(e.expires_on || "") >= today
    && (!e.device_id || e.device_id === device?.id));

  if (live) {
    return {
      key: "allowed",
      label: own === "personal" ? "私物（承認済み）" : "承認済み",
      note: `${live.expires_on} まで。理由: ${live.reason || "—"}`,
    };
  }
  if (own === "personal") {
    return {
      key: "banned", label: "私物（承認なし）",
      note: "業務利用は禁止です。必要なら事前承認を出してください",
    };
  }
  return {
    key: "check", label: "未確認",
    note: "会社貸与か私物か、まだ分かっていません。確かめて区分を付けてください",
  };
}

/** 私物利用の承認が、いま生きているか */
export function exceptionState(e, today = jstDate()) {
  if (e?.revoked_at) return { key: "revoked", label: "取り消し済み" };
  if (String(e?.expires_on || "") < today) return { key: "expired", label: "期限切れ" };
  return { key: "live", label: "有効" };
}

/**
 * 深夜・休日に社内システムを使っていた。
 *
 * ■ これを出すのは、働かせすぎを見つけるため
 *   サボりを探すためではない。画面の文言もそう書く。
 *   ここを取り違えると、この機能は社内で嫌われて終わる。
 */
export function timeAlerts(usage, { policy = {}, label = "" } = {}) {
  if (!usage || policy.night_alert === false) return [];
  const out = [];
  const nightMin = Number(policy.night_min_minutes) || 60;
  const holidayMin = Number(policy.holiday_min_minutes) || 120;

  if ((usage.nightMin || 0) >= nightMin) {
    out.push({
      severity: "warn", rule: "night_access",
      title: `深夜に社内システムを ${clock(usage.nightMin)} 使っていました`,
      detail: { minutes: usage.nightMin, label },
      occurredAt: usage.lastAt || `${usage.workDate}T23:59:00+09:00`,
      dedupeKey: `night:${usage.workDate}`,
    });
  }
  if ((usage.holidayMin || 0) >= holidayMin) {
    out.push({
      severity: "warn", rule: "holiday_access",
      title: `休日に社内システムを ${clock(usage.holidayMin)} 使っていました`,
      detail: { minutes: usage.holidayMin, label },
      occurredAt: usage.lastAt || `${usage.workDate}T23:59:00+09:00`,
      dedupeKey: `holiday:${usage.workDate}`,
    });
  }
  return out;
}

/**
 * エージェントが送ってきたできごとから、対応が要るものを拾う。
 *
 * ■ 深夜・休日を出すのは、働かせすぎを見つけるため
 *   サボりを探すためではない。画面の文言もそう書く。
 *   ここを取り違えると、この機能は社内で嫌われて終わる。
 *
 * @param {Array}  events  normalizeEvents を通したもの
 * @param {object} usage   その日の集計（深夜・休日の判定に使う）
 * @param {object} policy  会社ごとの設定
 * @returns {Array} アラートの種
 */
export function alertsFrom({ events = [], usage = null, policy = {} }) {
  const out = [];
  const blocked = (policy.blocked_software || [])
    .map((s) => String(s).toLowerCase()).filter(Boolean);

  for (const e of events) {
    if (e.kind === "app_install") {
      const name = String(e.detail?.name || "").toLowerCase();
      const hit = blocked.find((b) => name.includes(b));
      if (hit) {
        out.push({
          severity: "critical", rule: "unapproved_software",
          title: `未承認のソフト「${e.detail?.name || hit}」がインストールされました`,
          detail: e.detail, occurredAt: e.at, seq: e.seq,
          dedupeKey: `sw:${e.workDate}:${name.slice(0, 60)}`,
        });
      }
    }
    if (e.kind === "usb_attach" && policy.usb_alert !== false) {
      // 大容量記憶装置だけ。マウスやキーボードまで出すと、毎朝アラートが出る
      if (String(e.detail?.class || "") === "mass_storage") {
        out.push({
          severity: "warn", rule: "usb_attach",
          title: `USBメモリが接続されました${e.detail?.label ? `（${e.detail.label}）` : ""}`,
          detail: e.detail, occurredAt: e.at, seq: e.seq,
          dedupeKey: `usb:${e.workDate}:${e.detail?.vid || ""}${e.detail?.pid || ""}`,
        });
      }
    }
    if (e.kind === "agent_error") {
      out.push({
        severity: "warn", rule: "agent_error",
        title: "エージェントがエラーを報告しました",
        detail: e.detail, occurredAt: e.at, seq: e.seq,
        dedupeKey: `err:${e.workDate}`,
      });
    }
  }

  if (usage && policy.night_alert !== false) {
    const nightMin = Number(policy.night_min_minutes) || 60;
    const holidayMin = Number(policy.holiday_min_minutes) || 120;
    if ((usage.nightMin || 0) >= nightMin) {
      out.push({
        severity: "warn", rule: "night_work",
        title: `深夜の稼働が ${clock(usage.nightMin)} ありました`,
        detail: { minutes: usage.nightMin },
        occurredAt: usage.lastAt || `${usage.workDate}T23:59:00+09:00`,
        dedupeKey: `night:${usage.workDate}`,
      });
    }
    if ((usage.holidayMin || 0) >= holidayMin) {
      out.push({
        severity: "warn", rule: "holiday_work",
        title: `休日の稼働が ${clock(usage.holidayMin)} ありました`,
        detail: { minutes: usage.holidayMin },
        occurredAt: usage.lastAt || `${usage.workDate}T23:59:00+09:00`,
        dedupeKey: `holiday:${usage.workDate}`,
      });
    }
  }
  return out;
}

/**
 * 端末の状態。一覧の「正常 / 要確認 / 使われていない」に使う。
 *
 * @param {object} device gw_devices の行
 * @param {number} warn   その端末で開いている要確認アラートの数
 */
export function deviceState(device, { critical = 0, warn = 0, staleDays = 60, now = Date.now() } = {}) {
  const isAgent = device.source === "agent";

  if (device.status === "retired") return { key: "retired", label: "使用終了" };
  if (device.status === "suspended") return { key: "suspended", label: "停止中" };
  if (!device.notified_at) {
    return {
      key: "waiting", label: "本人の確認待ち",
      note: isAgent
        ? "確認するまで、このパソコンからは何も送られてきません"
        : "確認するまで、この端末の利用時間は数えていません",
    };
  }
  if (critical) return { key: "critical", label: "重大" };

  const seen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;

  // エージェントは5分ごとに送ってくるはずのもの。1日届かなければ止まっている。
  // ブラウザは使ったときだけなので、しばらく空くのはふつう
  if (isAgent) {
    if (!seen || now - seen > 24 * 3600000) {
      return {
        key: "silent", label: "未通信",
        note: seen
          ? "24時間以上、このパソコンから届いていません。"
            + "ソフトが止まっているか、パソコンが起動していないか、通信できない場所にあります"
          : "このパソコンからは、まだ一度も届いていません",
      };
    }
  } else if (!seen || now - seen > staleDays * 86400000) {
    return {
      key: "stale", label: "使われていない",
      note: `${staleDays}日以上、この端末からの利用がありません`,
    };
  }
  if (warn) return { key: "warn", label: "要確認" };
  return { key: "ok", label: "正常" };
}

/** 最終利用を「3分前」のように出す */
export function sinceLabel(at, now = Date.now(), empty = "利用なし") {
  if (!at) return empty;
  const min = Math.floor((now - Date.parse(at)) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

// ---- 登録コード -------------------------------------------------------------------

/** 発行できる有効期限。長く生かしておく理由がないので、短いほうから並べる */
export const TOKEN_DAYS = [1, 3, 7, 30];

export function tokenDays(v, fallback = 7) {
  const n = Math.round(Number(v));
  return TOKEN_DAYS.includes(n) ? n : fallback;
}

/**
 * 登録コードの状態。
 *
 * 「使われた」「期限切れ」「取り消した」「まだ使える」の4つ。
 * 使われたコードは消さない。誰がいつ何に使ったかが、監査の本体になる。
 */
export function tokenState(row, now = Date.now()) {
  if (row.revoked_at) return { key: "revoked", label: "取り消し済み" };
  if (row.used_at) return { key: "used", label: "使用済み" };
  if (Date.parse(row.expires_at) < now) return { key: "expired", label: "期限切れ" };
  return { key: "open", label: "使えます" };
}

// ---- CSV ------------------------------------------------------------------------

export const SOURCE_LABEL = { browser: "ブラウザ", agent: "エージェント" };

export const CSV_HEADER = [
  "日付", "端末", "取得元", "OS", "ブラウザ", "使う人", "部署",
  "利用(分)", "離席(分)", "深夜(分)", "休日(分)", "最初", "最後",
];

export function csvRow(u, device, employee) {
  const hm = (t) => (t ? new Date(new Date(t).getTime() + JST).toISOString().slice(11, 16) : "");
  return [
    u.work_date,
    device?.label || device?.hostname || "",
    SOURCE_LABEL[device?.source] || "",
    device?.os || "",
    device?.browser || "",
    employee?.display_name || "",
    employee?.department || "",
    u.active_min, u.idle_min ?? 0, u.night_min, u.holiday_min,
    hm(u.first_at), hm(u.last_at),
  ];
}

export const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
