// 経営「予定・日報確認」の読み出し（GET /api/keiei?view=schedule）。読むだけ。書き込み・通知はしない。
//
// ■ 何を読むか（どれも既存の正本。写しは作らない）
//   名簿     … lib/member-exec-read.js の rosterOf（在籍・退職予定で、ログインできる人）。入社日・退職日も分母に使う
//   業務予定 … gw_calendar_events を lib/work-schedule.js の定義で（source='self'・私用以外・件名・正しい時刻）
//   休暇     … gw_calendar_events の source='leave'（承認済みの休暇）。期間の重なりで探す
//   日報     … tc_nippo。submitted_at があるときだけ提出（lib/nippo.js の isSubmittedNippo）
//   営業日   … lib/holidays.js の isBizDay（翌営業日は lib/focus.js の nextFocusDate）
//   時間割チェック … api/schedule/review.js の inspect()（時刻だけで決まる計算。AI は呼ばない）
//
// ■ 決めつけない
//   対象外（入社前・退職後・休日）は「対象外」、休暇は「休暇」。
//   読めなかったものは「取得できません」。未提出・未登録とは言わない（数も null にする。0 にしない）。
//
// ■ 返さないもの
//   予定のメモ（body）は読まない・返さない（db/142：メモは本人だけ）。日報の本文も返さない（提出の有無だけ）。
//   経営の確認状態（確認済み・修正依頼など）は Phase 2。review は null で返す。

import { readIn } from "./pg-read.js";
import { rosterOf } from "./member-exec-read.js";
import { isSubmittedNippo } from "./nippo.js";
import { isBizDay, HOLIDAYS } from "./holidays.js";
import { nextFocusDate } from "./focus.js";
import {
  addDays, isDate, readEventsOverlapping, isBusinessEvent, isLeaveEvent, overlapsDay, datesOf,
  jstStartMs, jstTimeOf,
} from "./work-schedule.js";
import { inspect } from "../api/schedule/review.js";

export const PERIODS = ["day", "week", "month"];

const MARK_LABEL = { has: "予定あり", none: "未登録", leave: "休暇", off: "対象外", error: "取得できません" };
const NIPPO_LABEL = { submitted: "提出", missing: "未提出", future: "—", leave: "休暇", off: "対象外", error: "取得できません" };

const utc = (date) => new Date(`${date}T00:00:00Z`);

/** 期間（日本時間の日付・両端含む） */
export function rangeOf(period, date) {
  if (period === "week") {
    const g = utc(date).getUTCDay();          // 0=日
    const from = addDays(date, -((g + 6) % 7)); // 月曜はじまり
    return { from, to: addDays(from, 6) };
  }
  if (period === "month") {
    const from = `${date.slice(0, 7)}-01`;
    const d = utc(from); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
    return { from, to: d.toISOString().slice(0, 10) };
  }
  return { from: date, to: date };
}

const daysBetween = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

/** その日、勤務の対象か（入社前・退職後は対象外） */
function employed(emp, date) {
  if (emp.joined_on && isDate(emp.joined_on) && date < emp.joined_on) return "入社前";
  if (emp.left_on && isDate(emp.left_on) && date > emp.left_on) return "退職後";
  return null;
}

/** 時間割チェック（api/schedule/review.js の inspect）。時刻のある予定だけ。AI は呼ばない */
function checkOf(evs, date) {
  const from = jstStartMs(date), to = jstStartMs(addDays(date, 1));
  const entries = [];
  for (const e of evs) {
    if (e.all_day) continue;
    const s = Math.max(Date.parse(e.starts_at), from), t = Math.min(Date.parse(e.ends_at), to - 60000);
    if (!(t > s)) continue;
    entries.push({ title: String(e.title || "").slice(0, 200), start: jstTimeOf(new Date(s).toISOString()), end: jstTimeOf(new Date(t).toISOString()) });
  }
  if (!entries.length) return null;
  const r = inspect(entries, []);
  return { verdict: r.verdict, overlaps: r.overlaps, totalMinutes: r.totalMinutes, notes: r.suggestions };
}

/**
 * 1人・1日の状態
 * @param {object} p
 */
function dayOf({ emp, date, today, events, leaves, nippos }) {
  const notEmployed = employed(emp, date);
  const biz = isBizDay(utc(date));
  const evs = events ? events.filter((e) => e.employee_id === emp.id && overlapsDay(e, date)) : null;
  const leave = leaves ? leaves.some((e) => e.employee_id === emp.id && overlapsDay(e, date)) : null;
  const count = evs ? evs.length : null;

  let mark, reason = null;
  if (notEmployed) { mark = "off"; reason = notEmployed; }
  else if (evs === null) mark = "error";
  else if (leave) { mark = "leave"; reason = "休暇"; }
  else if (count > 0) mark = "has";
  else if (!biz) { mark = "off"; reason = "休日"; }
  else mark = "none";

  let nippo;
  const n = nippos ? nippos.get(`${emp.user_id}|${date}`) || null : undefined;
  if (notEmployed) nippo = "off";
  else if (nippos === null) nippo = "error";
  else if (isSubmittedNippo(n)) nippo = "submitted";
  else if (leave) nippo = "leave";
  else if (!biz) nippo = "off";
  else if (date > today) nippo = "future";
  else nippo = "missing";

  // 対象：営業日・在籍中・休暇でない。休暇が読めないときは対象として数える（休暇を勝手に推測しない）
  const target = !notEmployed && biz && leave !== true;
  return {
    date, bizDay: biz, target, reason, mark, markLabel: MARK_LABEL[mark], count,
    nippo: {
      state: nippo, label: NIPPO_LABEL[nippo],
      submittedAt: nippo === "submitted" ? n.submitted_at || null : null,
      nippoId: nippo === "submitted" ? n.id || null : null,
    },
    check: evs && evs.length ? checkOf(evs, date) : null,
  };
}

/**
 * @param {object} sb  admin()
 * @param {{tenantId:string, period:string, date:string, today:string, employeeId?:string|null, dep?:string, q?:string}} p
 */
export async function readKeieiSchedule(sb, { tenantId, period, date, today, employeeId = null, dep = "", q = "" }) {
  const roster = await rosterOf(sb, tenantId, { withDates: true });
  if (!roster) return { error: "roster_unreadable" };
  const departments = [...new Set(roster.map((e) => e.department).filter(Boolean))].sort();

  let people = roster;
  if (employeeId) {
    people = roster.filter((e) => e.id === employeeId);
    if (!people.length) return { error: "not_found" };
  } else {
    if (dep) people = people.filter((e) => e.department === dep);
    if (q) people = people.filter((e) => String(e.display_name || "").includes(q));
  }

  const range = rangeOf(period, date);
  const next = nextFocusDate(date);
  // 期間のほかに、上部の集計（その日の日報・翌営業日の予定）に要る日も読む
  const qFrom = range.from < date ? range.from : date;
  const qTo = next && next > range.to ? next : range.to;
  const allDays = daysBetween(qFrom, qTo);

  const empIds = people.map((e) => e.id);
  const userIds = people.map((e) => e.user_id);
  const [rows, nippoRows] = await Promise.all([
    readEventsOverlapping(sb, { tenantId, employeeIds: empIds, from: qFrom, to: qTo }),
    readIn((part) => sb.from("tc_nippo").select("id, user_id, work_date, submitted_at")
      .in("user_id", part).gte("work_date", qFrom).lte("work_date", qTo).order("id"), userIds),
  ]);
  const events = rows ? rows.filter(isBusinessEvent) : null;
  const leaves = rows ? rows.filter(isLeaveEvent) : null;
  const nippos = nippoRows ? new Map(nippoRows.map((n) => [`${n.user_id}|${n.work_date}`, n])) : null;

  const out = people.map((emp) => {
    const days = {};
    for (const d of allDays) days[d] = dayOf({ emp, date: d, today, events, leaves, nippos });
    const a = days[date], nx = next ? days[next] : null;
    const nippoMissing = a.nippo.state === "missing";
    // 翌営業日の予定は、その日の日報を出すときまでに入れるもの。先の日（date > today）はまだ期限前なので要対応にしない
    const scheduleMissing = Boolean(nx && nx.target && nx.mark === "none" && date <= today);
    return {
      employeeId: emp.id, name: emp.display_name, department: emp.department || null, status: emp.status,
      joinedOn: emp.joined_on || null, leftOn: emp.left_on || null,
      days,
      attention: { nippoMissing, scheduleMissing, any: nippoMissing || scheduleMissing },
    };
  });
  // 要対応の人を上に。同じなら名前順
  out.sort((x, y) => (Number(y.attention.any) - Number(x.attention.any))
    || (Number(y.attention.nippoMissing) - Number(x.attention.nippoMissing))
    || String(x.name).localeCompare(String(y.name), "ja"));

  // 上部の集計（その日の日報・翌営業日の予定・要対応）
  const anchor = out.map((p) => p.days[date]);
  const nippoTarget = anchor.filter((d) => d.target);
  const nextDays = next ? out.map((p) => p.days[next]) : [];
  const nextTarget = nextDays.filter((d) => d.target);
  const summary = {
    people: out.length,
    nippo: nippos === null ? null : {
      date, target: nippoTarget.length,
      submitted: nippoTarget.filter((d) => d.nippo.state === "submitted").length,
      missing: nippoTarget.filter((d) => d.nippo.state === "missing").length,
      future: date > today, bizDay: isBizDay(utc(date)),
    },
    next: !next || events === null ? null : {
      date: next, target: nextTarget.length,
      registered: nextTarget.filter((d) => d.count > 0).length,
      missing: nextTarget.filter((d) => d.mark === "none").length,
    },
    // Phase 1 は「日報未提出」「翌営業日の予定が未登録」だけ。確認待ち・未読返信は Phase 2 以降（数を作らない）
    attention: nippos === null && events === null ? null : {
      people: out.filter((p) => p.attention.any).length,
      nippoMissing: nippos === null ? null : out.filter((p) => p.attention.nippoMissing).length,
      scheduleMissing: events === null ? null : out.filter((p) => p.attention.scheduleMissing).length,
    },
  };

  const evOut = events ? events
    .map((e) => ({
      id: e.id, employeeId: e.employee_id, title: e.title, category: e.category, location: e.location || null,
      allDay: Boolean(e.all_day), startsAt: e.starts_at, endsAt: e.ends_at, updatedAt: e.updated_at || null,
      dates: datesOf(e, allDays),
    }))
    .sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt) || String(x.id).localeCompare(String(y.id))) : null;

  return {
    period, date, today, from: range.from, to: range.to, nextBizDay: next,
    // 今日の翌営業日。これより先の「未登録」は、まだ期限前（画面では目立たせない）
    dueBy: nextFocusDate(today),
    days: daysBetween(range.from, range.to).map((d) => ({
      date: d, dow: utc(d).getUTCDay(), bizDay: isBizDay(utc(d)), holiday: HOLIDAYS.has(d), isToday: d === today,
    })),
    people: out,
    events: evOut,
    summary,
    departments,
    // メンバー別の選択肢（名前・部署だけ）。1人を選んでいても全員分を返す
    roster: roster.map((e) => ({ employeeId: e.id, name: e.display_name, department: e.department || null })),
    unreadable: [events === null && "予定・休暇", nippos === null && "日報"].filter(Boolean),
    review: null,
  };
}
