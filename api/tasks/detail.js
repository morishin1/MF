// GET  /api/tasks/detail?id=…            … 1件の中身・コメント・履歴
// POST /api/tasks/detail {id, action}
//        "update"   … 担当・期限・優先度・目的・完了条件・KPI・サービス・URLを直す
//        "status"   … 状態を変える（完了もここ）
//        "comment"  … コメントする
//        "carry"    … 持ち越し・優先度を下げる・別の人へ渡す・やらない
//        "ai"       … AIの案を 採る / 断る
//
// ■ 引き出しの中で片付ける
//   一覧は開いたまま、右から出る引き出しで読んで直す。
//   別の画面へ飛ばすと「確認 → 戻る → また探す」になる。
//
// ■ 変えたことは履歴に残る
//   担当・期限・優先度・状態・持ち越し・AIの採否。
//   引き出しの「履歴」タブで、担当者と頼んだ人が読む。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { taskEvent } from "../../lib/task-log.js";
import { priorityLabel, statusLabel, EVENT_LABEL, eventLine, PRIORITIES, STATUSES }
  from "../../lib/task-view.js";
import { CARRY_CHOICES, CARRY_KEYS, MAX_FOCUS, nextFocusDate, jstToday } from "../../lib/focus.js";

const SQL = "db/073_task_detail.sql";
const FIELDS =
  "id, tenant_id, title, body, purpose, done_condition, kpi_link, service, link, "
  + "assignee_id, escalate_to, due_on, priority, status, category, result, not_done_reason, "
  + "accepted_at, completed_at, focus_date, focus_rank, focus_for, "
  + "ai_review, ai_assignee, ai_assignee_why, carried_from, carry_count, "
  + "created_by, created_at, updated_at";

const str = (v, max = 500) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "no_employee" });

  if (req.method === "GET") return read(req, res, ctx, user);
  if (req.method === "POST") return act(req, res, ctx, user, await readJson(req));
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** そのタスクを見てよいか。担当・頼んだ人・管理者 */
const maySee = (ctx, userId, t) =>
  canManageHr(ctx) || t.assignee_id === ctx.employee.id || t.created_by === userId;

/** 直してよいか。見てよい人と同じ（担当者が自分で期限を引き直せるのは、そのため） */
const mayEdit = maySee;

async function load(sb, tenantId, id) {
  if (!id) return { task: null, error: null };
  const full = await sb.from("gw_tasks").select(FIELDS)
    .eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  if (!full.error) return { task: full.data || null, error: null };
  // 072 / 073 がまだの環境。足した列を落として引き直す
  const base = await sb.from("gw_tasks")
    .select("id, tenant_id, title, body, assignee_id, due_on, priority, status, category, "
          + "result, accepted_at, completed_at, created_by, created_at, updated_at")
    .eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  return { task: base.data || null, error: base.error || null };
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  const sb = admin();
  const { task, error } = await load(sb, ctx.tenantId, id);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!task) return json(res, 404, { error: "not_found" });
  if (!maySee(ctx, user.id, task)) return json(res, 403, { error: "forbidden" });

  const soft = async (fn) => { try { const r = await fn(); return r?.error ? [] : (r.data || []); } catch { return []; } };
  const [emps, comments, events] = await Promise.all([
    sb.from("gw_employees").select("id, display_name, department, user_id")
      .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"]).order("display_name").limit(300),
    soft(() => sb.from("gw_task_comments")
      .select("id, author_id, author_name, body, created_at")
      .eq("task_id", task.id).order("created_at", { ascending: true }).limit(200)),
    soft(() => sb.from("gw_task_events")
      .select("id, kind, actor_id, actor_name, detail, created_at")
      .eq("task_id", task.id).order("created_at", { ascending: true }).limit(200)),
  ]);
  const people = (emps.data || []).map((e) => ({
    id: e.id, name: e.display_name, department: e.department || null, userId: e.user_id,
  }));
  const nameOfUser = new Map(people.filter((p) => p.userId).map((p) => [p.userId, p.name]));

  return json(res, 200, {
    task: shape(task, people, nameOfUser),
    comments: comments.map((c) => ({
      id: c.id, name: c.author_name || nameOfUser.get(c.author_id) || "（不明）",
      body: c.body, at: c.created_at, mine: c.author_id === user.id,
    })),
    // 作成の1行は、履歴が空でも出す（いつ生まれたタスクかは必ず要る）
    events: [
      ...(events.length ? [] : [{ id: 0, kind: "created", actor_name: nameOfUser.get(task.created_by) || null,
                                  detail: null, created_at: task.created_at }]),
      ...events,
    ].map((e) => ({
      id: e.id, kind: e.kind, kindLabel: EVENT_LABEL[e.kind] || e.kind,
      who: e.actor_name || nameOfUser.get(e.actor_id) || "—",
      text: eventLine(e), at: e.created_at,
    })),
    people,
    priorities: PRIORITIES,
    statuses: STATUSES,
    carryChoices: CARRY_CHOICES,
    canEdit: mayEdit(ctx, user.id, task),
    canManage: canManageHr(ctx),
    me: { id: ctx.employee.id, name: ctx.employee.display_name },
  });
}

function shape(t, people, nameOfUser) {
  const who = (id) => people.find((p) => p.id === id)?.name || null;
  return {
    id: t.id, title: t.title, body: t.body || null,
    purpose: t.purpose || null, doneCondition: t.done_condition || null,
    kpi: t.kpi_link || null, service: t.service || null, url: t.link || null,
    assigneeId: t.assignee_id || null, assignee: who(t.assignee_id),
    dueOn: t.due_on || null,
    priority: t.priority || "normal", priorityLabel: priorityLabel(t.priority || "normal"),
    status: t.status, statusLabel: statusLabel(t.status),
    category: t.category || null,
    result: t.result || null, notDoneReason: t.not_done_reason || null,
    focusDate: t.focus_date || null, carryCount: t.carry_count || 0,
    acceptedAt: t.accepted_at || null, completedAt: t.completed_at || null,
    createdAt: t.created_at,
    createdBy: nameOfUser.get(t.created_by) || null,
    // AIが作ったものか、人が作ったものか。引き出しの「概要」に出す
    madeBy: t.ai_review?.madeBy === "ai" ? "ai" : "human",
    ai: t.ai_review
      ? { verdict: t.ai_review.verdict || null, reason: t.ai_review.reason || null,
          fix: t.ai_review.fix || null, doneCondition: t.ai_review.doneCondition || null,
          kpi: t.ai_review.kpi || null, checkedAt: t.ai_review.checkedAt || null,
          adopted: t.ai_review.adopted || null }
      : null,
    aiAssigneeId: t.ai_assignee || null,
    aiAssignee: who(t.ai_assignee),
    aiAssigneeWhy: t.ai_assignee_why || null,
  };
}

// ---- 書く ---------------------------------------------------------------------
async function act(req, res, ctx, user, body) {
  const sb = admin();
  const { task } = await load(sb, ctx.tenantId, body?.id);
  if (!task) return json(res, 404, { error: "not_found" });
  if (!mayEdit(ctx, user.id, task)) return json(res, 403, { error: "forbidden" });

  const actor = { id: user.id, name: ctx.employee.display_name };
  const base = { tenantId: ctx.tenantId, taskId: task.id, actor };

  switch (body.action) {
    case "update":  return update(res, sb, ctx, base, task, body, actor);
    case "status":  return setStatus(res, sb, ctx, base, task, body, actor);
    case "comment": return comment(res, sb, ctx, base, task, body, actor);
    case "carry":   return carry(res, sb, ctx, base, task, body, actor);
    case "ai":      return ai(res, sb, ctx, base, task, body, actor);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

async function update(res, sb, ctx, base, t, body, actor) {
  const patch = { updated_at: new Date().toISOString() };
  const events = [];
  const edited = [];

  if (body.assigneeId !== undefined && body.assigneeId !== t.assignee_id) {
    if (body.assigneeId && !(await isPeer(sb, ctx.tenantId, body.assigneeId))) {
      return json(res, 400, { error: "unknown_assignee", hint: "その相手は名簿にありません" });
    }
    patch.assignee_id = body.assigneeId || null;
    // 担当が変わったら、受諾は取り消す（新しい人がまだ見ていない）
    patch.accepted_at = null;
    events.push({ kind: "assigned",
                  detail: { fromName: await nameOf(sb, t.assignee_id), toName: await nameOf(sb, body.assigneeId) } });
  }
  if (body.dueOn !== undefined && (body.dueOn || null) !== (t.due_on || null)) {
    patch.due_on = isDate(body.dueOn) ? body.dueOn : null;
    events.push({ kind: "due", detail: { from: t.due_on, to: patch.due_on } });
  }
  if (body.priority !== undefined && body.priority !== t.priority) {
    if (!PRIORITIES.some((p) => p.key === body.priority)) {
      return json(res, 400, { error: "invalid_priority" });
    }
    patch.priority = body.priority;
    events.push({ kind: "priority", detail: { from: t.priority, to: body.priority } });
  }
  for (const [key, col, max] of [
    ["title", "title", 200], ["purpose", "purpose", 500], ["doneCondition", "done_condition", 500],
    ["kpi", "kpi_link", 120], ["service", "service", 120], ["category", "category", 80],
    ["body", "body", 2000],
  ]) {
    if (body[key] === undefined) continue;
    const v = str(body[key], max);
    if (v === (t[col] || null)) continue;
    patch[col] = key === "title" ? (v || t.title) : v;
    edited.push(key);
  }
  if (body.url !== undefined) {
    const u = str(body.url, 1000);
    if (u && !/^https?:\/\//i.test(u)) {
      return json(res, 400, { error: "bad_request", hint: "URL は http:// か https:// から始めてください" });
    }
    if (u !== (t.link || null)) { patch.link = u; edited.push("url"); }
  }
  if (edited.length) events.push({ kind: "edited", detail: { fields: edited } });

  if (!events.length) return json(res, 200, { ok: true, changed: false });

  const { error } = await sb.from("gw_tasks").update(patch).eq("id", t.id);
  if (error) {
    const hint = /purpose|done_condition|kpi_link|service|link/.test(error.message)
      ? "db/072_focus_tasks.sql → 073_task_detail.sql をまだ流していません" : null;
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_update_failed", detail: error.message });
  }
  for (const e of events) await taskEvent({ ...base, ...e });

  // 担当が変わったら、その人に知らせる
  if (patch.assignee_id && patch.assignee_id !== t.assignee_id) {
    await notify([{
      tenantId: ctx.tenantId, employeeId: patch.assignee_id, kind: "task_assigned",
      title: "タスクの担当になりました",
      body: [t.title, patch.due_on || t.due_on ? `期限 ${patch.due_on || t.due_on}` : null].filter(Boolean).join("／"),
      link: "tasks.html", dedupeKey: `task:${t.id}`,
    }]);
  }
  return json(res, 200, { ok: true, changed: true, events: events.map((e) => e.kind) });
}

async function setStatus(res, sb, ctx, base, t, body, actor) {
  if (!STATUSES.some((s) => s.key === body.status)) {
    return json(res, 400, { error: "invalid_status" });
  }
  const now = new Date().toISOString();
  const patch = { status: body.status, updated_at: now };
  if (body.status === "done") {
    patch.completed_at = now;
    if (body.result !== undefined) patch.result = str(body.result, 1000);
  } else {
    patch.completed_at = null;
  }
  const { error } = await sb.from("gw_tasks").update(patch).eq("id", t.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await taskEvent({ ...base, kind: "status",
                    detail: { from: t.status, to: body.status, result: patch.result || null } });

  // 頼んだ人に、終わったことを返す
  if (body.status === "done" && t.created_by && t.created_by !== actor.id) {
    const emp = await employeeOfUser(sb, ctx.tenantId, t.created_by);
    if (emp) {
      await notify([{
        tenantId: ctx.tenantId, employeeId: emp, kind: "task_assigned",
        title: `${actor.name}さんが終わらせました`,
        body: [t.title, patch.result].filter(Boolean).join("／"),
        link: "tasks.html", dedupeKey: `task-done:${t.id}`,
      }]);
    }
  }
  return json(res, 200, { ok: true, status: body.status });
}

async function comment(res, sb, ctx, base, t, body, actor) {
  const text = str(body.body, 2000);
  if (!text) return json(res, 400, { error: "bad_request", hint: "コメントを入れてください" });

  const { data, error } = await sb.from("gw_task_comments").insert({
    tenant_id: ctx.tenantId, task_id: t.id,
    author_id: actor.id, author_name: actor.name, body: text,
  }).select("id, author_name, body, created_at").single();
  if (error) {
    const hint = dbSetupHint(error, SQL) || (/gw_task_comments/.test(error.message) ? `${SQL} をまだ流していません` : null);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  await taskEvent({ ...base, kind: "comment", detail: { chars: text.length } });

  // 相手（担当 or 頼んだ人）に知らせる。自分だけのメモには送らない
  const targets = new Set();
  if (t.assignee_id && t.assignee_id !== ctx.employee.id) targets.add(t.assignee_id);
  if (t.created_by && t.created_by !== actor.id) {
    const emp = await employeeOfUser(sb, ctx.tenantId, t.created_by);
    if (emp && emp !== ctx.employee.id) targets.add(emp);
  }
  if (targets.size) {
    await notify([...targets].map((eid) => ({
      tenantId: ctx.tenantId, employeeId: eid, kind: "message",
      title: `${actor.name}さんがコメントしました`,
      body: [t.title, text.slice(0, 60)].join("／"),
      link: "tasks.html", dedupeKey: `task-comment:${t.id}`,
    })));
  }
  return json(res, 200, {
    comment: { id: data.id, name: data.author_name, body: data.body, at: data.created_at, mine: true },
  });
}

/** 持ち越し・優先度を下げる・別の人へ渡す・やらない。引き出しからも決められる */
async function carry(res, sb, ctx, base, t, body, actor) {
  if (!CARRY_KEYS.includes(body.decision)) {
    return json(res, 400, { error: "bad_request", hint: "どうするかを選んでください" });
  }
  const now = new Date().toISOString();
  const reason = str(body.reason, 300);
  const patch = { updated_at: now };
  if (reason) patch.not_done_reason = reason;
  const label = CARRY_CHOICES.find((c) => c.key === body.decision)?.label || body.decision;

  if (body.decision === "carry") {
    const to = isDate(body.date) ? body.date : nextFocusDate(jstToday());
    const owner = t.focus_for || t.assignee_id;
    const { data: have } = await sb.from("gw_tasks").select("id")
      .eq("tenant_id", ctx.tenantId).eq("focus_for", owner).eq("focus_date", to)
      .neq("status", "cancelled");
    if ((have || []).length >= MAX_FOCUS) {
      return json(res, 400, { error: "too_many", hint: `${to} の重要タスクは、もう${MAX_FOCUS}件あります` });
    }
    patch.focus_date = to;
    patch.focus_for = owner;
    patch.focus_rank = (have || []).length + 1;
    patch.carried_from = t.focus_date;
    patch.carry_count = (t.carry_count || 0) + 1;
    patch.due_on = to;
  } else if (body.decision === "lower") {
    patch.focus_date = null; patch.focus_rank = null; patch.priority = "normal";
  } else if (body.decision === "hand") {
    if (!body.assigneeId || !(await isPeer(sb, ctx.tenantId, body.assigneeId))) {
      return json(res, 400, { error: "unknown_assignee", hint: "渡す相手を選んでください" });
    }
    patch.assignee_id = body.assigneeId;
    patch.focus_date = null; patch.focus_rank = null; patch.accepted_at = null;
  } else {
    patch.status = "cancelled"; patch.focus_date = null; patch.focus_rank = null;
  }

  const { error } = await sb.from("gw_tasks").update(patch).eq("id", t.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  await taskEvent({ ...base, kind: "carry",
                    detail: { decision: body.decision, label, reason, to: patch.focus_date || null } });

  if (body.decision === "hand") {
    await notify([{
      tenantId: ctx.tenantId, employeeId: patch.assignee_id, kind: "task_assigned",
      title: "タスクが回ってきました",
      body: [t.title, reason].filter(Boolean).join("／"),
      link: "tasks.html", dedupeKey: `task:${t.id}`,
    }]);
  }
  return json(res, 200, { ok: true, decision: body.decision, label });
}

/**
 * AIの案を、採る・断る。
 *
 *   adopt   … 書き換え案・完了条件・担当の案を、そのまま入れる
 *   assign  … 担当の案だけ採る
 *   keep    … このまま進める（案は消す）
 */
async function ai(res, sb, ctx, base, t, body, actor) {
  const how = ["adopt", "assign", "keep"].includes(body.how) ? body.how : null;
  if (!how) return json(res, 400, { error: "bad_request", hint: "採る・担当だけ採る・このまま のどれかを選んでください" });
  if (!t.ai_review && !t.ai_assignee) return json(res, 400, { error: "no_ai", hint: "AIの案がありません" });

  const now = new Date().toISOString();
  const patch = { updated_at: now };
  const what = [];

  if (how === "adopt") {
    const r = t.ai_review || {};
    if (r.fix) { patch.title = String(r.fix).slice(0, 200); what.push("タスク名"); }
    if (r.doneCondition) { patch.done_condition = String(r.doneCondition).slice(0, 500); what.push("完了条件"); }
    if (r.kpi) { patch.kpi_link = String(r.kpi).slice(0, 120); what.push("KPI"); }
    if (t.ai_assignee) { patch.assignee_id = t.ai_assignee; patch.accepted_at = null; what.push("担当"); }
  } else if (how === "assign") {
    if (!t.ai_assignee) return json(res, 400, { error: "no_ai", hint: "担当の案がありません" });
    patch.assignee_id = t.ai_assignee;
    patch.accepted_at = null;
    what.push("担当");
  }
  // 採っても断っても、案は片付ける。押したあとも残っていると、
  // 一覧の「AI提案」が消えず、何度も同じものを見ることになる
  patch.ai_review = { ...(t.ai_review || {}), adopted: how, adoptedAt: now };
  patch.ai_assignee = null;

  const { error } = await sb.from("gw_tasks").update(patch).eq("id", t.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  await taskEvent({ ...base, kind: "ai",
                    detail: { adopted: how !== "keep", how, what: what.join("・") || null,
                              verdict: t.ai_review?.verdict || null } });

  if (patch.assignee_id && patch.assignee_id !== t.assignee_id) {
    await notify([{
      tenantId: ctx.tenantId, employeeId: patch.assignee_id, kind: "task_assigned",
      title: "タスクの担当になりました",
      body: [t.title, t.ai_assignee_why].filter(Boolean).join("／"),
      link: "tasks.html", dedupeKey: `task:${t.id}`,
    }]);
  }
  return json(res, 200, { ok: true, how, what });
}

// ---- 小物 ---------------------------------------------------------------------
async function isPeer(sb, tenantId, employeeId) {
  const { data } = await sb.from("gw_employees").select("id")
    .eq("id", employeeId).eq("tenant_id", tenantId).maybeSingle();
  return !!data;
}
async function nameOf(sb, employeeId) {
  if (!employeeId) return null;
  const { data } = await sb.from("gw_employees").select("display_name").eq("id", employeeId).maybeSingle();
  return data?.display_name || null;
}
async function employeeOfUser(sb, tenantId, userId) {
  const { data } = await sb.from("gw_employees").select("id")
    .eq("user_id", userId).eq("tenant_id", tenantId).maybeSingle();
  return data?.id || null;
}
