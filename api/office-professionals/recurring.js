// GET  /api/office-professionals/recurring
// POST /api/office-professionals/recurring { action: create|update|active, ... }

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import * as GW from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { requireMfa } from "../../lib/mfa.js";
import { gwLog } from "../../lib/gw-audit.js";
import { canManageKind, safeText, validateAssigneeRole } from "../../lib/professional-tasks.js";

const SQL = "db/146_office_professional_tasks.sql";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const checklistOf = (v) => (Array.isArray(v) ? v : []).slice(0, 30).map((x) => safeText(x, 300))
  .filter((x) => x.value && !x.error).map((x) => x.value);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await GW.gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee || !canManageKind(ctx, "tax", GW)) return json(res, 403, { error: "forbidden" });
  if (!(await requireMfa(req, res, ctx, user))) return;
  const sb = admin();
  try {
    if (req.method === "GET") {
      const rows = await must(sb.from("gw_professional_task_templates").select("id, title, description, due_day, assignee_employee_id, checklist, is_active, system_key, created_at, updated_at")
        .eq("tenant_id", ctx.tenantId).order("due_day").order("created_at").limit(200));
      const ids = [...new Set((rows || []).map((r) => r.assignee_employee_id).filter(Boolean))];
      const employees = ids.length ? await must(sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).in("id", ids).limit(200)) : [];
      const names = new Map((employees || []).map((e) => [e.id, e.display_name]));
      return json(res, 200, { templates: (rows || []).map((r) => ({ ...r, assigneeName: names.get(r.assignee_employee_id) || null })) });
    }
    if (req.method === "POST") return await act(req, res, sb, ctx, user, await readJson(req));
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office-professionals/recurring]", e?.message || e);
    return json(res, 500, { error: "professional_template_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function act(req, res, sb, ctx, user, body) {
  const now = new Date().toISOString();
  if (body?.action === "active") {
    const current = body.id ? await must(sb.from("gw_professional_task_templates").select("id, system_key")
      .eq("id", String(body.id)).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
    if (!current) return json(res, 404, { error: "not_found" });
    if (body.active === true) {
      const template = await must(sb.from("gw_professional_task_templates").select("assignee_employee_id")
        .eq("id", current.id).eq("tenant_id", ctx.tenantId).maybeSingle());
      if (!template?.assignee_employee_id || !await assigneeIsTaxAdvisor(sb, ctx.tenantId, template.assignee_employee_id)) {
        return json(res, 400, { error: "assignee_required", hint: "定例タスクを自動作成する前に、税理士の担当者を選んでください" });
      }
    }
    await must(sb.from("gw_professional_task_templates").update({ is_active: body.active === true, updated_by: user.id, updated_at: now })
      .eq("id", current.id).eq("tenant_id", ctx.tenantId));
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "professional_template.active", target: current.id,
      detail: { active: body.active === true } });
    return json(res, 200, { ok: true, active: body.active === true });
  }

  if (!["create", "update"].includes(body?.action)) return json(res, 400, { error: "invalid_action" });
  const title = safeText(body.title, 200);
  const description = safeText(body.description, 2000);
  const dueDay = Number(body.dueDay);
  if (title.error || !title.value || description.error || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    return json(res, 400, { error: "invalid_template", hint: title.error || description.error || "業務名と毎月の期限日を入力してください" });
  }
  const assigneeId = body.assigneeId ? String(body.assigneeId) : null;
  const existing = body.action === "update" && body.id ? await must(sb.from("gw_professional_task_templates").select("id, system_key, is_active")
    .eq("id", String(body.id)).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  if (body.action === "update" && !existing) return json(res, 404, { error: "not_found" });
  const willBeActive = body.action === "create" ? body.active === true : Boolean(existing?.is_active);
  if (willBeActive && !assigneeId) return json(res, 400, { error: "assignee_required", hint: "有効な定例業務には担当の税理士を設定してください" });
  if (assigneeId && !await assigneeIsTaxAdvisor(sb, ctx.tenantId, assigneeId)) {
    return json(res, 400, { error: "invalid_assignee", hint: "税理士の担当者を選んでください" });
  }
  const patch = {
    tenant_id: ctx.tenantId, title: title.value, description: description.value,
    due_day: dueDay, assignee_employee_id: assigneeId, checklist: checklistOf(body.checklist),
    updated_by: user.id, updated_at: now,
  };
  let row;
  if (body.action === "create") {
    row = await must(sb.from("gw_professional_task_templates").insert({ ...patch, is_active: body.active === true, created_by: user.id })
      .select("id, title, description, due_day, assignee_employee_id, checklist, is_active, system_key").single());
  } else {
    row = await must(sb.from("gw_professional_task_templates").update(patch).eq("id", existing.id).eq("tenant_id", ctx.tenantId)
      .select("id, title, description, due_day, assignee_employee_id, checklist, is_active, system_key").single());
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `professional_template.${body.action}`, target: row.id,
    detail: { dueDay, active: row.is_active } });
  return json(res, 200, { template: row });
}

async function assigneeIsTaxAdvisor(sb, tenantId, employeeId) {
  const [{ data: employee }, { data: roles }] = await Promise.all([
    sb.from("gw_employees").select("id").eq("id", employeeId).eq("tenant_id", tenantId).in("status", ["active", "invited"]).maybeSingle(),
    sb.from("gw_role_grants").select("role").eq("tenant_id", tenantId).eq("employee_id", employeeId).limit(100),
  ]);
  return Boolean(employee && validateAssigneeRole(roles, "tax"));
}
