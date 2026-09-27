// TimeRex Webhookから届く「予約確定・変更・キャンセル」を、既存の
// gw_hr_interviews / gw_hr_applicants へ反映する処理（採用HR Phase 4A指示書）。
//
// ■ 正規化イベントの形（applyTimerexEvent()への入力。TimeRexの生payloadではない）
//   {
//     type: "booked" | "rescheduled" | "canceled",
//     eventId: string,            // TimeRexの予約ごとの一意ID → timerex_event_id
//     previousEventId?: string,   // 変更でevent_idそのものが変わる場合の旧ID
//     applicantId: string,
//     scheduledAt?: string,       // ISO8601
//     meetingUrl?: string,
//   }
//
// ■ 実payloadで確認できた構造（TimeRex Webhook parser 最終実装指示）
//   webhook_type = "event_confirmed"
//   body.event.id / start_datetime / local_start_datetime
//   body.event.google_meet_meeting.join_url
//   body.event.form … [{ field_type: "guest_name"|"guest_email"|"company_name"|"guest_comment", value }]
//   body.event.is_changed / old_event_id / new_event_id … 日程変更
//
//   キャンセル時のwebhook_typeは未確認のため、event_confirmed以外は
//   parseTimerexWebhook()が unsupported_webhook_type として弾く（推測しない）。
//
// ■ 応募者識別（優先順位。名前だけでの照合はしない）
//   1. 将来payloadにapplicant_idが含まれるようになった場合はそれを最優先
//      （実payloadには現状含まれていないが、含まれた場合に備えて先に見る）
//   2. guest_emailの完全一致。ただし status=scheduling かつ一致が1名のみの場合だけ
//      自動反映する。0件はapplicant_not_found、2件以上はambiguous_applicantとして
//      DBを更新しない

import { admin } from "./supabase.js";
import { gwLog } from "./gw-audit.js";
import { interviewKindLabel } from "./hr.js";

/** @returns {Promise<{action:string,interview?:object}|{error:string,detail?:string}>} */
export async function applyTimerexEvent(event) {
  if (!event || typeof event !== "object") return { error: "invalid_event" };
  if (!event.applicantId) return { error: "missing_applicant_id" };
  if (!event.eventId) return { error: "missing_event_id" };

  const sb = admin();
  // applicant_idだけで応募者を特定する。同じidのテナントをそのまま使う
  // （webhook側から別途tenant_idを受け取って突き合わせる設計にはしない。
  //   偽装されたtenant_idを信じるより、実在するapplicant_id一致だけを根拠にする）
  const { data: applicant, error: aerr } = await sb.from("gw_hr_applicants")
    .select("id, tenant_id, name, status, stage")
    .eq("id", event.applicantId).maybeSingle();
  if (aerr) return { error: "db_query_failed", detail: aerr.message };
  if (!applicant) return { error: "applicant_not_found" };

  if (event.type === "canceled") return cancelByEvent(sb, applicant, event);
  if (event.type === "booked" || event.type === "rescheduled") return upsertByEvent(sb, applicant, event);
  return { error: "unknown_event_type" };
}

async function upsertByEvent(sb, applicant, event) {
  if (!event.scheduledAt) return { error: "missing_scheduled_at" };
  const now = new Date().toISOString();

  // 1) 同じ予約からの再送（同じevent_id）。Webhookは必ず冪等にする（同指示書 §5）
  const { data: byEventId } = await sb.from("gw_hr_interviews").select("*")
    .eq("tenant_id", applicant.tenant_id).eq("timerex_event_id", event.eventId).maybeSingle();
  if (byEventId) {
    const { data, error } = await sb.from("gw_hr_interviews").update({
      scheduled_at: event.scheduledAt, meeting_url: event.meetingUrl || byEventId.meeting_url,
      timerex_synced_at: now, canceled_at: null,
    }).eq("id", byEventId.id).select("*").single();
    if (error) return { error: "db_update_failed", detail: error.message };
    await afterSchedule(sb, applicant, data, { resynced: true });
    return { action: "resynced", interview: data };
  }

  // 2) 変更でevent_idそのものが変わった場合。旧IDの行を新IDへ引き継ぐ
  //    （公式仕様でold_event_id/new_event_idの関係が確認できたら、ここへ反映する。
  //    それまではpreviousEventIdが渡されたときだけ、既存行の更新として扱う）
  if (event.previousEventId) {
    const { data: byPrevId } = await sb.from("gw_hr_interviews").select("*")
      .eq("tenant_id", applicant.tenant_id).eq("timerex_event_id", event.previousEventId).maybeSingle();
    if (byPrevId) {
      const { data, error } = await sb.from("gw_hr_interviews").update({
        scheduled_at: event.scheduledAt, meeting_url: event.meetingUrl || byPrevId.meeting_url,
        timerex_event_id: event.eventId, timerex_synced_at: now, canceled_at: null,
      }).eq("id", byPrevId.id).select("*").single();
      if (error) return { error: "db_update_failed", detail: error.message };
      await afterSchedule(sb, applicant, data, { rescheduled: true });
      return { action: "rescheduled", interview: data };
    }
  }

  // 3) この応募者に、まだTimeRexと紐付いていない手動設定ずみの面談があれば、
  //    それをTimeRex連携の行として引き継ぐ（手動運用との共存。同指示書 §9。
  //    二重に面談を作らない。既存の「同じ種別の未実施面談があれば二重登録を断る」
  //    という手動側の制約と矛盾しないようにする）
  const { data: manual } = await sb.from("gw_hr_interviews").select("*")
    .eq("tenant_id", applicant.tenant_id).eq("applicant_id", applicant.id).eq("kind", "casual")
    .is("conducted_at", null).is("canceled_at", null).is("timerex_event_id", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (manual) {
    const { data, error } = await sb.from("gw_hr_interviews").update({
      scheduled_at: event.scheduledAt, meeting_url: event.meetingUrl || manual.meeting_url,
      timerex_event_id: event.eventId, timerex_synced_at: now,
    }).eq("id", manual.id).select("*").single();
    if (error) return { error: "db_update_failed", detail: error.message };
    await afterSchedule(sb, applicant, data, { adoptedManual: true });
    return { action: "adopted_manual", interview: data };
  }

  // 4) 新規予約
  const { data, error } = await sb.from("gw_hr_interviews").insert({
    tenant_id: applicant.tenant_id, applicant_id: applicant.id, kind: "casual",
    scheduled_at: event.scheduledAt, meeting_url: event.meetingUrl || null,
    timerex_event_id: event.eventId, timerex_synced_at: now,
  }).select("*").single();
  if (error) return { error: "db_insert_failed", detail: error.message };
  await afterSchedule(sb, applicant, data, { created: true });
  return { action: "created", interview: data };
}

async function afterSchedule(sb, applicant, interview, meta) {
  const now = new Date().toISOString();
  await sb.from("gw_hr_applicants")
    .update({ stage: "casual_interview", status: "interview_scheduled", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "interview_scheduled",
    label: `${interviewKindLabel(interview.kind)}が決まりました（TimeRex）`,
  });
  await gwLog({
    tenantId: applicant.tenant_id, actorId: null, action: "hr.timerex_interview_sync",
    target: `hr_interview:${interview.id}`,
    detail: { applicantId: applicant.id, eventId: interview.timerex_event_id, ...meta },
  });
}

async function cancelByEvent(sb, applicant, event) {
  const { data: existing } = await sb.from("gw_hr_interviews").select("*")
    .eq("tenant_id", applicant.tenant_id).eq("timerex_event_id", event.eventId).maybeSingle();
  if (!existing) return { error: "interview_not_found" };
  if (existing.canceled_at) return { action: "already_canceled", interview: existing };
  if (existing.conducted_at) return { error: "already_conducted" };

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_interviews")
    .update({ canceled_at: now }).eq("id", existing.id).select("*").single();
  if (error) return { error: "db_update_failed", detail: error.message };

  // カジュアル面談キャンセル後は、日程調整のやり直し（README「応募者一覧・
  // ドロワーUI改善」指示書 §3 と同じ規則。応募者を削除しない、面談も物理削除しない）
  await sb.from("gw_hr_applicants")
    .update({ status: "scheduling", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "interview_canceled",
    label: `${interviewKindLabel(existing.kind)}をキャンセル（TimeRex）`,
  });
  await gwLog({
    tenantId: applicant.tenant_id, actorId: null, action: "hr.timerex_interview_cancel",
    target: `hr_interview:${existing.id}`, detail: { applicantId: applicant.id, eventId: event.eventId },
  });
  return { action: "canceled", interview: data };
}

// ---- 生Webhook payloadの解析 --------------------------------------------------

const FIELD_TYPE_GUEST_EMAIL = "guest_email";

function formFieldValue(form, fieldType) {
  if (!Array.isArray(form)) return null;
  const hit = form.find((f) => f && f.field_type === fieldType);
  return hit && hit.value != null ? String(hit.value) : null;
}

/**
 * 応募者を特定する。名前だけでの照合はしない（TimeRex連携指示書 §11・
 * Webhook parser最終実装指示）。
 * @returns {Promise<{applicantId:string}|{error:string,detail?:string}>}
 */
export async function resolveTimerexApplicantId(event, body) {
  // 1) 将来payloadにapplicant_idが含まれるようになった場合は最優先
  const direct = (body && body.applicant_id) || (event && event.applicant_id) || null;
  if (direct) return { applicantId: String(direct) };

  const sb = admin();

  // 2) 同じevent_idの面談が既にあれば、その応募者へそのまま引き継ぐ
  //    （Webhook再送の冪等性。最初の反映で応募者のstatusはscheduling以外へ
  //    進んでいるため、再送のたびにemailをstatus=schedulingで探し直すと
  //    見つからなくなってしまう）
  if (event && event.id) {
    const { data: existing, error: eerr } = await sb.from("gw_hr_interviews")
      .select("applicant_id").eq("timerex_event_id", event.id).limit(1).maybeSingle();
    if (eerr) return { error: "db_query_failed", detail: eerr.message };
    if (existing) return { applicantId: existing.applicant_id };
  }

  // 3) guest_emailの完全一致。status=scheduling かつ1名のみの場合だけ自動反映する
  const guestEmail = formFieldValue(event && event.form, FIELD_TYPE_GUEST_EMAIL);
  if (!guestEmail) return { error: "applicant_not_found" };

  const { data, error } = await sb.from("gw_hr_applicants").select("id")
    .eq("email", guestEmail).eq("status", "scheduling");
  if (error) return { error: "db_query_failed", detail: error.message };
  const rows = data || [];
  if (rows.length === 0) return { error: "applicant_not_found" };
  if (rows.length > 1) return { error: "ambiguous_applicant" };
  return { applicantId: rows[0].id };
}

/**
 * TimeRexの生Webhook bodyを、applyTimerexEvent() が受け取る正規化イベントへ変換する。
 * @returns {Promise<{event:object}|{error:string,detail?:string}>}
 */
export async function parseTimerexWebhook(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  if (!body.webhook_type) return { error: "invalid_body" };
  // event_confirmed以外（キャンセル等）のwebhook_typeは未確認のため、推測で処理しない
  if (body.webhook_type !== "event_confirmed") return { error: "unsupported_webhook_type" };

  const ev = body.event;
  if (!ev || typeof ev !== "object" || !ev.id) return { error: "invalid_body" };
  if (!ev.start_datetime) return { error: "invalid_body", detail: "start_datetimeがありません" };

  const resolved = await resolveTimerexApplicantId(ev, body);
  if (resolved.error) return resolved;

  const meetingUrl = (ev.google_meet_meeting && ev.google_meet_meeting.join_url) || null;

  // is_changed + old_event_idがある場合は日程変更（旧IDの行を新IDへ引き継ぐ）。
  // new_event_idはこの確定payload自身のevent.idと同じ想定のため、ここでは使わない
  if (ev.is_changed && ev.old_event_id) {
    return {
      event: {
        type: "rescheduled", eventId: ev.id, previousEventId: ev.old_event_id,
        applicantId: resolved.applicantId, scheduledAt: ev.start_datetime, meetingUrl,
      },
    };
  }
  return {
    event: {
      type: "booked", eventId: ev.id,
      applicantId: resolved.applicantId, scheduledAt: ev.start_datetime, meetingUrl,
    },
  };
}
