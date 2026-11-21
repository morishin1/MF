import { docByTitle, docOf } from "./onboard-docs.js";
import { notify } from "./notify.js";
import { gwLog } from "./gw-audit.js";

export const KINDS = ["labor", "tax"];
export const STATUSES = ["open", "in_progress", "submitted", "returned", "done", "skipped"];
export const PRIORITIES = ["high", "normal", "low"];
export const TITLE_MAX = 200;

export function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return false;
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(y, month - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function safeText(value, max = 2000) {
  const text = String(value ?? "").trim().slice(0, max);
  // 個人番号をコメント・タスク文面に紛れ込ませない。空白やハイフンを挟んだ12桁も拒否する。
  // 13桁の適格請求書登録番号など、別形式の番号は誤って止めない。
  if (/(?:^|\D)(?:\d[\s-]?){11}\d(?:\D|$)/.test(text)) return { error: "個人番号はこのタスクに入力できません" };
  return { value: text || null };
}

export const isAdvisor = (ctx) => Boolean(ctx?.isAdvisor || (ctx?.roles || []).includes("labor_advisor"));
export const isTaxAdvisor = (ctx) => Boolean(ctx?.isTaxAdvisor || (ctx?.roles || []).includes("tax_advisor"));

export function canViewKind(ctx, kind, gw) {
  if (kind === "labor") return Boolean(ctx?.isAdmin || gw.canManageHr(ctx) || isAdvisor(ctx));
  if (kind === "tax") return Boolean(ctx?.isAdmin || gw.canOfficeFinance(ctx) || gw.canAccessOffice(ctx) || isTaxAdvisor(ctx));
  return false;
}

export function canManageKind(ctx, kind, gw) {
  if (kind === "labor") return Boolean(ctx?.isAdmin || gw.canManageHr(ctx));
  if (kind === "tax") return Boolean(ctx?.isAdmin || gw.canOfficeFinance(ctx) || gw.canAccessOffice(ctx));
  return false;
}

export function canUsePortal(ctx, gw) {
  return KINDS.some((kind) => canViewKind(ctx, kind, gw));
}

export function canSeeTask(ctx, userId, task, gw) {
  if (!canViewKind(ctx, task?.kind, gw)) return false;
  return canManageKind(ctx, task.kind, gw)
    || (task.assignee_employee_id && task.assignee_employee_id === ctx?.employee?.id)
    || task.created_by === userId;
}

export function isSensitiveProcedureItem(item) {
  const doc = docOf(item?.item_key) || docByTitle(item?.title);
  return Boolean(doc?.sensitive || doc?.collect === false
    || /マイナンバー|個人番号|個人番号カード|通知カード/i.test(String(item?.title || "")));
}

export function sharedAdvisorFolderLink(procedure, viewerEmail) {
  const folderId = procedure?.drive_folders?.["04"];
  const sharedTo = String(procedure?.advisor_shared_to || "").toLowerCase();
  const viewer = String(viewerEmail || "").toLowerCase();
  if (!folderId || !sharedTo || !viewer || sharedTo !== viewer || !/^[A-Za-z0-9_-]{10,}$/.test(String(folderId))) return null;
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export async function isSharedProcedureTask(sb, tenantId, task) {
  if (!task?.procedure_item_id) return true;
  const { data } = await sb.from("gw_procedure_items").select("share_with_advisor, item_key, title")
    .eq("id", task.procedure_item_id).eq("procedure_id", task.procedure_id).eq("tenant_id", tenantId).maybeSingle();
  return Boolean(data?.share_with_advisor && !isSensitiveProcedureItem(data));
}

export function mayActOnTask(ctx, userId, task, gw) {
  return canSeeTask(ctx, userId, task, gw);
}

export function validateAssigneeRole(roleRows, kind) {
  const role = kind === "labor" ? "labor_advisor" : "tax_advisor";
  return (roleRows || []).some((r) => r.role === role);
}

export function shapeTask(task, employeeName, subject, today) {
  const overdue = task.status !== "done" && task.status !== "skipped" && task.due_on && task.due_on < today;
  return {
    id: task.id, kind: task.kind, title: task.title, description: task.description || null,
    dueOn: task.due_on || null, priority: task.priority, status: task.status,
    assigneeId: task.assignee_employee_id || null, assigneeName: employeeName || null,
    source: task.source, subject, overdue: Boolean(overdue),
    overdueDays: overdue ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${task.due_on}T00:00:00Z`)) / 86400000) : 0,
    createdAt: task.created_at, updatedAt: task.updated_at,
  };
}

/**
 * 本人が共有対象の入社・退社書類を提出した時点で、社労士の確認タスクを同期する。
 * 既存の hr バケットと share_with_advisor を使い、書類本体の複製はしない。
 */
export async function syncProcedureTask(sb, { tenantId, itemId, actorId = null }) {
  if (!tenantId || !itemId) return { skipped: "missing_id" };
  const { data: item, error: ie } = await sb.from("gw_procedure_items")
    .select("id, tenant_id, procedure_id, item_key, title, status, due_on, share_with_advisor")
    .eq("id", itemId).eq("tenant_id", tenantId).maybeSingle();
  if (ie || !item) return { skipped: "item_unavailable" };
  if (!item.share_with_advisor) return { skipped: "not_shared" };

  if (isSensitiveProcedureItem(item)) return { skipped: "sensitive_document" };

  const { data: procedure, error: pe } = await sb.from("gw_procedures")
    .select("id, tenant_id, kind, employee_id, target_on")
    .eq("id", item.procedure_id).eq("tenant_id", tenantId).maybeSingle();
  if (pe || !procedure || !["onboarding", "offboarding"].includes(procedure.kind)) return { skipped: "procedure_unavailable" };

  const existingResult = await sb.from("gw_professional_tasks")
    .select("id, status, assignee_employee_id")
    .eq("procedure_item_id", item.id).eq("tenant_id", tenantId).maybeSingle();
  if (existingResult.error) return { error: existingResult.error };
  if (!existingResult.data && item.status !== "submitted") return { skipped: "not_submitted" };
  if (!["submitted", "done"].includes(item.status)) {
    if (!existingResult.data) return { skipped: "not_submitted" };
    const status = item.status === "na" ? "skipped" : "open";
    const { data: reset, error } = await sb.from("gw_professional_tasks").update({
      status, completed_at: null, completed_by: null, updated_at: new Date().toISOString(),
    }).eq("id", existingResult.data.id).eq("tenant_id", tenantId).select("id, status, assignee_employee_id").single();
    return error ? { error } : { task: reset, created: false };
  }
  let assignee = existingResult.data?.assignee_employee_id || null;
  if (!assignee) {
    const { data: grants } = await sb.from("gw_role_grants").select("employee_id")
      .eq("tenant_id", tenantId).eq("role", "labor_advisor").limit(100);
    const ids = (grants || []).map((r) => r.employee_id).filter(Boolean);
    if (ids.length) {
      const { data: people } = await sb.from("gw_employees").select("id, status, display_name")
        .eq("tenant_id", tenantId).in("id", ids).in("status", ["active", "invited"]).order("display_name").limit(100);
      assignee = people?.[0]?.id || null;
    }
  }

  const now = new Date().toISOString();
  const patch = {
    kind: "labor", title: `書類の確認：${String(item.title || "提出書類").slice(0, 180)}`,
    description: "本人が入社・退社手続きの書類を提出しました。共有された書類を確認してください。",
    due_on: item.due_on || procedure.target_on || null, priority: "normal",
    status: item.status === "done" ? "done" : "submitted",
    assignee_employee_id: assignee,
    procedure_id: procedure.id, procedure_item_id: item.id, source: "procedure",
    source_key: `procedure-item:${item.id}`, updated_at: now,
    ...(item.status === "done" ? { completed_at: now, completed_by: actorId || null } : { completed_at: null, completed_by: null }),
  };
  if (existingResult.data) {
    const { data: updated, error } = await sb.from("gw_professional_tasks").update(patch)
      .eq("id", existingResult.data.id).eq("tenant_id", tenantId).select("id, status, assignee_employee_id").single();
    if (error) return { error };
    if (existingResult.data.status !== updated.status) {
      await sb.from("gw_professional_task_events").insert({ tenant_id: tenantId, task_id: updated.id,
        kind: "status", actor_id: actorId, detail: { from: existingResult.data.status, to: updated.status, source: "procedure_sync" } });
      if (actorId) await gwLog({ tenantId, actorId, action: "professional_task.status", target: updated.id,
        detail: { kind: "labor", from: existingResult.data.status, to: updated.status, source: "procedure_sync" } });
    }
    if (updated.status === "submitted" && (existingResult.data.status !== "submitted"
      || updated.assignee_employee_id !== existingResult.data.assignee_employee_id) && updated.assignee_employee_id) {
      await notify([{ tenantId, employeeId: updated.assignee_employee_id, kind: "task_assigned",
        title: "入退社の提出書類が届きました", body: `確認してください：${item.title}`,
        link: "/office/professionals.html?tab=labor", dedupeKey: `professional-task:${updated.id}` }]);
    }
    return { task: updated, created: false };
  }

  const { data: created, error } = await sb.from("gw_professional_tasks")
    .insert({ ...patch, tenant_id: tenantId, created_by: actorId || null }).select("id, status, assignee_employee_id").single();
  if (error) {
    // 同時に二つのアップロード完了通知が来たときも、部分一意制約を最終防衛線にする。
    const { data: raced } = await sb.from("gw_professional_tasks")
      .select("id, status, assignee_employee_id").eq("procedure_item_id", item.id).eq("tenant_id", tenantId).maybeSingle();
    if (raced) return { task: raced, created: false };
    return { error };
  }
  await sb.from("gw_professional_task_checklist").insert([
    { tenant_id: tenantId, task_id: created.id, title: "共有書類を確認する", position: 1 },
    { tenant_id: tenantId, task_id: created.id, title: "確認結果を本人・人事へ伝える", position: 2 },
  ]);
  await sb.from("gw_professional_task_events").insert({
    tenant_id: tenantId, task_id: created.id, kind: "created", actor_id: actorId,
    detail: { source: "procedure", itemId: item.id },
  });
  if (created.assignee_employee_id) await notify([{ tenantId, employeeId: created.assignee_employee_id, kind: "task_assigned",
    title: "入退社の提出書類が届きました", body: `確認してください：${item.title}`,
    link: "/office/professionals.html?tab=labor", dedupeKey: `professional-task:${created.id}` }]);
  return { task: created, created: true };
}

export function monthDate(year, month, day) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

export async function generateTaxTasks(sb, tenantId, { from, to }) {
  const { data: masters, error: me } = await sb.from("gw_professional_task_templates")
    .select("id, title, description, due_day, assignee_employee_id, checklist, created_by")
    .eq("tenant_id", tenantId).eq("is_active", true).limit(500);
  if (me) throw me;
  const made = [];
  for (const master of masters || []) {
    let year = Number(from.slice(0, 4));
    let month = Number(from.slice(5, 7));
    const endYear = Number(to.slice(0, 4));
    const endMonth = Number(to.slice(5, 7));
    for (let guard = 0; guard < 36 && (year < endYear || (year === endYear && month <= endMonth)); guard++) {
      const due = monthDate(year, month, Number(master.due_day) || 10);
      if (due >= from && due <= to) {
        const sourceKey = `tax-recurring:${master.id}:${due.slice(0, 7)}`;
        const { data: task, error } = await sb.from("gw_professional_tasks").insert({
          tenant_id: tenantId, kind: "tax", title: master.title, description: master.description,
          due_on: due, assignee_employee_id: master.assignee_employee_id || null,
          template_id: master.id, source: "recurring", source_key: sourceKey,
          status: "open", priority: "normal", created_by: master.created_by || null,
        }).select("id, title, due_on, assignee_employee_id").single();
        if (error) {
          if (error.code === "23505") { /* 画面と cron が同時に作る場合。既存分として扱う */ }
          else throw error;
        } else if (task) {
          made.push(task);
          const items = (Array.isArray(master.checklist) ? master.checklist : [])
            .map((x, i) => ({ title: String(x || "").trim().slice(0, 300), position: i + 1 }))
            .filter((x) => x.title).slice(0, 30);
          if (items.length) await sb.from("gw_professional_task_checklist").insert(items.map((x) => ({ ...x, tenant_id: tenantId, task_id: task.id })));
          await sb.from("gw_professional_task_events").insert({ tenant_id: tenantId, task_id: task.id, kind: "created", detail: { source: "recurring" } });
        }
      }
      month++; if (month > 12) { month = 1; year++; }
    }
  }
  return made;
}

/**
 * GWの入社届出を社労士タスクに連携する。
 * 住所・保険番号等をタスク/通知へ複写しない。認可済み詳細画面で都度参照する。
 * マイナンバー、給与口座、緊急連絡先は社労士向け概要の対象外。
 */
export function onboardingAdvisorEmployeeId(task) {
  if (task?.kind !== "labor" || task?.source !== "manual") return null;
  const match = /^onboard-profile:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(task?.source_key || ""));
  return match?.[1] || null;
}

async function availableLaborAdvisor(sb, tenantId) {
  const { data: grants, error } = await sb.from("gw_role_grants")
    .select("employee_id").eq("tenant_id", tenantId).eq("role", "labor_advisor").limit(100);
  if (error) throw error;
  const ids = [...new Set((grants || []).map((g) => g.employee_id).filter(Boolean))];
  if (!ids.length) return null;
  const { data: people, error: pe } = await sb.from("gw_employees")
    .select("id").eq("tenant_id", tenantId).in("id", ids)
    .in("status", ["active", "invited"]).order("display_name").limit(1);
  if (pe) throw pe;
  return people?.[0]?.id || null;
}

export async function syncOnboardingProfileTask(sb, { tenantId, employeeId, actorId = null }) {
  if (!tenantId || !employeeId) return { skipped: "missing_id" };
  const { data: profile, error: pe } = await sb.from("gw_onboard_profiles")
    .select("employee_id,status,submitted_at")
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).maybeSingle();
  if (pe) throw pe;
  // 入力途中の保存は送らない。本人が必要な同意を終えて「提出」した事実が条件。
  if (profile?.status !== "submitted") return { skipped: "not_submitted" };
  const { data: employee, error: ee } = await sb.from("gw_employees")
    .select("id,joined_on").eq("tenant_id", tenantId).eq("id", employeeId).maybeSingle();
  if (ee) throw ee;
  if (!employee) return { skipped: "employee_unavailable" };

  const sourceKey = `onboard-profile:${employeeId}`;
  const { data: existing, error: te } = await sb.from("gw_professional_tasks")
    .select("id,status,assignee_employee_id,due_on")
    .eq("tenant_id", tenantId).eq("source_key", sourceKey).maybeSingle();
  if (te) throw te;
  const assignee = existing?.assignee_employee_id || await availableLaborAdvisor(sb, tenantId);
  const notifyAdvisor = async (taskId, assignment) => {
    if (!assignment) return false;
    try {
      // 通知には個人情報を含めず、MFAを要求する専用画面へ遷移させる。
      await notify([{ tenantId, employeeId: assignment, kind: "task_assigned",
        title: "入社情報が提出されました", body: "GWにログインして内容をご確認ください。",
        link: `/office/professionals.html?tab=labor&taskId=${encodeURIComponent(taskId)}`,
        dedupeKey: `professional-task:${taskId}:profile:${profile.submitted_at || "submitted"}` }]);
      return true;
    } catch (error) {
      console.error("[professional-tasks] onboarding advisor notification failed:", error?.message || error);
      return false;
    }
  };
  if (existing) {
    const reopened = ["done", "skipped", "returned"].includes(existing.status);
    const patch = {};
    if (!existing.assignee_employee_id && assignee) patch.assignee_employee_id = assignee;
    if (reopened) {
      patch.status = "open";
      patch.completed_at = null;
      patch.completed_by = null;
    }
    if ((existing.due_on || null) !== (employee.joined_on || null)) patch.due_on = employee.joined_on || null;
    if (!Object.keys(patch).length) return { task: existing, created: false, assigned: Boolean(assignee), notified: false };
    patch.updated_at = new Date().toISOString();
    const { data: updated, error } = await sb.from("gw_professional_tasks")
      .update(patch).eq("tenant_id", tenantId).eq("id", existing.id)
      .select("id,status,assignee_employee_id").single();
    if (error) throw error;
    if (reopened) {
      await sb.from("gw_professional_task_events").insert({ tenant_id: tenantId, task_id: updated.id,
        kind: "status", actor_id: actorId, detail: { from: existing.status, to: "open", source: "onboarding_profile" } });
    }
    const informed = Boolean(assignee && (reopened || !existing.assignee_employee_id));
    const notified = informed ? await notifyAdvisor(updated.id, assignee) : false;
    return { task: updated, created: false, assigned: Boolean(assignee), notified };
  }
  const { data: created, error } = await sb.from("gw_professional_tasks").insert({
    tenant_id: tenantId, kind: "labor",
    title: "入社届出の確認・社会保険手続き",
    description: "本人がGWの入社情報を提出しました。必要項目を確認し、手続きの要否と不足情報をOfficeにお知らせください。",
    due_on: employee.joined_on || null, priority: "normal", status: "open",
    assignee_employee_id: assignee, source: "manual", source_key: sourceKey, created_by: actorId,
  }).select("id,status,assignee_employee_id").single();
  if (error) {
    // 同時提出でも1名につき1件。DBの一意制約を正とする。
    if (error.code === "23505") {
      const { data: raced } = await sb.from("gw_professional_tasks")
        .select("id,status,assignee_employee_id").eq("tenant_id", tenantId).eq("source_key", sourceKey).maybeSingle();
      if (raced) return { task: raced, created: false, assigned: Boolean(raced.assignee_employee_id), notified: false };
    }
    throw error;
  }
  await sb.from("gw_professional_task_checklist").insert([
    { tenant_id: tenantId, task_id: created.id, title: "届出内容と不足項目を確認する", position: 1 },
    { tenant_id: tenantId, task_id: created.id, title: "手続き要否・結果をOfficeに報告する", position: 2 },
  ]);
  await sb.from("gw_professional_task_events").insert({
    tenant_id: tenantId, task_id: created.id, kind: "created", actor_id: actorId,
    detail: { source: "onboarding_profile" },
  });
  const notified = await notifyAdvisor(created.id, assignee);
  return { task: created, created: true, assigned: Boolean(assignee), notified };
}
