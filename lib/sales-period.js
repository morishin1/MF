// 営業分析の「期間」（本日・昨日・今週・先週・今月・先月・任意期間）。すべて日本時間（JST）の暦日で区切る。
//
// ■ 週の定義は、システム内の既存のものに合わせる（新しい定義を増やさない）
//   週は月曜はじまり（lib/nippo.js weekStart。週次の振り返り・週目標・ダッシュボードと同じ）。
//   今週＝今日を含む週の月曜〜今日、先週＝その前の月曜〜日曜。
//
// ■ 返すもの
//   from・to … 期間の最初の日・最後の日（YYYY-MM-DD・JST。両端を含む）
//   sinceIso・untilIso … timestamptz と比べる境目（from の 0:00 JST 以上、to の翌日 0:00 JST 未満）
//   今日より先の日は数えない（今週・今月は今日まで）
import { weekStart } from "./nippo.js";
import { todayJst } from "./sales.js";

export const PERIOD_KEYS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "custom"];
export const PERIOD_LABEL = {
  today: "本日", yesterday: "昨日", this_week: "今週", last_week: "先週",
  this_month: "今月", last_month: "先月", custom: "任意期間",
};
/** 既定は今週 */
export const DEFAULT_PERIOD = "this_week";
/** 任意期間の長さの上限（1回の集計で読む量を抑える） */
export const MAX_CUSTOM_DAYS = 400;

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * 期間を日付に直す。
 * @param {string} key PERIOD_KEYS のどれか（空なら今週）
 * @param {{from?:string, to?:string}} custom 任意期間の開始日・終了日（YYYY-MM-DD）
 * @returns {{key,label,from,to,sinceIso,untilIso,days}|{error:string,hint:string}}
 */
export function resolvePeriod(key, custom = {}, now = new Date()) {
  const k = key || DEFAULT_PERIOD;
  if (!PERIOD_KEYS.includes(k)) return { error: "bad_period", hint: "期間の指定が正しくありません" };
  const today = todayJst(now);
  let from, to;
  if (k === "today") { from = today; to = today; }
  else if (k === "yesterday") { from = addDays(today, -1); to = from; }
  else if (k === "this_week") { from = weekStart(today); to = today; }
  else if (k === "last_week") { to = addDays(weekStart(today), -1); from = weekStart(to); }
  else if (k === "this_month") { from = monthStart(today); to = today; }
  else if (k === "last_month") { to = addDays(monthStart(today), -1); from = monthStart(to); }
  else {
    from = String(custom.from || "").trim();
    to = String(custom.to || "").trim();
    if (!isYmd(from) || !isYmd(to)) return { error: "bad_range", hint: "開始日と終了日を YYYY-MM-DD で指定してください" };
    if (from > to) return { error: "bad_range", hint: "開始日は終了日より前の日にしてください" };
    if (daysBetween(from, to) + 1 > MAX_CUSTOM_DAYS) {
      return { error: "range_too_long", hint: `任意期間は${MAX_CUSTOM_DAYS}日以内で指定してください` };
    }
  }
  return {
    key: k, label: PERIOD_LABEL[k], from, to, days: daysBetween(from, to) + 1,
    // UTC の ISO 文字列にする（同じ時刻。文字列のまま比べる所があっても、表記の違いで順番がずれない）
    sinceIso: new Date(`${from}T00:00:00+09:00`).toISOString(),
    untilIso: new Date(`${addDays(to, 1)}T00:00:00+09:00`).toISOString(),
  };
}
