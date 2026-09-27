// TimeRex Webhookから届く「予約確定・変更・キャンセル」を、既存の
// gw_hr_interviews / gw_hr_applicants へ反映する処理（採用HR Phase 4A指示書）。
//
// ■ ここではTimeRexの実payload構造をまだ扱わない
//   TimeRex公式の実event名・payloadのフィールドパス・署名/認証方式を、実際の
//   テスト予約1件のpayloadでまだ確認できていない（同指示書「最重要」）。
//   推測でこれらを実装すると、誤った応募者へ面談を紐付けたり、公式仕様と
//   食い違う認証方式を作ってしまうおそれがあるため、確認できるまでは
//   「生のTimeRex payloadを読む層」（api/hr/timerex/webhook.js）を完成させない。
//
//   この関数は、その生payloadを読む層が確認後に変換する「正規化イベント」を
//   受け取る形にしておくことで、DB反映・冪等性・応募者状態遷移・手動運用との
//   共存だけを先に完成させ、テストできるようにする。
//
// ■ 正規化イベントの形（このモジュールへの入力。TimeRexの生payloadではない）
//   {
//     type: "booked" | "rescheduled" | "canceled",
//     eventId: string,            // TimeRexの予約ごとの一意ID → timerex_event_id
//     previousEventId?: string,   // 変更でevent_idそのものが変わる場合の旧ID
//     applicantId: string,        // 日程調整URLのapplicant_idパラメータ由来。
//                                 // 名前・メールだけでの照合はしない（README「TimeRex連携」指示書 §11）
//     scheduledAt?: string,       // ISO8601
//     meetingUrl?: string,
//   }

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
