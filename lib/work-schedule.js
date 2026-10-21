// 「業務予定」の定義を1か所に置く（gw_calendar_events のどの行を、会社の業務予定として数えるか）。
//
// ■ 業務予定とは
//   ・source = 'self'（本人が入れた予定。休暇の承認・スペース予約から自動でできた行は含めない）
//   ・category <> 'private'（私用は会社の予定に含めない）
//   ・件名がある
//   ・時刻が正しい（終日、または 終了 > 開始）
//   日報提出の前提（lib/schedule-gate.js）・全員の予定（api/schedule/team.js）と同じ条件。
//   TODO: そちらの2か所は、まだ自前で同じ条件を持っている（日報提出の前提に触れないよう、寄せるのは別の PR で）。
//
// ■ 休暇
//   承認された休暇は source = 'leave'・終日・複数日を1行（api/requests/decide.js）。
//   開始日だけで絞ると2日目以降を落とすので、期間の重なりで探す。
//
// ■ 日付は日本時間
//   「その日」は日本時間の 0:00 〜 翌日 0:00。

import { readIn } from "./pg-read.js";

export const BUSINESS_SOURCE = "self";
export const LEAVE_SOURCE = "leave";
export const PRIVATE_CATEGORY = "private";

/** 返してよい列（本文・メモ body は読まない。db/142：メモは本人だけ） */
export const EVENT_COLUMNS = "id, employee_id, title, category, location, all_day, starts_at, ends_at, updated_at, source";

const JST = 9 * 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDate = (s) => DATE_RE.test(String(s || "")) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** YYYY-MM-DD に n 日足す */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 秒までの ISO（ミリ秒なし・Z）。PostgREST へ渡す境界 */
const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

/** 日本時間のその日の 0:00（UTC ミリ秒） */
export const jstStartMs = (date) => Date.parse(`${date}T00:00:00Z`) - JST;

/** 日本時間の [from 0:00, to の翌日 0:00) を ISO で */
export function jstBounds(from, to = from) {
  return { fromIso: iso(jstStartMs(from)), toIso: iso(jstStartMs(addDays(to, 1))) };
}

/** 日本時間の日付（YYYY-MM-DD） */
export const jstDateOf = (ts) => new Date(Date.parse(ts) + JST).toISOString().slice(0, 10);
/** 日本時間の時刻（HH:MM） */
export const jstTimeOf = (ts) => new Date(Date.parse(ts) + JST).toISOString().slice(11, 16);

/** 時刻が正しいか（終日、または 終了 > 開始） */
export function validTimes(e) {
  const s = Date.parse(e?.starts_at), t = Date.parse(e?.ends_at);
  if (Number.isNaN(s)) return false;
  if (e.all_day) return Number.isNaN(t) || t >= s;
  return !Number.isNaN(t) && t > s;
}

/** 業務予定か（この関数が唯一の定義） */
export function isBusinessEvent(e) {
  if (!e) return false;
  if ((e.source ?? BUSINESS_SOURCE) !== BUSINESS_SOURCE) return false;
  if (e.category === PRIVATE_CATEGORY) return false;
  if (!String(e.title || "").trim()) return false;
  return validTimes(e);
}

/** 休暇（承認済みの休暇から自動でできた行）か */
export const isLeaveEvent = (e) => e?.source === LEAVE_SOURCE;

/**
 * 予定が、日本時間のその日に掛かっているか。
 * 終日で 終了 = 開始 の行は、開始の日だけに掛かるとみなす。
 */
export function overlapsDay(e, date) {
  const s = Date.parse(e.starts_at);
  let t = Date.parse(e.ends_at);
  if (Number.isNaN(t) || t <= s) t = s + 1;
  const from = jstStartMs(date), to = jstStartMs(addDays(date, 1));
  return s < to && t > from;
}

/** 予定が掛かっている日（dates の中から） */
export const datesOf = (e, dates) => dates.filter((d) => overlapsDay(e, d));

/**
 * 期間 [from, to]（日本時間・両端含む）に重なる予定を読む。
 * 業務予定（self）と休暇（leave）だけ。予約（booking）は読まない。
 * 読めなければ null（0件と区別する）。業務予定の判定は isBusinessEvent で別にする。
 *
 * @param {object} sb  admin()（service_role）。必ず tenant と社員で絞る
 * @param {{tenantId:string, employeeIds:string[], from:string, to:string}} p
 * @returns {Promise<object[]|null>}
 */
export async function readEventsOverlapping(sb, { tenantId, employeeIds, from, to }) {
  if (!tenantId) return null;
  if (!employeeIds?.length) return [];
  const { fromIso, toIso } = jstBounds(from, to);
  const rows = await readIn((part) => sb.from("gw_calendar_events").select(EVENT_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("employee_id", part)
    .in("source", [BUSINESS_SOURCE, LEAVE_SOURCE])
    .lt("starts_at", toIso)
    .gte("ends_at", fromIso)
    .order("id"), employeeIds);
  if (!rows) return null;
  // 境界の扱い（終了 = 開始 の終日など）は JS で正確にそろえる
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return rows.filter((e) => days.some((d) => overlapsDay(e, d)));
}
