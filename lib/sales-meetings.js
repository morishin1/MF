// 営業の商談（/sales Phase 2）。db/090_sales_meetings.sql と1対1。
//
// ■ 流れ：リード → 商談を予定する（TimeRex の日程調整URLを発行） → 日程確定 → 商談予定
//
// ■ 日程確定は1か所（applyScheduled）
//   いまは画面から手で入れる。TimeRex Webhook を実装したら、受信口からも同じ関数を呼ぶ
//   （Webhook 側は payload を読んで、この関数に渡すだけにする）。
//
// ■ 採用DBと混ぜない
//   ここで触るのは gw_sales_meetings・gw_sales_companies・gw_sales_events だけ。

import { statusRank, todayJst, addBizDays, CLOSED_STATUSES } from "./sales.js";

export const MEETING_KINDS = [{ key: "first_meeting", label: "初回商談", minutes: 30 }];
export const MEETING_KIND_LABEL = Object.fromEntries(MEETING_KINDS.map((k) => [k.key, k.label]));
export const MEETING_STATUS_LABEL = {
  scheduling: "日程調整中", scheduled: "商談予定", done: "実施済み", canceled: "取りやめ",
};
export const MEETING_FIELDS = "id, tenant_id, company_id, owner_id, kind, duration_min, status, scheduling_url, "
  + "scheduling_sent_at, scheduled_at, meeting_url, timerex_event_id, timerex_synced_at, conducted_at, "
  + "recording_url, result, notes, created_at, updated_at";

export const NEXT_WAITING = "日程調整待ち（初回商談）";
export const NEXT_PREPARE = "商談準備";

/**
 * TimeRex の日程調整URL。HR（lib/hr.js schedulingUrlFor）と同じく、
 * どの会社・どの商談の予約かを URL に載せておく（Webhook で振り分けるため）
 */
export function salesSchedulingUrl(baseUrl, companyId, meetingId) {
  const base = String(baseUrl || "").trim();
  if (!base || !companyId || !meetingId) return null;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}sales_company_id=${encodeURIComponent(companyId)}&sales_meeting_id=${encodeURIComponent(meetingId)}`;
}

export const shapeMeeting = (m, nameOf = () => null) => ({
  id: m.id,
  companyId: m.company_id,
  ownerId: m.owner_id || null,
  ownerName: nameOf(m.owner_id) || null,
  kind: m.kind,
  kindLabel: MEETING_KIND_LABEL[m.kind] || m.kind,
  durationMin: m.duration_min,
  status: m.status,
  statusLabel: MEETING_STATUS_LABEL[m.status] || m.status,
  schedulingUrl: m.scheduling_url || null,
  schedulingSentAt: m.scheduling_sent_at || null,
  scheduledAt: m.scheduled_at || null,
  meetingUrl: m.meeting_url || null,
  fromTimerex: Boolean(m.timerex_synced_at),
  conductedAt: m.conducted_at || null,
  recordingUrl: m.recording_url || null,
  notes: m.notes || null,
  createdAt: m.created_at,
});

/** いま進んでいる商談（取りやめ・実施済みは除く）。新しいもの優先 */
export function activeMeeting(meetings) {
  return (meetings || [])
    .filter((m) => m.status === "scheduling" || m.status === "scheduled")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

const jstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const jstLabel = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000).toISOString();
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${d.slice(11, 16)}`;
};

/**
 * 日程が決まった。商談を「商談予定」にし、会社を「商談」へ進め、NEXT を「商談準備」（商談の日）にする。
 * 手入力と TimeRex Webhook の両方から呼ぶ。
 *
 * @param {object} sb Supabase（手入力はユーザーの権限、Webhook は service_role）
 * @param {{meeting:object, company:object, scheduledAt:string, meetingUrl?:string|null,
 *          timerexEventId?:string|null, employeeId?:string|null, userId?:string|null}} p
 * @returns {Promise<{meeting:object}>}
 */
export async function applyScheduled(sb, p) {
  const now = new Date().toISOString();
  const at = new Date(p.scheduledAt);
  if (Number.isNaN(at.getTime())) throw Object.assign(new Error("bad_date"), { status: 400 });
  const patch = {
    status: "scheduled", scheduled_at: at.toISOString(), updated_at: now,
    ...(p.meetingUrl !== undefined ? { meeting_url: p.meetingUrl || null } : {}),
    ...(p.timerexEventId ? { timerex_event_id: p.timerexEventId, timerex_synced_at: now } : {}),
  };
  const { data: meeting, error } = await sb.from("gw_sales_meetings").update(patch)
    .eq("id", p.meeting.id).eq("tenant_id", p.meeting.tenant_id).select(MEETING_FIELDS).single();
  if (error) throw error;

  // 会社は「商談」へ（前へ進めるだけ。後ろへは戻さない）。NEXT は商談の日に「商談準備」。
  // 成約・失注・対象外（CLOSED_STATUSES）と営業禁止（ng_reason）の会社は、状態も NEXT も変えない
  // （失注・対象外は statusRank が -1 なので、比べるだけだと「商談」へ戻してしまう）
  const closed = Boolean(p.company.ng_reason) || CLOSED_STATUSES.includes(p.company.status);
  if (!closed) {
    const cpatch = { next_action: NEXT_PREPARE, next_action_on: jstDate(at), followed_at: now, updated_at: now };
    if (statusRank("meeting") > statusRank(p.company.status)) cpatch.status = "meeting";
    await sb.from("gw_sales_companies").update(cpatch).eq("id", p.company.id).eq("tenant_id", p.company.tenant_id);
  }

  await sb.from("gw_sales_events").insert({
    tenant_id: p.company.tenant_id, company_id: p.company.id, event_key: "meeting",
    label: `商談予定：${jstLabel(at)}（${MEETING_KIND_LABEL[meeting.kind] || "商談"}）`,
    detail: [p.timerexEventId ? "TimeRexで確定" : "手入力", meeting.meeting_url || null].filter(Boolean).join(" ／ "),
    employee_id: p.employeeId || null, created_by: p.userId || null,
  });
  return { meeting };
}

/** 日程調整URLを送った。相手の予約待ちの NEXT を3営業日後に置く */
export function waitingNext(now = new Date()) {
  return { next_action: NEXT_WAITING, next_action_on: addBizDays(todayJst(now), 3) };
}
