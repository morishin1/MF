// GET    /api/tasks?scope=mine|all   … やること一覧（見える範囲は RLS が決める）
// POST   /api/tasks                  … 作成（管理者・人事）
// PATCH  /api/tasks {id, ...}        … 更新
//          管理者・人事 … すべての項目
//          担当者       … status のみ（他の列は無視する）
// DELETE /api/tasks?id=...           … 削除（管理者・人事）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";

const PRIORITIES = ["low", "normal", "high"];
const STATUSES = ["todo", "doing", "done", "cancelled"];

const FIELDS =
  "id, tenant_id, title, body, assignee_id, escalate_to, due_on, priority, status, category, completed_at, created_at, updated_at";
const WITH_NAMES =
  `${FIELDS}, assignee:gw_employees!gw_tasks_assignee_id_fkey(id, display_name, department)`;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const scope = new URL(req.url, "http://localhost").searchParams.get("scope") || "all";

    let q = sb.from("gw_tasks").select(WITH_NAMES).eq("tenant_id", ctx.tenantId);
    // 自分の担当だけに絞る。RLS は「関係するもの」まで見せるので、ここで更に絞る
    if (scope === "mine") {
      if (!ctx.employee) return json(res, 200, { tasks: [], canManage: canManageHr(ctx) });
      q = q.eq("assignee_id", ctx.employee.id);
    }
    const { data, error } = await q
      .order("status", { ascending: true })
      .order("due_on", { ascending: true, nullsFirst: false })
      .limit(300);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    return json(res, 200, {
      tasks: data || [],
      canManage: canManageHr(ctx),
      me: ctx.employee,
    });
  }

  if (req.method === "POST") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.title) return json(res, 400, { error: "invalid_body", detail: "title は必須です" });

    const { data, error } = await sb
      .from("gw_tasks")
      .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
      .select(WITH_NAMES)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    return json(res, 200, { task: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

    // 管理者・人事はそのまま。RLS が可否を決める
    if (canManageHr(ctx)) {
      const row = normalize(body, { partial: true });
      if (row.error) return json(res, 400, row);
      const patch = withCompletion(row.value);

      const { data, error } = await sb
        .from("gw_tasks")
        .update(patch)
        .eq("id", body.id)
        .eq("tenant_id", ctx.tenantId)
        .select(WITH_NAMES)
        .maybeSingle();
      if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
      if (!data) return json(res, 404, { error: "task_not_found" });
      return json(res, 200, { task: data });
    }

    // 担当者本人は status だけ変えられる。
    // RLS では列を絞れないので、ここで service_role を使い、変更対象を限定する。
    if (!ctx.employee) return json(res, 403, { error: "forbidden" });
    if (!STATUSES.includes(body.status)) return json(res, 400, { error: "invalid_status", detail: STATUSES.join(", ") });

    const sbAdmin = admin();
    const { data: task, error: qe } = await sbAdmin
      .from("gw_tasks")
      .select("id, assignee_id")
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (qe) return json(res, 500, { error: "db_query_failed", detail: qe.message });
    if (!task) return json(res, 404, { error: "task_not_found" });
    if (task.assignee_id !== ctx.employee.id) return json(res, 403, { error: "not_your_task" });

    const { data, error } = await sbAdmin
      .from("gw_tasks")
      .update(withCompletion({ status: body.status }))
      .eq("id", body.id)
      .select(FIELDS)
      .single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    return json(res, 200, { task: data });
  }

  if (req.method === "DELETE") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await sb
      .from("gw_tasks")
      .delete()
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "task_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// 完了に変わったときだけ完了日時を入れ、戻したら消す
function withCompletion(patch) {
  const out = { ...patch, updated_at: new Date().toISOString() };
  if (out.status === "done") out.completed_at = new Date().toISOString();
  else if (out.status) out.completed_at = null;
  return out;
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("title")) v.title = String(body.title ?? "").trim();
  if (has("body")) v.body = body.body ? String(body.body) : null;
  if (has("assigneeId")) v.assignee_id = body.assigneeId || null;
  if (has("escalateTo")) v.escalate_to = body.escalateTo || null;
  if (has("dueOn")) v.due_on = body.dueOn || null;
  if (has("category")) v.category = body.category ? String(body.category).trim() : null;
  if (has("priority")) {
    if (!PRIORITIES.includes(body.priority)) return { error: "invalid_priority", detail: PRIORITIES.join(", ") };
    v.priority = body.priority;
  }
  if (has("status")) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_status", detail: STATUSES.join(", ") };
    v.status = body.status;
  }
  return { value: v };
}
