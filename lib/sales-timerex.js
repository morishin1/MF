// 営業（Sales）の TimeRex 予約を gw_sales_meetings へ反映する（/api/sales/timerex/webhook から呼ぶ）。
//
// ■ 実 Webhook で確認できたこと（DEBUG 受信：lib/sales-timerex-debug.js）
//   webhook_type = "event_confirmed" ／ calendar_url_path = 営業の初回商談カレンダー（b6915742）
//   event.id ／ event.start_datetime（オフセット付き）／ event.google_meet_meeting.join_url
//   event.form … field_type: company_name / guest_name / guest_email / guest_comment
//   予約URLに付けた sales_company_id / sales_meeting_id は Webhook に返ってこない
//
// ■ 商談の特定（初回予約）
//   guest_email の完全一致（大文字小文字は区別しない）。対象は status='scheduling'（日程調整中）の商談だけ。
//   企業のメールアドレス：contacts.email・いまの連絡手段がメールならその連絡先・（#44 以降）emails[]。
//   ちょうど1件に決まったときだけ反映する。0件・2件以上なら何も書かない（自動で選ばない）。
//   書き込みは、見つけた商談の tenant_id で必ず絞る（別テナントへは書かない）。
//
// ■ 再送
//   同じ event.id の商談がすでにあれば、日時・Meet URL が同じなら何もしない（二重に登録・記録しない）。
//   違っていれば日時・Meet URL・同期時刻だけを直す（TimeRex を正とする）。
//
// ■ 今回やらないこと（後続）
//   日程変更（is_changed / old_event_id）・キャンセルの Webhook。届いても何も書かない（形だけログ）。
//
// ■ 採用HRとは別
//   lib/hr-timerex.js・gw_hr_interviews・TIMEREX_WEBHOOK_SECRET は使わない。予約枠の読み方 calendarKey() だけ借りる。

import { calendarKey } from "./hr-timerex-calendars.js";
import { applyScheduled, MEETING_FIELDS } from "./sales-meetings.js";
import { gwLog } from "./gw-audit.js";

const CANDIDATE_LIMIT = 5000;

/** 営業の初回商談カレンダーの予約枠（TIMEREX_SALES_MEETING_URL の最後の部分） */
export const salesCalendarKey = (env = process.env) => calendarKey(env.TIMEREX_SALES_MEETING_URL);

const formValue = (form, type) => {
  if (!Array.isArray(form)) return null;
  const f = form.find((x) => x && x.field_type === type);
  const v = f && f.value != null ? String(f.value).trim() : "";
  return v || null;
};

const normEmail = (v) => String(v ?? "").trim().toLowerCase();

/**
 * TimeRex の生 body → 反映に使う値。処理しないものは { skip } / { error }
 * @returns {{event:{eventId:string, scheduledAt:string, meetingUrl:string|null, guestEmail:string}}
 *   | {skip:string, webhookType?:string} | {error:string, detail?:string}}
 */
export function parseSalesTimerex(body, env = process.env) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.webhook_type) return { error: "invalid_body" };
  const ev = body.event && typeof body.event === "object" && !Array.isArray(body.event) ? body.event : null;
  const key = salesCalendarKey(env);
  if (!key) return { error: "not_configured", detail: "TIMEREX_SALES_MEETING_URL が未設定です" };
  // 営業の初回商談カレンダー以外（採用HRの面談など）は処理しない
  const path = body.calendar_url_path ?? ev?.calendar_url_path ?? null;
  if (calendarKey(path) !== key) return { error: "not_sales_calendar" };
  // 予約確定だけ。日程変更・キャンセルは今回は扱わない（後続）
  if (body.webhook_type !== "event_confirmed") return { skip: "unsupported_webhook_type", webhookType: String(body.webhook_type).slice(0, 60) };
  if (ev?.is_changed) return { skip: "reschedule_not_supported" };
  if (!ev?.id) return { error: "invalid_body", detail: "event.id がありません" };
  if (!ev.start_datetime || Number.isNaN(new Date(ev.start_datetime).getTime())) {
    return { error: "invalid_body", detail: "start_datetime がありません" };
  }
  const guestEmail = normEmail(formValue(ev.form, "guest_email"));
  if (!guestEmail) return { error: "missing_guest_email" };
  const join = ev.google_meet_meeting && typeof ev.google_meet_meeting === "object" ? ev.google_meet_meeting.join_url : null;
  return {
    event: {
      eventId: String(ev.id), scheduledAt: new Date(ev.start_datetime).toISOString(),
      meetingUrl: typeof join === "string" && /^https:\/\//i.test(join) ? join : null, guestEmail,
    },
  };
}

/** 企業のメールアドレス（main の contacts・いまの連絡手段、#44 以降の emails[]） */
export function companyEmails(c) {
  const out = new Set();
  const add = (v) => { const e = normEmail(v); if (e) out.add(e); };
  if (c?.contacts && typeof c.contacts === "object") add(c.contacts.email);
  if (c?.current_contact_channel === "email") add(c.current_contact_value);
  if (Array.isArray(c?.emails)) c.emails.forEach(add);
  return out;
}

/**
 * 予約確定を反映する
 * @param {object} sb service_role の Supabase（Webhook は利用者のログインが無い）
 * @returns {Promise<{action:"scheduled"|"resynced"|"updated", meeting:object} | {error:string, detail?:string, count?:number}>}
 */
export async function applySalesBooking(sb, event) {
  // 1) 再送：同じ event.id の商談がすでにある
  const { data: same, error: e0 } = await sb.from("gw_sales_meetings").select(MEETING_FIELDS)
    .eq("timerex_event_id", event.eventId).limit(2);
  if (e0) return { error: "db_query_failed", detail: e0.message };
  if (same?.length) {
    const m = same[0];
    const unchanged = m.scheduled_at && Date.parse(m.scheduled_at) === Date.parse(event.scheduledAt)
      && (m.meeting_url || null) === (event.meetingUrl || null);
    if (unchanged) return { action: "resynced", meeting: m };
    const now = new Date().toISOString();
    const { data, error } = await sb.from("gw_sales_meetings")
      .update({ scheduled_at: event.scheduledAt, meeting_url: event.meetingUrl, timerex_synced_at: now, updated_at: now })
      .eq("id", m.id).eq("tenant_id", m.tenant_id).select(MEETING_FIELDS).single();
    if (error) return { error: "db_update_failed", detail: error.message };
    await gwLog({ tenantId: m.tenant_id, actorId: null, action: "sales.meeting_timerex_update",
      target: `sales_company:${m.company_id}`, detail: { meetingId: m.id, eventId: event.eventId } });
    return { action: "updated", meeting: data };
  }

  // 2) 初回：日程調整中の商談から、企業のメールアドレスが guest_email と完全一致するもの
  const { data: rows, error: e1 } = await sb.from("gw_sales_meetings")
    .select(`${MEETING_FIELDS}, company:gw_sales_companies(*)`)
    .eq("status", "scheduling").limit(CANDIDATE_LIMIT);
  if (e1) return { error: "db_query_failed", detail: e1.message };
  const hits = (rows || []).filter((m) => m.company && m.company.tenant_id === m.tenant_id
    && companyEmails(m.company).has(event.guestEmail));
  if (!hits.length) return { error: "meeting_not_found" };
  if (hits.length > 1) return { error: "ambiguous_meeting", count: hits.length };

  const { company, ...meeting } = hits[0];
  let r;
  try {
    r = await applyScheduled(sb, {
      meeting, company, scheduledAt: event.scheduledAt, meetingUrl: event.meetingUrl,
      timerexEventId: event.eventId, employeeId: null, userId: null,
    });
  } catch (e) {
    // 同時に届いた同じ予約（一意索引 tenant_id, timerex_event_id）なら、先に入ったほうで済んでいる
    if (e?.code === "23505") return { action: "resynced", meeting };
    return { error: "db_update_failed", detail: e?.message };
  }
  await gwLog({ tenantId: meeting.tenant_id, actorId: null, action: "sales.meeting_timerex_booked",
    target: `sales_company:${company.id}`, detail: { meetingId: meeting.id, eventId: event.eventId } });
  return { action: "scheduled", meeting: r.meeting };
}
