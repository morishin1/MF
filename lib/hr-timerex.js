// TimeRex Webhook から届く予約を、既存の gw_hr_interviews / gw_hr_applicants へ反映する。
// カジュアル面談・社長面談の両方に対応する（どちらかは予約枠 calendar_url_path で決める）。
//
// ■ 正規化イベントの形（applyTimerexEvent() への入力。TimeRex の生 payload ではない）
//   {
//     type: "booked" | "rescheduled" | "canceled",
//     kind: "casual" | "ceo",          // 予約枠から決めた面談の種類（lib/hr-timerex-calendars.js）
//     eventId: string,                 // TimeRex の予約ごとの一意ID → timerex_event_id
//     previousEventId?: string,        // 日程変更で event_id が変わったときの旧ID（old_event_id）
//     applicantId: string,
//     scheduledAt?: string,            // ISO8601
//     meetingUrl?: string,             // Google Meet
//     calendarPath?: string,           // どの予約枠からか
//     rescheduleUrl?, guestCancelUrl?, hostCancelUrl?  // TimeRex の日程変更・取消の導線
//   }
//
// ■ 実 payload で確認できた構造（event_confirmed）
//   webhook_type = "event_confirmed"
//   event.id / start_datetime / local_start_datetime
//   event.google_meet_meeting.join_url
//   event.form … [{ field_type: "guest_name"|"guest_email"|"company_name"|"guest_comment", value }]
//   event.is_changed / old_event_id / new_event_id … 日程変更
//   event.calendar_url_path … 予約枠
//   event.guest_reschedule_url / guest_cancel_url / host_cancel_url … TimeRex の変更・取消の導線
//
// ■ キャンセルの Webhook
//   event名・payload がまだ実ログで確認できていない。推測で実装しない。
//   環境変数 TIMEREX_CANCEL_WEBHOOK_TYPES（例 "event_canceled"）に実際の event 名を入れたときだけ
//   キャンセルとして受け付ける（入れるまでは unsupported_webhook_type で止め、event 名だけを記録する）。
//   DB 側のキャンセル処理（canceled_at・応募者の状態を戻す）は用意してある。
//
// ■ 応募者の特定（名前だけでは照合しない）
//   1. payload の applicant_id
//   2. 同じ event_id（再送）・旧 event_id（日程変更）の面談がすでにあれば、その応募者
//   3. guest_email の完全一致。面談の種類ごとの対象ステータス（カジュアル＝scheduling、
//      社長＝ceo_interview_pending）で1名だけのとき。0名は applicant_not_found、
//      2名以上は ambiguous_applicant（自動で決めない）
//
// ■ ログ
//   監査ログ・コンソールに URL（Meet・日程変更・取消）やメールアドレスを残さない。

import { admin } from "./supabase.js";
import { gwLog } from "./gw-audit.js";
import { notify } from "./notify.js";
import { interviewKindLabel, decisionMakerEmployeeIds } from "./hr.js";
import { KIND_RULES, TIMEREX_KINDS, kindForCalendar, calendarKey } from "./hr-timerex-calendars.js";

const jstTime = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/** @returns {Promise<{action:string,interview?:object}|{error:string,detail?:string}>} */
export async function applyTimerexEvent(event) {
  if (!event || typeof event !== "object") return { error: "invalid_event" };
  if (!event.applicantId) return { error: "missing_applicant_id" };
  if (!event.eventId) return { error: "missing_event_id" };
  if (!TIMEREX_KINDS.includes(event.kind)) return { error: "unknown_timerex_calendar" };

  const sb = admin();
  // applicant_id だけで応募者を特定する。同じ id のテナントをそのまま使う
  const { data: applicant, error: aerr } = await sb.from("gw_hr_applicants")
    .select("id, tenant_id, name, status, stage")
    .eq("id", event.applicantId).maybeSingle();
  if (aerr) return { error: "db_query_failed", detail: aerr.message };
  if (!applicant) return { error: "applicant_not_found" };

  if (event.type === "canceled") return cancelByEvent(sb, applicant, event);
  if (event.type === "booked" || event.type === "rescheduled") return upsertByEvent(sb, applicant, event);
  return { error: "unknown_event_type" };
}

/** TimeRex から来た値（無いものは既存の値を残す） */
function timerexFields(event, prev = {}) {
  return {
    scheduled_at: event.scheduledAt,
    meeting_url: event.meetingUrl || prev.meeting_url || null,
    timerex_calendar_path: event.calendarPath || prev.timerex_calendar_path || null,
    timerex_reschedule_url: event.rescheduleUrl || prev.timerex_reschedule_url || null,
    timerex_guest_cancel_url: event.guestCancelUrl || prev.timerex_guest_cancel_url || null,
    timerex_host_cancel_url: event.hostCancelUrl || prev.timerex_host_cancel_url || null,
    timerex_synced_at: new Date().toISOString(),
  };
}

async function upsertByEvent(sb, applicant, event) {
  if (!event.scheduledAt) return { error: "missing_scheduled_at" };

  // 1) 同じ予約からの再送（同じ event_id）。面談を増やさず更新する
  const { data: byEventId } = await sb.from("gw_hr_interviews").select("*")
    .eq("tenant_id", applicant.tenant_id).eq("timerex_event_id", event.eventId).maybeSingle();
  if (byEventId) {
    const { data, error } = await sb.from("gw_hr_interviews")
      .update({ ...timerexFields(event, byEventId), canceled_at: null })
      .eq("id", byEventId.id).select("*").single();
    if (error) return { error: "db_update_failed", detail: error.message };
    await afterSchedule(sb, applicant, data, event, { resynced: true });
    return { action: "resynced", interview: data };
  }

  // 2) 日程変更で event_id そのものが変わった（old_event_id → new_event_id）。旧IDの面談を引き継ぐ
  if (event.previousEventId) {
    const { data: byPrevId } = await sb.from("gw_hr_interviews").select("*")
      .eq("tenant_id", applicant.tenant_id).eq("timerex_event_id", event.previousEventId).maybeSingle();
    if (byPrevId) {
      const { data, error } = await sb.from("gw_hr_interviews")
        .update({ ...timerexFields(event, byPrevId), timerex_event_id: event.eventId, canceled_at: null })
        .eq("id", byPrevId.id).select("*").single();
      if (error) return { error: "db_update_failed", detail: error.message };
      await afterSchedule(sb, applicant, data, event, { rescheduled: true });
      return { action: "rescheduled", interview: data };
    }
  }

  // 3) 同じ種類の、まだ TimeRex と紐付いていない手動設定の面談があれば引き継ぐ（二重に作らない）
  const { data: manual } = await sb.from("gw_hr_interviews").select("*")
    .eq("tenant_id", applicant.tenant_id).eq("applicant_id", applicant.id).eq("kind", event.kind)
    .is("conducted_at", null).is("canceled_at", null).is("timerex_event_id", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (manual) {
    const { data, error } = await sb.from("gw_hr_interviews")
      .update({ ...timerexFields(event, manual), timerex_event_id: event.eventId })
      .eq("id", manual.id).select("*").single();
    if (error) return { error: "db_update_failed", detail: error.message };
    await afterSchedule(sb, applicant, data, event, { adoptedManual: true });
    return { action: "adopted_manual", interview: data };
  }

  // 4) 新しい予約
  const { data, error } = await sb.from("gw_hr_interviews").insert({
    tenant_id: applicant.tenant_id, applicant_id: applicant.id, kind: event.kind,
    ...timerexFields(event), timerex_event_id: event.eventId,
  }).select("*").single();
  if (error) return { error: "db_insert_failed", detail: error.message };
  await afterSchedule(sb, applicant, data, event, { created: true });
  return { action: "created", interview: data };
}

async function afterSchedule(sb, applicant, interview, event, meta) {
  const now = new Date().toISOString();
  const rule = KIND_RULES[interview.kind] || KIND_RULES[event.kind];
  // 実施済みの面談の再送で、先へ進んだ状態を巻き戻さない
  if (!interview.conducted_at) {
    await sb.from("gw_hr_applicants")
      .update({ stage: rule.booked.stage, status: rule.booked.status, updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
  }
  if (!meta.resynced) {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id,
      event_key: meta.rescheduled ? "interview_rescheduled" : "interview_scheduled",
      label: `${interviewKindLabel(interview.kind)}${meta.rescheduled ? "の日程が変わりました" : "が決まりました"}（TimeRex）`,
      detail: interview.scheduled_at ? jstTime(interview.scheduled_at) : null,
    });
  }
  // 社長面談が入ったら、判断できる人へ知らせる（手動で社長面談を入れたときと同じ通知・同じ重複防止キー）
  if (interview.kind === "ceo" && !meta.resynced) {
    const targets = await decisionMakerEmployeeIds(sb, applicant.tenant_id);
    await notify(targets.map((employeeId) => ({
      tenantId: applicant.tenant_id, employeeId, kind: "hr",
      title: meta.rescheduled ? "社長面談の日程が変わりました" : "社長面談が入りました",
      body: [applicant.name, interview.scheduled_at ? jstTime(interview.scheduled_at) : null].filter(Boolean).join("\n"),
      link: "/hr/ceo-review.html",
      dedupeKey: meta.rescheduled ? `hr_ceo_meeting:${interview.id}:${interview.scheduled_at}` : `hr_ceo_meeting:${interview.id}`,
    })));
  }
  await gwLog({
    tenantId: applicant.tenant_id, actorId: null, action: "hr.timerex_interview_sync",
    target: `hr_interview:${interview.id}`,
    detail: { applicantId: applicant.id, kind: interview.kind, eventId: interview.timerex_event_id,
              calendar: calendarKey(interview.timerex_calendar_path), ...meta },
  });
}

async function cancelByEvent(sb, applicant, event) {
  const { data: existing } = await sb.from("gw_hr_interviews").select("*")
    .eq("tenant_id", applicant.tenant_id).eq("timerex_event_id", event.eventId).maybeSingle();
  if (!existing) return { error: "interview_not_found" };
  if (existing.canceled_at) return { action: "already_canceled", interview: existing };
  if (existing.conducted_at) return { error: "already_conducted" };

  const now = new Date().toISOString();
  // 物理削除しない。canceled_at を立てるだけ
  const { data, error } = await sb.from("gw_hr_interviews")
    .update({ canceled_at: now, timerex_synced_at: now }).eq("id", existing.id).select("*").single();
  if (error) return { error: "db_update_failed", detail: error.message };

  // 日程調整のやり直しへ戻す（カジュアル＝scheduling、社長＝ceo_interview / ceo_interview_pending）
  const back = (KIND_RULES[existing.kind] || KIND_RULES.casual).canceled;
  await sb.from("gw_hr_applicants")
    .update({ ...back, updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "interview_canceled",
    label: `${interviewKindLabel(existing.kind)}をキャンセル（TimeRex）`,
  });
  await gwLog({
    tenantId: applicant.tenant_id, actorId: null, action: "hr.timerex_interview_cancel",
    target: `hr_interview:${existing.id}`, detail: { applicantId: applicant.id, kind: existing.kind, eventId: event.eventId },
  });
  return { action: "canceled", interview: data };
}

// ---- 生 Webhook payload の解析 --------------------------------------------------

const FIELD_TYPE_GUEST_EMAIL = "guest_email";

function formFieldValue(form, fieldType) {
  if (!Array.isArray(form)) return null;
  const hit = form.find((f) => f && f.field_type === fieldType);
  return hit && hit.value != null ? String(hit.value).trim() : null;
}

/** event にあれば event、無ければ body の値（どちらの階層に来ても読めるように） */
const pick = (ev, body, key) => {
  const v = (ev && ev[key] != null ? ev[key] : body && body[key] != null ? body[key] : null);
  return v == null || v === "" ? null : String(v);
};

/** キャンセルとして受け付ける webhook_type（実ログで確認したものだけを環境変数で有効にする） */
export const cancelWebhookTypes = (env = process.env) =>
  String(env.TIMEREX_CANCEL_WEBHOOK_TYPES || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * 応募者を特定する。名前だけでの照合はしない。
 * @param {"casual"|"ceo"} kind 面談の種類（guest_email で探す対象ステータスが変わる）
 * @returns {Promise<{applicantId:string}|{error:string,detail?:string}>}
 */
export async function resolveTimerexApplicantId(event, body, kind) {
  // 1) payload の applicant_id
  const direct = (body && body.applicant_id) || (event && event.applicant_id) || null;
  if (direct) return { applicantId: String(direct) };

  const sb = admin();

  // 2) 同じ event_id（再送）・旧 event_id（日程変更）の面談がすでにあれば、その応募者。
  //    1回目の反映で応募者の status は先へ進んでいるので、メールで探し直すと見つからない
  for (const id of [event && event.id, event && event.is_changed ? event.old_event_id : null]) {
    if (!id) continue;
    const { data: existing, error: eerr } = await sb.from("gw_hr_interviews")
      .select("applicant_id").eq("timerex_event_id", String(id)).limit(1).maybeSingle();
    if (eerr) return { error: "db_query_failed", detail: eerr.message };
    if (existing) return { applicantId: existing.applicant_id };
  }

  // 3) guest_email の完全一致。面談の種類ごとの対象ステータスで、1名だけのとき
  const guestEmail = formFieldValue(event && event.form, FIELD_TYPE_GUEST_EMAIL) || pick(event, body, "guest_email");
  if (!guestEmail) return { error: "applicant_not_found" };
  const statuses = (KIND_RULES[kind] || KIND_RULES.casual).searchStatuses;
  const { data, error } = await sb.from("gw_hr_applicants").select("id")
    .eq("email", guestEmail).in("status", statuses);
  if (error) return { error: "db_query_failed", detail: error.message };
  const rows = data || [];
  if (rows.length === 0) return { error: "applicant_not_found" };
  if (rows.length > 1) return { error: "ambiguous_applicant" };
  return { applicantId: rows[0].id };
}

/**
 * TimeRex の生 Webhook body を、applyTimerexEvent() が受け取る正規化イベントへ変換する。
 * @returns {Promise<{event:object}|{error:string,detail?:string,webhookType?:string}>}
 */
export async function parseTimerexWebhook(body, env = process.env) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  if (!body.webhook_type) return { error: "invalid_body" };
  const isCancel = cancelWebhookTypes(env).includes(body.webhook_type);
  // event_confirmed と、実ログで確認して設定したキャンセル以外は推測で処理しない
  if (body.webhook_type !== "event_confirmed" && !isCancel) {
    return { error: "unsupported_webhook_type", webhookType: String(body.webhook_type).slice(0, 60) };
  }

  const ev = body.event;
  if (!ev || typeof ev !== "object" || !ev.id) return { error: "invalid_body" };

  // どの予約枠からか → 面談の種類。知らない予約枠はカジュアル扱いにせず止める
  const calendarPath = pick(ev, body, "calendar_url_path");
  const kind = kindForCalendar(calendarPath, env);
  if (!kind) return { error: "unknown_timerex_calendar", detail: calendarKey(calendarPath) || "calendar_url_pathがありません" };

  const resolved = await resolveTimerexApplicantId(ev, body, kind);
  if (resolved.error) return resolved;

  if (isCancel) {
    return { event: { type: "canceled", kind, eventId: String(ev.id), applicantId: resolved.applicantId } };
  }
  if (!ev.start_datetime) return { error: "invalid_body", detail: "start_datetimeがありません" };

  const base = {
    kind, eventId: String(ev.id), applicantId: resolved.applicantId, scheduledAt: ev.start_datetime,
    meetingUrl: (ev.google_meet_meeting && ev.google_meet_meeting.join_url) || null,
    calendarPath,
    rescheduleUrl: pick(ev, body, "guest_reschedule_url"),
    guestCancelUrl: pick(ev, body, "guest_cancel_url"),
    hostCancelUrl: pick(ev, body, "host_cancel_url"),
  };
  // is_changed + old_event_id があれば日程変更（旧IDの面談を新IDへ引き継ぐ）
  if (ev.is_changed && ev.old_event_id) {
    return { event: { ...base, type: "rescheduled", previousEventId: String(ev.old_event_id) } };
  }
  return { event: { ...base, type: "booked" } };
}
