// POST /api/requests/decide  { id, action, note? }
//   action = approve … 承認する（稟議は1段目のあと代表の承認へ進む）
//            reject  … 却下する
//            cancel  … 取り下げる（本人、または管理部・経営者）
//
// なぜ API なのか:
//   RLS では列単位の制限が書けない。本人に UPDATE を許すと、自分の申請を
//   approved に書き換えられてしまう。DB 側では本人の書き込みを塞ぎ、
//   ここで「取り下げだけ」に絞って service_role で書く。
//
// 承認された有給は、共有カレンダー「社内ポータル」に終日の予定として入れる。
// 誰が休むかは社内で共有されるべき情報で、予定表で見えるのがいちばん早い。
// 休む理由（申請の本文）はカレンダーには書かない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { canReviewExpense } from "../../lib/expenses.js";
import { LEAVE_LABEL, STATUS_LABEL, nextStatusFor, leaveLabel, yen } from "../../lib/requests.js";
import { syncAllDay } from "../../lib/gcal.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";

const ACTIONS = ["approve", "reject", "cancel"];

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const body = await readJson(req);
  if (!body?.id || !ACTIONS.includes(body.action)) {
    return json(res, 400, { error: "invalid_body", required: ["id", `action(${ACTIONS.join("|")})`] });
  }

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = admin();
  const { data: r, error } = await sb
    .from("gw_requests")
    .select("*, applicant:gw_employees!gw_requests_employee_id_fkey(id, display_name)")
    .eq("id", body.id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!r) return json(res, 404, { error: "request_not_found" });

  const isReviewer = canReviewExpense(ctx);
  const isOwner = ctx.roles.includes("owner");
  const isMine = !!ctx.employee && r.employee_id === ctx.employee.id;

  if (body.action === "cancel") {
    if (!isMine && !isReviewer) return json(res, 403, { error: "forbidden" });
  } else if (!isReviewer) {
    return json(res, 403, { error: "forbidden" });
  }

  const now = new Date().toISOString();
  const note = body.note ? String(body.note).slice(0, 500) : null;
  const patch = { updated_at: now, decision_note: note };

  if (body.action === "approve") {
    if (r.status === "pending") {
      patch.status = nextStatusFor(r.kind);
      patch.approved_by = ctx.employee?.id || null;
      patch.approved_at = now;
    } else if (r.status === "pending_owner") {
      if (!isOwner) {
        return json(res, 403, { error: "owner_required", hint: "稟議の最終承認は代表（経営者権限）が行います" });
      }
      patch.status = "approved";
      patch.owner_approved_by = ctx.employee?.id || null;
      patch.owner_approved_at = now;
    } else {
      return json(res, 409, { error: "not_pending", hint: `すでに「${STATUS_LABEL[r.status]}」です` });
    }
  } else if (body.action === "reject") {
    if (r.status !== "pending" && r.status !== "pending_owner") {
      return json(res, 409, { error: "not_pending", hint: `すでに「${STATUS_LABEL[r.status]}」です` });
    }
    patch.status = "rejected";
  } else {
    if (r.status === "rejected" || r.status === "cancelled") {
      return json(res, 409, { error: "already_closed" });
    }
    // 承認後の取り下げは管理部の判断で行う。休暇は予定表にも出ているため
    if (r.status === "approved" && !isReviewer) {
      return json(res, 409, { error: "already_approved", hint: "承認後の取り消しは管理部へご連絡ください" });
    }
    patch.status = "cancelled";
  }

  // 有給が確定したらカレンダーへ。取り消し・却下なら消す
  let calendar = { skipped: "not_applicable" };
  if (r.kind === "leave") {
    const goingLive = patch.status === "approved";
    calendar = await syncAllDay({
      record: r,
      action: goingLive ? "upsert" : "delete",
      summary: `${r.applicant?.display_name || ""}さん ${LEAVE_LABEL[r.leave_type] || "休暇"}`,
      description: "エイト 社内ポータルの休暇申請から自動で作成されました。",
      startsOn: r.starts_on,
      endsOn: r.ends_on,
    });
    if (!calendar.skipped) {
      patch.gcal_error = calendar.error || null;
      if (!calendar.error) {
        patch.gcal_calendar_id = calendar.calendarId ?? null;
        patch.gcal_event_id = calendar.eventId ?? null;
        patch.gcal_link = calendar.link ?? null;
      }
    }
  }

  const { data: saved, error: ue } = await sb
    .from("gw_requests")
    .update(patch)
    .eq("id", r.id)
    .select("id, kind, status, approved_at, owner_approved_at, decision_note, gcal_link, gcal_error")
    .single();
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  await announce({ ctx, r, saved, action: body.action, note, isMine });
  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
    action: `request.${body.action}`, target: r.id,
    detail: { kind: r.kind, status: saved.status, title: r.title },
  });

  return json(res, 200, {
    request: saved,
    calendar: calendar.skipped ? { synced: false, reason: calendar.skipped }
      : (calendar.error ? { synced: false, error: calendar.error } : { synced: true, link: calendar.link || null }),
  });
}

async function announce({ ctx, r, saved, action, note, isMine }) {
  const label = r.kind === "leave" ? leaveLabel(r) : (r.amount ? yen(r.amount) : "金額なし");

  // 代表の承認待ちに進んだ場合は、代表にだけ知らせる
  if (saved.status === "pending_owner") {
    const { data: owners } = await admin()
      .from("gw_role_grants")
      .select("employee_id")
      .eq("tenant_id", ctx.tenantId)
      .eq("role", "owner");
    await notify((owners || []).map((o) => ({
      tenantId: ctx.tenantId, employeeId: o.employee_id,
      kind: "request",
      title: "稟議の承認依頼（代表）",
      body: `${r.applicant?.display_name || ""}／${label}／${r.title}`,
      link: "admin-requests.html",
      dedupeKey: `request:${r.id}`,
    })));
    await notifySlack({
      text: `:page_facing_up: 稟議が代表承認待ちになりました　${label}`,
      lines: [r.title],
      link: "admin-requests.html",
    });
    return;
  }

  if (action === "cancel" && isMine) return;   // 自分で取り下げた分は知らせない

  const done = {
    approved: "承認されました", rejected: "却下されました", cancelled: "取り消されました",
  }[saved.status];
  if (!done || !r.employee_id) return;

  const heading = r.kind === "leave" ? "休暇の申請" : "稟議";
  await notify([{
    tenantId: ctx.tenantId, employeeId: r.employee_id,
    kind: "request",
    title: `${heading}が${done}`,
    body: `${label}／${r.title}${note ? `\n${note}` : ""}`,
    link: "requests.html",
    dedupeKey: `request:${r.id}`,
  }]);

  if (saved.status === "approved") {
    await notifySlack({
      text: `:white_check_mark: ${heading}を承認　${r.applicant?.display_name || ""}`,
      lines: [r.title, label],
      link: "admin-requests.html",
    });
  }
}
