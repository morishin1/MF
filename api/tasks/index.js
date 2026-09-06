// GET    /api/tasks?scope=mine|all   … やること一覧（見える範囲は RLS が決める）
//          scope=mine のときは、業務タスクだけでなく
//          「日報で決めた次にやること」と「入社手続きの提出物」も混ぜて返す。
//
//          ■ なぜ混ぜるのか
//            いま自分が対応すべきものが3か所に散っていると、
//            どれかを必ず見落とす。入口を1つにする。
//            入社手続きのように一時期しか使わないものに専用メニューを作らず、
//            ここに出して、終われば自然に消えるようにする。
// POST   /api/tasks                  … 作成（管理者・人事）
// PATCH  /api/tasks {id, ...}        … 更新
//          管理者・人事 … すべての項目
//          担当者       … status のみ（他の列は無視する）
// DELETE /api/tasks?id=...           … 削除（管理者・人事）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { notifySlack } from "../../lib/slack.js";

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
      // 自分の画面のときだけ、他から来る「やること」も足す
      extras: scope === "mine" ? await extrasFor(ctx, user.id) : { actions: [], onboarding: [] },
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

    if (data.assignee_id) {
      await notifySlack({
        text: `:white_square_button: タスクを割り当て　${data.assignee?.display_name || ""}`,
        lines: [data.title, data.due_on ? `期限 ${data.due_on}` : null],
        link: "tasks.html",
      });
    }
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

/**
 * 業務タスク以外の「やること」。
 *
 *   actions    … 日報で決めた次にやること（gw_action_items）
 *   onboarding … 入社手続きのうち、本人が出すもの（gw_procedure_items）
 *
 * どちらも開いているものだけ返す。
 * 入社手続きは、手続き自体が完了になった時点で1件も返らなくなる。
 * 「終わったら自動で消える」を、消す処理ではなく問い合わせの条件で作る。
 * 消す処理にすると、消し忘れたときに残り続ける。
 */
async function extrasFor(ctx, userId) {
  const out = { actions: [], onboarding: [] };
  if (!ctx.employee) return out;

  const sb = admin();

  const [items, proc] = await Promise.all([
    sb.from("gw_action_items")
      .select("id, title, detail, source, due_date, priority, status")
      .eq("user_id", userId)
      .eq("status", "open")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("priority")
      .limit(30),
    sb.from("gw_procedures")
      .select("id, status, target_on")
      .eq("employee_id", ctx.employee.id).eq("kind", "onboarding").maybeSingle(),
  ]);

  out.actions = (items.data || []).map((a) => ({
    id: a.id, title: a.title, detail: a.detail,
    dueOn: a.due_date, source: a.source,
  }));

  // 手続きが完了・中止になっていれば、もう出さない
  if (proc.data && !["done", "cancelled"].includes(proc.data.status)) {
    const { data } = await sb.from("gw_procedure_items")
      .select("id, item_key, title, category, required, status, due_on")
      .eq("procedure_id", proc.data.id)
      .eq("owner", "employee")
      .in("status", ["todo", "submitted"])
      .order("sort_order").limit(50);

    out.onboarding = (data || []).map((i) => ({
      id: i.id, itemKey: i.item_key, title: i.title,
      category: i.category, required: i.required,
      status: i.status, dueOn: i.due_on,
      // 入力欄がある項目は入社フォームへ、書類だけの項目もそこから出せる
      href: "onboarding.html",
    }));
  }

  return out;
}
