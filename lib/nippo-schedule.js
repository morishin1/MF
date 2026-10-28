// Calendar is the plan source; a report keeps a snapshot, never an execution receipt.
// Call with userClient(req), not the service-role client. No Google/Office GET side effects.
import { readCalendarQuantity } from "./calendar-quantity.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ["work", "meeting", "visit", "other"];
export const SCHEDULE_COLUMNS = "id,title,starts_at,ends_at,all_day,source,category,visibility";
export const SYSTEM_WORK_UNCONFIRMED = Object.freeze({ status: "unconnected", count: null });
const snapshotKeys = ["task", "target", "schedule_event_id", "planned_starts_at", "planned_ends_at", "planned_all_day"];
const reportKeys = [...snapshotKeys, "unit", "actual", "actual_minutes", "measurement_note", "done_when", "result", "undone_reason", "done"];

// Avoid an older morning/plan request overwriting a report saved since its read.
// Existing JSON storage is reused; this is not a new table or a migration.
export async function updateReportIfUnchanged(sb, userId, existing, row) {
  // Always advance the version, including two writes within one millisecond.
  const prior = Date.parse(existing.updated_at);
  const updated_at = new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString();
  let query = sb.from("tc_nippo").update({ ...row, updated_at }).eq("id", existing.id).eq("user_id", userId);
  query = existing.updated_at == null ? query.is("updated_at", null) : query.eq("updated_at", existing.updated_at);
  return query.select("*").maybeSingle();
}

export async function readReportSchedule(sb, ctx, date) {
  const unavailable = { status: "unavailable", items: [] };
  if (!ctx?.tenantId || !ctx?.employee?.id || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return unavailable;
  const day = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) return unavailable;
  day.setUTCDate(day.getUTCDate() + 1);
  const from = `${date}T00:00:00+09:00`, to = `${day.toISOString().slice(0, 10)}T00:00:00+09:00`;
  try {
    const { data, error, quantityAvailable } = await readCalendarQuantity(columns => sb.from("gw_calendar_events").select(columns)
      .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id)
      .eq("source", "self").eq("visibility", "shared").in("category", CATEGORIES)
      .lt("starts_at", to).gt("ends_at", from).order("starts_at").order("id").limit(101), SCHEDULE_COLUMNS);
    if (error || !Array.isArray(data)) return unavailable;
    // Be defensive even if a mock/older server fails to apply the database filters.
    const items = data.slice(0, 100).filter(e => UUID.test(e.id || "") && e.source === "self"
      && e.visibility === "shared" && CATEGORIES.includes(e.category) && String(e.title || "").trim()
      && Number.isFinite(Date.parse(e.starts_at)) && Date.parse(e.ends_at) > Date.parse(e.starts_at)
      && Date.parse(e.starts_at) < Date.parse(to) && Date.parse(e.ends_at) > Date.parse(from))
      .map(e => ({ task: e.title.slice(0, 500), schedule_event_id: e.id,
        planned_starts_at: new Date(e.starts_at).toISOString(), planned_ends_at: new Date(e.ends_at).toISOString(),
        planned_all_day: e.all_day === true, target: quantityAvailable && e.planned_quantity != null ? Number(e.planned_quantity) : null,
        unit: quantityAvailable && e.planned_quantity != null ? String(e.planned_quantity_unit || "") : "" }));
    return { status: data.length > 100 ? "incomplete" : "available", items, quantityAvailable };
  } catch { return unavailable; }
}

/** Bind new references to the current user's calendar. Existing report snapshots stay unchanged.
 * Missing saved references are retained for old clients; omission is not a delete operation.
 * Quantities are self-reported, never derived from calendar duration or event count.
 */
export async function bindReportSchedule({ sb, ctx, date, items, existing = [], rawItems = [] }) {
  for (const r of Array.isArray(rawItems) ? rawItems : []) {
    if (!r?.schedule_event_id) continue;
    for (const [key, max] of [["actual_minutes", 1440], ["actual", 1e9]]) {
      const value = r[key];
      if (value !== "" && value != null && (typeof value === "boolean" || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max)) {
        return { error: "invalid_report_measurement", status: 400 };
      }
    }
  }
  if (Array.isArray(rawItems) && rawItems.some(r => r?.schedule_event_id && !UUID.test(String(r.schedule_event_id)))) {
    return { error: "invalid_schedule_reference", status: 400 };
  }
  const rows = (items || []).map(r => ({ ...r }));
  const refs = rows.filter(r => r.schedule_event_id).map(r => r.schedule_event_id);
  if (new Set(refs).size !== refs.length || (Array.isArray(rawItems) && rawItems.length > 10 && rawItems.some(r => r?.schedule_event_id))) {
    return { error: "duplicate_or_too_many_schedule_items", status: 400 };
  }
  const saved = new Map((existing || []).filter(r => UUID.test(r?.schedule_event_id || "")).map(r => [r.schedule_event_id, r]));
  const newIds = refs.filter(id => !saved.has(id));
  let source = new Map();
  if (newIds.length) {
    const read = await readReportSchedule(sb, ctx, date);
    if (read.status !== "available") return { error: "schedule_reference_unavailable", status: 503 };
    source = new Map(read.items.map(r => [r.schedule_event_id, r]));
    if (newIds.some(id => !source.has(id))) return { error: "schedule_reference_not_found", status: 409 };
  }
  for (const row of rows) {
    if (!row.schedule_event_id) continue;
    const original = saved.get(row.schedule_event_id) || source.get(row.schedule_event_id);
    for (const key of snapshotKeys) row[key] = original[key] ?? (key === "target" ? null : key === "planned_all_day" ? false : "");
    if (original.target != null) row.unit = original.unit || "";
    // No guessed title matching to task/action completion, nor arbitrary client evidence.
    delete row.task_id; delete row.action_id;
  }
  for (const [id, row] of saved) if (!refs.includes(id)) {
    rows.push(Object.fromEntries(reportKeys.filter(key => key in row).map(key => [key, row[key]])));
  }
  if (rows.length > 10) return { error: "too_many_report_items", status: 409 };
  return { items: rows.length ? rows : null };
}
