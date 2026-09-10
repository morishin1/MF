// 端末管理の計算と判定。
//
// ■ 端末の載り方が2つある
//   source='browser' … ブラウザが持つID。社内システムに入ると自動で載る。
//                       分かるのは「社内システムを開いていた時間」だけ。
//                       パソコンの稼働時間ではない。
//   source='agent'   … PCに入れた常駐ソフト。起動終了・稼働・アプリ・
//                       サイトのカテゴリ・USB・ソフトの出入りが分かる。
//   同じPCで両方載る。見ているものが違うので、混ぜない。
//
// ■ どちらでも取らないもの
//   キー入力・パスワード・メール本文・チャット本文・画面・
//   ウィンドウのタイトル・URLの全文。
//   URLは端末の中でホスト名→カテゴリに落としてから送るので、
//   サーバに来るのはカテゴリだけ。
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

export const CATEGORIES = ["work", "research", "sns", "video", "shopping", "other"];
export const CATEGORY_LABEL = {
  work: "業務", research: "調べもの", sns: "SNS",
  video: "動画", shopping: "ショッピング", other: "その他",
};

/**
 * 既定のカテゴリ表。会社ごとに gw_device_policies.site_categories で足せる。
 *
 * ここに無いものは other。分類できないものを「怪しい」とはしない。
 */
export const DEFAULT_SITES = {
  // 業務
  "github.com": "work", "gitlab.com": "work",
  "docs.google.com": "work", "drive.google.com": "work", "mail.google.com": "work",
  "slack.com": "work", "teams.microsoft.com": "work", "zoom.us": "work",
  "notion.so": "work", "backlog.com": "work", "chatwork.com": "work",
  "moneyforward.com": "work", "freee.co.jp": "work",
  "8grp.co.jp": "work",
  // 調べもの
  "google.com": "research", "bing.com": "research", "yahoo.co.jp": "research",
  "stackoverflow.com": "research", "qiita.com": "research", "zenn.dev": "research",
  "wikipedia.org": "research", "chatgpt.com": "research", "claude.ai": "research",
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

/** サイト。カテゴリ以外は受け取らない */
export function normalizeWeb(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && isDate(w.workDate) && CATEGORIES.includes(w.category))
    .map((w) => ({
      workDate: w.workDate,
      category: w.category,
      minutes: Math.min(Math.max(Math.round(Number(w.minutes) || 0), 0), 1440),
    }))
    .filter((w) => w.minutes > 0)
    .slice(0, 100);
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
  unknown_device: "見慣れない端末",
  night_access: "深夜の利用",
  holiday_access: "休日の利用",
  no_access: "使われていない端末",
  unapproved_software: "未承認のソフト",
  usb_attach: "USBメモリの接続",
  agent_error: "エージェントのエラー",
  night_work: "深夜の稼働",
  holiday_work: "休日の稼働",
  agent_silent: "エージェントから届いていない",
};

/**
 * 見慣れない端末から入られた。
 *
 * ■ 何をもって「見慣れない」とするか
 *   その人が今まで使っていなかった端末から入った、というだけ。
 *   新しいPCを買っても出るし、自宅のPCから見ても出る。
 *   それでよい。出たものを人が見て、問題かどうかを決める。
 */
export function unknownDeviceAlert(device, { known = 0, policy = {}, at = Date.now() } = {}) {
  if (policy.unknown_alert === false) return null;
  // その人にとって最初の端末なら、比べるものが無い。入社した日に出しても意味がない
  if (known < 1) return null;
  return {
    severity: "warn",
    rule: "unknown_device",
    title: `見慣れない端末から社内システムに入りました（${device.label}）`,
    detail: { label: device.label, os: device.os, browser: device.browser },
    occurredAt: new Date(at).toISOString(),
    dedupeKey: `unknown:${device.device_uid || device.id}`,
  };
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
        key: "silent", label: "受信なし",
        note: "24時間以上、このパソコンから届いていません",
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
