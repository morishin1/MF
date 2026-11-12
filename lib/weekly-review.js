import { isDate, weekStart, lastWorkdayOfWeek, weeklyFilled } from './nippo.js';

export function validReviewDate(value) {
  return typeof value === 'string' && isDate(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// Missing/failed preferences are not evidence of a Friday workday.
export function reviewClosing(date, prefs, weekly) {
  const days = prefs?.data?.workdays;
  const known = !prefs?.error && Array.isArray(days) &&
    days.every(d => Number.isInteger(d) && d >= 1 && d <= 7);
  const on = known && days.length ? lastWorkdayOfWeek(weekStart(date), days) : null;
  return { on, isToday: !!on && date === on, filled: weeklyFilled(weekly),
    scheduleStatus: prefs?.error ? 'unavailable' : !known ? 'unknown' : days.length ? 'known' : 'no_workdays' };
}

// submitted_at is the administrator's publication time, not employee submission.
export function ownReview(row) {
  if (!row) return null;
  const keys = ['id', 'user_id', 'user_name', 'week_start', 'q1', 'q2', 'q3', 'q4', 'created_at', 'updated_at', 'submitted_at'];
  if (row.submitted_at) keys.push('eval_scores', 'eval_total', 'eval_comment', 'eval_categories');
  return Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]));
}
