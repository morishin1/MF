// 営業の商談（/sales Phase 2）
//
// GET   /api/sales/meetings?companyId=…          … その会社の商談（新しい順）
// POST  /api/sales/meetings { companyId, ownerId? }
//         … 「商談を予定する」。初回商談（30分）の商談を作り、TimeRex の日程調整URLを返す。
//           進行中（日程調整中・商談予定）の商談があれば、新しく作らずにそれを返す
// PATCH /api/sales/meetings { id, action: "sent" }
//         … 日程調整URLを相手に送った。NEXT を「日程調整待ち」（3営業日後）にする
// PATCH /api/sales/meetings { id, action: "schedule", scheduledAt, meetingUrl? }
//         … 日程が決まった（手入力）。TimeRex Webhook の実装後は受信口が同じ処理を呼ぶ
// PATCH /api/sales/meetings { id, action: "cancel" }
//
// ■ TimeRex の URL は環境変数 TIMEREX_SALES_MEETING_URL（初回商談 30分のイベントタイプ）
//   未設定なら schedulingUrl は null。画面は「手入力で日程を入れる」へ案内する（止めない）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { COMPANY_FIELDS, isUuid, safeUrl } from "../../../lib/sales.js";
import {
  MEETING_FIELDS, shapeMeeting, activeMeeting, salesSchedulingUrl, applyScheduled, waitingNext,
} from "../../../lib/sales-meetings.js";

const SQL = "db/090_sales_meetings.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return issue(req, res, sb, ctx, user);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

const configured = () => Boolean((process.env.TIMEREX_SALES_MEETING_URL || "").trim());

function fail(res, error) {
  const hint = dbSetupHint(error, SQL);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
}

async function names(sb, ctx) {
  const { data } = await sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).limit(500);
  const m = new Map((data || []).map((e) => [e.id, e.display_name]));
  return (id) => m.get(id) || null;
}

async function loadCompany(sb, ctx, id) {
  const { data } = await sb.from("gw_sales_companies").select(COMPANY_FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}

async function list(req, res, sb, ctx) {
  const companyId = new URL(req.url, "http://localhost").searchParams.get("companyId");
  if (!isUuid(companyId)) return json(res, 400, { error: "invalid_query", required: ["companyId"] });
  const { data, error } = await sb.from("gw_sales_meetings").select(MEETING_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("company_id", companyId).order("created_at", { ascending: false }).limit(50);
  if (error) return fail(res, error);
  const nameOf = await names(sb, ctx);
  return json(res, 200, { meetings: (data || []).map((m) => shapeMeeting(m, nameOf)), timerexConfigured: configured() });
}

async function issue(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.companyId)) return json(res, 400, { error: "invalid_body", required: ["companyId"] });
  const c = await loadCompany(sb, ctx, body.companyId);
  if (!c) return json(res, 404, { error: "not_found" });
  if (c.ng_reason) return json(res, 403, { error: "ng_company", hint: "営業禁止の企業です" });
  if (body.ownerId && !isUuid(body.ownerId)) return json(res, 400, { error: "bad_owner" });

  const { data: existing, error: e1 } = await sb.from("gw_sales_meetings").select(MEETING_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("company_id", c.id).limit(50);
  if (e1) return fail(res, e1);
  const nameOf = await names(sb, ctx);

  // 進行中の商談があれば、それを返す（二重に日程調整URLを出さない）
  const open = activeMeeting(existing);
  if (open) {
    return json(res, 200, { meeting: shapeMeeting(open, nameOf), reused: true, timerexConfigured: configured() });
  }

  const ownerId = body.ownerId || c.owner_id || ctx.employee?.id || null;
  const { data: made, error: e2 } = await sb.from("gw_sales_meetings").insert({
    tenant_id: ctx.tenantId, company_id: c.id, owner_id: ownerId,
    kind: "first_meeting", duration_min: 30, status: "scheduling", created_by: user.id,
  }).select(MEETING_FIELDS).single();
  if (e2) return fail(res, e2);

  // URL には会社と商談のIDを載せる（Webhook で「どの会社のどの商談か」を決めるため）
  const url = salesSchedulingUrl(process.env.TIMEREX_SALES_MEETING_URL, c.id, made.id);
  let meeting = made;
  if (url) {
    const { data } = await sb.from("gw_sales_meetings").update({ scheduling_url: url })
      .eq("id", made.id).eq("tenant_id", ctx.tenantId).select(MEETING_FIELDS).single();
    if (data) meeting = data;
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.meeting_issue",
    target: `sales_company:${c.id}`, detail: { meetingId: made.id, timerex: Boolean(url) } });
  return json(res, 200, { meeting: shapeMeeting(meeting, nameOf), reused: false, timerexConfigured: configured() });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id", "action"] });
  const { data: m, error } = await sb.from("gw_sales_meetings").select(MEETING_FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) return fail(res, error);
  if (!m) return json(res, 404, { error: "not_found" });
  const c = await loadCompany(sb, ctx, m.company_id);
  if (!c) return json(res, 404, { error: "company_not_found" });
  const now = new Date().toISOString();
  const nameOf = await names(sb, ctx);

  if (body.action === "sent") {
    if (m.status !== "scheduling") return json(res, 409, { error: "not_scheduling", hint: "日程調整中の商談ではありません" });
    const { data } = await sb.from("gw_sales_meetings").update({ scheduling_sent_at: now, updated_at: now })
      .eq("id", m.id).eq("tenant_id", ctx.tenantId).select(MEETING_FIELDS).single();
    // リードに対応した（未対応クリックから外す）。NEXT は相手の予約待ち
    await sb.from("gw_sales_companies").update({ ...waitingNext(), followed_at: now, updated_at: now })
      .eq("id", c.id).eq("tenant_id", ctx.tenantId);
    await sb.from("gw_sales_events").insert({
      tenant_id: ctx.tenantId, company_id: c.id, event_key: "meeting", label: "商談の日程調整URLを送付（初回商談 30分）",
      detail: null, employee_id: ctx.employee?.id || null, created_by: user.id,
    });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.meeting_sent", target: `sales_company:${c.id}`, detail: { meetingId: m.id } });
    return json(res, 200, { meeting: shapeMeeting(data || m, nameOf) });
  }

  if (body.action === "schedule") {
    if (!["scheduling", "scheduled"].includes(m.status)) return json(res, 409, { error: "closed", hint: "この商談は終わっています" });
    // TimeRex の予約で確定した日時・Meet URL は TimeRex が正（手入力で上書きして食い違いを作らない）
    if (m.timerex_event_id) {
      return json(res, 409, { error: "timerex_managed", hint: "TimeRexで予約が確定した商談です。日時の変更はTimeRexで行ってください" });
    }
    if (!body.scheduledAt || Number.isNaN(new Date(body.scheduledAt).getTime())) {
      return json(res, 400, { error: "bad_date", hint: "商談の日時を入れてください" });
    }
    const meetingUrl = safeUrl(body.meetingUrl);
    if (meetingUrl === false) return json(res, 400, { error: "bad_url", hint: "商談URLが正しくありません" });
    try {
      const r = await applyScheduled(sb, {
        meeting: m, company: c, scheduledAt: body.scheduledAt,
        meetingUrl: meetingUrl === undefined ? undefined : meetingUrl,
        employeeId: ctx.employee?.id || null, userId: user.id,
      });
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.meeting_schedule", target: `sales_company:${c.id}`, detail: { meetingId: m.id } });
      return json(res, 200, { meeting: shapeMeeting(r.meeting, nameOf) });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message || "failed" });
    }
  }

  if (body.action === "cancel") {
    if (!["scheduling", "scheduled"].includes(m.status)) return json(res, 409, { error: "closed" });
    const { data } = await sb.from("gw_sales_meetings").update({ status: "canceled", updated_at: now })
      .eq("id", m.id).eq("tenant_id", ctx.tenantId).select(MEETING_FIELDS).single();
    await sb.from("gw_sales_events").insert({
      tenant_id: ctx.tenantId, company_id: c.id, event_key: "meeting", label: "商談を取りやめ",
      detail: null, employee_id: ctx.employee?.id || null, created_by: user.id,
    });
    return json(res, 200, { meeting: shapeMeeting(data || m, nameOf) });
  }

  return json(res, 400, { error: "bad_action", allowed: ["sent", "schedule", "cancel"] });
}
