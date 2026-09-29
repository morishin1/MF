// 勤務表の時間の計算（/office の稼働時間確定）。
//
// ■ 純関数だけ
//   時刻は「その日の 0:00 からの分」の整数で持つ。DB も画面も、境界ではこの形と HH:MM を行き来する。
//   終了が 1440 以上なら翌日（例：26:00 = 翌 2:00）。
//
// ■ 決まっているルール（要件 §8）
//   ・休憩は差し引いてから月合計する
//   ・休憩が不明なら、勝手に補完しない（実働は出さず「要確認」）
//   ・日跨ぎ：勤務開始日を勤務日とする
//   ・月跨ぎ：月境界で分割する（月末日の勤務が翌日にかかるぶんは、翌月に入れる）
//   ・深夜・休日：別割増の計算はしない（実働の分だけを数える）
//
// ■ 推測で埋めない
//   読めない・書かれていない値は null のまま。null があれば、その日の実働は出さない。
//   人が確認して入れるまで、合計にも入れない（unresolved に日付を挙げる）。

import { daysInMonth } from "./holidays.js";

export const DAY = 1440;
/** 拘束時間の上限（これを超えたら、読み違い・入力ミスを疑う） */
export const MAX_SPAN = 20 * 60;

const pad = (n) => String(n).padStart(2, "0");

/**
 * "9:00" / "09:00" / "9：00" / "9時" / "9時30分" / "26:00" → 分。読めなければ null
 * 24時間を超える表記（26:00 = 翌2:00）は、終了時刻としてだけ意味がある
 */
export function parseClock(v, { allowOver24 = true } = {}) {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v < (allowOver24 ? 48 * 60 : DAY) ? v : null;
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  // コロン形式は分を2桁で（「9:5」は 9:05 とも 9:50 とも読めるので通さない）。「9時」「9時30分」は分が1桁でもよい
  const m = /^(\d{1,2})(?:[:：](\d{2})(?::\d{2})?|時(\d{1,2})?分?)$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? m[3] ?? 0);
  if (mi > 59) return null;
  const min = h * 60 + mi;
  return min < (allowOver24 ? 48 * 60 : DAY) ? min : null;
}

/** 分 → "HH:MM"（26:00 のように 24 を超えてもそのまま） */
export function formatClock(min) {
  if (!Number.isFinite(min) || min < 0) return "";
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** 分 → "162.5"（時間。小数は2桁まで、末尾の0は落とす） */
export function formatHours(min) {
  if (!Number.isFinite(min)) return "";
  return String(Math.round((min / 60) * 100) / 100);
}

/**
 * 休憩の書き方を分にする。
 *   "1:00"・"60"・"60分"・"1時間"・"1.5時間" → 分
 *   単位のない「1」「1.5」は、分か時間か分からないので読まない（エラー）。数値（number）は分
 *   "なし"・"無し"・"0" → 0（休憩を取っていない、と書いてある）
 *   空・"-"・"不明" → null（不明。補完しない）
 * @returns {{ value: number|null, error?: string }}
 */
export function parseBreak(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === "number") {
    return Number.isFinite(v) && v >= 0 && Number.isInteger(v) ? { value: v } : { value: null, error: "休憩は0以上の整数（分）で指定してください" };
  }
  const s = String(v).trim().replace(/\s+/g, "");
  if (!s || /^[-−—―ー]+$/.test(s) || /^(不明|未記入)$/.test(s)) return { value: null };
  if (/^(なし|無し|無|0)$/.test(s)) return { value: 0 };
  let m = /^(\d{1,2})[:：](\d{2})$/.exec(s);
  if (m) return Number(m[2]) > 59 ? { value: null, error: `休憩「${v}」を読み取れません` } : { value: Number(m[1]) * 60 + Number(m[2]) };
  // 単位のない数は、分とも時間とも読めるので、10〜1440 の整数だけを分として読む（「1」「1.5」は読まない）
  m = /^(\d+)(\.\d+)?$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return !m[2] && n >= 10 && n <= 1440 ? { value: n } : { value: null, error: `休憩「${v}」は、分か時間か分かりません（「60分」「1時間」のように書いてください）` };
  }
  m = /^(\d+)(分|min|m)$/i.exec(s);
  if (m) return Number(m[1]) <= 1440 ? { value: Number(m[1]) } : { value: null, error: `休憩「${v}」を読み取れません` };
  m = /^(\d+(?:\.\d+)?)(時間|h)$/i.exec(s);
  if (m) return { value: Math.round(Number(m[1]) * 60) };
  return { value: null, error: `休憩「${v}」を読み取れません` };
}

/**
 * 1日ぶんの実働。
 *
 * @param {{ kind: 'work'|'off', start: number|null, end: number|null, breakMin: number|null }} d
 * @returns {{ gross: number|null, worked: number|null, endMin: number|null, overnight: boolean,
 *             flags: {code: string, text: string, blocking: boolean}[] }}
 *   blocking … 実働を出せない（人が入れるまで合計に入れない）
 *   それ以外の flag は、実働は出せるが、人の目で見てほしいもの
 */
export function dayWork({ kind, start, end, breakMin }) {
  const flags = [];
  if (kind === "off") return { gross: 0, worked: 0, endMin: null, overnight: false, flags };
  if (start === null || start === undefined || end === null || end === undefined) {
    flags.push({ code: "time_missing", text: "開始または終了が空です", blocking: true });
    return { gross: null, worked: null, endMin: end ?? null, overnight: false, flags };
  }
  let e = end;
  let overnight = false;
  if (e >= DAY) {
    overnight = true;                       // 26:00 のように、翌日と書いてある
  } else if (e <= start) {
    e += DAY;                               // 22:00〜06:00 のように、書かれていないが翌日にかかる
    overnight = true;
    flags.push({ code: "overnight_assumed", text: "終了が開始より前のため、翌日の終了として計算しました", blocking: false });
  }
  const gross = e - start;
  if (gross > MAX_SPAN) flags.push({ code: "span_long", text: "拘束時間が20時間を超えています", blocking: false });
  if (breakMin === null || breakMin === undefined) {
    flags.push({ code: "break_unknown", text: "休憩が不明です（補完しません）", blocking: true });
    return { gross, worked: null, endMin: e, overnight, flags };
  }
  if (breakMin > gross) {
    flags.push({ code: "break_over", text: "休憩が拘束時間より長いです", blocking: true });
    return { gross, worked: null, endMin: e, overnight, flags };
  }
  return { gross, worked: gross - breakMin, endMin: e, overnight, flags };
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

/**
 * 月境界での分割。月末日の勤務が翌日にかかるとき、翌日にかかるぶんは翌月に入れる。
 * 休憩は、開始の側（月内）から先に差し引く。どこで休んだかは書かれていないので、
 * 分割した日は「要確認」として人に見てもらう。
 * @returns {{ inMonth: number, spill: number, flagged: boolean }}
 */
export function splitAtMonthEnd(workDate, month, { start, endMin, breakMin, worked }) {
  if (worked === null || worked === undefined) return { inMonth: null, spill: 0, flagged: false };
  const last = `${month}-${pad(daysInMonth(month))}`;
  if (workDate !== last || endMin <= DAY) return { inMonth: worked, spill: 0, flagged: false };
  const inGross = DAY - start;
  const spillGross = endMin - DAY;
  const brk = breakMin || 0;
  const brkIn = Math.min(brk, inGross);
  return { inMonth: Math.max(0, inGross - brkIn), spill: Math.max(0, spillGross - (brk - brkIn)), flagged: true };
}

/** 丸め。unit=分（15・30 など）、mode=floor|ceil|round。unit が無ければ丸めない */
export function roundMinutes(min, unit, mode = "floor") {
  if (!unit || unit <= 1 || !Number.isFinite(min)) return min;
  const q = min / unit;
  const n = mode === "ceil" ? Math.ceil(q - 1e-9) : mode === "round" ? Math.round(q) : Math.floor(q + 1e-9);
  return n * unit;
}

/**
 * 月間の集計。
 *
 * @param {object[]} days [{ workDate, kind, startMin, endMin, breakMin }]
 * @param {{ month: string, unit?: number|null, mode?: string, scope?: 'day'|'month', carryInMinutes?: number }} o
 *   unit・mode・scope は契約条件（gw_site_contract_terms）。無ければ丸めない
 *   carryInMinutes … 前月の月末日の勤務が、この月にかかるぶん
 * @returns {{
 *   rawMinutes: number, totalMinutes: number, workDays: number, unresolved: string[],
 *   spillMinutes: number, carryInMinutes: number, rounding: object|null,
 *   perDay: {workDate, worked: number|null, counted: number|null, flags: object[]}[]
 * }}
 *   unresolved … 実働が出せない日（人が入れるまで合計に入れない）。1つでもあれば、確定できない
 */
export function aggregateMonth(days, { month, unit = null, mode = "floor", scope = "day", carryInMinutes = 0 } = {}) {
  const perDay = [];
  const unresolved = [];
  let raw = 0;
  let rounded = 0;
  let workDays = 0;
  let spill = 0;

  for (const d of days || []) {
    const flags = [];
    if (!isDate(d.workDate) || String(d.workDate).slice(0, 7) !== month) {
      perDay.push({ workDate: d.workDate, worked: null, counted: null,
        flags: [{ code: "out_of_month", text: "対象月ではない日付です", blocking: true }] });
      unresolved.push(d.workDate);
      continue;
    }
    const w = dayWork({ kind: d.kind, start: d.startMin, end: d.endMin, breakMin: d.breakMin });
    flags.push(...w.flags);
    if (w.worked === null) {
      unresolved.push(d.workDate);
      perDay.push({ workDate: d.workDate, worked: null, counted: null, flags });
      continue;
    }
    const sp = splitAtMonthEnd(d.workDate, month, { start: d.startMin, endMin: w.endMin, breakMin: d.breakMin, worked: w.worked });
    if (sp.flagged) flags.push({ code: "month_split", text: "月をまたぐ勤務です。月境界で分割しました（休憩は開始側から差し引き）", blocking: false });
    spill += sp.spill;
    const counted = sp.inMonth;
    raw += counted;
    rounded += scope === "day" ? roundMinutes(counted, unit, mode) : counted;
    if (counted > 0) workDays += 1;
    perDay.push({ workDate: d.workDate, worked: w.worked, counted, flags });
  }

  const carry = carryInMinutes || 0;
  raw += carry;
  rounded += scope === "day" ? roundMinutes(carry, unit, mode) : carry;
  const total = scope === "month" ? roundMinutes(rounded, unit, mode) : rounded;

  return {
    rawMinutes: raw, totalMinutes: unit ? total : raw, workDays, unresolved,
    spillMinutes: spill, carryInMinutes: carry,
    rounding: unit ? { unit, mode, scope } : null,
    perDay,
  };
}
