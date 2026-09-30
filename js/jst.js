// 日時は「日本時間（Asia/Tokyo）」で見せる。HR画面の共通部品（サーバ側は lib/jst.js・同じ中身）。
//
// ■ なぜ要るか
//   DB は ISO8601（UTC）で持つ。new Date(...).getHours() や toLocaleString() は「見ている端末の」
//   タイムゾーンで出るので、海外や UTC 設定の端末・サーバ（Vercel は UTC）で 9 時間ずれる。
//   toISOString().slice(...) は UTC のまま切り出すので、日本の日付・時刻にならない。
//   HR で人に見せる日時・日付・「本日」判定・datetime-local の入出力は、すべてここを通す。
//
//   JST.dateTime(iso)   "2026/10/1 16:15"
//   JST.when(iso)       日本時間で今日なら "本日 16:15"、それ以外は "2026/10/1 16:15"
//   JST.date(iso)       "2026/10/1"
//   JST.time(iso)       "16:15"
//   JST.ymd(iso?)       "2026-10-01"（省略時は今日。日本の日付）
//   JST.toInput(iso)    datetime-local に入れる値 "2026-10-01T16:15"（日本時間）
//   JST.fromInput(v)    datetime-local の値（日本時間）→ 保存用 ISO（UTC）
(function (root) {
  const TZ = "Asia/Tokyo";
  const FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const pad = (n) => String(n).padStart(2, "0");
  const toDate = (v) => {
    if (v == null || v === "") return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  /** 日本時間の年・月・日・時・分 */
  function parts(v) {
    const d = toDate(v);
    if (!d) return null;
    const p = {};
    for (const x of FMT.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
    return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute };
  }
  const ymd = (v = new Date()) => { const p = parts(v); return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : ""; };
  const date = (v) => { const p = parts(v); return p ? `${p.y}/${p.m}/${p.d}` : ""; };
  const time = (v) => { const p = parts(v); return p ? `${pad(p.hh)}:${pad(p.mm)}` : ""; };
  const dateTime = (v) => { const p = parts(v); return p ? `${date(v)} ${time(v)}` : ""; };
  const when = (v, now = new Date()) => {
    if (!toDate(v)) return "";
    return ymd(v) === ymd(now) ? `本日 ${time(v)}` : dateTime(v);
  };
  const toInput = (v) => { const p = parts(v); return p ? `${ymd(v)}T${pad(p.hh)}:${pad(p.mm)}` : ""; };
  /** "2026-10-01T16:15" を日本時間として読む。日本は夏時間が無いので +09:00 固定 */
  const fromInput = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  root.JST = { TZ, parts, ymd, date, time, dateTime, when, toInput, fromInput };
})(typeof window !== "undefined" ? window : globalThis);
