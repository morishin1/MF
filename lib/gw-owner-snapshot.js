// Owner-only GW copy. Server reads existing business sources; no credential leaves the server.
// Activation is separate from deployment. No caller-selected recipient, tenant, date or content.
import { createHash, timingSafeEqual } from "node:crypto";
import { ymd, dateTime, parts } from "./jst.js";
import { isLeftEmployee } from "./left-gate.js";
import { mailConfig, sendMail } from "./mail/index.js";

export const VERSION = "gw-owner-snapshot-v1";
export const RECIPIENT = "s_morita@gw.8grp.co.jp";
export const SENDER = "saiyou@8grp.co.jp";
export const SOURCE = "https://gw.8grp.co.jp";
export const MAX_ROWS = 5000;
export const INITIAL_DATE = "2026-10-28";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const clean = (x, max = 600) => typeof x === "string" ? x.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : null;
const number = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
const validTime = (x) => typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null;
const active = (e, today) => ["active", "leaving"].includes(e.status) && !isLeftEmployee(e, today) && (!e.joined_on || e.joined_on <= today);

export function authorized(header, secret) {
  if (typeof secret !== "string" || !secret.trim() || typeof header !== "string") return false;
  const a = Buffer.from(header), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function snapshotConfig(env = process.env, now = new Date()) {
  if (env.GW_OWNER_SNAPSHOT_ENABLED !== "1") return { ok: false, reason: "disabled" };
  if (env.VERCEL_ENV !== "production") return { ok: false, reason: "production_only" };
  const tenantId = String(env.GW_OWNER_SNAPSHOT_TENANT_ID || "");
  const ownerId = String(env.GW_OWNER_SNAPSHOT_OWNER_EMPLOYEE_ID || "");
  const consentAt = validTime(env.GW_OWNER_SNAPSHOT_CONSENT_AT);
  if (!UUID.test(tenantId) || !UUID.test(ownerId) || !consentAt || Date.parse(consentAt) > now.getTime())
    return { ok: false, reason: "binding_or_consent_missing" };
  if (env.GW_OWNER_SNAPSHOT_ROSTER_CONFIRMED !== "1") return { ok: false, reason: "roster_unreviewed" };
  const excluded = String(env.GW_OWNER_SNAPSHOT_EXCLUDED_EMPLOYEE_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (excluded.some(x => !UUID.test(x)) || excluded.includes(ownerId)) return { ok: false, reason: "invalid_exclusions" };
  const mail = mailConfig("gw_snapshot", env);
  if (!mail.configured || mail.provider !== "smtp" || mail.fromAddress?.toLowerCase() !== SENDER)
    return { ok: false, reason: "approved_sender_unavailable" };
  return { ok: true, tenantId, ownerId, consentAt, excluded, initialDate: env.GW_OWNER_SNAPSHOT_INITIAL_DATE || null };
}

// Fixed scheduled windows; callers cannot replay arbitrary history or request another mailbox.
export function slotFor(now, requested, cfg) {
  const p = parts(now), minute = p.hh * 60 + p.mm;
  if (requested === "initial") return cfg.initialDate === INITIAL_DATE && ymd(now) === INITIAL_DATE ? "initial" : null;
  if (requested && !["morning", "evening"].includes(requested)) return null;
  const slot = minute >= 470 && minute < 500 ? "morning" : minute >= 1040 && minute < 1070 ? "evening" : null;
  return (!requested || requested === slot) ? slot : null;
}

async function rows(query, source, issues, { fallback } = {}) {
  try {
    const r = await query.limit(MAX_ROWS + 1);
    if (r.error && fallback && ["42703", "PGRST204"].includes(r.error.code)) {
      issues.push(`${source}:planned_quantity_columns_unavailable`);
      return rows(fallback(), source, issues);
    }
    if (r.error || !Array.isArray(r.data)) { issues.push(`${source}:read_failed`); return []; }
    if (r.data.length > MAX_ROWS || (typeof r.count === "number" && r.count > r.data.length)) { issues.push(`${source}:limit_exceeded`); return []; }
    return r.data;
  } catch { issues.push(`${source}:read_failed`); return []; }
}

export async function readSnapshot(sb, cfg, now = new Date(), actorUserId = null) {
  const today = ymd(now), from = addDays(today, -7), until = addDays(today, 7), issues = [];
  const tenant = (table, columns) => sb.from(table).select(columns, { count: "exact" }).eq("tenant_id", cfg.tenantId);
  const roster = await rows(tenant("gw_employees", "id,user_id,display_name,department,position,status,joined_on,left_on"), "roster", issues);
  if (issues.length) throw new Error("roster_unavailable");
  const owner = roster.find(e => e.id === cfg.ownerId && active(e, today));
  if (!owner?.user_id) throw new Error("owner_inactive");
  if (actorUserId && owner.user_id !== actorUserId) throw new Error("owner_forbidden");
  // Check both the current explicit owner grant and current membership on every execution.
  const grants = await rows(tenant("gw_role_grants", "employee_id,role").eq("employee_id", owner.id).eq("role", "owner"), "owner_grant", issues);
  const membership = await rows(tenant("memberships", "user_id,role").eq("user_id", owner.user_id).in("role", ["admin", "staff"]), "owner_membership", issues);
  if (issues.length) throw new Error("owner_authorization_unavailable");
  if (!grants.length || !membership.length) throw new Error("owner_forbidden");
  // Exact existing employee email must match the fixed Gmail recipient, not an environment override.
  const ownerAddress = await rows(tenant("gw_employees", "id,email").eq("id", owner.id), "owner_address", issues);
  if (issues.length || ownerAddress.length !== 1 || ownerAddress[0].email?.toLowerCase() !== RECIPIENT)
    throw new Error("recipient_binding_mismatch");
  const people = roster.filter(e => active(e, today) && !cfg.excluded.includes(e.id));
  if (!people.length) throw new Error("empty_roster");
  const employeeIds = people.map(e => e.id), users = [...new Set(people.map(e => e.user_id).filter(Boolean))];
  const employeeSet = new Set(employeeIds), userSet = new Set(users);
  // tc_nippo has no tenant_id. Only original IDs proven by a visible tenant-scoped share
  // are eligible. Share text is never substituted for the original; missing links are unknown.
  const shares = users.length ? await rows(tenant("gw_nippo_shares", "nippo_id,user_id,work_date,visible")
    .in("user_id", users).eq("visible", true).gte("work_date", from).lte("work_date", today), "report_provenance", issues) : [];
  const provenance = new Map(shares.filter(s => s.nippo_id && userSet.has(s.user_id) && s.visible === true)
    .map(s => [s.nippo_id, s]));
  const reports = provenance.size ? await rows(sb.from("tc_nippo")
    .select("id,user_id,work_date,submitted_at,morning_at,updated_at,top_priority,work_items,goal_today,kgi_target,kgi_actual,tomorrow_plan,tomorrow_deadline,tomorrow_target", { count: "exact" })
    .in("id", [...provenance.keys()]).in("user_id", users).gte("work_date", from).lte("work_date", today), "reports", issues) : [];
  const originals = reports.filter(n => {
    const s = provenance.get(n.id), e = people.find(x => x.user_id === n.user_id);
    return s && e && s.user_id === n.user_id && s.work_date === n.work_date && (!e.joined_on || n.work_date >= e.joined_on);
  });
  if (originals.length !== provenance.size) issues.push("reports:provenance_original_mismatch");
  const starts = `${today}T00:00:00+09:00`, ends = `${addDays(until, 1)}T00:00:00+09:00`;
  const calendarColumns = "id,employee_id,title,category,source,visibility,all_day,starts_at,ends_at,updated_at";
  const calendarQuery = columns => tenant("gw_calendar_events", columns)
    .in("employee_id", employeeIds).eq("source", "self").eq("visibility", "shared").in("category", ["work", "meeting", "visit", "other"])
    .lt("starts_at", ends).gte("ends_at", starts).order("starts_at");
  const [events, tasks, focus, prefs, leave] = await Promise.all([
    rows(calendarQuery(calendarColumns + ",planned_quantity,planned_quantity_unit"), "schedule", issues,
      { fallback: () => calendarQuery(calendarColumns) }),
    rows(tenant("gw_tasks", "id,assignee_id,focus_for,focus_date,title,done_condition,due_on,status,updated_at")
      .in("assignee_id", employeeIds).gte("focus_date", today).lte("focus_date", until).neq("status", "cancelled").order("focus_date"), "tasks", issues),
    rows(tenant("gw_focus_days", "employee_id,focus_date,status,confirmed_at,updated_at")
      .in("employee_id", employeeIds).gte("focus_date", today).lte("focus_date", until), "focus", issues),
    rows(tenant("gw_reminder_prefs", "employee_id,workdays,evening_at,updated_at").in("employee_id", employeeIds), "workday_hints", issues),
    rows(tenant("gw_requests", "employee_id,leave_type,starts_on,ends_on,updated_at")
      .in("employee_id", employeeIds).eq("kind", "leave").eq("status", "approved").lte("starts_on", until).gte("ends_on", from), "leave", issues),
  ]);
  return buildSnapshot({ today, from, until, checkedAt: now.toISOString(), people, originals,
    events: events.filter(e => employeeSet.has(e.employee_id)), tasks, focus, prefs, leave, issues,
    rosterRows: roster.length, unknownStatusCount: roster.filter(e => !["active", "leaving", "invited", "left"].includes(e.status)).length,
    rosterCandidates: roster.filter(e => active(e, today)).length, excludedCount: roster.filter(e => active(e, today) && cfg.excluded.includes(e.id)).length });
}

function workItem(w) {
  return { task: clean(w?.task), target: number(w?.target), unit: clean(w?.unit, 20),
    doneWhen: clean(w?.done_when), result: clean(w?.result), actual: number(w?.actual),
    plannedStartsAt: validTime(w?.planned_starts_at), plannedEndsAt: validTime(w?.planned_ends_at), plannedAllDay: w?.planned_all_day === true,
    actualMinutes: number(w?.actual_minutes) !== null && w.actual_minutes >= 0 && w.actual_minutes <= 1440 ? w.actual_minutes : null,
    done: typeof w?.done === "boolean" ? w.done : null };
}
function report(n) {
  return { date: n.work_date, evidence: "self_reported_not_independently_verified", submittedAt: validTime(n.submitted_at), morningAt: validTime(n.morning_at), updatedAt: validTime(n.updated_at),
    priority: clean(n.top_priority), items: (Array.isArray(n.work_items) ? n.work_items : []).map(workItem),
    kpi: { name: clean(n.goal_today), target: number(n.kgi_target), actual: number(n.kgi_actual) },
    nextPlan: clean(n.tomorrow_plan), nextDeadline: clean(n.tomorrow_deadline, 80), nextDoneWhen: clean(n.tomorrow_target),
    sourceUrl: `${SOURCE}/admin-nippo.html?date=${n.work_date}` };
}
export function buildSnapshot({ today, from, until, checkedAt, people, originals = [], events = [], tasks = [], focus = [], prefs = [], leave = [], issues = [], rosterCandidates = people.length, excludedCount = 0, rosterRows = people.length, unknownStatusCount = 0 }) {
  const members = [...people].sort((a, b) => a.id.localeCompare(b.id)).map(e => {
    const ns = originals.filter(n => n.user_id === e.user_id).sort((a, b) => b.work_date.localeCompare(a.work_date));
    const current = ns.filter(n => n.work_date === today), previous = ns.filter(n => n.work_date < today);
    const pref = prefs.find(p => p.employee_id === e.id);
    const userReports = [current[0], previous[0]].filter(Boolean).map(report);
    const memberIssues = [];
    if (!e.user_id) memberIssues.push("account_link_missing");
    if (!current.length) memberIssues.push("today_original_not_obtained_not_a_missing_submission_judgment");
    if (!previous.length) memberIssues.push("previous_original_not_obtained");
    if (current.length > 1 || previous.filter(n => n.work_date === previous[0]?.work_date).length > 1) memberIssues.push("duplicate_report_date");
    const ownTasks = tasks.filter(t => t.assignee_id === e.id).sort((a, b) => a.id.localeCompare(b.id));
    const ownEvents = events.filter(t => t.employee_id === e.id).sort((a, b) => a.id.localeCompare(b.id));
    if (!ownTasks.some(t => t.focus_date > today) && !ownEvents.some(t => ymd(t.starts_at) > today)) memberIssues.push("next_business_plan_not_obtained_not_a_day_off_judgment");
    return {
      memberRef: e.id, name: clean(e.display_name, 100), role: [clean(e.department, 80), clean(e.position, 80)].filter(Boolean).join(" / ") || null,
      reports: userReports,
      workdayHint: pref ? { notificationWeekdays: Array.isArray(pref.workdays) ? pref.workdays.filter(n => Number.isInteger(n) && n >= 1 && n <= 7) : [],
        reminderTime: clean(pref.evening_at, 5), updatedAt: validTime(pref.updated_at), authoritativeShiftOrDeadline: false } : null,
      unavailable: leave.filter(l => l.employee_id === e.id).sort((a,b) => `${a.starts_on}:${a.ends_on}:${a.leave_type}`.localeCompare(`${b.starts_on}:${b.ends_on}:${b.leave_type}`)).map(l => ({ from: l.starts_on, to: l.ends_on,
        period: l.leave_type === "am" ? "morning" : l.leave_type === "pm" ? "afternoon" : "full_day", updatedAt: validTime(l.updated_at) })),
      tasks: ownTasks.map(t => { const f = focus.find(d => d.employee_id === (t.focus_for || e.id) && d.focus_date === t.focus_date);
        return { taskRef: t.id, date: t.focus_date, title: clean(t.title), doneWhen: clean(t.done_condition), dueOn: t.due_on, status: t.status,
          planConfirmed: f?.status === "confirmed" && Boolean(f?.confirmed_at), confirmedAt: validTime(f?.confirmed_at), updatedAt: validTime(t.updated_at) }; }),
      schedule: ownEvents.map(t => ({ title: clean(t.title), startsAt: validTime(t.starts_at), endsAt: validTime(t.ends_at),
        allDay: t.all_day === true, plannedQuantity: number(t.planned_quantity), plannedQuantityUnit: clean(t.planned_quantity_unit, 30),
        plannedQuantityState: !Object.hasOwn(t, "planned_quantity") ? "schema_unavailable" : number(t.planned_quantity) === null ? "not_set" : "recorded",
        updatedAt: validTime(t.updated_at) })),
      missing: memberIssues,
    };
  });
  const snapshot = { schema: VERSION, kind: "copy_of_gw_business_records_not_the_original", sourceUrl: SOURCE + "/office/",
    targetDate: today, checkedAt, timezone: "Asia/Tokyo", range: { reportsFrom: from, reportsTo: today, plansTo: until },
    coverage: { rosterRows, unknownStatusAwaitingReview: unknownStatusCount, rosterCandidates, approvedExclusions: excludedCount, targetMembers: members.length,
      todayOriginalsObtained: members.filter(m => m.reports.some(n => n.date === today)).length,
      previousOriginalsObtained: members.filter(m => m.reports.some(n => n.date < today)).length,
      nextBusinessPlanObtained: members.filter(m => m.tasks.some(t => t.date > today) || m.schedule.some(s => ymd(s.startsAt) > today)).length,
      sourceReadsComplete: issues.length === 0, issues: [...new Set(issues)].sort() },
    limitations: ["取得なしは未提出・欠勤・予定なしを意味しません。勤務日/締切未確定では未提出判定をしません。",
      "日報のactual/done/時間は本人申告で、客観的に検証済みの実績件数ではありません。予定の計画数と実績を混同しません。",
      "状態不明の名簿行は確認待ち件数に残し、対象なしや退職として消しません。",
      "日報は会社内の可視共有レコードで来歴が確認できた原本だけ。非共有・未共有の原本は不足として残ります。",
      "予定は本人入力かつ共有された業務予定だけ。私用・非共有・Google個人予定・本文・場所は対象外。",
      "曜日/時刻は通知設定の参考情報で、確定シフト・日報提出期限ではありません。休暇理由は出しません。",
      "日報は当日と直近7日内の前回1件を収録。Pが以前送った助言自体は別の会話/メール正本との照合が必要です。"],
    members };
  const { checkedAt: ignored, ...material } = snapshot;
  snapshot.fingerprint = "sha256:" + createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return snapshot;
}

export function renderMail(snapshot) {
  return { purpose: "gw_snapshot", to: RECIPIENT, replyTo: SENDER,
    subject: `[GW日報スナップショット] ${snapshot.targetDate} ${dateTime(snapshot.checkedAt)} JST / ${VERSION}`,
    text: ["代表本人向け・GW業務記録の写し（自動送信）", `対象日: ${snapshot.targetDate} / 確認: ${dateTime(snapshot.checkedAt)} JST`,
      `正本: ${snapshot.sourceUrl}`, `対象 ${snapshot.coverage.targetMembers}名 / 状態確認待ち ${snapshot.coverage.unknownStatusAwaitingReview}名 / 当日原本取得 ${snapshot.coverage.todayOriginalsObtained}名 / 前回原本取得 ${snapshot.coverage.previousOriginalsObtained}名 / 次業務予定取得 ${snapshot.coverage.nextBusinessPlanObtained}名`,
      "未取得を未提出と判断しないでください。メール時点以降の更新はGWが正本です。", ...snapshot.limitations,
      "", "--- GW_SNAPSHOT_JSON_BEGIN ---", JSON.stringify(snapshot, null, 2), "--- GW_SNAPSHOT_JSON_END ---"].join("\n") };
}

export async function deliverSnapshot({ sb, cfg, now, slot, env = process.env, mailer = sendMail, actorUserId = null }) {
  const snapshot = await readSnapshot(sb, cfg, now, actorUserId);
  snapshot.trigger = slot === "manual" ? "owner_manual" : slot === "initial" ? "initial" : `scheduled_${slot}`;
  const msg = renderMail(snapshot);
  if (Buffer.byteLength(msg.text, "utf8") > 400000) throw new Error("snapshot_size_exceeded");
  // initial is once per consent, not once a day. Atomic insert wins before any SMTP call.
  const key = slot === "manual" ? `manual:${snapshot.fingerprint}` : slot === "initial" ? `initial:${cfg.consentAt}` : `${snapshot.targetDate}:${slot}`;
  const claim = await sb.from("gw_owner_snapshot_sends").insert({ tenant_id: cfg.tenantId, dispatch_key: key,
    owner_employee_id: cfg.ownerId, schema_version: VERSION, target_date: snapshot.targetDate, slot, status: "sending",
    checked_at: snapshot.checkedAt, fingerprint: snapshot.fingerprint, target_count: snapshot.coverage.targetMembers,
    obtained_count: snapshot.coverage.todayOriginalsObtained, source_reads_complete: snapshot.coverage.sourceReadsComplete })
    .select("id").single();
  if (claim.error?.code === "23505") return { status: "duplicate_suppressed" };
  if (claim.error || !claim.data?.id) throw new Error("dispatch_claim_failed");
  let mail;
  try { mail = await mailer(msg, { env }); } catch { mail = { status: "failed" }; }
  // A sendMail 'failed' does NOT prove rejection: DATA may have been accepted before disconnection.
  // Conservatively all attempted failures are unknown. Neither unknown nor sending is auto-retried.
  const status = mail?.status === "sent" ? "accepted" : mail?.status === "skipped" ? "not_sent" : "unknown";
  let saved;
  try { saved = await sb.from("gw_owner_snapshot_sends").update({ status, finished_at: new Date().toISOString() })
    .eq("id", claim.data.id).eq("tenant_id", cfg.tenantId).select("id").single(); } catch { saved = { error: true }; }
  if (saved.error || !saved.data?.id) return { status: "unknown", reason: "outcome_record_failed", deliveryConfirmed: false };
  return { status, deliveryConfirmed: false, targetDate: snapshot.targetDate,
    targetMembers: snapshot.coverage.targetMembers, obtainedMembers: snapshot.coverage.todayOriginalsObtained,
    sourceReadsComplete: snapshot.coverage.sourceReadsComplete };
}
