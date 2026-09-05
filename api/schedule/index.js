// GET    /api/schedule?from=&to=   … その期間の自分の予定をまとめて返す
//          ・社内カレンダー（自分で入れた予定）
//          ・自分のスペース予約
//          ・自分のタスクの期限
// POST   /api/schedule             … 予定を作る
// PATCH  /api/schedule {id, ...}   … 予定を直す
// DELETE /api/schedule?id=…        … 予定を消す
// POST   /api/schedule {action:"push"|"unpush", id}
//                                  … その予定を本人の Google カレンダーへ入れる／取り消す
//
// 1画面ぶんを1回の呼び出しで返しているのは、週を送るたびに3本叩くと
// 表示が3段階でガタつくため。取得元が増えてもここで吸収する。
//
// 予定の中身は本人以外に見せない。RLS（017）が本人以外の行を返さないので、
// この API に「誰の分か」を指定する口は用意していない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { fetchExternalEvents, pushEvent, unpushEvent, linkStatus } from "../../lib/google-link.js";

const FIELDS =
  "id, title, body, location, category, all_day, starts_at, ends_at, created_at, " +
  "gcal_event_id, gcal_synced_at";

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
  if (req.method === "POST") {
    const body = await readJson(req);
    // 書き出しは作成と同じ口にした。押すたびに別のURLを覚える必要がない
    if (body?.action === "push" || body?.action === "unpush") {
      return syncOne(req, res, ctx, body);
    }
    return create(req, res, ctx, body);
  }
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

  return json(res, 200, { events, bookings, tasks, external, googleLink: await linkStatus(ctx.employee.id) });
}

// ---- 作成・更新・削除 -------------------------------------------------------
async function create(req, res, ctx, body) {
  const row = normalize(body);
  if (row.error) return json(res, 400, row);

  const { data, error } = await userClient(req)
    .from("gw_calendar_events")
    .insert({ ...row.value, tenant_id: ctx.tenantId, employee_id: ctx.employee.id })
    .select(FIELDS)
    .single();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });

  // 「入れたらそのまま Google にも」を1操作で済ませる
  let google = null;
  if (body?.pushToGoogle) google = await pushAndRecord(ctx, data);
  return json(res, 200, { event: data, google });
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

  // 既に書き出してある予定を直したら、向こうも合わせる。
  // ここを手動にすると、社内とGoogleで中身が違う状態が静かに残る
  let google = null;
  if (data.gcal_event_id || body.pushToGoogle) google = await pushAndRecord(ctx, data);
  return json(res, 200, { event: data, google });
}

async function remove(req, res, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  // 消す前に、Google 側にも書き出してあるかを見ておく。
  // 先に消すと id が分からなくなり、向こうに幽霊が残る
  const { data: before } = await userClient(req)
    .from("gw_calendar_events").select("gcal_event_id")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();

  const { data, error } = await userClient(req)
    .from("gw_calendar_events")
    .delete()
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .select("id")
    .maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "event_not_found" });

  // 向こうの削除に失敗しても、社内の削除はもう済んでいる。
  // 消し損ねたことだけ伝えて、操作自体は成功として返す
  let google = null;
  if (before?.gcal_event_id) google = await unpushEvent(ctx.employee.id, before.gcal_event_id);
  return json(res, 200, { ok: true, id, google });
}

// ---- Google カレンダーへの書き出し ------------------------------------------
async function syncOne(req, res, ctx, body) {
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  // RLS を通す読み取り。他人の予定を書き出せないようにするのはここ
  const { data: ev } = await userClient(req)
    .from("gw_calendar_events").select(FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!ev) return json(res, 404, { error: "event_not_found" });

  if (body.action === "unpush") {
    const r = await unpushEvent(ctx.employee.id, ev.gcal_event_id);
    if (!r.ok) return json(res, 502, { error: r.reason, hint: r.hint, detail: r.detail });
    await stamp(ev.id, { gcal_event_id: null, gcal_synced_at: null });
    return json(res, 200, { ok: true, event: { ...ev, gcal_event_id: null, gcal_synced_at: null } });
  }

  const google = await pushAndRecord(ctx, ev);
  if (!google.ok) return json(res, 502, { error: google.reason, hint: google.hint, detail: google.detail });
  return json(res, 200, {
    ok: true, google,
    event: { ...ev, gcal_event_id: google.gcalEventId, gcal_synced_at: google.syncedAt },
  });
}

/** 書き出して、向こうの id を控える。控えないと2回目で2件になる */
async function pushAndRecord(ctx, ev) {
  const r = await pushEvent(ctx.employee.id, {
    title: ev.title, body: ev.body, location: ev.location, category: ev.category,
    allDay: ev.all_day, startsAt: ev.starts_at, endsAt: ev.ends_at,
    gcal_event_id: ev.gcal_event_id,
  });
  if (!r.ok) return r;

  const syncedAt = new Date().toISOString();
  await stamp(ev.id, { gcal_event_id: r.gcalEventId, gcal_synced_at: syncedAt });
  return { ...r, syncedAt };
}

// 書き出しの控えは service_role で書く。
// 本人が編集できる列にしてしまうと、向こうの id を書き換えて
// 他人の予定を上書きさせられる余地ができる
async function stamp(id, patch) {
  try {
    await admin().from("gw_calendar_events").update(patch).eq("id", id);
  } catch (e) {
    console.error("[schedule] gcal 控えの保存に失敗:", e?.message || e);
  }
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
