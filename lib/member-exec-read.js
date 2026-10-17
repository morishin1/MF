// 経営「メンバー実行状況」の読み出し（api/keiei?view=members）。
//
// 新しい表・集計の写しは作らない。既存の画面と同じ表を、同じ関数で読む：
//   名簿           … 日報・勤怠と同じ（在籍・退職予定で、ログインできる人＝user_id あり）
//   要フォローの材料 … lib/follow-read.js（日報・勤怠 api/nippo/admin.js と同じ部品）
//   今日・明日の3つ  … gw_focus_days・gw_tasks を lib/focus.js の focusRows で（全員のタスク api/tasks/board.js と同じ）
//   期限超過       … gw_tasks を lib/task-view.js の isOverdue で
//   今週の提出     … tc_nippo を lib/nippo-week.js の buildWeek で
// 給与・手当・単価・勤怠の詳細は読まない。
// どれかが読めなければ、その欄だけ null にする（0 や「問題なし」にしない）。

import { readAll, readIn } from "./pg-read.js";
import { readFollowSources } from "./follow-read.js";
import { findFollowUps, recentWorkdays } from "./follow.js";
import { focusRows, nextFocusDate, missingFields, progressOf } from "./focus.js";
import { isOverdue } from "./task-view.js";
import { buildWeek, mondayOf, weekRange } from "./nippo-week.js";
import { isSubmittedNippo } from "./nippo.js";
import { buildMemberExec, topFollow } from "./member-exec.js";

const TASK_FIELDS = "id, title, assignee_id, focus_for, focus_date, focus_rank, status, due_on, priority, "
  + "purpose, done_condition, kpi_link, service, ai_review, carry_count";

/** 名簿。日報・勤怠（api/nippo/admin.js）と同じ条件 */
export async function rosterOf(sb, tenantId) {
  const rows = await readAll(() => sb.from("gw_employees").select("id, user_id, display_name, department, status")
    .eq("tenant_id", tenantId).in("status", ["active", "leaving"]).order("id"));
  return rows ? rows.filter((e) => e.user_id) : null;
}

/**
 * @param {object} sb  admin()
 * @param {{tenantId:string, date:string, today:string, employeeId?:string|null}} p
 */
export async function readMemberExec(sb, { tenantId, date, today, employeeId = null }) {
  const roster = await rosterOf(sb, tenantId);
  if (!roster) return { error: "roster_unreadable" };
  const userIds = roster.map((e) => e.user_id);
  const empIds = roster.map((e) => e.id);
  const tomorrow = nextFocusDate(date);
  const prevWorkday = recentWorkdays(date, 2)[1] || null;
  const monday = mondayOf(date);
  const range = weekRange(monday);

  const [follow, focusDays, focusTasks, openTasks, weekNippos] = await Promise.all([
    readFollowSources(sb, { date, userIds }),
    readAll(() => sb.from("gw_focus_days").select("employee_id, focus_date, status, ai, ai_at, confirmed_at")
      .eq("tenant_id", tenantId).in("focus_date", [date, tomorrow].filter(Boolean)).order("employee_id")),
    readAll(() => sb.from("gw_tasks").select(TASK_FIELDS)
      .eq("tenant_id", tenantId).in("focus_date", [date, tomorrow].filter(Boolean)).order("id")),
    readAll(() => sb.from("gw_tasks").select("id, title, assignee_id, status, due_on, priority, is_template")
      .eq("tenant_id", tenantId).in("status", ["todo", "doing"]).lt("due_on", date).order("id")),
    readIn((part) => sb.from("tc_nippo").select("user_id, work_date, submitted_at")
      .in("user_id", part).gte("work_date", range.from).lte("work_date", range.to).order("work_date"), userIds),
  ]);

  // 今日・明日の3つ
  let focus = null;
  let focusRowsList = null;
  if (focusDays && focusTasks) {
    focusRowsList = focusRows({ emps: roster, days: focusDays, tasks: focusTasks, date, tomorrow });
    focus = new Map(focusRowsList.map((r) => [r.employeeId, r]));
  }
  // 要フォロー・日報の提出
  let followMap = null, submittedToday = null, submittedPrev = null;
  if (follow.ok) {
    const staff = roster.map((e) => ({ user_id: e.user_id, display_name: e.display_name }));
    followMap = new Map(findFollowUps({ date, staff, nippos: follow.nippos, kpis: follow.kpis, blockers: follow.blockers, items: follow.items })
      .map((f) => [f.userId, f]));
    submittedToday = new Set(follow.nippos.filter((n) => isSubmittedNippo(n) && n.work_date === date).map((n) => n.user_id));
    submittedPrev = new Set(follow.nippos.filter((n) => isSubmittedNippo(n) && n.work_date === prevWorkday).map((n) => n.user_id));
  }
  // 期限超過
  let overdue = null;
  if (openTasks) {
    overdue = new Map();
    for (const t of openTasks) {
      if (!t.assignee_id || !isOverdue(t, date)) continue;
      if (!overdue.has(t.assignee_id)) overdue.set(t.assignee_id, []);
      overdue.get(t.assignee_id).push(t);
    }
  }
  // 今週の提出
  let week = null;
  if (weekNippos) {
    const w = buildWeek({ monday, today: date, staff: roster, nippos: weekNippos.filter(isSubmittedNippo), entries: null });
    week = new Map(w.members.map((m) => [m.userId, m]));
  }

  const built = buildMemberExec({
    date, isToday: date === today, prevWorkday, roster, focus, follow: followMap, submittedToday, submittedPrev, overdue, week,
  });
  const unreadable = [
    !follow.ok && "日報・要フォロー", !focus && "今日・明日の3つ", !overdue && "期限超過", !week && "今週の日報",
  ].filter(Boolean);
  const out = {
    date, today, tomorrow, prevWorkday, isToday: date === today,
    summary: built.summary,
    members: built.members,
    follow: topFollow(built.members),
    departments: [...new Set(roster.map((e) => e.department).filter(Boolean))].sort(),
    unreadable,
  };
  if (!employeeId) return out;

  // ---- 1人の詳細（ドロワー） ----
  const emp = roster.find((e) => e.id === employeeId);
  if (!emp) return { error: "not_found" };
  const row = focus ? focus.get(emp.id) : null;
  const [nippoRes, weekTasks] = await Promise.all([
    sb.from("tc_nippo").select("id, user_id, work_date, submitted_at, top_priority, goal_today, kgi_target, kgi_actual, kgi_achieved, "
      + "work_items, wins, consult_note, improved_note, tomorrow_plan, issues, no_issues")
      .eq("user_id", emp.user_id).eq("work_date", date).maybeSingle(),
    readAll(() => sb.from("gw_tasks").select("id, status, focus_date, assignee_id")
      .eq("tenant_id", tenantId).eq("assignee_id", emp.id).gte("focus_date", range.from).lte("focus_date", date).order("id")),
  ]);
  const n = nippoRes?.error ? undefined : (nippoRes?.data || null);
  let replies = null;
  if (n?.id) {
    const r = await sb.from("tc_nippo_replies").select("id, kind").eq("nippo_id", n.id).in("kind", ["ai", "admin"]);
    replies = r.error ? null : { admin: (r.data || []).filter((x) => x.kind === "admin").length, ai: (r.data || []).filter((x) => x.kind === "ai").length };
  }
  const taskView = (t) => ({
    id: t.id, title: t.title, status: t.status, done: t.status === "done", purpose: t.purpose || null,
    doneCondition: t.done_condition || null, dueOn: t.due_on || null, priority: t.priority || null,
    kpi: t.kpi_link || null, service: t.service || null, carryCount: t.carry_count || 0,
    missing: missingFields(t).map((f) => f.label), hasAi: Boolean(t.ai_review),
  });
  const todayTasks = row ? row._today.tasks.slice().sort((a, b) => (a.focus_rank || 9) - (b.focus_rank || 9)) : null;
  const tmDay = row ? row._tomorrow.day : null;
  const blockers = follow.ok ? follow.blockers.filter((b) => b.user_id === emp.user_id) : null;
  const od = overdue ? overdue.get(emp.id) || [] : null;
  const member = built.members.find((m) => m.employeeId === emp.id);
  const weekLive = weekTasks ? weekTasks.filter((t) => t.status !== "cancelled") : null;
  out.detail = {
    member,
    nippoId: n?.id || null,
    nippo: n === undefined ? null : n ? {
      submitted: isSubmittedNippo(n), submittedAt: n.submitted_at || null, topPriority: n.top_priority || null,
      kpi: n.goal_today || n.kgi_target != null ? { name: n.goal_today || null, target: n.kgi_target, actual: n.kgi_actual, achieved: n.kgi_achieved } : null,
      workItems: (n.work_items || []).slice(0, 10).map((w) => ({ task: w.task || w.title || "", result: w.result || "", undone: w.undone_reason || "" })),
      wins: n.wins || [], consult: n.consult_note || null, improved: n.improved_note || null, tomorrowPlan: n.tomorrow_plan || null,
      issues: n.no_issues ? [] : (n.issues || []).filter((i) => i.issue).map((i) => i.issue),
      replies,
    } : { submitted: false },
    today: todayTasks ? todayTasks.map(taskView) : null,
    tomorrow: row ? {
      count: row.tomorrow.count, label: row.tomorrow.label, confirmed: row.tomorrow.confirmed,
      aiChecked: Boolean(tmDay?.ai_at || tmDay?.status === "ai_checked" || tmDay?.status === "confirmed"),
      complete: row.tomorrow.count >= 3,
      tasks: row._tomorrow.tasks.map((t) => ({ id: t.id, title: t.title })),
    } : null,
    stuck: {
      overdue: od ? od.map((t) => ({ id: t.id, title: t.title, dueOn: t.due_on })) : null,
      blockers: blockers ? blockers.map((b) => ({ id: b.id, title: b.title, since: b.blocked_since })) : null,
      carried: todayTasks ? todayTasks.filter((t) => (t.carry_count || 0) > 0).map((t) => ({ id: t.id, title: t.title, carryCount: t.carry_count })) : null,
      noCondition: todayTasks ? todayTasks.filter((t) => !String(t.done_condition || "").trim()).map((t) => ({ id: t.id, title: t.title })) : null,
      aiPending: row ? row.hasAi && !row.tomorrow.confirmed : null,
    },
    week: {
      nippo: member?.week || null,
      focus: weekLive ? progressOf(weekLive) : null,
      overdue: od ? od.length : null,
    },
  };
  return out;
}
