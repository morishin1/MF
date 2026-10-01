// 日時は「日本時間（Asia/Tokyo）」で見せる。サーバ側の共通部品（画面側は js/jst.js・同じ中身）。
// Vercel のサーバは UTC なので、getHours() や toLocaleString() をそのまま使わない。
// DB には従来どおり ISO8601（UTC）で保存し、人に見せる文字列・日本の「今日」だけをここで作る。
//   dateTime(iso) "2026/10/1 16:15" / when(iso) "本日 16:15" or "2026/10/1 16:15"
//   date(iso) "2026/10/1" / time(iso) "16:15" / ymd(iso?) "2026-10-01"（日本の日付）
//   toInput(iso) "2026-10-01T16:15" / fromInput("2026-10-01T16:15") → ISO（UTC）
export const TZ = "Asia/Tokyo";
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
export function parts(v) {
  const d = toDate(v);
  if (!d) return null;
  const p = {};
  for (const x of FMT.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute };
}
export const ymd = (v = new Date()) => { const p = parts(v); return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : ""; };
export const date = (v) => { const p = parts(v); return p ? `${p.y}/${p.m}/${p.d}` : ""; };
export const time = (v) => { const p = parts(v); return p ? `${pad(p.hh)}:${pad(p.mm)}` : ""; };
export const dateTime = (v) => (parts(v) ? `${date(v)} ${time(v)}` : "");
export const when = (v, now = new Date()) => {
  if (!toDate(v)) return "";
  return ymd(v) === ymd(now) ? `本日 ${time(v)}` : dateTime(v);
};
export const toInput = (v) => { const p = parts(v); return p ? `${ymd(v)}T${pad(p.hh)}:${pad(p.mm)}` : ""; };
/** "2026-10-01T16:15" を日本時間として読む。日本は夏時間が無いので +09:00 固定 */
export const fromInput = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
