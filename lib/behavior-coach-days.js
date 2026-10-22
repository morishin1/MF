// 日報コーチ：人別の「前の勤務日」「次の勤務日」と対象範囲を決める純粋関数。
//
// ■ 方針（docs/behavior-coach.md）
//   ・勤務曜日は gw_reminder_prefs.workdays（1=月〜7=日）だけを使う。行が無ければ null（月〜金を補わない）
//   ・会社休日（lib/holidays.js の HOLIDAYS）と承認済みの全日休暇は休みとして飛ばす。
//     ただし、その日に提出済みの日報があれば、その日は勤務日として扱う（本人の記録を優先）
//   ・申請中の休暇・入社前・表の範囲外などで決められないときは null と理由を返す。推測で埋めない
//   ・退職・入社前は「確認できたとき」だけ対象外。在籍状態が分からない人は確認待ち（未確認）として数える
import { HOLIDAYS, COVERED_TO } from "./holidays.js";
import { isLeftEmployee } from "./left-gate.js";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (s) => typeof s === "string" && DATE_RE.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const isoWeekday = (date) => new Date(date + "T00:00:00Z").getUTCDay() || 7;
/** 何日さかのぼる／先を見るか。2週間で見つからなければ決めない */
export const SEARCH_DAYS = 14;

/** 勤務曜日として使える値か。空・範囲外は「未設定」と同じ（null） */
export function validWorkdays(workdays) {
  if (!Array.isArray(workdays) || !workdays.length) return null;
  const list = workdays.map(Number);
  return list.every((x) => Number.isInteger(x) && x >= 1 && x <= 7) ? [...new Set(list)].sort() : null;
}

/** 全日の休暇（午前・午後休は勤務日のまま）。status: approved は休み、pending は決められない */
export function leaveOn(date, leaves) {
  let pending = false;
  for (const l of leaves || []) {
    if (!l || !l.starts_on || !l.ends_on || date < l.starts_on || date > l.ends_on) continue;
    if (l.leave_type === "am" || l.leave_type === "pm") continue;
    if (l.status === "approved") return "approved";
    if (l.status === "pending" || l.status === "pending_owner") pending = true;
  }
  return pending ? "pending" : null;
}

/**
 * その日はその人の勤務日か。true / false / null（決められない）と理由。
 * @param {string} date
 * @param {{workdays?:number[]|null, leaves?:object[], submittedDates?:Set<string>, joinedOn?:string|null, leftOn?:string|null}} ctx
 */
export function workdayStatus(date, ctx = {}) {
  if (ctx.joinedOn && date < ctx.joinedOn) return { work: false, reason: "before_join" };
  if (ctx.leftOn && date > ctx.leftOn) return { work: false, reason: "after_left" };
  if (ctx.submittedDates?.has(date)) return { work: true, reason: "submitted_report" };
  const workdays = validWorkdays(ctx.workdays);
  if (!workdays) return { work: null, reason: "workdays_unknown" };
  if (!workdays.includes(isoWeekday(date))) return { work: false, reason: "not_workday" };
  if (date > COVERED_TO) return { work: null, reason: "holiday_table_not_covered" };
  if (HOLIDAYS.has(date)) return { work: false, reason: "company_holiday" };
  const leave = leaveOn(date, ctx.leaves);
  if (leave === "approved") return { work: false, reason: "leave" };
  if (leave === "pending") return { work: null, reason: "leave_pending" };
  return { work: true, reason: "workday" };
}

/** date より前の、いちばん近い勤務日。決められなければ {date:null, reason} */
export function previousWorkday(date, ctx = {}) {
  for (let i = 1; i <= SEARCH_DAYS; i++) {
    const d = addDays(date, -i);
    const s = workdayStatus(d, ctx);
    if (s.work === true) return { date: d, reason: s.reason };
    if (s.work === null) return { date: null, reason: s.reason };
    if (s.reason === "before_join") return { date: null, reason: "before_join" };
  }
  return { date: null, reason: "not_found_within_search" };
}

/** date より後の、いちばん近い勤務日。決められなければ {date:null, reason} */
export function nextWorkday(date, ctx = {}) {
  for (let i = 1; i <= SEARCH_DAYS; i++) {
    const d = addDays(date, i);
    // 未来の日報は無いので、提出済みの記録では決めない
    const s = workdayStatus(d, { ...ctx, submittedDates: null });
    if (s.work === true) return { date: d, reason: s.reason };
    if (s.work === null) return { date: null, reason: s.reason };
    if (s.reason === "after_left") return { date: null, reason: "after_left" };
  }
  return { date: null, reason: "not_found_within_search" };
}

/** 日報の提出を求めてよい雇用形態。委託・役員・不明は、提出が契約範囲か確認できないので未確認にする */
export const REPORT_EXPECTED_TYPES = new Set(["正社員", "契約社員", "パート", "アルバイト"]);

/**
 * 名簿の1人を、対象・対象外・確認待ちに分ける。
 * @returns {{scope:'in'|'out'|'unknown', reason:string}}
 */
export function rosterScope(emp, date) {
  if (!emp) return { scope: "unknown", reason: "member_unavailable" };
  if (emp.status === "left" || isLeftEmployee(emp, date)) return { scope: "out", reason: "left_confirmed" };
  if (emp.joined_on && date < String(emp.joined_on).slice(0, 10)) return { scope: "out", reason: "before_join" };
  if (emp.status === "active" || emp.status === "leaving") {
    return emp.user_id ? { scope: "in", reason: "active" } : { scope: "unknown", reason: "no_login_mapping" };
  }
  if (emp.status === "invited") return { scope: "unknown", reason: "invited_not_confirmed" };
  return { scope: "unknown", reason: "status_unknown" };
}
