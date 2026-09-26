// GET  /api/tasks/focus?date=YYYY-MM-DD[&employeeId=…]
//        … その日の重要タスクと、状態（登録中／AI確認待ち／確認待ち／確定）
//          あわせて「明日ぶん」と、前日の未完了も返す
// POST /api/tasks/focus {action}
//        "add"      … 明日の重要タスクを1件足す
//        "update"   … 直す（担当・期限・優先度・完了条件・目的・KPI・得たい結果・なぜ明日やるか）
//        "remove"   … 重要タスクから外す（タスク自体は消さない）
//        "check"    … AIに見てもらう
//        "coach"    … ペアコーチングを終える（得たい結果・なぜ明日やるか・完了条件を、対話の結果で確定する）
//        "confirm"  … 人が確定する。ここで担当者へ配信され、日報が書けるようになる
//        "complete" … 今日の重要タスクを完了にする
//        "reopen"   … 完了を取り消す（押し間違い）
//        "carry"    … 終わらなかったものを、どうするか決める
//
// ■ 決めるのは人
//   AIは案と理由を出すだけ。confirm を押すまで、担当も内容も変わらない。
//   ペアコーチングも同じで、質を判定・修正するのはAIではなく本人（対話の相手が質問するだけ）。
//
// ■ 自分のぶんだけ
//   一般のメンバーは自分の重要タスクだけ。管理者・人事は全員ぶんを見て、
//   代わりに登録・確定もできる（本人が休んでいる日に止めないため）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  MIN_FOCUS, MAX_FOCUS, CARRY_KEYS, CARRY_CHOICES, FOCUS_FIELDS,
  focusState, progressOf, nextFocusDate, jstToday, missingFields, qualityLevel,
  COACH_STEPS, COACH_QUESTIONS, COACH_ECHO_EXAMPLE, QUALITY_LEVELS,
} from "../../lib/focus.js";
import { reviewFocus, reviewCarry, aiConfigured } from "../../lib/task-ai.js";

const SQL = "db/072_focus_tasks.sql";
const PRIORITIES = ["low", "normal", "high"];
const T_FIELDS =
  "id, tenant_id, title, body, purpose, done_condition, kpi_link, assignee_id, due_on, "
  + "priority, status, category, result, not_done_reason, completed_at, "
  + "focus_date, focus_rank, focus_for, ai_review, ai_assignee, ai_assignee_why, "
  + "outcome, tomorrow_reason, coached_at, coached_with, "
  + "carried_from, carry_count, created_by, created_at, updated_at";

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
  if (!ctx.employee) {
    return json(res, 403, { error: "no_employee", hint: "社員名簿にあなたの行がありません" });
  }

  if (req.method === "GET") return read(req, res, ctx, user);
  if (req.method === "POST") return act(req, res, ctx, user, await readJson(req));
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** 誰のぶんを見るか。他人のぶんは管理者・人事だけ */
function targetOf(ctx, employeeId) {
  if (!employeeId || employeeId === ctx.employee.id) return { id: ctx.employee.id, mine: true };
  if (!canManageHr(ctx)) return null;
  return { id: employeeId, mine: false };
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const who = targetOf(ctx, q.get("employeeId"));
  if (!who) return json(res, 403, { error: "forbidden" });

  const today = isDate(q.get("date")) ? q.get("date") : jstToday();
  const tomorrow = nextFocusDate(today);
  const sb = admin();

  const [todayPack, todayDoing, tomorrowPack, prev] = await Promise.all([
    load(sb, ctx.tenantId, who.id, today),
    // 今日「やる」ぶん。人から回ってきたものも入る
    doing(sb, ctx.tenantId, who.id, today),
    load(sb, ctx.tenantId, who.id, tomorrow),
    // 前の日の未完了。決めていないものが残っていたら、先にそれを片付けてもらう
    openOf(sb, ctx.tenantId, who.id, today),
  ]);
  if (todayPack.error) {
    const hint = dbSetupHint(todayPack.error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: todayPack.error.message });
  }

  const people = await peers(sb, ctx.tenantId);
  return json(res, 200, {
    today, tomorrowDate: tomorrow,
    // 今日の3つ（ダッシュボードと日報で使う）。担当で引く
    todayTasks: todayDoing.map(shape),
    todayProgress: progressOf(todayDoing),
    todayState: focusState({ day: todayPack.day, tasks: todayPack.tasks }),
    // 明日の3つ（決める側）
    tomorrowTasks: tomorrowPack.tasks.map(shape),
    tomorrowState: focusState({ day: tomorrowPack.day, tasks: tomorrowPack.tasks }),
    tomorrowAi: tomorrowPack.day?.ai || null,
    // 終わらなかったもの。どうするか決めるまで残る
    carryOver: prev.map(shape),
    carryChoices: CARRY_CHOICES,
    fields: FOCUS_FIELDS,
    min: MIN_FOCUS, max: MAX_FOCUS,
    // ペアコーチング（聞き方ガイド）。画面はこれを描くだけにする
    coachSteps: COACH_STEPS,
    coachQuestions: COACH_QUESTIONS,
    coachEcho: COACH_ECHO_EXAMPLE,
    qualityLevels: QUALITY_LEVELS,
    people,
    me: { id: ctx.employee.id, name: ctx.employee.display_name },
    employeeId: who.id,
    canManage: canManageHr(ctx),
    aiReady: aiConfigured(),
  });
}

/**
 * その日の行と、その人が「決めた」タスク。
 *
 * 決めた人（focus_for）で引く。担当を人に渡しても、決めた側の3件からは消えない。
 * 実際にやる側の一覧は doing()（担当で引く）
 */
async function load(sb, tenantId, employeeId, date) {
  if (!date) return { day: null, tasks: [], error: null };
  const [days, tasks] = await Promise.all([
    sb.from("gw_focus_days").select("*")
      .eq("employee_id", employeeId).eq("focus_date", date).maybeSingle(),
    sb.from("gw_tasks").select(T_FIELDS)
      .eq("tenant_id", tenantId).eq("focus_for", employeeId).eq("focus_date", date)
      .order("focus_rank", { ascending: true, nullsFirst: false }).limit(20),
  ]);
  return { day: days.data || null, tasks: tasks.data || [], error: days.error || tasks.error || null };
}

/**
 * その日に、その人が「やる」タスク。
 *
 * 人から回ってきたものも入る。ダッシュボードの「今日やる3つ」はこちら
 */
async function doing(sb, tenantId, employeeId, date) {
  if (!date) return [];
  const { data } = await sb.from("gw_tasks").select(T_FIELDS)
    .eq("tenant_id", tenantId).eq("assignee_id", employeeId).eq("focus_date", date)
    .order("focus_rank", { ascending: true, nullsFirst: false }).limit(20);
  return data || [];
}

/**
 * 前の日までの、終わらなかった重要タスク。
 *
 * 自動では動かさない。決めるまでここに残り続ける。
 * 積み上がるのが目に見えるので、「そもそもやらない」判断が出るようになる
 */
async function openOf(sb, tenantId, employeeId, today) {
  const { data } = await sb.from("gw_tasks").select(T_FIELDS)
    .eq("tenant_id", tenantId).eq("focus_for", employeeId)
    .not("focus_date", "is", null).lt("focus_date", today)
    .in("status", ["todo", "doing"])
    .order("focus_date", { ascending: false }).limit(20);
  return data || [];
}

/** 同僚。担当を変えるときの選択肢と、AIに渡す仕事量 */
async function peers(sb, tenantId) {
  const { data: emps } = await sb.from("gw_employees")
    .select("id, display_name, department, position")
    .eq("tenant_id", tenantId).in("status", ["active", "invited"])
    .order("display_name").limit(200);
  const ids = (emps || []).map((e) => e.id);
  if (!ids.length) return [];

  const [{ data: open }, { data: grants }] = await Promise.all([
    sb.from("gw_tasks").select("assignee_id, focus_date, status")
      .eq("tenant_id", tenantId).in("assignee_id", ids).in("status", ["todo", "doing"]).limit(3000),
    sb.from("gw_role_grants").select("employee_id, role").eq("tenant_id", tenantId).limit(500),
  ]);
  const openBy = new Map();
  const focusBy = new Map();
  const tomorrow = nextFocusDate(jstToday());
  for (const t of open || []) {
    openBy.set(t.assignee_id, (openBy.get(t.assignee_id) || 0) + 1);
    if (t.focus_date === tomorrow) focusBy.set(t.assignee_id, (focusBy.get(t.assignee_id) || 0) + 1);
  }
  const rolesBy = new Map();
  for (const g of grants || []) {
    if (!rolesBy.has(g.employee_id)) rolesBy.set(g.employee_id, []);
    rolesBy.get(g.employee_id).push(g.role);
  }
  return (emps || []).map((e) => ({
    id: e.id, name: e.display_name, department: e.department || null, position: e.position || null,
    roles: rolesBy.get(e.id) || [],
    openCount: openBy.get(e.id) || 0,
    focusCount: focusBy.get(e.id) || 0,
  }));
}

const shape = (t) => ({
  id: t.id, title: t.title, purpose: t.purpose, doneCondition: t.done_condition,
  kpiLink: t.kpi_link, assigneeId: t.assignee_id, dueOn: t.due_on, priority: t.priority,
  status: t.status, focusDate: t.focus_date, focusRank: t.focus_rank, focusFor: t.focus_for,
  result: t.result, notDoneReason: t.not_done_reason,
  aiReview: t.ai_review || null, aiAssignee: t.ai_assignee || null, aiAssigneeWhy: t.ai_assignee_why || null,
  carriedFrom: t.carried_from, carryCount: t.carry_count || 0,
  completedAt: t.completed_at,
  missing: missingFields(t),
  // ペアコーチング（得たい結果・なぜ明日やるか・質・誰と組んだか）
  outcome: t.outcome || null, tomorrowReason: t.tomorrow_reason || null,
  coachedAt: t.coached_at || null, coachedWith: t.coached_with || null,
  qualityLevel: qualityLevel(t),
});

// ---- 書く ---------------------------------------------------------------------
async function act(req, res, ctx, user, body) {
  const sb = admin();
  const who = targetOf(ctx, body?.employeeId);
  if (!who) return json(res, 403, { error: "forbidden" });

  switch (body?.action) {
    case "add":      return addTask(res, sb, ctx, user, who, body);
    case "update":   return updateTask(res, sb, ctx, user, who, body);
    case "remove":   return removeTask(res, sb, ctx, user, who, body);
    case "check":    return check(res, sb, ctx, who, body);
    case "coach":    return coachTask(res, sb, ctx, user, who, body);
    case "confirm":  return confirm(res, sb, ctx, user, who, body);
    case "complete": return complete(res, sb, ctx, user, who, body);
    case "reopen":   return reopen(res, sb, ctx, who, body);
    case "carry":    return carry(res, sb, ctx, user, who, body);
    case "carryPlan": return carryPlan(res, sb, ctx, who, body);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

/** その日の行を、無ければ作る */
async function ensureDay(sb, tenantId, employeeId, date) {
  const { data } = await sb.from("gw_focus_days").select("*")
    .eq("employee_id", employeeId).eq("focus_date", date).maybeSingle();
  if (data) return { day: data, error: null };
  const ins = await sb.from("gw_focus_days")
    .insert({ tenant_id: tenantId, employee_id: employeeId, focus_date: date, status: "draft" })
    .select("*").single();
  return { day: ins.data || null, error: ins.error || null };
}

/** 状態を1つ進める・戻す */
async function setStatus(sb, dayId, status, extra = {}) {
  if (!dayId) return;
  await sb.from("gw_focus_days")
    .update({ status, updated_at: new Date().toISOString(), ...extra }).eq("id", dayId);
}

async function addTask(res, sb, ctx, user, who, body) {
  const date = isDate(body.date) ? body.date : nextFocusDate(jstToday());
  if (!date) return json(res, 400, { error: "bad_request", hint: "日付が正しくありません" });

  const title = str(body.title, 200);
  if (!title) return json(res, 400, { error: "bad_request", hint: "タスク名を入れてください" });

  const { day, error: de } = await ensureDay(sb, ctx.tenantId, who.id, date);
  if (de) {
    const hint = dbSetupHint(de, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: de.message });
  }
  // 確定したあとは足させない。確定の意味が無くなる
  if (day?.status === "confirmed") {
    return json(res, 409, { error: "already_confirmed", hint: "確定ずみです。直すには、いったん確定を取り消してください" });
  }

  const { data: have } = await sb.from("gw_tasks").select("id")
    .eq("tenant_id", ctx.tenantId).eq("focus_for", who.id).eq("focus_date", date)
    .neq("status", "cancelled");
  if ((have || []).length >= MAX_FOCUS) {
    return json(res, 400, { error: "too_many",
      hint: `1日に決める重要タスクは${MAX_FOCUS}件までです。多いほど、どれも終わりません` });
  }

  // 担当は未指定でよい（AIが候補を出す）。指定するなら同じ会社の人だけ
  let assignee = body.assigneeId || null;
  if (assignee && !(await isPeer(sb, ctx.tenantId, assignee))) {
    return json(res, 400, { error: "unknown_assignee", hint: "その相手は名簿にありません" });
  }
  // 誰のぶんとして決めているか。担当が未定でも、まずはその人の欄に置く
  if (!assignee) assignee = who.id;

  const row = {
    tenant_id: ctx.tenantId,
    title,
    purpose: str(body.purpose, 500),
    done_condition: str(body.doneCondition, 500),
    kpi_link: str(body.kpiLink, 120),
    assignee_id: assignee,
    due_on: isDate(body.dueOn) ? body.dueOn : date,
    priority: PRIORITIES.includes(body.priority) ? body.priority : "high",
    category: str(body.category, 80),
    focus_date: date,
    focus_rank: (have || []).length + 1,
    // 誰の3件として決めたか。担当を人に渡しても、ここは動かさない
    focus_for: who.id,
    created_by: user.id,
  };
  const { data, error } = await sb.from("gw_tasks").insert(row).select(T_FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL) || (/focus_date|purpose|kpi_link/.test(error.message) ? `${SQL} をまだ流していません` : null);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  // 件数が変わったので、状態を見直す（3件そろえば ready）
  await refresh(sb, ctx.tenantId, who.id, date, day);
  return json(res, 200, { task: shape(data) });
}

async function updateTask(res, sb, ctx, user, who, body) {
  const t = await loadTask(sb, ctx.tenantId, body.id);
  if (!t) return json(res, 404, { error: "not_found" });
  if (!mayTouch(ctx, user.id, t)) return json(res, 403, { error: "forbidden" });

  const patch = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) patch.title = str(body.title, 200) || t.title;
  if (body.purpose !== undefined) patch.purpose = str(body.purpose, 500);
  if (body.doneCondition !== undefined) patch.done_condition = str(body.doneCondition, 500);
  if (body.outcome !== undefined) patch.outcome = str(body.outcome, 500);
  if (body.tomorrowReason !== undefined) patch.tomorrow_reason = str(body.tomorrowReason, 500);
  if (body.kpiLink !== undefined) patch.kpi_link = str(body.kpiLink, 120);
  if (body.dueOn !== undefined) patch.due_on = isDate(body.dueOn) ? body.dueOn : null;
  if (body.priority !== undefined && PRIORITIES.includes(body.priority)) patch.priority = body.priority;
  if (body.focusRank !== undefined) patch.focus_rank = Number(body.focusRank) || null;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId && !(await isPeer(sb, ctx.tenantId, body.assigneeId))) {
      return json(res, 400, { error: "unknown_assignee", hint: "その相手は名簿にありません" });
    }
    patch.assignee_id = body.assigneeId || null;
  }
  // コーチング後の中身をまた直したら、コーチング済みを取り消す。
  // 古い対話の結果が付いたまま確定されるのを防ぐ
  if (t.coached_at && ["title", "purpose", "doneCondition", "outcome", "tomorrowReason"]
      .some((k) => body[k] !== undefined)) {
    patch.coached_at = null;
    patch.coached_with = null;
  }

  const { data, error } = await sb.from("gw_tasks").update(patch)
    .eq("id", t.id).select(T_FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  // 直したら、AIの確認はやり直し。古い講評が付いたまま確定されるのを防ぐ
  if (t.focus_date) {
    const owner = t.focus_for || who.id;
    const { day } = await ensureDay(sb, ctx.tenantId, owner, t.focus_date);
    if (day && day.status === "ai_checked") await setStatus(sb, day.id, "ready");
    await refresh(sb, ctx.tenantId, owner, t.focus_date, day);
  }
  return json(res, 200, { task: shape(data) });
}

/**
 * ペアコーチングを終える（聞き方ガイドの7番目「確認済み」）。
 *
 * 承認ではない。得たい結果・なぜ明日やるか・完了条件は、対話の中で
 * 本人が直したものをそのまま保存し、いつ・誰と組んだかだけを記録する。
 * Lv3（成果が明確）に届いていなくても、決めるのは本人なので止めない
 */
async function coachTask(res, sb, ctx, user, who, body) {
  const t = await loadTask(sb, ctx.tenantId, body.id);
  if (!t) return json(res, 404, { error: "not_found" });
  if (!mayTouch(ctx, user.id, t)) return json(res, 403, { error: "forbidden" });

  const partners = (Array.isArray(body.partners) ? body.partners : []).slice(0, 2)
    .map((p) => ({ employeeId: p?.employeeId || null, name: str(p?.name, 60) }))
    .filter((p) => p.name);
  if (!partners.length) {
    return json(res, 400, { error: "bad_request", hint: "誰と組んだかを選んでください" });
  }

  const now = new Date().toISOString();
  const patch = { updated_at: now, coached_at: now, coached_with: partners };
  if (body.outcome !== undefined) patch.outcome = str(body.outcome, 500);
  if (body.tomorrowReason !== undefined) patch.tomorrow_reason = str(body.tomorrowReason, 500);
  if (body.doneCondition !== undefined) patch.done_condition = str(body.doneCondition, 500);

  const { data, error } = await sb.from("gw_tasks").update(patch)
    .eq("id", t.id).select(T_FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  if (t.focus_date) await refresh(sb, ctx.tenantId, t.focus_for || who.id, t.focus_date, null);
  return json(res, 200, { task: shape(data) });
}

/** 重要タスクから外す。タスクそのものは消さない（ふつうのタスクに戻す） */
async function removeTask(res, sb, ctx, user, who, body) {
  const t = await loadTask(sb, ctx.tenantId, body.id);
  if (!t) return json(res, 404, { error: "not_found" });
  if (!mayTouch(ctx, user.id, t)) return json(res, 403, { error: "forbidden" });

  const date = t.focus_date;
  const { error } = await sb.from("gw_tasks")
    .update({ focus_date: null, focus_rank: null, updated_at: new Date().toISOString() })
    .eq("id", t.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (date) await refresh(sb, ctx.tenantId, t.focus_for || who.id, date, null);
  return json(res, 200, { ok: true, id: t.id });
}

/** 件数がそろったか見て、状態を直す */
async function refresh(sb, tenantId, employeeId, date, dayRow) {
  const { day, tasks } = await load(sb, tenantId, employeeId, date);
  const row = day || dayRow;
  if (!row) return null;
  if (row.status === "confirmed") return row;
  const st = focusState({ day: row, tasks });
  if (st.key !== row.status) await setStatus(sb, row.id, st.key);
  return { ...row, status: st.key };
}

// ---- AIに見てもらう -----------------------------------------------------------
async function check(res, sb, ctx, who, body) {
  const date = isDate(body.date) ? body.date : nextFocusDate(jstToday());
  const { day, tasks } = await load(sb, ctx.tenantId, who.id, date);
  const st = focusState({ day, tasks });
  if (!st.ready) {
    return json(res, 400, { error: "not_ready_yet", hint: st.todo });
  }
  if (!aiConfigured()) {
    return json(res, 503, { error: "ai_not_configured",
      hint: "AIの鍵が設定されていません。管理者に OPENAI_API_KEY か ANTHROPIC_API_KEY の設定を依頼してください" });
  }

  const [emp, members, goals, kpis, open] = await Promise.all([
    sb.from("gw_employees").select("display_name, department, position, initial_role")
      .eq("id", who.id).maybeSingle(),
    peers(sb, ctx.tenantId),
    weekGoal(sb, ctx.tenantId, who.id, date),
    kpiTemplates(sb, who.id),
    sb.from("gw_tasks").select("title, due_on, priority")
      .eq("tenant_id", ctx.tenantId).eq("assignee_id", who.id)
      .in("status", ["todo", "doing"]).is("focus_date", null).limit(30),
  ]);
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  let out;
  try {
    out = await reviewFocus({
      employee: { name: emp.data?.display_name, department: emp.data?.department,
                  position: emp.data?.position, role: emp.data?.initial_role },
      date,
      tasks: tasks.map((t) => ({ ...t, assigneeName: nameOf.get(t.assignee_id) || null })),
      goals, kpis,
      members: members.filter((m) => m.id !== who.id),
      openTasks: open.data || [],
    });
  } catch (e) {
    console.error("[focus] AIの確認に失敗:", e?.message || e);
    return json(res, 502, { error: "ai_failed", hint: "AIの確認に失敗しました。もう一度お試しください",
                            detail: String(e?.message || e).slice(0, 200) });
  }

  // タスクごとの講評を、そのタスクに書く。人が見て直せるようにする
  const byName = new Map(members.map((m) => [m.name, m.id]));
  const now = new Date().toISOString();
  for (const r of out.result?.tasks || []) {
    const t = tasks[r.index];
    if (!t) continue;
    const suggested = r.assignee_name ? byName.get(String(r.assignee_name).trim()) || null : null;
    await sb.from("gw_tasks").update({
      ai_review: { verdict: r.verdict, reason: r.reason, fix: r.fix || null,
                   doneCondition: r.done_condition || null, kpi: r.kpi || null, checkedAt: now },
      ai_assignee: suggested && suggested !== t.assignee_id ? suggested : null,
      ai_assignee_why: r.assignee_why || null,
      updated_at: now,
    }).eq("id", t.id);
  }
  await setStatus(sb, day?.id, "ai_checked",
    { ai: out.result?.overall || null, ai_model: out.model, ai_at: now });

  const after = await load(sb, ctx.tenantId, who.id, date);
  return json(res, 200, {
    ai: out.result?.overall || null,
    tasks: after.tasks.map(shape),
    state: focusState({ day: after.day, tasks: after.tasks }),
  });
}

/** その週のゴール（管理者が決めたもの）。AIの材料 */
async function weekGoal(sb, tenantId, employeeId, date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));           // 月曜
  const { data } = await sb.from("gw_week_goals")
    .select("kgi, kpis, priority_work, deadline")
    .eq("employee_id", employeeId).eq("week_start", d.toISOString().slice(0, 10))
    .eq("status", "active").maybeSingle();
  return data || null;
}

async function kpiTemplates(sb, employeeId) {
  const { data: emp } = await sb.from("gw_employees").select("user_id").eq("id", employeeId).maybeSingle();
  if (!emp?.user_id) return [];
  const { data } = await sb.from("gw_kpi_templates")
    .select("label, unit, target").eq("user_id", emp.user_id).eq("active", true).limit(10);
  return data || [];
}

// ---- 確定 ---------------------------------------------------------------------
async function confirm(res, sb, ctx, user, who, body) {
  const date = isDate(body.date) ? body.date : nextFocusDate(jstToday());
  const { day, tasks } = await load(sb, ctx.tenantId, who.id, date);
  const st = focusState({ day, tasks });
  if (st.confirmed) return json(res, 200, { ok: true, already: true, state: st });
  if (!st.ready) return json(res, 400, { error: "not_ready_yet", hint: st.todo });
  if (!st.coached) {
    return json(res, 400, { error: "needs_coaching", hint: "3件のペアコーチングを終えてから確定してください" });
  }

  const now = new Date().toISOString();
  const { day: row } = await ensureDay(sb, ctx.tenantId, who.id, date);
  await setStatus(sb, row?.id, "confirmed", { confirmed_at: now, confirmed_by: user.id });

  // 担当が自分以外のタスクは、その人に配る。
  // 配られた側は、ふつうのタスクと同じように受けて進める
  const others = tasks.filter((t) => t.assignee_id && t.assignee_id !== who.id);
  for (const t of others) {
    await notify([{
      tenantId: ctx.tenantId, employeeId: t.assignee_id, kind: "task_assigned",
      title: `${date} の重要タスクが届きました`,
      body: [t.title, t.done_condition ? `完了条件：${t.done_condition}` : null].filter(Boolean).join("／"),
      link: "home.html", dedupeKey: `focus:${t.id}`,
    }]);
    // 相手の日ぶんも作る（相手の画面にも「今日やる3つ」として出る）
    await ensureDay(sb, ctx.tenantId, t.assignee_id, date);
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "focus.confirm",
    target: `employee:${who.id}`, detail: { date, count: tasks.length, byAdmin: !who.mine },
  });
  const after = await load(sb, ctx.tenantId, who.id, date);
  return json(res, 200, {
    ok: true,
    state: focusState({ day: after.day, tasks: after.tasks }),
    tasks: after.tasks.map(shape),
    sent: others.length,
  });
}

// ---- 完了 ---------------------------------------------------------------------
async function complete(res, sb, ctx, user, who, body) {
  const t = await loadTask(sb, ctx.tenantId, body.id);
  if (!t) return json(res, 404, { error: "not_found" });
  // 完了を押せるのは担当者本人と管理者だけ
  if (t.assignee_id !== ctx.employee.id && !canManageHr(ctx)) {
    return json(res, 403, { error: "not_your_task" });
  }
  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_tasks").update({
    status: "done", completed_at: now,
    result: body.result !== undefined ? str(body.result, 1000) : t.result,
    not_done_reason: null,
    updated_at: now,
  }).eq("id", t.id).select(T_FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  const prog = progressOf(await doing(sb, ctx.tenantId, t.assignee_id, t.focus_date));
  // 3件そろったら、その場で伝える。ここが今日の区切りになる
  return json(res, 200, { task: shape(data), progress: prog,
                          done: prog.allDone, message: prog.allDone ? "今日の重要タスク完了" : null });
}

async function reopen(res, sb, ctx, who, body) {
  const t = await loadTask(sb, ctx.tenantId, body.id);
  if (!t) return json(res, 404, { error: "not_found" });
  if (t.assignee_id !== ctx.employee.id && !canManageHr(ctx)) {
    return json(res, 403, { error: "not_your_task" });
  }
  const { data, error } = await sb.from("gw_tasks")
    .update({ status: "todo", completed_at: null, updated_at: new Date().toISOString() })
    .eq("id", t.id).select(T_FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  return json(res, 200, { task: shape(data),
                          progress: progressOf(await doing(sb, ctx.tenantId, t.assignee_id, t.focus_date)) });
}

// ---- 未完了をどうするか -------------------------------------------------------

/** AIに案を出してもらう（決めるのは人） */
async function carryPlan(res, sb, ctx, who, body) {
  const open = await openOf(sb, ctx.tenantId, who.id, isDate(body.date) ? body.date : jstToday());
  if (!open.length) return json(res, 200, { items: [] });
  if (!aiConfigured()) {
    return json(res, 503, { error: "ai_not_configured", hint: "AIの鍵が設定されていません" });
  }
  const [emp, members] = await Promise.all([
    sb.from("gw_employees").select("display_name").eq("id", who.id).maybeSingle(),
    peers(sb, ctx.tenantId),
  ]);
  try {
    const out = await reviewCarry({
      employee: { name: emp.data?.display_name }, date: body.date || jstToday(),
      tasks: open, members: members.filter((m) => m.id !== who.id),
    });
    const byName = new Map(members.map((m) => [m.name, m.id]));
    return json(res, 200, {
      items: (out.result?.items || []).map((r) => ({
        taskId: open[r.index]?.id || null,
        decision: CARRY_KEYS.includes(r.decision) ? r.decision : "carry",
        reason: r.reason,
        assigneeId: r.assignee_name ? byName.get(String(r.assignee_name).trim()) || null : null,
        assigneeName: r.assignee_name || null,
      })).filter((r) => r.taskId),
      model: out.model,
    });
  } catch (e) {
    console.error("[focus] 未完了の案に失敗:", e?.message || e);
    return json(res, 502, { error: "ai_failed", hint: "AIの提案に失敗しました" });
  }
}

/** 人が決める。決めたときだけ動かす */
async function carry(res, sb, ctx, user, who, body) {
  const t = await loadTask(sb, ctx.tenantId, body.id);
  if (!t) return json(res, 404, { error: "not_found" });
  if (!mayTouch(ctx, user.id, t)) return json(res, 403, { error: "forbidden" });
  if (!CARRY_KEYS.includes(body.decision)) {
    return json(res, 400, { error: "bad_request", hint: "どうするかを選んでください" });
  }

  const now = new Date().toISOString();
  const reason = str(body.reason, 300);
  const patch = { updated_at: now };
  if (reason) patch.not_done_reason = reason;

  if (body.decision === "carry") {
    const to = isDate(body.date) ? body.date : nextFocusDate(jstToday());
    const { data: have } = await sb.from("gw_tasks").select("id")
      .eq("tenant_id", ctx.tenantId).eq("focus_for", t.focus_for || t.assignee_id).eq("focus_date", to)
      .neq("status", "cancelled");
    if ((have || []).length >= MAX_FOCUS) {
      return json(res, 400, { error: "too_many", hint: `${to} の重要タスクは、もう${MAX_FOCUS}件あります` });
    }
    const { day } = await ensureDay(sb, ctx.tenantId, t.focus_for || t.assignee_id, to);
    if (day?.status === "confirmed") {
      return json(res, 409, { error: "already_confirmed", hint: `${to} ぶんは確定ずみです` });
    }
    patch.focus_date = to;
    patch.focus_rank = (have || []).length + 1;
    patch.carried_from = t.focus_date;
    patch.carry_count = (t.carry_count || 0) + 1;
    patch.due_on = to;
  } else if (body.decision === "lower") {
    // 重要タスクから外して、ふつうのタスクに戻す
    patch.focus_date = null;
    patch.focus_rank = null;
    patch.priority = "normal";
  } else if (body.decision === "hand") {
    if (!body.assigneeId || !(await isPeer(sb, ctx.tenantId, body.assigneeId))) {
      return json(res, 400, { error: "unknown_assignee", hint: "渡す相手を選んでください" });
    }
    patch.assignee_id = body.assigneeId;
    patch.focus_date = null;
    patch.focus_rank = null;
    patch.accepted_at = null;
  } else {
    patch.status = "cancelled";
    patch.focus_date = null;
    patch.focus_rank = null;
  }

  const { data, error } = await sb.from("gw_tasks").update(patch)
    .eq("id", t.id).select(T_FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  if (body.decision === "hand") {
    await notify([{
      tenantId: ctx.tenantId, employeeId: patch.assignee_id, kind: "task_assigned",
      title: "タスクが回ってきました",
      body: [t.title, reason].filter(Boolean).join("／"),
      link: "tasks.html", dedupeKey: `task:${t.id}`,
    }]);
  }
  if (t.focus_date) {
    await sb.from("gw_focus_days")
      .update({ carry_handled_at: now, updated_at: now })
      .eq("employee_id", t.assignee_id).eq("focus_date", t.focus_date);
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "focus.carry",
    target: `task:${t.id}`, detail: { decision: body.decision, from: t.focus_date, carryCount: data.carry_count },
  });
  return json(res, 200, { task: shape(data), decision: body.decision });
}

// ---- 小物 ---------------------------------------------------------------------
async function loadTask(sb, tenantId, id) {
  if (!id) return null;
  const { data } = await sb.from("gw_tasks").select(T_FIELDS)
    .eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  return data || null;
}

/**
 * そのタスクを直してよいか。
 *   管理者・人事 … 全部
 *   本人         … 自分が担当のもの
 *   頼んだ人     … 自分が作ったもの（担当を人に渡したあとも直せる）
 */
function mayTouch(ctx, userId, t) {
  if (canManageHr(ctx)) return true;
  if (t.assignee_id === ctx.employee.id) return true;
  return t.created_by === userId;
}

async function isPeer(sb, tenantId, employeeId) {
  const { data } = await sb.from("gw_employees").select("id")
    .eq("id", employeeId).eq("tenant_id", tenantId).maybeSingle();
  return !!data;
}
