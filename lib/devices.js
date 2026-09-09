// 端末管理の計算と判定。
//
// ■ 何を取り、何を取らないか
//   取るのは 起動終了・稼働・アプリ名・サイトのカテゴリ・USB・ソフトの出入り。
//   キー入力・パスワード・メール本文・チャット本文・画面・
//   ウィンドウのタイトル・URLの全文は取らない。
//   URLは端末の中でホスト名→カテゴリに落としてから送るので、
//   ここに来るのはカテゴリだけ。
//
// ■ 判定はサーバでやる
//   何をアラートにするかは会社が決める。端末側で決めさせない。
//   端末は改ざんできるし、ポリシーを変えたときに全台へ配り直すことになる。
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

// ---- 資格情報 -------------------------------------------------------------------

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

export const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/**
 * 送られてきた資格情報を読む。
 * Authorization: Device <deviceId>:<secret>
 */
export function readDeviceAuth(header) {
  const m = /^Device\s+([0-9a-f-]{36}):(\S+)$/i.exec(String(header || "").trim());
  return m ? { deviceId: m[1], secret: m[2] } : null;
}

// ---- サイトのカテゴリ -------------------------------------------------------------

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

// ---- 集計 -----------------------------------------------------------------------

/** 分 → 「6:12」 */
export function clock(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

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

export const EVENT_KINDS = [
  "boot", "shutdown", "logon", "logoff", "lock", "unlock", "sleep", "wake",
  "usb_attach", "usb_detach", "app_install", "app_uninstall",
  "agent_start", "agent_update", "agent_error",
];

export const EVENT_LABEL = {
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
 * イベントをそろえる。
 *
 * detail に入れてよいものを、ここで絞る。
 * 端末が何を送ってきても、決めた鍵しか通さない。
 * ファイル名・URL・ウィンドウのタイトルが紛れ込む道を作らない。
 */
const DETAIL_KEYS = ["vid", "pid", "class", "label", "name", "version", "publisher", "message"];

export function normalizeEvents(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && EVENT_KINDS.includes(e.kind) && Number.isFinite(Number(e.seq)) && e.at)
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

/**
 * 送られてきたイベントから、対応が要るものを拾う。
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
  const blocked = (policy.blocked_software || []).map((s) => String(s).toLowerCase()).filter(Boolean);

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
    // 深夜60分・休日120分。1〜2時間なら、たまたまのこともある
    if (usage.nightMin >= 60) {
      out.push({
        severity: "warn", rule: "night_work",
        title: `深夜の稼働が ${clock(usage.nightMin)} ありました`,
        detail: { minutes: usage.nightMin },
        occurredAt: usage.lastAt || `${usage.workDate}T23:59:00+09:00`,
        dedupeKey: `night:${usage.workDate}`,
      });
    }
    if (usage.holidayMin >= 120) {
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
 * 端末の状態。一覧の「正常 / 要確認 / 重大」に使う。
 *
 * @param {object} device   gw_devices の行
 * @param {number} critical その端末で開いている重大アラートの数
 * @param {number} warn     要確認の数
 */
export function deviceState(device, { critical = 0, warn = 0, now = Date.now() } = {}) {
  if (device.status === "retired") return { key: "retired", label: "使用終了" };
  if (device.status === "suspended") return { key: "suspended", label: "停止中" };
  if (!device.notified_at) {
    return { key: "waiting", label: "本人の確認待ち", note: "確認するまで、記録は取っていません" };
  }
  if (critical) return { key: "critical", label: "重大" };

  const seen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
  // 24時間。1日休んだだけで「異常」と出ると、毎週月曜に赤が並ぶ
  if (!seen || now - seen > 24 * 3600000) {
    return { key: "silent", label: "受信なし", note: "24時間以上、この端末から届いていません" };
  }
  if (warn) return { key: "warn", label: "要確認" };
  return { key: "ok", label: "正常" };
}

/** 最終受信を「3分前」のように出す */
export function sinceLabel(at, now = Date.now()) {
  if (!at) return "未受信";
  const min = Math.floor((now - Date.parse(at)) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

// ---- CSV ------------------------------------------------------------------------

export const CSV_HEADER = [
  "日付", "ホスト名", "使う人", "部署",
  "稼働(分)", "離席(分)", "ロック(分)", "深夜(分)", "休日(分)",
  "最初", "最後",
];

export function csvRow(u, device, employee) {
  const hm = (t) => (t ? new Date(new Date(t).getTime() + JST).toISOString().slice(11, 16) : "");
  return [
    u.work_date,
    device?.hostname || "",
    employee?.display_name || "",
    employee?.department || "",
    u.active_min, u.idle_min, u.locked_min, u.night_min, u.holiday_min,
    hm(u.first_at), hm(u.last_at),
  ];
}

export const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
