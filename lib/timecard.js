// タイムカードの計算。
//
// ■ ここで出すのは「実労働時間」まで
//   法定内・法定外の区別、深夜・休日の割増、みなし残業との相殺は、
//   就業規則と給与規定によって決まるもので、打刻だけでは決まらない。
//   中途半端に計算すると、給与計算がその数字を信じてしまう。
//   出すのは「出勤・退勤・休憩・実労働」と、所定を超えた分の目安だけ。
//
// ■ 日本時間で数える
//   サーバは UTC で動く。日付の区切りをそのまま扱うと、
//   朝9時の打刻が前日ぶんになる。日付が絡むところは必ず +9時間してから見る。
//
// ■ 夜勤で日をまたぐ
//   出勤した日の行に、翌日の退勤時刻が入る。
//   時刻は timestamptz なので、引き算はそのままで正しい。

/** いまの日本時間 */
export const jstNow = () => new Date(Date.now() + 9 * 3600000);

/** その時刻の、日本時間での YYYY-MM-DD */
export const jstDate = (t = Date.now()) =>
  new Date((t instanceof Date ? t.getTime() : new Date(t).getTime()) + 9 * 3600000)
    .toISOString().slice(0, 10);

/** その時刻の、日本時間での HH:MM */
export const jstTime = (t) => {
  if (!t) return null;
  return new Date(new Date(t).getTime() + 9 * 3600000).toISOString().slice(11, 16);
};

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
export const isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s || ""));

/** その月の初日と、翌月の初日 */
export function monthRange(month) {
  if (!isMonth(month)) return null;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: `${month}-01`, to: next };
}

// ---- 休憩 ---------------------------------------------------------------------

/**
 * 休憩の配列をそろえる。
 * end の無いものは「休憩中」。開始の無いものは捨てる（数えようがない）
 */
export function normalizeBreaks(list) {
  if (!Array.isArray(list)) return [];
  // 読めない時刻は捨てる。toISOString() は不正な日付だと例外を投げるので、
  // 変換する前に数値として成り立つかを見る
  const iso = (v) => {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  return list
    .filter((b) => b && b.start)
    .map((b) => ({ start: iso(b.start), end: b.end ? iso(b.end) : null }))
    .filter((b) => b.start)
    .slice(0, 12);                       // 1日に12回も休憩を刻む運用は想定しない
}

/** いま休憩中か */
export const onBreak = (entry) =>
  (entry?.breaks || []).some((b) => b.start && !b.end);

/** 休憩の合計（分）。終わっていない休憩は、いまの時刻まで数える */
export function breakMinutes(entry, now = new Date()) {
  let ms = 0;
  for (const b of entry?.breaks || []) {
    if (!b.start) continue;
    const s = new Date(b.start).getTime();
    const e = b.end ? new Date(b.end).getTime() : now.getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) ms += e - s;
  }
  return Math.round(ms / 60000);
}

// ---- 1日 ---------------------------------------------------------------------

/**
 * 1日ぶんの計算。
 *
 * @param {object} entry gw_time_entries の1行
 * @param {Date}   now   出勤中の日を数えるときの「いま」
 * @returns {{stayMinutes:number, breakMinutes:number, workMinutes:number,
 *            open:boolean, onBreak:boolean}}
 */
export function dayTotals(entry, now = new Date()) {
  const open = entry?.status === "open" && entry?.clock_in && !entry?.clock_out;

  let stay = 0;
  if (entry?.clock_in) {
    const s = new Date(entry.clock_in).getTime();
    const e = entry.clock_out ? new Date(entry.clock_out).getTime() : now.getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) stay = Math.round((e - s) / 60000);
  }

  const br = breakMinutes(entry, now);
  return {
    stayMinutes: stay,
    breakMinutes: br,
    // 休憩が滞在を超えることは本来ないが、打刻の直しで起こりうる。
    // 負の労働時間を出すより、0で止めるほうが読み違えが少ない
    workMinutes: Math.max(0, stay - br),
    open,
    onBreak: onBreak(entry),
  };
}

/** 分 → 「8時間30分」。給与の話をするときに小数だと読み違える */
export function hhmm(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h}時間${r ? `${r}分` : ""}` : `${r}分`;
}

/** 分 → 「8:30」。表や CSV はこちらのほうが揃う */
export function clock(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

// ---- 所定労働時間 --------------------------------------------------------------

/**
 * 「9:00〜18:00」のような文字列から、1日の所定労働時間（分）を読む。
 * 休憩1時間は、契約に書いていなければ引かない（勝手に減らさない）。
 *
 * gw_contracts.work_hours は人が書く欄なので、読めない書き方も来る。
 * 読めなければ null を返し、呼ぶ側で「所定は未登録」として扱う。
 */
export function scheduledMinutes(workHours) {
  const t = String(workHours ?? "").replace(/[０-９]/g, (c) => "0123456789"[c.charCodeAt(0) - 0xff10]);
  const m = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[〜~\-–—から]\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(t);
  if (!m) return null;

  const from = Number(m[1]) * 60 + Number(m[2]);
  let to = Number(m[3]) * 60 + Number(m[4]);
  if (to <= from) to += 24 * 60;          // 夜勤（22:00〜翌7:00）

  // 「休憩60分」「休憩1時間」と書いてあれば引く
  const br = /休憩\s*(\d{1,3})\s*分/.exec(t) ? Number(/休憩\s*(\d{1,3})\s*分/.exec(t)[1])
    : /休憩\s*(\d)\s*時間/.exec(t) ? Number(/休憩\s*(\d)\s*時間/.exec(t)[1]) * 60
      : 0;

  return Math.max(0, to - from - br);
}

/**
 * 月のまとめ。
 *
 * 「所定を超えた分」は目安として出すが、割増の対象かどうかは別の話。
 * 画面にもそう書いてある
 */
export function monthTotals(entries, { scheduled = null } = {}, now = new Date()) {
  let work = 0;
  let br = 0;
  let days = 0;
  let over = 0;
  let openDays = 0;

  for (const e of entries || []) {
    if (e.status === "absent") continue;
    const t = dayTotals(e, now);
    if (!t.stayMinutes) continue;
    days++;
    work += t.workMinutes;
    br += t.breakMinutes;
    if (t.open) openDays++;
    if (scheduled) over += Math.max(0, t.workMinutes - scheduled);
  }

  return { days, workMinutes: work, breakMinutes: br, overMinutes: scheduled ? over : null, openDays };
}

// ---- 打刻の妥当性 --------------------------------------------------------------

/**
 * 直した内容が成り立つか。
 * 画面でもサーバでも同じ判定を通す（往復させると直すのが面倒になる）
 *
 * @returns {string|null} だめな理由。問題なければ null
 */
export function validateEntry({ clockIn, clockOut, breaks }) {
  const inT = clockIn ? new Date(clockIn).getTime() : null;
  const outT = clockOut ? new Date(clockOut).getTime() : null;

  if (clockIn && !Number.isFinite(inT)) return "出勤の時刻が読めません";
  if (clockOut && !Number.isFinite(outT)) return "退勤の時刻が読めません";
  if (outT && !inT) return "退勤だけを入れることはできません。出勤の時刻も入れてください";
  if (inT && outT && outT < inT) return "退勤が出勤より前になっています";
  if (inT && outT && outT - inT > 20 * 3600000) {
    return "1日の拘束が20時間を超えています。日付を間違えていないか確かめてください";
  }

  const list = normalizeBreaks(breaks);
  for (const b of list) {
    const s = new Date(b.start).getTime();
    const e = b.end ? new Date(b.end).getTime() : null;
    if (e && e < s) return "休憩の終わりが始まりより前になっています";
    if (inT && s < inT) return "出勤より前の休憩は入れられません";
    if (outT && e && e > outT) return "退勤より後の休憩は入れられません";
  }

  // 休憩が労働時間を食い切る形は、たいてい入力の間違い
  if (inT && outT) {
    const stay = Math.round((outT - inT) / 60000);
    const brm = breakMinutes({ breaks: list }, new Date(outT));
    if (brm > stay) return "休憩の合計が、出勤から退勤までの時間を超えています";
  }
  return null;
}

/** CSV の1行ぶん。給与計算へ渡すためのもの */
export const CSV_HEADER = [
  "日付", "氏名", "部署", "出勤", "退勤", "休憩", "実労働", "状態", "備考", "修正",
];

export function csvRow(entry, employee, now = new Date()) {
  const t = dayTotals(entry, now);
  return [
    entry.work_date,
    employee?.display_name || "",
    employee?.department || "",
    jstTime(entry.clock_in) || "",
    jstTime(entry.clock_out) || "",
    clock(t.breakMinutes),
    clock(t.workMinutes),
    entry.status === "absent" ? "欠勤・休暇" : entry.status === "open" ? "出勤中" : "退勤済",
    entry.note || "",
    entry.edited_at ? `${entry.edit_reason || "修正あり"}` : "",
  ];
}
