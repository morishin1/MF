// Office 業務予定（年間業務カレンダー。db/125）。個人の予定（/api/calendar・gw_calendar_events）とは別。
//
// GET  /api/office-tasks/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//        … 範囲の予定（見られるカテゴリだけ）と、範囲より前の期限超過（未完了）。範囲は最大62日
//          範囲が「今日〜先400日」に入っていれば、まだ作っていない定例の予定をその場で作る（cron を待たずに先の月を見られる）
// POST /api/office-tasks/calendar {action:"complete"|"reopen"|"skip", id}
//        … 完了（完了日時・完了した人を残す）／未完了に戻す／今回は行わない
// POST /api/office-tasks/calendar {action:"create", title, category, date, dueOn?, assigneeEmployeeId?, note?}
//        … 単発の予定を足す
//
// ■ 権限（lib/office-recurring.js）
//   人事・労務だけの人（canAccessOffice＝経営者・責任者・経理 に入らない）も使うので、api/office/ ではなく
//   api/office-tasks/ に置く（api/office/* は canAccessOffice 専用。api/billing-progress と同じ考え方）。
//   見る：カテゴリごとの Office の権限。完了・今回なし：そのカテゴリを直せる人か、その予定の担当者本人。
//   表は RLS でログインした人から閉じてあり、ここで確かめてから service role で読み書きする

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import * as GW from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/timecard.js";
import {
  CATEGORIES, CATEGORY_KEYS, permsOf, canUseRecurring, canViewCategory, canEditCategory, categoryLabel,
  isDate, addDays, daysBetween, VIEW_HORIZON_DAYS, TITLE_MAX,
} from "../../lib/office-recurring.js";
import { EVENT_FIELDS, generate, activeMasters } from "../../lib/office-recurring-db.js";

const SQL = "db/125_office_recurring.sql";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const MAX_RANGE = 62;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await GW.gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  const perms = permsOf(ctx, GW);
  if (!canUseRecurring(perms)) return json(res, 403, { error: "forbidden" });
  const sb = admin();
  try {
    if (req.method === "GET") return await read(req, res, sb, ctx, perms);
    if (req.method === "POST") return await act(req, res, sb, ctx, user, perms);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office/calendar]", e?.message || e);
    return json(res, 500, { error: "office_calendar_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

const effDue = (e) => e.due_on || e.event_date;

export function shapeEvent(e, people, today, perms, me) {
  const who = e.assignee_employee_id ? people.get(e.assignee_employee_id) : null;
  const due = effDue(e);
  return {
    id: e.id, recurringTaskId: e.recurring_task_id, title: e.title, description: e.description,
    category: e.category, categoryLabel: categoryLabel(e.category),
    date: e.event_date, dueOn: due, status: e.status, priority: e.priority, note: e.note, url: e.url, source: e.source,
    assigneeId: e.assignee_employee_id, assigneeName: who?.display_name || null,
    assigneeMissing: !e.assignee_employee_id || !who || who.status === "left",
    overdueDays: e.status === "pending" && due < today ? daysBetween(due, today) : 0,
    completedAt: e.completed_at, completedByName: e.completed_by_name,
    canEdit: canEditCategory(perms, e.category) || Boolean(me && e.assignee_employee_id === me),
  };
}

async function read(req, res, sb, ctx, perms) {
  const q = new URL(req.url || "/", "http://localhost").searchParams;
  const today = jstDate();
  const from = isDate(q.get("from")) ? q.get("from") : `${today.slice(0, 7)}-01`;
  const to = isDate(q.get("to")) ? q.get("to") : addDays(from, 41);
  if (to < from || daysBetween(from, to) > MAX_RANGE) return json(res, 400, { error: "invalid_range", hint: `範囲は${MAX_RANGE}日までです` });
  const cats = CATEGORY_KEYS.filter((k) => canViewCategory(perms, k));

  // 見ている範囲のうち、今日〜先400日の定例の予定は、無ければここで作る（二重には作らない）
  const genFrom = from > today ? from : today;
  const genTo = to < addDays(today, VIEW_HORIZON_DAYS) ? to : addDays(today, VIEW_HORIZON_DAYS);
  if (genFrom <= genTo) await generate(sb, await activeMasters(sb, ctx.tenantId), { from: genFrom, to: genTo });

  const [rows, overdue, people] = await Promise.all([
    must(sb.from("gw_office_calendar_events").select(EVENT_FIELDS).eq("tenant_id", ctx.tenantId).in("category", cats)
      .gte("event_date", from).lte("event_date", to).order("event_date").limit(3000)),
    // 範囲より前の未完了で、期限が今日より前のもの（期限超過）
    must(sb.from("gw_office_calendar_events").select(EVENT_FIELDS).eq("tenant_id", ctx.tenantId).in("category", cats)
      .eq("status", "pending").lt("event_date", from).lt("event_date", today).order("event_date").limit(300)),
    must(sb.from("gw_employees").select("id, display_name, status").eq("tenant_id", ctx.tenantId).limit(500)),
  ]);
  const byId = new Map((people || []).map((p) => [p.id, p]));
  const me = ctx.employee?.id || null;
  const shape = (e) => shapeEvent(e, byId, today, perms, me);
  return json(res, 200, {
    today, from, to,
    events: (rows || []).map(shape),
    overdue: (overdue || []).filter((e) => effDue(e) < today).map(shape),
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, view: cats.includes(c.key), edit: canEditCategory(perms, c.key) })),
    employees: (people || []).filter((p) => p.status !== "left").map((p) => ({ id: p.id, name: p.display_name })),
    me,
  });
}

async function act(req, res, sb, ctx, user, perms) {
  const b = await readJson(req);
  const action = String(b?.action || "");
  const today = jstDate();
  const now = new Date().toISOString();
  const me = ctx.employee?.id || null;
  const log = (what, detail) => gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `office.calendar.${what}`, target: "office_calendar", detail });
  const people = async () => new Map(((await must(sb.from("gw_employees").select("id, display_name, status").eq("tenant_id", ctx.tenantId).limit(500))) || []).map((p) => [p.id, p]));

  if (["complete", "reopen", "skip"].includes(action)) {
    const ev = b?.id ? await must(sb.from("gw_office_calendar_events").select(EVENT_FIELDS).eq("id", String(b.id)).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
    if (!ev || !canViewCategory(perms, ev.category)) return json(res, 404, { error: "not_found" });
    if (!canEditCategory(perms, ev.category) && !(me && ev.assignee_employee_id === me)) {
      return json(res, 403, { error: "forbidden", hint: "この予定を完了にできるのは、担当者か、このカテゴリを担当する人です" });
    }
    const patch = action === "complete"
      ? { status: "done", completed_at: now, completed_by: user.id, completed_by_name: ctx.employee?.display_name || null, updated_at: now }
      : { status: action === "skip" ? "skipped" : "pending", completed_at: null, completed_by: null, completed_by_name: null, updated_at: now };
    const row = await must(sb.from("gw_office_calendar_events").update(patch).eq("id", ev.id).eq("tenant_id", ctx.tenantId).select(EVENT_FIELDS).single());
    await log(action, { id: ev.id, category: ev.category, date: ev.event_date });
    return json(res, 200, { event: shapeEvent(row, await people(), today, perms, me) });
  }

  if (action === "create") {
    const title = String(b?.title ?? "").trim().slice(0, TITLE_MAX);
    const category = CATEGORY_KEYS.includes(b?.category) ? b.category : null;
    const date = isDate(b?.date) ? b.date : null;
    const dueOn = b?.dueOn ? (isDate(b.dueOn) ? b.dueOn : "bad") : null;
    const problems = [];
    if (!title) problems.push("業務名を入れてください");
    if (!category) problems.push("カテゴリを選んでください");
    if (!date) problems.push("日付を入れてください");
    if (dueOn === "bad" || (dueOn && date && dueOn < date)) problems.push("期限は日付以降にしてください");
    if (problems.length) return json(res, 400, { error: "invalid", hint: problems[0], problems });
    if (!canEditCategory(perms, category)) return json(res, 403, { error: "forbidden", hint: `「${categoryLabel(category)}」の予定を足す権限がありません` });
    const assignee = b?.assigneeEmployeeId ? String(b.assigneeEmployeeId) : null;
    if (assignee) {
      const ok = await must(sb.from("gw_employees").select("id").eq("id", assignee).eq("tenant_id", ctx.tenantId).maybeSingle());
      if (!ok) return json(res, 400, { error: "invalid", hint: "担当者が名簿にいません" });
    }
    const row = await must(sb.from("gw_office_calendar_events").insert({
      tenant_id: ctx.tenantId, recurring_task_id: null, title, category, event_date: date, due_on: dueOn || date,
      assignee_employee_id: assignee, note: String(b?.note ?? "").trim().slice(0, 2000) || null,
      priority: ["high", "normal", "low"].includes(b?.priority) ? b.priority : "normal",
      status: "pending", source: "manual", created_by: user.id,
    }).select(EVENT_FIELDS).single());
    await log("create", { id: row.id, category, date });
    return json(res, 200, { event: shapeEvent(row, await people(), today, perms, me) });
  }

  return json(res, 400, { error: "invalid_action", detail: "complete, reopen, skip, create" });
}
