import assert from "node:assert/strict";
import * as D from "../lib/devices.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };

console.log("— 日本時間 —");
ok("UTCの夕方は、日本ではもう翌日", () => {
  assert.equal(D.jstDate("2026-09-09T15:30:00Z"), "2026-09-10");
  assert.equal(D.jstDate("2026-09-09T14:59:00Z"), "2026-09-09");
});
ok("深夜の分", () => {
  assert.equal(D.jstMinutes("2026-09-08T16:30:00Z"), 90);   // 日本時間 1:30
  assert.equal(D.jstMinutes("2026-09-09T00:00:00Z"), 9 * 60);
});
ok("土日", () => {
  assert.equal(D.isWeekend("2026-09-12"), true);  // 土
  assert.equal(D.isWeekend("2026-09-13"), true);  // 日
  assert.equal(D.isWeekend("2026-09-14"), false); // 月
});

console.log("— 端末の見分け —");
ok("ブラウザが作ったIDは、形だけ確かめて通す", () => {
  assert.equal(D.cleanUid("abcDEF123_-xyz01234"), "abcDEF123_-xyz01234");
  assert.equal(D.cleanUid("みじかい"), null);
  assert.equal(D.cleanUid("x".repeat(15)), null, "短すぎる");
  assert.equal(D.cleanUid("x".repeat(65)), null, "長すぎる");
  assert.equal(D.cleanUid("' or 1=1--aaaaaaaaaaaaaaa"), null, "変な字は通さない");
  assert.equal(D.cleanUid(null), null);
});
ok("サーバ側でも作れる", () => {
  const s = new Set(Array.from({ length: 50 }, D.newDeviceUid));
  assert.equal(s.size, 50);
  assert.ok(D.cleanUid(D.newDeviceUid()), "自分で作ったものは自分で通る");
});
ok("ハッシュは安定していて、生の値とはちがう", () => {
  assert.equal(D.sha256("abc"), D.sha256("abc"));
  assert.notEqual(D.sha256("abc"), "abc");
});

console.log("— 端末の名前を組み立てる —");
ok("Client Hints があればそれを使う", () => {
  const d = D.describeDevice({
    platform: "Windows", platformVersion: "15.0.0", browser: "Chrome",
    screen: "1920x1080", userAgent: "Mozilla/5.0 ...",
  });
  assert.equal(d.os, "Windows");
  assert.equal(d.osVersion, "11", "platformVersion 13以上は Windows 11");
  assert.equal(d.label, "Windows 11 の Chrome");
  assert.equal(d.screen, "1920x1080");
});
ok("Windows 10 と 11 を取り違えない", () => {
  assert.equal(D.describeDevice({ platform: "Windows", platformVersion: "10.0.0" }).osVersion, "10");
  assert.equal(D.describeDevice({ platform: "Windows", platformVersion: "13.0.0" }).osVersion, "11");
});
ok("UAだけのときは、分かるところまでで止める", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const d = D.describeDevice({ userAgent: ua });
  assert.equal(d.os, "Windows");
  assert.equal(d.osVersion, null, "UAでは10と11を見分けられない。断定しない");
  assert.equal(d.label, "Windows の Chrome");
});
ok("Edge を Chrome と間違えない", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0";
  assert.equal(D.describeDevice({ userAgent: ua }).browser, "Edge");
});
ok("Chrome を Safari と間違えない", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36";
  const d = D.describeDevice({ userAgent: ua });
  assert.equal(d.browser, "Chrome");
  assert.equal(d.os, "macOS");
});
ok("スマホも見分ける", () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15";
  const d = D.describeDevice({ userAgent: ua });
  assert.equal(d.os, "iOS");
  assert.equal(d.browser, "Safari");
});
ok("何も分からなくても名前は付く", () => {
  const d = D.describeDevice({});
  assert.equal(d.label, "不明 の ブラウザ");
  assert.equal(d.userAgent, null);
});
ok("UAは長すぎるぶんを捨てる", () => {
  assert.equal(D.describeDevice({ userAgent: "x".repeat(1000) }).userAgent.length, 300);
});
ok("画面サイズは形が合うものだけ", () => {
  assert.equal(D.describeDevice({ screen: "1920x1080" }).screen, "1920x1080");
  assert.equal(D.describeDevice({ screen: "<script>" }).screen, null);
});

console.log("— 深夜の判定 —");
ok("日をまたぐ設定を扱える（22:00〜05:00）", () => {
  const p = { night_from: "22:00", night_to: "05:00" };
  assert.equal(D.inNight("2026-09-09T14:00:00Z", p), true,  "日本時間 23:00");
  assert.equal(D.inNight("2026-09-08T18:00:00Z", p), true,  "日本時間 3:00");
  assert.equal(D.inNight("2026-09-09T05:00:00Z", p), false, "日本時間 14:00");
  assert.equal(D.inNight("2026-09-08T20:00:00Z", p), false, "日本時間 5:00 ちょうどは含めない");
});
ok("日をまたがない設定も扱える", () => {
  const p = { night_from: "01:00", night_to: "04:00" };
  assert.equal(D.inNight("2026-09-08T17:00:00Z", p), true,  "日本時間 2:00");
  assert.equal(D.inNight("2026-09-08T20:00:00Z", p), false, "日本時間 5:00");
});
ok("設定が無ければ 22:00〜05:00", () => {
  assert.equal(D.inNight("2026-09-09T14:00:00Z"), true);
  assert.equal(D.inNight("2026-09-09T05:00:00Z"), false);
});

console.log("— 合図をつなぐ —");
const T = (s) => `2026-09-09T${s}:00+09:00`;   // 水曜
ok("はじめての合図は1分", () => {
  const u = D.applyBeat(null, T("10:00"));
  assert.equal(u.activeMin, 1);
  assert.equal(u.beats, 1);
  assert.equal(u.workDate, "2026-09-09");
  assert.equal(u.firstAt, u.lastAt);
});
ok("5分後の合図は、その5分ぶんを足す", () => {
  const a = D.applyBeat(null, T("10:00"));
  const b = D.applyBeat(row(a), T("10:05"));
  assert.equal(b.activeMin, 6, "1 + 5");
  assert.equal(b.addedMin, 5);
});
ok("間が空いたら、そのあいだは数えない", () => {
  const a = D.applyBeat(null, T("10:00"));
  const b = D.applyBeat(row(a), T("13:00"));
  assert.equal(b.addedMin, 1, "3時間ぶんは足さない");
  assert.equal(b.activeMin, 2);
});
ok("つなぐ上限は12分。少しの席立ちは通す", () => {
  const a = D.applyBeat(null, T("10:00"));
  assert.equal(D.applyBeat(row(a), T("10:12")).addedMin, 12);
  assert.equal(D.applyBeat(row(a), T("10:13")).addedMin, 1);
});
ok("1日ぶんつないでも 1440分を超えない", () => {
  let u = { active_min: 1439, night_min: 0, holiday_min: 0, beats: 300,
            first_at: T("00:00"), last_at: T("23:50") };
  const b = D.applyBeat(u, T("23:55"));
  assert.equal(b.activeMin, 1440);
});
ok("巻き戻った合図は数えない（時計がずれている端末）", () => {
  const a = D.applyBeat(null, T("10:05"));
  const b = D.applyBeat(row(a), T("10:00"));
  assert.equal(b.addedMin, 0);
  assert.equal(b.activeMin, 1, "増えない");
  assert.equal(b.lastAt, row(a).last_at, "最後の時刻を巻き戻さない");
  assert.equal(b.beats, 2, "届いたことは数える");
});
ok("深夜ぶんを分けて数える", () => {
  const a = D.applyBeat(null, T("23:00"));
  const b = D.applyBeat(row(a), T("23:05"));
  assert.equal(b.activeMin, 6);
  assert.equal(b.nightMin, 6, "深夜のあいだの合図は深夜ぶんにも入る");
  assert.equal(b.holidayMin, 0);
});
ok("昼の合図は深夜ぶんに入らない", () => {
  const a = D.applyBeat(null, T("14:00"));
  assert.equal(D.applyBeat(row(a), T("14:05")).nightMin, 0);
});
ok("土日ぶんを分けて数える", () => {
  const sat = (s) => `2026-09-12T${s}:00+09:00`;
  const a = D.applyBeat(null, sat("14:00"));
  const b = D.applyBeat(row(a), sat("14:05"));
  assert.equal(b.holidayMin, 6);
  assert.equal(b.nightMin, 0);
});
function row(u) {
  return { active_min: u.activeMin, night_min: u.nightMin, holiday_min: u.holidayMin,
           beats: u.beats, first_at: u.firstAt, last_at: u.lastAt };
}

console.log("— 見慣れない端末 —");
const dev = { id: "d1", device_uid: "uid1", label: "Windows 11 の Chrome", os: "Windows", browser: "Chrome" };
ok("その人に別の端末が既にあれば知らせる", () => {
  const a = D.unknownDeviceAlert(dev, { known: 2 });
  assert.equal(a.severity, "warn");
  assert.equal(a.rule, "unknown_device");
  assert.match(a.title, /Windows 11 の Chrome/);
});
ok("入社した日には出さない（比べるものが無い）", () => {
  assert.equal(D.unknownDeviceAlert(dev, { known: 0 }), null);
});
ok("会社の設定で止められる", () => {
  assert.equal(D.unknownDeviceAlert(dev, { known: 2, policy: { unknown_alert: false } }), null);
});
ok("同じ端末では1件しか作らない", () => {
  const a = D.unknownDeviceAlert(dev, { known: 2, at: Date.parse("2026-09-09T01:00:00Z") });
  const b = D.unknownDeviceAlert(dev, { known: 5, at: Date.parse("2026-10-01T01:00:00Z") });
  assert.equal(a.dedupeKey, b.dedupeKey);
});

console.log("— 深夜・休日のアラート —");
ok("深夜60分から。要確認どまりにする（働かせすぎを見つけるため）", () => {
  const a = D.timeAlerts({ workDate: "2026-09-09", nightMin: 90, holidayMin: 0 });
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "warn");
  assert.equal(a[0].rule, "night_access");
  assert.match(a[0].title, /1:30/);
  assert.match(a[0].title, /社内システム/, "PCの稼働ではないと分かる書き方にする");
});
ok("少しなら鳴らさない", () => {
  assert.equal(D.timeAlerts({ workDate: "2026-09-09", nightMin: 40, holidayMin: 100 }).length, 0);
});
ok("会社ごとに閾値を変えられる", () => {
  const p = { night_min_minutes: 30, holiday_min_minutes: 30 };
  assert.equal(D.timeAlerts({ workDate: "2026-09-09", nightMin: 40, holidayMin: 100 }, { policy: p }).length, 2);
});
ok("止められる", () => {
  assert.equal(D.timeAlerts({ workDate: "x", nightMin: 999 }, { policy: { night_alert: false } }).length, 0);
});
ok("同じ日の同じことは、同じ鍵になる", () => {
  const a = D.timeAlerts({ workDate: "2026-09-09", nightMin: 90 })[0];
  const b = D.timeAlerts({ workDate: "2026-09-09", nightMin: 200 })[0];
  assert.equal(a.dedupeKey, b.dedupeKey);
});

console.log("— 端末の状態 —");
const now = Date.parse("2026-09-09T05:00:00Z");
const fresh = new Date(now - 5 * 60000).toISOString();
ok("本人が確認するまでは「確認待ち」。重大より先に出す", () => {
  const s = D.deviceState({ status: "unconfirmed", notified_at: null, last_seen_at: fresh },
    { critical: 3, now });
  assert.equal(s.key, "waiting");
  assert.match(s.note, /数えていません/);
});
ok("重大 > 使われていない > 要確認 > 正常", () => {
  const base = { status: "active", notified_at: "2026-09-01T00:00:00Z", last_seen_at: fresh };
  assert.equal(D.deviceState(base, { critical: 1, warn: 5, now }).key, "critical");
  assert.equal(D.deviceState({ ...base, last_seen_at: "2026-01-01T00:00:00Z" }, { warn: 1, now }).key, "stale");
  assert.equal(D.deviceState(base, { warn: 1, now }).key, "warn");
  assert.equal(D.deviceState(base, { now }).key, "ok");
});
ok("使用終了・停止中は、そのまま出す", () => {
  assert.equal(D.deviceState({ status: "retired" }, { now }).key, "retired");
  assert.equal(D.deviceState({ status: "suspended" }, { now }).key, "suspended");
});
ok("1週間使わなかったくらいでは、まだ何も言わない", () => {
  const base = { status: "active", notified_at: "2026-09-01T00:00:00Z" };
  const d7 = new Date(now - 7 * 86400000).toISOString();
  assert.equal(D.deviceState({ ...base, last_seen_at: d7 }, { now }).key, "ok");
  const d70 = new Date(now - 70 * 86400000).toISOString();
  assert.equal(D.deviceState({ ...base, last_seen_at: d70 }, { now }).key, "stale");
});
ok("何日で「使われていない」とするかは会社が決める", () => {
  const base = { status: "active", notified_at: "2026-09-01T00:00:00Z",
                 last_seen_at: new Date(now - 10 * 86400000).toISOString() };
  assert.equal(D.deviceState(base, { now, staleDays: 7 }).key, "stale");
  assert.equal(D.deviceState(base, { now, staleDays: 30 }).key, "ok");
});

console.log("— 表示 —");
ok("分を時計にする", () => {
  assert.equal(D.clock(0), "0:00");
  assert.equal(D.clock(372), "6:12");
  assert.equal(D.clock(-5), "0:00");
  assert.equal(D.clock("90"), "1:30");
  assert.equal(D.clock(null), "0:00");
});
ok("最終利用", () => {
  assert.equal(D.sinceLabel(null), "利用なし");
  assert.equal(D.sinceLabel(new Date(now - 30000).toISOString(), now), "たった今");
  assert.equal(D.sinceLabel(new Date(now - 3 * 60000).toISOString(), now), "3分前");
  assert.equal(D.sinceLabel(new Date(now - 5 * 3600000).toISOString(), now), "5時間前");
  assert.equal(D.sinceLabel(new Date(now - 50 * 3600000).toISOString(), now), "2日前");
});
ok("CSVはカンマと引用符を壊さない", () => {
  assert.equal(D.csvCell("a,b"), '"a,b"');
  assert.equal(D.csvCell('a"b'), '"a""b"');
  assert.equal(D.csvCell(null), "");
});
ok("CSVの1行", () => {
  const r = D.csvRow(
    { work_date: "2026-09-09", active_min: 372, night_min: 0, holiday_min: 0,
      first_at: "2026-09-08T23:55:00Z", last_at: "2026-09-09T09:30:00Z" },
    { label: "Windows 11 の Chrome", source: "browser", os: "Windows", browser: "Chrome" },
    { display_name: "山田 太郎", department: "営業部" },
  );
  assert.equal(r.length, D.CSV_HEADER.length);
  assert.equal(r[1], "Windows 11 の Chrome");
  assert.equal(r[2], "ブラウザ", "エージェントと混ざる表なので、取得元を出す");
  assert.equal(r[11], "08:55", "日本時間で出す");
  assert.equal(r[12], "18:30");
});
ok("エージェントの行も同じ形で出る", () => {
  const r = D.csvRow(
    { work_date: "2026-09-09", active_min: 400, idle_min: 60, night_min: 0, holiday_min: 0 },
    { hostname: "8GRP-PC-01", source: "agent", os: "Windows" },
    { display_name: "山田 太郎" },
  );
  assert.equal(r[1], "8GRP-PC-01");
  assert.equal(r[2], "エージェント");
  assert.equal(r[8], 60, "離席はエージェントだけが測れる");
});
ok("できごとは、そのまま読める日本語で持つ", () => {
  for (const k of D.EVENT_KINDS) assert.ok(D.EVENT_LABEL[k], k);
});
ok("アラートの理由も日本語がある", () => {
  for (const k of ["unknown_device", "night_access", "holiday_access", "no_access",
                   "unapproved_software", "usb_attach", "agent_error",
                   "night_work", "holiday_work", "agent_load"]) {
    assert.ok(D.RULE_LABEL[k], k);
  }
});

console.log("— 資格情報（エージェント） —");
ok("登録トークンは紛らわしい字を使わない", () => {
  for (let i = 0; i < 200; i++) {
    const t = D.newEnrollToken();
    assert.match(t, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(/[0O1IL]/.test(t), false, t);
  }
});
ok("シークレットは毎回ちがう", () => {
  const s = new Set(Array.from({ length: 50 }, D.newSecret));
  assert.equal(s.size, 50);
  assert.ok(D.newSecret().length >= 40);
});
ok("Authorization を読む", () => {
  const id = "8f2c1d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
  assert.deepEqual(D.readDeviceAuth(`Device ${id}:abc.DEF-123_x`), { deviceId: id, secret: "abc.DEF-123_x" });
  assert.equal(D.readDeviceAuth(`Bearer ${id}:x`), null, "社員のJWTでは通らない");
  assert.equal(D.readDeviceAuth("Device notauuid:x"), null);
  assert.equal(D.readDeviceAuth(`Device ${id}:`), null, "シークレットが空なら通さない");
  assert.equal(D.readDeviceAuth(null), null);
});

console.log("— サイトのカテゴリ（端末の中で使う表） —");
ok("そのままの一致", () => {
  assert.equal(D.categoryOf("github.com"), "work");
  assert.equal(D.categoryOf("YouTube.com"), "video");
  assert.equal(D.categoryOf("www.amazon.co.jp"), "shopping");
});
ok("より具体的なほうが勝つ", () => {
  assert.equal(D.categoryOf("mail.google.com"), "work");
  assert.equal(D.categoryOf("google.com"), "search");
  assert.equal(D.categoryOf("news.google.com"), "search", "表に無いサブドメインは親に落ちる");
});
ok("知らないものは other。怪しい扱いにはしない", () => {
  assert.equal(D.categoryOf("example.co.jp"), "other");
  assert.equal(D.categoryOf(""), "other");
  assert.equal(D.categoryOf(null), "other");
});
ok("会社ごとの追加が効く", () => {
  assert.equal(D.categoryOf("app.kintone.com", { "kintone.com": "work" }), "work");
});

console.log("— エージェントが送ってきたものをそろえる —");
ok("日別。1440分を超える値は落とす", () => {
  const u = D.normalizeUsage({ workDate: "2026-09-09", activeMin: 9999, idleMin: -5, nightMin: "30" });
  assert.equal(u.activeMin, 1440);
  assert.equal(u.idleMin, 0);
  assert.equal(u.nightMin, 30);
});
ok("日付が無いものは受け取らない", () => {
  assert.equal(D.normalizeUsage({ activeMin: 100 }), null);
  assert.equal(D.normalizeUsage({ workDate: "2026-9-9" }), null);
  assert.equal(D.normalizeUsage(null), null);
});
ok("アプリはパスを捨てて、実行ファイル名だけにする", () => {
  const a = D.normalizeApps([
    { workDate: "2026-09-09", exeName: "C:\\Users\\yamada\\AppData\\chrome.exe", minutes: 120 },
    { workDate: "2026-09-09", exeName: "excel.exe", minutes: 0 },
    { workDate: "bad", exeName: "x.exe", minutes: 10 },
  ]);
  assert.equal(a.length, 1);
  assert.equal(a[0].exeName, "chrome.exe", "ユーザー名の入ったパスを残さない");
});
ok("サイトはカテゴリだけ。URLは通さない", () => {
  const w = D.normalizeWeb([
    { workDate: "2026-09-09", category: "sns", minutes: 30 },
    { workDate: "2026-09-09", category: "hostname", minutes: 30 },
    { workDate: "2026-09-09", category: "work", url: "https://x/secret", minutes: 60 },
  ]);
  assert.equal(w.length, 2);
  assert.equal(w[1].url, undefined);
});
ok("できごとの detail は決めた鍵しか通さない", () => {
  const [e] = D.normalizeEvents([{
    seq: 5, at: "2026-09-09T01:00:00Z", kind: "usb_attach",
    detail: { vid: "0781", pid: "5583", class: "mass_storage",
              windowTitle: "見積書.xlsx", url: "https://..." },
  }]);
  assert.deepEqual(Object.keys(e.detail).sort(), ["class", "pid", "vid"]);
  assert.equal(e.workDate, "2026-09-09");
});
ok("知らない種類・壊れた時刻・seq無しは落ちる", () => {
  assert.equal(D.normalizeEvents([{ seq: 1, at: "2026-09-09T01:00:00Z", kind: "screenshot" }]).length, 0);
  assert.equal(D.normalizeEvents([{ seq: 1, at: "きのう", kind: "boot" }]).length, 0);
  assert.equal(D.normalizeEvents([{ at: "2026-09-09T01:00:00Z", kind: "boot" }]).length, 0);
  assert.equal(D.normalizeEvents("x").length, 0);
});
ok("ブラウザ側の種類は、端末からは受け取らない", () => {
  // confirmed をエージェントから送られて、勝手に確認済みにされては困る
  assert.equal(D.normalizeEvents([{ seq: 1, at: "2026-09-09T01:00:00Z", kind: "confirmed" }]).length, 0);
});
ok("一度に受け取る数に上限がある", () => {
  const many = Array.from({ length: 900 }, (_, i) => ({ seq: i, at: "2026-09-09T01:00:00Z", kind: "lock" }));
  assert.equal(D.normalizeEvents(many).length, 500);
});

console.log("— エージェント側のアラート —");
const ev = (kind, detail, seq = 1) => ({ seq, kind, detail, at: "2026-09-09T05:00:00Z", workDate: "2026-09-09" });
ok("未承認ソフトは重大", () => {
  const a = D.alertsFrom({
    events: [ev("app_install", { name: "TeamViewer 15" })],
    policy: { blocked_software: ["teamviewer", "anydesk"] },
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "critical");
  assert.equal(a[0].rule, "unapproved_software");
});
ok("表に無いソフトは何も出さない", () => {
  assert.equal(D.alertsFrom({ events: [ev("app_install", { name: "Visual Studio Code" })],
    policy: { blocked_software: ["teamviewer"] } }).length, 0);
});
ok("USBは大容量記憶装置だけ。マウスで毎朝鳴らさない", () => {
  assert.equal(D.alertsFrom({ events: [ev("usb_attach", { class: "mass_storage", label: "USB DISK" })] }).length, 1);
  assert.equal(D.alertsFrom({ events: [ev("usb_attach", { class: "hid" })] }).length, 0);
});
ok("USBのアラートは会社ごとに止められる", () => {
  assert.equal(D.alertsFrom({ events: [ev("usb_attach", { class: "mass_storage" })],
    policy: { usb_alert: false } }).length, 0);
});
ok("エージェントのエラーは要確認", () => {
  const a = D.alertsFrom({ events: [ev("agent_error", { message: "queue full" })] });
  assert.equal(a[0].rule, "agent_error");
  assert.equal(a[0].severity, "warn");
});
// 端末管理のソフトが、そのPCを重くしている。
// これは本人の働きかたの話ではなく、こちらの落ち度。いちばん早く直す
ok("Agent負荷異常は、こちらの落ち度として出す", () => {
  const a = D.alertsFrom({ events: [ev("agent_load_high",
    { label: "high", message: "待機時のCPUが 6.0%（目安 1.0%）" })] });
  assert.equal(a[0].rule, "agent_load");
  assert.equal(a[0].severity, "warn");
  assert.ok(/重くしています/.test(a[0].title), a[0].title);
});
ok("大きく越えていれば critical", () => {
  const a = D.alertsFrom({ events: [ev("agent_load_high", { label: "critical" })] });
  assert.equal(a[0].severity, "critical");
});
ok("負荷が戻ったときは、アラートにしない", () => {
  assert.equal(D.alertsFrom({ events: [ev("agent_load_ok", {})] }).length, 0);
});

ok("深夜の稼働は要確認どまり（働かせすぎを見つけるため）", () => {
  const a = D.alertsFrom({ usage: { workDate: "2026-09-09", nightMin: 90, holidayMin: 0 } });
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "warn");
  assert.equal(a[0].rule, "night_work");
  assert.match(a[0].title, /1:30/);
});
ok("同じ日の同じことは、同じ鍵になる（何度送られても1件）", () => {
  const one = D.alertsFrom({ events: [ev("usb_attach", { class: "mass_storage", vid: "0781", pid: "5583" }, 1)] });
  const two = D.alertsFrom({ events: [ev("usb_attach", { class: "mass_storage", vid: "0781", pid: "5583" }, 2)] });
  assert.equal(one[0].dedupeKey, two[0].dedupeKey);
});

console.log("— エージェントの端末は、止まったらすぐ分かる —");
ok("エージェントは24時間で「受信なし」、ブラウザは60日で「使われていない」", () => {
  const seen = (d) => new Date(now - d * 86400000).toISOString();
  const agent = { source: "agent", status: "active", notified_at: "2026-09-01T00:00:00Z" };
  const browser = { source: "browser", status: "active", notified_at: "2026-09-01T00:00:00Z" };
  assert.equal(D.deviceState({ ...agent, last_seen_at: seen(2) }, { now }).key, "silent");
  assert.equal(D.deviceState({ ...browser, last_seen_at: seen(2) }, { now }).key, "ok",
    "ブラウザは2日空いてもふつう");
  assert.equal(D.deviceState({ ...browser, last_seen_at: seen(70) }, { now }).key, "stale");
});
ok("確認前のエージェントは「何も送られてこない」と書く", () => {
  const s = D.deviceState({ source: "agent", status: "unconfirmed", notified_at: null }, { now });
  assert.equal(s.key, "waiting");
  assert.match(s.note, /何も送られてきません/);
});

console.log(`\n合計 ${n} 件 通過`);
