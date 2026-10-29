// GET  /api/office-professionals?kind=labor|tax[&id=…]
// POST /api/office-professionals { action: create|update|status|approve|request_resubmission|checklist|comment, ... }
//
// 社労士・税理士専用のタスク口。各リクエストで担当と業務種別を確かめ、
// 新しい表は service role からだけ読む。HR 関連の書類は共有済みの提出物だけを返す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import * as GW from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { requireMfa } from "../../lib/mfa.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import { jstDate } from "../../lib/timecard.js";
import { phaseOf } from "../../lib/hr-flow.js";
import { advance } from "../../lib/onboard-advance.js";
import {
  KINDS, STATUSES, PRIORITIES, canViewKind, canManageKind, canUsePortal, canSeeTask,
  validateAssigneeRole, safeText, isDate, shapeTask, generateTaxTasks, isAdvisor, isTaxAdvisor, isSharedProcedureTask,
  sharedAdvisorFolderLink,
} from "../../lib/professional-tasks.js";

const SQL = "db/146_office_professional_tasks.sql";
const FIELDS = "id, tenant_id, kind, title, description, due_on, priority, status, assignee_employee_id, "
  + "procedure_id, procedure_item_id, template_id, source, source_key, created_by, completed_by, completed_at, created_at, updated_at";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const validId = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const cleanChecklist = (items) => (Array.isArray(items) ? items : []).slice(0, 30)
  .map((x) => safeText(x, 300)).filter((x) => x.value && !x.error).map((x) => x.value);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await GW.gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee) return json(res, 403, { error: "no_membership" });
  if (!canUsePortal(ctx, GW)) return json(res, 403, { error: "forbidden" });
  if (!(await requireMfa(req, res, ctx, user))) return;

  try {
    if (req.method === "GET") return await read(req, res, ctx, user);
    if (req.method === "POST") return await act(req, res, ctx, user, await readJson(req));
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office-professionals]", e?.message || e);
    return json(res, 500, { error: "professional_task_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function read(req, res, ctx, user) {
  const sb = admin();
  const q = new URL(req.url || "/", "http://localhost").searchParams;
  const today = jstDate();
  const kinds = KINDS.filter((k) => canViewKind(ctx, k, GW));
  if (!kinds.length) return json(res, 403, { error: "forbidden" });

  if (canManageKind(ctx, "tax", GW)) {
    await ensureDefaultTemplates(sb, ctx.tenantId, user.id);
    const made = await generateTaxTasks(sb, ctx.tenantId, { from: today, to: addDays(today, 90) });
    for (const task of made) if (task.assignee_employee_id) {
      await notify([{ tenantId: ctx.tenantId, employeeId: task.assignee_employee_id, kind: "task_assigned",
        title: "税理士の定期タスクが追加されました", body: task.title,
        link: "/office/professionals.html?tab=tax", dedupeKey: `professional-task:${task.id}` }]);
    }
  }
  const id = q.get("id");
  let query = sb.from("gw_professional_tasks").select(FIELDS).eq("tenant_id", ctx.tenantId).in("kind", kinds);
  if (id) query = query.eq("id", id);
  if (!canManageKind(ctx, "labor", GW) && isAdvisor(ctx)) query = query.eq("assignee_employee_id", ctx.employee.id);
  if (!canManageKind(ctx, "tax", GW) && isTaxAdvisor(ctx)) query = query.eq("assignee_employee_id", ctx.employee.id);
  const rows = await must(query.order("due_on", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).limit(id ? 1 : 500));
  if (id && !rows?.length) return json(res, 404, { error: "not_found" });

  let taskRows = rows || [];
  if (isAdvisor(ctx)) {
    const checked = await Promise.all(taskRows.map(async (task) => [task, await isSharedProcedureTask(sb, ctx.tenantId, task)]));
    taskRows = checked.filter(([, shared]) => shared).map(([task]) => task);
  }
  if (id) {
    const task = taskRows[0];
    if (!canSeeTask(ctx, user.id, task, GW)) return json(res, 404, { error: "not_found" });
    return await readDetail(res, sb, ctx, user, task, today);
  }

  const [employees, procedures, templateRows] = await Promise.all([
    listTaskEmployees(sb, ctx.tenantId, taskRows),
    listTaskProcedures(sb, ctx.tenantId, taskRows),
    canManageKind(ctx, "tax", GW)
      ? must(sb.from("gw_professional_task_templates").select("id, title, description, due_day, assignee_employee_id, checklist, is_active, system_key")
        .eq("tenant_id", ctx.tenantId).order("due_day").order("created_at").limit(100))
      : Promise.resolve([]),
  ]);
  const names = new Map((employees || []).map((e) => [e.id, e.display_name]));
  const procedureMap = new Map((procedures || []).map((p) => [p.id, p]));
  const shaped = taskRows.map((t) => {
    const proc = t.procedure_id ? procedureMap.get(t.procedure_id) : null;
    return shapeTask(t, names.get(t.assignee_employee_id), proc ? {
      name: proc.employee?.display_name || "（対象者不明）",
      kind: proc.kind === "onboarding" ? "入社" : "退職",
      targetOn: proc.target_on || null,
    } : null, today);
  });

  const assignable = [];
  if (canManageKind(ctx, "labor", GW) || canManageKind(ctx, "tax", GW)) {
    const grants = await must(sb.from("gw_role_grants").select("employee_id, role")
      .eq("tenant_id", ctx.tenantId).in("role", ["labor_advisor", "tax_advisor"]).limit(300));
    const ids = [...new Set((grants || []).map((g) => g.employee_id))];
    const people = ids.length ? await must(sb.from("gw_employees").select("id, display_name, status").eq("tenant_id", ctx.tenantId)
      .in("id", ids).in("status", ["active", "invited"]).order("display_name").limit(300)) : [];
    const rolesById = new Map();
    for (const g of grants || []) rolesById.set(g.employee_id, [...(rolesById.get(g.employee_id) || []), g.role]);
    for (const person of people || []) assignable.push({ id: person.id, name: person.display_name, roles: rolesById.get(person.id) || [] });
  }

  return json(res, 200, {
    today, kinds,
    tasks: shaped,
    stats: Object.fromEntries(kinds.map((kind) => [kind, {
      open: shaped.filter((t) => t.kind === kind && !["done", "skipped"].includes(t.status)).length,
      overdue: shaped.filter((t) => t.kind === kind && t.overdue).length,
      returned: shaped.filter((t) => t.kind === kind && t.status === "returned").length,
    }])),
    templates: templateRows || [], assignable,
    permissions: Object.fromEntries(KINDS.map((k) => [k, { view: canViewKind(ctx, k, GW), manage: canManageKind(ctx, k, GW) }])),
    me: { id: ctx.employee.id },
  });
}

async function readDetail(res, sb, ctx, user, task, today) {
  const [employees, checklist, comments, events, files] = await Promise.all([
    listTaskEmployees(sb, ctx.tenantId, [task]),
    must(sb.from("gw_professional_task_checklist").select("id, title, position, completed_at, completed_by")
      .eq("task_id", task.id).order("position").limit(100)),
    must(sb.from("gw_professional_task_comments").select("id, author_id, author_name, body, created_at")
      .eq("task_id", task.id).order("created_at").limit(200)),
    must(sb.from("gw_professional_task_events").select("id, kind, actor_id, actor_name, detail, created_at")
      .eq("task_id", task.id).order("created_at").limit(200)),
    must(sb.from("gw_professional_task_files").select("id, filename, mime_type, size_bytes, created_at")
      .eq("task_id", task.id).not("uploaded_at", "is", null).order("created_at", { ascending: false }).limit(100)),
  ]);
  const names = new Map((employees || []).map((e) => [e.id, e.display_name]));
  let subject = null;
  let procedureFiles = [];
  let procedureItem = null;
  let sharedDriveLink = null;
  if (task.procedure_id && task.procedure_item_id && task.kind === "labor") {
    const [{ data: procedure }, { data: item }] = await Promise.all([
      sb.from("gw_procedures").select("id, kind, target_on, employee_id, drive_folders, advisor_shared_to").eq("id", task.procedure_id).eq("tenant_id", ctx.tenantId).maybeSingle(),
      sb.from("gw_procedure_items").select("id, title, share_with_advisor, status, advisor_review_note")
        .eq("id", task.procedure_item_id).eq("procedure_id", task.procedure_id).eq("tenant_id", ctx.tenantId).maybeSingle(),
    ]);
    if (procedure && item?.share_with_advisor) {
      sharedDriveLink = sharedAdvisorFolderLink(procedure, ctx.employee.email);
      procedureItem = { id: item.id, status: item.status, reviewNote: item.advisor_review_note || null };
      const [{ data: emp }, { data: rows }] = await Promise.all([
        sb.from("gw_employees").select("display_name").eq("id", procedure.employee_id).eq("tenant_id", ctx.tenantId).maybeSingle(),
        sb.from("gw_procedure_files").select("id, filename, mime_type, size_bytes, created_at")
          .eq("procedure_id", procedure.id).eq("item_id", item.id).order("created_at", { ascending: false }).limit(100),
      ]);
      subject = { name: emp?.display_name || "（対象者不明）", kind: procedure.kind === "onboarding" ? "入社" : "退職", targetOn: procedure.target_on || null };
      procedureFiles = rows || [];
    }
  }
  const canManage = canManageKind(ctx, task.kind, GW);
  const own = task.assignee_employee_id === ctx.employee.id;
  return json(res, 200, {
    task: { ...shapeTask(task, names.get(task.assignee_employee_id), subject, today), subject, canManage, canAct: canManage || own },
    checklist: checklist || [],
    comments: (comments || []).map((c) => ({ id: c.id, author: c.author_name || "専門家", body: c.body, at: c.created_at, mine: c.author_id === user.id })),
    events: (events || []).map((e) => ({ id: e.id, kind: e.kind, actor: e.actor_name || "—", detail: e.detail || null, at: e.created_at })),
    files: files || [], procedureFiles, sharedDriveLink,
    procedureItem,
    labels: { statuses: STATUSES, priorities: PRIORITIES },
  });
}

async function act(req, res, ctx, user, body) {
  const sb = admin();
  const action = String(body?.action || "");
  if (action === "create") return createTask(res, sb, ctx, user, body);
  if (!validId(body?.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const task = await must(sb.from("gw_professional_tasks").select(FIELDS).eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!task || !canSeeTask(ctx, user.id, task, GW)) return json(res, 404, { error: "not_found" });
  if (isAdvisor(ctx) && !await isSharedProcedureTask(sb, ctx.tenantId, task)) return json(res, 404, { error: "not_found" });
  if (action === "update") return updateTask(res, sb, ctx, user, task, body);
  if (action === "status") return setStatus(res, sb, ctx, user, task, body);
  if (action === "approve") return approve(res, sb, ctx, user, task);
  if (action === "request_resubmission") return requestResubmission(res, sb, ctx, user, task, body);
  if (action === "checklist") return setChecklist(res, sb, ctx, user, task, body);
  if (action === "comment") return comment(res, sb, ctx, user, task, body);
  return json(res, 400, { error: "invalid_action" });
}

async function createTask(res, sb, ctx, user, body) {
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind || !canManageKind(ctx, kind, GW)) return json(res, 403, { error: "forbidden" });
  const title = safeText(body.title, 200);
  const description = safeText(body.description, 2000);
  if (title.error || !title.value || description.error) return json(res, 400, { error: "invalid_text", hint: title.error || description.error || "タスク名を入れてください" });
  if (body.dueOn && !isDate(body.dueOn)) return json(res, 400, { error: "invalid_due_date" });
  const assigneeId = body.assigneeId ? String(body.assigneeId) : null;
  if (!assigneeId) return json(res, 400, { error: "assignee_required", hint: "担当者を選んでください" });
  if (!await assigneeAllowed(sb, ctx.tenantId, assigneeId, kind)) return json(res, 400, { error: "invalid_assignee", hint: "このタスク種別を担当できる専門家を選んでください" });
  const priority = PRIORITIES.includes(body.priority) ? body.priority : "normal";
  const now = new Date().toISOString();
  const task = await must(sb.from("gw_professional_tasks").insert({
    tenant_id: ctx.tenantId, kind, title: title.value, description: description.value,
    due_on: body.dueOn || null, priority, status: "open", assignee_employee_id: assigneeId,
    source: "manual", created_by: user.id,
  }).select(FIELDS).single());
  const items = cleanChecklist(body.checklist);
  if (items.length) await must(sb.from("gw_professional_task_checklist").insert(items.map((x, i) => ({ tenant_id: ctx.tenantId, task_id: task.id, title: x, position: i + 1 }))));
  await event(sb, ctx, user, task, "created", { kind });
  await notifyAssignee(sb, ctx, task, user, "新しいタスクが割り当てられました");
  return json(res, 200, { ok: true, id: task.id });
}

async function updateTask(res, sb, ctx, user, task, body) {
  if (!canManageKind(ctx, task.kind, GW)) return json(res, 403, { error: "forbidden" });
  const patch = { updated_at: new Date().toISOString() };
  const events = [];
  const changed = [];
  if (body.title !== undefined) {
    const x = safeText(body.title, 200);
    if (x.error || !x.value) return json(res, 400, { error: "invalid_text", hint: x.error || "タスク名を入れてください" });
    patch.title = x.value;
    if (x.value !== task.title) changed.push("title");
  }
  if (body.description !== undefined) {
    const x = safeText(body.description, 2000);
    if (x.error) return json(res, 400, { error: "invalid_text", hint: x.error });
    patch.description = x.value;
    if (x.value !== task.description) changed.push("description");
  }
  if (body.dueOn !== undefined) {
    if (body.dueOn && !isDate(body.dueOn)) return json(res, 400, { error: "invalid_due_date" });
    if ((body.dueOn || null) !== task.due_on) { patch.due_on = body.dueOn || null; events.push(["due", { to: patch.due_on }]); }
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return json(res, 400, { error: "invalid_priority" });
    patch.priority = body.priority;
    if (body.priority !== task.priority) changed.push("priority");
  }
  if (body.assigneeId !== undefined && (body.assigneeId || null) !== task.assignee_employee_id) {
    const next = body.assigneeId || null;
    if (!next || !await assigneeAllowed(sb, ctx.tenantId, next, task.kind)) return json(res, 400, { error: "invalid_assignee" });
    patch.assignee_employee_id = next;
    events.push(["assigned", { to: next }]);
  }
  await must(sb.from("gw_professional_tasks").update(patch).eq("id", task.id).eq("tenant_id", ctx.tenantId));
  if (changed.length) events.push(["edited", { fields: changed }]);
  for (const [kind, detail] of events) await event(sb, ctx, user, task, kind, detail);
  if (patch.assignee_employee_id) await notifyAssignee(sb, ctx, { ...task, ...patch }, user, "タスクの担当になりました");
  return json(res, 200, { ok: true });
}

async function setStatus(res, sb, ctx, user, task, body) {
  if (!STATUSES.includes(body.status)) return json(res, 400, { error: "invalid_status" });
  const manage = canManageKind(ctx, task.kind, GW);
  const own = task.assignee_employee_id === ctx.employee.id;
  if (!manage && !own) return json(res, 403, { error: "forbidden" });
  if (task.procedure_item_id && body.status === "done") return json(res, 409, { error: "use_approve", hint: "HRの進捗と揃えるため「確認済みにする」を使ってください" });
  if (task.kind === "labor" && own && !manage && !["in_progress", "submitted"].includes(body.status)) {
    return json(res, 403, { error: "forbidden", hint: "社労士タスクは確認中または確認結果の提出にできます" });
  }
  await must(sb.from("gw_professional_tasks").update({ status: body.status, updated_at: new Date().toISOString(),
    completed_at: ["done", "skipped"].includes(body.status) ? new Date().toISOString() : null,
    completed_by: ["done", "skipped"].includes(body.status) ? user.id : null,
  }).eq("id", task.id).eq("tenant_id", ctx.tenantId));
  await event(sb, ctx, user, task, "status", { from: task.status, to: body.status });
  if (["done", "returned", "submitted"].includes(body.status)) await notifyCreator(sb, ctx, task, user, `タスクの状態が「${body.status}」に変わりました`);
  return json(res, 200, { ok: true, status: body.status });
}

async function approve(res, sb, ctx, user, task) {
  if (!task.procedure_item_id || task.kind !== "labor" || !(isAdvisor(ctx) || canManageKind(ctx, "labor", GW))) return json(res, 403, { error: "forbidden" });
  const now = new Date().toISOString();
  const { data: item } = await sb.from("gw_procedure_items").select("id, share_with_advisor, status")
    .eq("id", task.procedure_item_id).eq("procedure_id", task.procedure_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!item?.share_with_advisor) return json(res, 404, { error: "not_found" });
  if (item.status !== "submitted") return json(res, 409, { error: "not_submitted", hint: "本人から提出された書類を確認してから操作してください" });
  await must(sb.from("gw_procedure_items").update({ status: "done", advisor_review_note: null,
    completed_at: now, completed_by: user.id, updated_at: now }).eq("id", item.id));
  await must(sb.from("gw_professional_tasks").update({ status: "done", completed_at: now, completed_by: user.id, updated_at: now })
    .eq("id", task.id).eq("tenant_id", ctx.tenantId));
  await syncProcedureState(sb, ctx, task.procedure_id);
  await event(sb, ctx, user, task, "approved", { itemId: item.id });
  await notifyProcedurePeople(sb, ctx, task, user, "提出書類を確認しました", "hr" );
  return json(res, 200, { ok: true, status: "done" });
}

async function requestResubmission(res, sb, ctx, user, task, body) {
  if (!task.procedure_item_id || task.kind !== "labor" || !(isAdvisor(ctx) || canManageKind(ctx, "labor", GW))) return json(res, 403, { error: "forbidden" });
  const note = safeText(body.note, 1000);
  if (note.error || !note.value) return json(res, 400, { error: "invalid_text", hint: note.error || "再提出してほしい内容を入力してください" });
  const now = new Date().toISOString();
  const { data: item } = await sb.from("gw_procedure_items").select("id, share_with_advisor, status")
    .eq("id", task.procedure_item_id).eq("procedure_id", task.procedure_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!item?.share_with_advisor) return json(res, 404, { error: "not_found" });
  if (item.status !== "submitted") return json(res, 409, { error: "not_submitted", hint: "本人から提出された書類を確認してから再提出を依頼してください" });
  await must(sb.from("gw_procedure_items").update({ status: "todo", advisor_review_note: note,
    document_id: null, submitted_at: null, completed_at: null, completed_by: null, updated_at: now }).eq("id", item.id));
  await must(sb.from("gw_professional_tasks").update({ status: "returned", completed_at: null, completed_by: null, updated_at: now })
    .eq("id", task.id).eq("tenant_id", ctx.tenantId));
  await syncProcedureState(sb, ctx, task.procedure_id);
  await event(sb, ctx, user, task, "returned", { itemId: item.id });
  await notifyProcedurePeople(sb, ctx, task, user, "提出書類の再提出をお願いします", "message", note);
  return json(res, 200, { ok: true, status: "returned" });
}

async function setChecklist(res, sb, ctx, user, task, body) {
  if (!canSeeTask(ctx, user.id, task, GW)) return json(res, 403, { error: "forbidden" });
  const id = String(body.itemId || "");
  const item = await must(sb.from("gw_professional_task_checklist").select("id, title")
    .eq("id", id).eq("task_id", task.id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!item) return json(res, 404, { error: "not_found" });
  const now = body.done ? new Date().toISOString() : null;
  await must(sb.from("gw_professional_task_checklist").update({ completed_at: now, completed_by: now ? user.id : null }).eq("id", item.id));
  await event(sb, ctx, user, task, "checklist", { itemId: item.id, done: Boolean(now) });
  return json(res, 200, { ok: true });
}

async function comment(res, sb, ctx, user, task, body) {
  const text = safeText(body.body, 2000);
  if (text.error || !text.value) return json(res, 400, { error: "invalid_text", hint: text.error || "コメントを入力してください" });
  const { data: author } = await sb.from("gw_employees").select("display_name").eq("id", ctx.employee.id).maybeSingle();
  const row = await must(sb.from("gw_professional_task_comments").insert({ tenant_id: ctx.tenantId, task_id: task.id,
    author_id: user.id, author_name: author?.display_name || "専門家", body: text.value }).select("id, author_name, body, created_at").single());
  await event(sb, ctx, user, task, "comment", { chars: text.value.length });
  await notifyCounterpart(sb, ctx, task, user, "タスクにコメントがありました");
  return json(res, 200, { comment: { id: row.id, author: row.author_name, body: row.body, at: row.created_at, mine: true } });
}

async function event(sb, ctx, user, task, kind, detail) {
  await sb.from("gw_professional_task_events").insert({ tenant_id: ctx.tenantId, task_id: task.id,
    kind, actor_id: user.id, actor_name: ctx.employee?.display_name || null, detail });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `professional_task.${kind}`,
    target: task.id, detail: { kind: task.kind, status: task.status, ...detail } });
}

async function notifyAssignee(sb, ctx, task, user, title) {
  if (!task.assignee_employee_id || task.assignee_employee_id === ctx.employee.id) return;
  await notify([{ tenantId: ctx.tenantId, employeeId: task.assignee_employee_id, kind: "task_assigned", title,
    body: task.title, link: "/office/professionals.html", dedupeKey: `professional-task:${task.id}` }]);
}
async function notifyCreator(sb, ctx, task, user, title) {
  if (!task.created_by || task.created_by === user.id) return;
  const employee = await employeeForUser(sb, ctx.tenantId, task.created_by);
  if (employee) await notify([{ tenantId: ctx.tenantId, employeeId: employee, kind: "task_assigned", title,
    body: task.title, link: "/office/professionals.html", dedupeKey: `professional-task:${task.id}` }]);
}
async function notifyCounterpart(sb, ctx, task, user, title) {
  if (task.assignee_employee_id && task.assignee_employee_id !== ctx.employee.id) {
    await notify([{ tenantId: ctx.tenantId, employeeId: task.assignee_employee_id, kind: "message", title,
      body: task.title, link: "/office/professionals.html", dedupeKey: `professional-comment:${task.id}` }]);
  }
  await notifyCreator(sb, ctx, task, user, title);
}
async function notifyProcedurePeople(sb, ctx, task, user, title, kind = "message", note = "") {
  const { data: procedure } = await sb.from("gw_procedures").select("employee_id, kind").eq("id", task.procedure_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!procedure) return;
  await notify([{ tenantId: ctx.tenantId, employeeId: procedure.employee_id, kind,
    title, body: note || task.title, link: procedure.kind === "offboarding" ? "/retiree/" : "/onboarding/",
    dedupeKey: `professional-review:${task.id}` }]);
  const roles = await sb.from("gw_role_grants").select("employee_id").eq("tenant_id", ctx.tenantId).in("role", ["hr", "owner"]).limit(200);
  const targets = [...new Set((roles.data || []).map((r) => r.employee_id).filter((id) => id !== ctx.employee.id))];
  if (targets.length) await notify(targets.map((employeeId) => ({ tenantId: ctx.tenantId, employeeId, kind: "message",
    title, body: task.title, link: "/office/professionals.html", dedupeKey: `professional-review:${task.id}` })));
}
async function employeeForUser(sb, tenantId, userId) {
  const { data } = await sb.from("gw_employees").select("id").eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  return data?.id || null;
}
async function assigneeAllowed(sb, tenantId, employeeId, kind) {
  const { data: employee } = await sb.from("gw_employees").select("id, status").eq("id", employeeId).eq("tenant_id", tenantId).in("status", ["active", "invited"]).maybeSingle();
  if (!employee) return false;
  const { data: roles } = await sb.from("gw_role_grants").select("role").eq("tenant_id", tenantId).eq("employee_id", employeeId).limit(100);
  return validateAssigneeRole(roles, kind);
}
async function listTaskEmployees(sb, tenantId, tasks) {
  const ids = [...new Set((tasks || []).map((t) => t.assignee_employee_id).filter(Boolean))];
  if (!ids.length) return [];
  return must(sb.from("gw_employees").select("id, display_name").eq("tenant_id", tenantId).in("id", ids).limit(300));
}

async function listTaskProcedures(sb, tenantId, tasks) {
  const ids = [...new Set((tasks || []).map((t) => t.procedure_id).filter(Boolean))];
  if (!ids.length) return [];
  const procedures = await must(sb.from("gw_procedures").select("id, kind, target_on, employee_id").eq("tenant_id", tenantId).in("id", ids).limit(300));
  const employees = await listTaskEmployees(sb, tenantId, procedures.map((p) => ({ assignee_employee_id: p.employee_id })));
  const names = new Map((employees || []).map((e) => [e.id, e]));
  return (procedures || []).map((p) => ({ ...p, employee: names.get(p.employee_id) || null }));
}

async function syncProcedureState(sb, ctx, procedureId) {
  const { data: procedure } = await sb.from("gw_procedures").select("id, kind, target_on")
    .eq("id", procedureId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!procedure) return;
  if (procedure.kind === "onboarding") {
    await advance(sb, ctx, procedure.id);
    return;
  }
  const { data: items } = await sb.from("gw_procedure_items").select("owner, status, phase, sort_order, title")
    .eq("procedure_id", procedure.id).eq("tenant_id", ctx.tenantId).limit(300);
  const phase = phaseOf(procedure.kind, procedure.target_on, items || [], jstDate());
  await sb.from("gw_procedures").update({ phase, status: phase === "done" ? "done" : "in_progress", updated_at: new Date().toISOString() })
    .eq("id", procedure.id).eq("tenant_id", ctx.tenantId);
}

async function ensureDefaultTemplates(sb, tenantId, userId) {
  const defaults = [
    { system_key: "monthly_source_review", title: "前月分の会計資料を確認", due_day: 10,
      description: "前月分の会計資料を確認し、不足や確認事項をまとめます。", checklist: ["資料の受領状況を確認", "不足資料・質問を整理", "会社へ確認事項を連絡"] },
    { system_key: "monthly_trial_balance", title: "月次試算表を確認", due_day: 15,
      description: "前月分の試算表と残高を確認します。", checklist: ["試算表を確認", "残高の差異・未処理を確認", "確認結果を会社へ共有"] },
    { system_key: "monthly_report", title: "月次報告・相談事項をまとめる", due_day: 20,
      description: "月次の報告と次回の相談事項をまとめます。", checklist: ["月次報告を作成", "相談事項を整理", "共有・打合せ日を確認"] },
  ];
  const { data } = await sb.from("gw_professional_task_templates").select("system_key").eq("tenant_id", tenantId).limit(100);
  const have = new Set((data || []).map((r) => r.system_key));
  const missing = defaults.filter((r) => !have.has(r.system_key)).map((r) => ({ ...r, tenant_id: tenantId, is_active: false, created_by: userId, updated_by: userId }));
  if (missing.length) await sb.from("gw_professional_task_templates").upsert(missing, { onConflict: "tenant_id,system_key", ignoreDuplicates: true });
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
