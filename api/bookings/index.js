// GET    /api/bookings?scope=mine|pending|all&from=&to=&spaceId=
// POST   /api/bookings                       … 申請する
// PATCH  /api/bookings {id, action, note?}   … approve / reject / cancel
// DELETE /api/bookings?id=...                … 削除（管理者・人事）
//
// カレンダー連携の考え方:
//   申請   → 仮の予定（tentative）としてカレンダーに入れる
//   承認   → 確定（confirmed）に変える
//   却下   → 予定を消す
//   取消   → 予定を消す
//
// 連携に失敗しても予約は成立させる。カレンダーが書けないことを理由に
// 申請そのものを失敗させると、予約の受付が Google の状態に引きずられるため。
// 失敗の内容は gcal_error に残し、管理画面で気づけるようにする。
//
// 二重予約は DB の排他制約（gw_bookings_no_overlap）で止まる。
// 同時に押された2件はアプリ側の事前チェックだけではすり抜けるため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { syncBooking } from "../../lib/gcal.js";
import { approverEmployeeIds, validateRange, rangeLabel } from "../../lib/bookings.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";

const FIELDS =
  "id, tenant_id, space_id, employee_id, title, note, headcount, starts_at, ends_at, " +
  "status, decided_by, decided_at, decision_note, gcal_calendar_id, gcal_event_id, gcal_link, gcal_error, created_at";
const WITH_NAMES =
  `${FIELDS}, space:gw_spaces(id, code, name, capacity, calendar_id, needs_approval), ` +
  "applicant:gw_employees!gw_bookings_employee_id_fkey(id, display_name, department)";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") return list(req, res, ctx);
  if (req.method === "POST") return create(req, res, ctx);
  if (req.method === "PATCH") return decide(req, res, ctx);
  if (req.method === "DELETE") return remove(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// ---- 一覧 -------------------------------------------------------------------
async function list(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = userClient(req);

  let query = sb
    .from("gw_bookings")
    .select(WITH_NAMES)
    .eq("tenant_id", ctx.tenantId);

  const scope = q.get("scope") || "all";
  if (scope === "mine") {
    if (!ctx.employee) return json(res, 200, { bookings: [], canApprove: false });
    query = query.eq("employee_id", ctx.employee.id);
  } else if (scope === "pending") {
    query = query.eq("status", "pending");
  }

  if (q.get("spaceId")) query = query.eq("space_id", q.get("spaceId"));
  if (q.get("from")) query = query.gte("starts_at", q.get("from"));
  if (q.get("to")) query = query.lt("starts_at", q.get("to"));

  // 承認待ちは古い順（待たせている順）、それ以外は新しい予定から
  const ascending = scope === "pending";
  const { data, error } = await query.order("starts_at", { ascending }).limit(500);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  return json(res, 200, {
    bookings: data || [],
    canApprove: canManageHr(ctx),
    me: ctx.employee ? { id: ctx.employee.id, name: ctx.employee.display_name } : null,
  });
}

// ---- 申請 -------------------------------------------------------------------
async function create(req, res, ctx) {
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  const body = await readJson(req);
  const title = String(body?.title ?? "").trim().slice(0, 200);
  if (!body?.spaceId || !title) {
    return json(res, 400, { error: "invalid_body", required: ["spaceId", "title", "startsAt", "endsAt"] });
  }

  const range = validateRange(body.startsAt, body.endsAt);
  if (range.error) return json(res, 400, range);

  const sb = userClient(req);

  const { data: space, error: se } = await sb
    .from("gw_spaces")
    .select("id, code, name, capacity, calendar_id, active, needs_approval")
    .eq("id", body.spaceId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (se) return json(res, 500, { error: "db_query_failed", detail: se.message });
  if (!space) return json(res, 404, { error: "space_not_found" });
  if (!space.active) return json(res, 409, { error: "space_inactive", hint: "このスペースは現在受付を止めています" });

  const headcount = body.headcount ? Number(body.headcount) : null;
  if (headcount !== null && (!Number.isInteger(headcount) || headcount < 1)) {
    return json(res, 400, { error: "invalid_headcount" });
  }
  if (headcount && space.capacity && headcount > space.capacity) {
    return json(res, 400, { error: "over_capacity", hint: `${space.name} の定員は ${space.capacity} 名です` });
  }

  // 先に重なりを見て、誰が押さえているかを添えて返す。
  // 取りこぼしは下の排他制約が止めるので、ここは案内のためのチェック。
  const { data: clash } = await sb
    .from("gw_bookings")
    .select("id, starts_at, ends_at, status, applicant:gw_employees!gw_bookings_employee_id_fkey(display_name)")
    .eq("space_id", space.id)
    .in("status", ["pending", "approved"])
    .lt("starts_at", range.endsAt)
    .gt("ends_at", range.startsAt)
    .limit(1);
  if (clash?.length) return json(res, 409, conflictBody(clash[0]));

  const { data: booking, error } = await sb
    .from("gw_bookings")
    .insert({
      tenant_id: ctx.tenantId,
      space_id: space.id,
      employee_id: ctx.employee.id,
      title,
      note: body.note ? String(body.note).slice(0, 1000) : null,
      headcount,
      starts_at: range.startsAt,
      ends_at: range.endsAt,
      status: "pending",
    })
    .select(FIELDS)
    .single();
  if (error) {
    if (error.code === "23P01") return json(res, 409, { error: "time_conflict", hint: "同じ時間に別の予約が入りました。時間を変えて申請してください" });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  // 承認不要のスペースは、申請と同時に確定させる
  const autoApprove = space.needs_approval === false;
  const applicantName = ctx.employee.display_name;
  const sync = await syncBooking({
    booking, space, applicantName, action: autoApprove ? "confirm" : "tentative",
  });

  const patch = { ...calendarPatch(sync) };
  if (autoApprove) {
    patch.status = "approved";
    patch.decided_by = ctx.employee.id;
    patch.decided_at = new Date().toISOString();
    patch.decision_note = "承認不要のスペースのため自動で確定";
  }
  const saved = await applyPatch(booking.id, patch);

  if (!autoApprove) {
    const approvers = await approverEmployeeIds(ctx.tenantId);
    await notify(approvers.filter((id) => id !== ctx.employee.id).map((employeeId) => ({
      tenantId: ctx.tenantId,
      employeeId,
      kind: "booking",
      title: `${space.name} の予約申請`,
      body: `${applicantName}／${rangeLabel(booking.starts_at, booking.ends_at)}／${title}`,
      link: "admin-bookings.html",
      dedupeKey: `booking:${booking.id}`,
    })));

    await notifySlack({
      text: `:office: スペース予約の申請　${applicantName}`,
      lines: [`${space.name}　${rangeLabel(booking.starts_at, booking.ends_at)}`, title],
      link: "admin-bookings.html",
    });
  }

  // 申請そのものは一覧に残るのでログには入れない。
  // 承認を経ずに確定したものだけ、後から辿れるように残す
  if (autoApprove) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: ctx.employee.id,
      action: "booking.auto_approved", target: booking.id,
      detail: { space: space.name, range: rangeLabel(booking.starts_at, booking.ends_at), title },
    });
  }

  return json(res, 200, { booking: saved || booking, calendar: calendarResult(sync) });
}

// ---- 承認 / 却下 / 取消 -----------------------------------------------------
async function decide(req, res, ctx) {
  const body = await readJson(req);
  const action = body?.action;
  if (!body?.id || !["approve", "reject", "cancel"].includes(action)) {
    return json(res, 400, { error: "invalid_body", required: ["id", "action(approve|reject|cancel)"] });
  }

  // 認可の判定に使うので、ここだけは RLS を通さずに素の行を読む
  const sb = admin();
  const { data: booking, error } = await sb
    .from("gw_bookings")
    .select(`${FIELDS}, space:gw_spaces(id, code, name, calendar_id), applicant:gw_employees!gw_bookings_employee_id_fkey(id, display_name)`)
    .eq("id", body.id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!booking) return json(res, 404, { error: "booking_not_found" });

  const isApprover = canManageHr(ctx);
  const isOwner = !!ctx.employee && booking.employee_id === ctx.employee.id;

  if (action === "cancel") {
    // 取り消しは本人と承認者。承認者は代理で下げられる
    if (!isOwner && !isApprover) return json(res, 403, { error: "forbidden" });
  } else if (!isApprover) {
    return json(res, 403, { error: "forbidden" });
  }

  if (booking.status === "rejected" || booking.status === "cancelled") {
    return json(res, 409, { error: "already_closed", hint: "この予約はすでに終了しています" });
  }
  if (action === "approve" && booking.status === "approved") {
    return json(res, 200, { booking, calendar: { skipped: "already_approved" } });
  }

  const status = action === "approve" ? "approved" : (action === "reject" ? "rejected" : "cancelled");
  const sync = await syncBooking({
    booking,
    space: booking.space,
    applicantName: booking.applicant?.display_name,
    action: action === "approve" ? "confirm" : "delete",
  });

  const patch = {
    status,
    decided_by: ctx.employee?.id || null,
    decided_at: new Date().toISOString(),
    decision_note: body.note ? String(body.note).slice(0, 500) : null,
    ...calendarPatch(sync),
  };
  const saved = await applyPatch(booking.id, patch);

  // 本人が自分で取り下げた場合まで本人に知らせる必要はない
  if (booking.employee_id && !(action === "cancel" && isOwner)) {
    const label = { approved: "承認されました", rejected: "却下されました", cancelled: "取り消されました" }[status];
    await notify([{
      tenantId: ctx.tenantId,
      employeeId: booking.employee_id,
      kind: "booking",
      title: `${booking.space?.name || "スペース"}の予約が${label}`,
      body: `${rangeLabel(booking.starts_at, booking.ends_at)}／${booking.title}` +
            (patch.decision_note ? `\n${patch.decision_note}` : ""),
      link: "booking.html",
      dedupeKey: `booking:${booking.id}`,
    }]);
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
    action: `booking.${action}`,
    target: booking.id,
    detail: { space: booking.space?.name, range: rangeLabel(booking.starts_at, booking.ends_at) },
  });

  return json(res, 200, { booking: saved || booking, calendar: calendarResult(sync) });
}

// ---- 削除 -------------------------------------------------------------------
async function remove(req, res, ctx) {
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const sb = userClient(req);
  const { data: booking } = await sb
    .from("gw_bookings")
    .select(`${FIELDS}, space:gw_spaces(id, name, calendar_id)`)
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (!booking) return json(res, 404, { error: "booking_not_found" });

  // 行を消す前にカレンダーの予定も消す。順番が逆だと、消し忘れた予定が
  // カレンダーに残ったまま、ポータル側から辿れなくなる
  await syncBooking({ booking, space: booking.space, action: "delete" });

  const { error } = await sb
    .from("gw_bookings")
    .delete()
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
    action: "booking.deleted", target: id, detail: { space: booking.space?.name },
  });
  return json(res, 200, { ok: true, id });
}

// ---- 補助 -------------------------------------------------------------------

// カレンダー連携の結果を行に落とす。未設定のときは列を触らない
function calendarPatch(sync) {
  if (!sync || sync.skipped) return {};
  return {
    gcal_calendar_id: sync.error ? undefined : (sync.calendarId ?? null),
    gcal_event_id: sync.error ? undefined : (sync.eventId ?? null),
    gcal_link: sync.error ? undefined : (sync.link ?? null),
    gcal_error: sync.error || null,
  };
}

function calendarResult(sync) {
  if (!sync) return { synced: false };
  if (sync.skipped) return { synced: false, reason: sync.skipped };
  if (sync.error) return { synced: false, error: sync.error };
  return { synced: true, link: sync.link || null };
}

// 予約の書き戻しは service_role で行う。
// 申請者には UPDATE 権限が無く（RLS）、カレンダーIDを本人に書かせるわけにもいかない
async function applyPatch(id, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(clean).length) return null;
  const { data, error } = await admin()
    .from("gw_bookings")
    .update({ ...clean, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(FIELDS)
    .maybeSingle();
  if (error) {
    console.error("[bookings] patch failed:", error.message);
    return null;
  }
  return data;
}

function conflictBody(row) {
  const who = row.applicant?.display_name || "他のメンバー";
  const state = row.status === "pending" ? "申請中" : "予約済み";
  return {
    error: "time_conflict",
    hint: `${rangeLabel(row.starts_at, row.ends_at)} は ${who} が${state}です`,
  };
}
