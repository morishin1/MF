// GET    /api/tasks?scope=mine|all   … やること一覧（見える範囲は RLS が決める）
//          scope=mine のときは、業務タスクだけでなく
//          「日報で決めた次にやること」と「入社手続きの提出物」も混ぜて返す。
//          あわせて requested（自分が人に頼んだ分）も返す。
//
//          ■ なぜ混ぜるのか
//            いま自分が対応すべきものが3か所に散っていると、
//            どれかを必ず見落とす。入口を1つにする。
//            入社手続きのように一時期しか使わないものに専用メニューを作らず、
//            ここに出して、終われば自然に消えるようにする。
// POST   /api/tasks                  … 作成（名簿に載っている人なら誰でも）
// PATCH  /api/tasks {id, ...}        … 更新
//          管理者・人事、頼んだ本人 … すべての項目
//          担当された人             … status のみ（他の列は無視する）
// DELETE /api/tasks?id=...           … 削除（管理者・人事、頼んだ本人）
//
// ■ メンバー同士で頼めるようにした（044）
//   タスクを作れるのが管理者だけだと、「これお願いします」が結局チャットに戻り、
//   誰が何を抱えているかが画面から消える。
//   代わりに、直せる範囲を「自分が頼んだ分」に閉じてある。
//   他人が頼んだタスクの期限や担当を書き換えられると、頼んだ側から見て
//   自分の依頼が黙って変わることになる。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { notifySlack } from "../../lib/slack.js";
import { notify } from "../../lib/notify.js";

const PRIORITIES = ["low", "normal", "high"];
const STATUSES = ["todo", "doing", "done", "cancelled"];

const FIELDS =
  "id, tenant_id, title, body, assignee_id, escalate_to, due_on, priority, status, category, "
  + "completed_at, created_by, created_at, updated_at";
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
      if (!ctx.employee) return json(res, 200, { tasks: [], requested: [], canManage: canManageHr(ctx) });
      q = q.eq("assignee_id", ctx.employee.id);
    }
    const { data, error } = await q
      .order("status", { ascending: true })
      .order("due_on", { ascending: true, nullsFirst: false })
      .limit(300);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    // 自分が人に頼んだ分。自分の担当分とは別の箱で返す。
    // 混ぜると「自分がやること」と「相手を待っていること」が同じ列に並び、
    // 一覧を見ても自分の手番かどうか分からなくなる
    let requested = [];
    if (scope === "mine" && ctx.employee) {
      // 終わったものは2週間で落とす。そうしないと、頼めば頼むほど
      // 自分の画面が過去の依頼で埋まっていく
      const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
      const { data: mine } = await sb
        .from("gw_tasks").select(WITH_NAMES)
        .eq("tenant_id", ctx.tenantId)
        .eq("created_by", user.id)
        .neq("assignee_id", ctx.employee.id)
        .or(`status.in.(todo,doing),completed_at.gte.${cutoff}`)
        .order("status", { ascending: true })
        .order("due_on", { ascending: true, nullsFirst: false })
        .limit(200);
      requested = mine || [];
    }

    const all = [...(data || []), ...requested];
    const names = await creatorNames(all);

    return json(res, 200, {
      tasks: (data || []).map((t) => shape(t, user.id, ctx, names)),
      requested: requested.map((t) => shape(t, user.id, ctx, names)),
      // 自分の画面のときだけ、他から来る「やること」も足す
      extras: scope === "mine" ? await extrasFor(ctx, user.id) : { actions: [], onboarding: [], proposed: [] },
      canManage: canManageHr(ctx),
      me: ctx.employee,
    });
  }

  if (req.method === "POST") {
    // 名簿に載っていれば誰でも頼める。名簿に無い人（顧問先ロールなど）は不可
    if (!canManageHr(ctx) && !ctx.employee) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.title) return json(res, 400, { error: "invalid_body", detail: "title は必須です" });

    // 担当は同じ会社の名簿の人だけ。他社の id を渡されても通さない
    if (row.value.assignee_id) {
      const ok = await isPeer(ctx.tenantId, row.value.assignee_id);
      if (!ok) return json(res, 400, { error: "unknown_assignee", hint: "その相手は名簿にありません" });
    }
    if (row.value.escalate_to) {
      const ok = await isPeer(ctx.tenantId, row.value.escalate_to);
      if (!ok) return json(res, 400, { error: "unknown_escalate_to", hint: "その相手は名簿にありません" });
    }

    const { data, error } = await sb
      .from("gw_tasks")
      .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
      .select(WITH_NAMES)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });

    // 自分で自分に立てたメモに通知はいらない
    if (data.assignee_id && data.assignee_id !== ctx.employee?.id) {
      const from = ctx.employee?.display_name || "社内";
      await notify([{
        tenantId: ctx.tenantId,
        employeeId: data.assignee_id,
        kind: "task_assigned",
        title: `${from}さんから頼まれごとが届きました`,
        body: [data.title, data.due_on ? `期限 ${data.due_on}` : null].filter(Boolean).join("／"),
        link: "tasks.html",
        dedupeKey: `task:${data.id}`,
      }]);
      await notifySlack({
        text: `:white_square_button: タスクを割り当て　${data.assignee?.display_name || ""}`,
        lines: [data.title, `依頼 ${from}`, data.due_on ? `期限 ${data.due_on}` : null],
        link: "tasks.html",
      });
    }
    const names = await creatorNames([data]);
    return json(res, 200, { task: shape(data, user.id, ctx, names) });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

    const sbAdmin = admin();
    const { data: task, error: qe } = await sbAdmin
      .from("gw_tasks")
      .select("id, assignee_id, created_by, title")
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (qe) return json(res, 500, { error: "db_query_failed", detail: qe.message });
    if (!task) return json(res, 404, { error: "task_not_found" });

    // 管理者・人事と、頼んだ本人は全部直せる。RLS が最終的な可否を決める
    if (canManageHr(ctx) || task.created_by === user.id) {
      const row = normalize(body, { partial: true });
      if (row.error) return json(res, 400, row);
      if (row.value.assignee_id && !(await isPeer(ctx.tenantId, row.value.assignee_id))) {
        return json(res, 400, { error: "unknown_assignee", hint: "その相手は名簿にありません" });
      }
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
      const names = await creatorNames([data]);
      return json(res, 200, { task: shape(data, user.id, ctx, names) });
    }

    // 担当された人は status だけ変えられる。
    // RLS では列を絞れないので、ここで service_role を使い、変更対象を限定する。
    if (!ctx.employee) return json(res, 403, { error: "forbidden" });
    if (!STATUSES.includes(body.status)) return json(res, 400, { error: "invalid_status", detail: STATUSES.join(", ") });
    if (task.assignee_id !== ctx.employee.id) return json(res, 403, { error: "not_your_task" });

    const { data, error } = await sbAdmin
      .from("gw_tasks")
      .update(withCompletion({ status: body.status }))
      .eq("id", body.id)
      .select(FIELDS)
      .single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    // 頼んだ人に、終わったことを返す。
    // 「やりました」をチャットで送り直させないため
    if (body.status === "done" && task.created_by && task.created_by !== user.id) {
      const requester = await employeeOfUser(ctx.tenantId, task.created_by);
      if (requester) {
        await notify([{
          tenantId: ctx.tenantId,
          employeeId: requester,
          kind: "task_assigned",
          title: `${ctx.employee.display_name}さんが終わらせました`,
          body: task.title,
          link: "tasks.html",
          dedupeKey: `task-done:${task.id}`,
        }]);
      }
    }
    const names = await creatorNames([data]);
    return json(res, 200, { task: shape(data, user.id, ctx, names) });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    // 頼んだ本人も取り消せる。取り消せないと、間違えて頼んだものが
    // 相手の画面に残り続け、管理者に頼んで消してもらうことになる
    const { data: before } = await admin()
      .from("gw_tasks").select("created_by")
      .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!before) return json(res, 404, { error: "task_not_found" });
    if (!canManageHr(ctx) && before.created_by !== user.id) {
      return json(res, 403, { error: "not_your_task", hint: "自分が頼んだものだけ取り消せます" });
    }

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

/**
 * 画面に返す形。
 *
 * created_by（auth.users の id）はそのまま外に出さない。
 * 画面が知りたいのは「これは自分が頼んだものか」「誰から来たか」だけで、
 * 同僚のユーザーIDまでは要らない。
 */
function shape(t, userId, ctx, names) {
  const { created_by, ...rest } = t;
  const mine = created_by === userId;
  return {
    ...rest,
    byMe: mine,
    // 直せるのは、管理者・人事か、頼んだ本人だけ
    canEdit: canManageHr(ctx) || mine,
    requester: mine ? null : (names.get(created_by) || null),
  };
}

/** created_by（auth.users）を名簿の表示名に直す。分からない分は出さない */
async function creatorNames(rows) {
  const ids = [...new Set((rows || []).map((r) => r.created_by).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const { data } = await admin()
      .from("gw_employees").select("user_id, display_name").in("user_id", ids);
    for (const e of data || []) map.set(e.user_id, e.display_name);
  } catch (e) {
    console.error("[tasks] 依頼者名を引けませんでした:", e?.message || e);
  }
  return map;
}

/** その社員 id が同じ会社の名簿にあるか */
async function isPeer(tenantId, employeeId) {
  const { data } = await admin()
    .from("gw_employees").select("id")
    .eq("id", employeeId).eq("tenant_id", tenantId).maybeSingle();
  return !!data;
}

/** auth.users の id から、その会社の社員 id を引く */
async function employeeOfUser(tenantId, userId) {
  const { data } = await admin()
    .from("gw_employees").select("id")
    .eq("user_id", userId).eq("tenant_id", tenantId).maybeSingle();
  return data?.id || null;
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
  const out = { actions: [], onboarding: [], proposed: [] };
  if (!ctx.employee) return out;

  const sb = admin();

  const [items, proposed, proc] = await Promise.all([
    sb.from("gw_action_items")
      .select("id, title, detail, source, due_date, priority, status")
      .eq("user_id", userId)
      .eq("status", "open")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("priority")
      .limit(30),
    // AIが出したまま、まだ採否を決めていないもの。
    // ホームで見送っても消えないので、ここから後で処理できる
    sb.from("gw_action_items")
      .select("id, title, detail, source, due_date, created_at")
      .eq("user_id", userId).eq("status", "proposed")
      .order("created_at", { ascending: false }).limit(20),
    sb.from("gw_procedures")
      .select("id, status, target_on")
      .eq("employee_id", ctx.employee.id).eq("kind", "onboarding").maybeSingle(),
  ]);

  out.actions = (items.data || []).map((a) => ({
    id: a.id, title: a.title, detail: a.detail,
    dueOn: a.due_date, source: a.source,
  }));
  out.proposed = (proposed.data || []).map((a) => ({
    id: a.id, title: a.title, detail: a.detail, dueOn: a.due_date,
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
