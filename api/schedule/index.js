// GET    /api/schedule?from=&to=   … その期間の自分の予定をまとめて返す
//          ・社内カレンダー（自分で入れた予定）
//          ・自分のスペース予約
//          ・自分のタスクの期限
// POST   /api/schedule             … 予定を作る
// PATCH  /api/schedule {id, ...}   … 予定を直す
// DELETE /api/schedule?id=…        … 予定を消す
//
// 1画面ぶんを1回の呼び出しで返しているのは、週を送るたびに3本叩くと
// 表示が3段階でガタつくため。取得元が増えてもここで吸収する。
//
// 予定の中身は本人以外に見せない。RLS（017）が本人以外の行を返さないので、
// この API に「誰の分か」を指定する口は用意していない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { fetchExternalEvents } from "../../lib/google-link.js";

const FIELDS =
  "id, title, body, location, category, all_day, starts_at, ends_at, created_at";

const CATEGORIES = ["work", "meeting", "visit", "private", "other"];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  if (req.method === "GET") return list(req, res, ctx);
  if (req.method === "POST") return create(req, res, ctx);
  if (req.method === "PATCH") return update(req, res, ctx);
  if (req.method === "DELETE") return remove(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// ---- 一覧 -------------------------------------------------------------------
async function list(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const from = q.get("from");
  const to = q.get("to");
  if (!from || !to) return json(res, 400, { error: "invalid_query", required: ["from", "to"] });

  const sb = userClient(req);

  // どれも空振り（未適用の環境、連携なし）でも画面は出したいので
  // 個別に握りつぶし、取れたものだけ返す
  const [events, bookings, tasks, external] = await Promise.all([
    sb.from("gw_calendar_events")
      .select(FIELDS)
      .gte("starts_at", from).lt("starts_at", to)
      .order("starts_at").limit(500)
      .then((r) => r.data || [], () => []),

    sb.from("gw_bookings")
      .select("id, title, starts_at, ends_at, status, space:gw_spaces(code, name)")
      .eq("employee_id", ctx.employee.id)
      .in("status", ["pending", "approved"])
      .gte("starts_at", from).lt("starts_at", to)
      .order("starts_at").limit(200)
      .then((r) => r.data || [], () => []),

    sb.from("gw_tasks")
      .select("id, title, due_on, priority, status, category")
      .eq("assignee_id", ctx.employee.id)
      .in("status", ["todo", "doing"])
      .gte("due_on", from.slice(0, 10)).lte("due_on", to.slice(0, 10))
      .order("due_on").limit(200)
      .then((r) => r.data || [], () => []),

    // 本人が連携していれば、その人の Google カレンダーも一緒に取る。
    // 連携が切れていても error を添えて返すだけで、画面は出す
    fetchExternalEvents(ctx.employee.id, { from, to }),
  ]);

  return json(res, 200, { events, bookings, tasks, external });
}

// ---- 作成・更新・削除 -------------------------------------------------------
async function create(req, res, ctx) {
  const body = await readJson(req);
  const row = normalize(body);
  if (row.error) return json(res, 400, row);

  const { data, error } = await userClient(req)
    .from("gw_calendar_events")
    .insert({ ...row.value, tenant_id: ctx.tenantId, employee_id: ctx.employee.id })
    .select(FIELDS)
    .single();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  return json(res, 200, { event: data });
}

async function update(req, res, ctx) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const row = normalize(body, { partial: true });
  if (row.error) return json(res, 400, row);

  const { data, error } = await userClient(req)
    .from("gw_calendar_events")
    .update({ ...row.value, updated_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("tenant_id", ctx.tenantId)
    .select(FIELDS)
    .maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "event_not_found" });
  return json(res, 200, { event: data });
}

async function remove(req, res, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data, error } = await userClient(req)
    .from("gw_calendar_events")
    .delete()
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .select("id")
    .maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "event_not_found" });
  return json(res, 200, { ok: true, id });
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("title")) {
    const title = String(body.title ?? "").trim();
    if (!title) return { error: "invalid_body", hint: "件名を入力してください" };
    v.title = title.slice(0, 200);
  }
  if (has("body")) v.body = body.body ? String(body.body).slice(0, 2000) : null;
  if (has("location")) v.location = body.location ? String(body.location).slice(0, 200) : null;
  if (has("allDay")) v.all_day = !!body.allDay;

  if (has("category")) {
    if (!CATEGORIES.includes(body.category)) return { error: "invalid_category", detail: CATEGORIES.join(", ") };
    v.category = body.category;
  }

  if (!partial || has("startsAt") || has("endsAt")) {
    const s = new Date(body.startsAt);
    const e = new Date(body.endsAt);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      return { error: "invalid_time", hint: "日時の形式が正しくありません" };
    }
    if (e < s) return { error: "invalid_time", hint: "終了は開始より後にしてください" };
    // 1件が長すぎるのは入力ミスのほうが多い。年をまたぐ帯は弾く
    if (e - s > 366 * 86400000) return { error: "too_long", hint: "1件で1年を超える予定は入れられません" };
    v.starts_at = s.toISOString();
    v.ends_at = e.toISOString();
  }
  return { value: v };
}
