import {
  aggregateApproaches, applyListFilters, channelLabel, hasUnhandledClick, LIST_FIELDS,
  listSource, NEXT_AFTER_FAIL, nextFor, RECENT_DAYS, safeUrl, STATUS_LABEL, todayJst,
} from "./sales.js";
import { aggregateLp, isMgnLp, LP_EVENT_KEYS } from "./sales-lp.js";
import { prefectureOf } from "./sales-master.js";

export const ATTACK_STAGES = ["unsent", "sent", "responded", "scheduled", "done"];
const REPLIED = new Set(["clicked", "replied", "meeting", "proposal", "won"]);
const ATTACKABLE = new Set(["untouched", "reattack_wait"]);
const MEETING_PRIORITY = { scheduled: 0, scheduling: 1, done: 2 };

function primaryMeetings(meetings) {
  const selected = new Map();
  for (const m of meetings) {
    const last = selected.get(m.company_id);
    if (!last || MEETING_PRIORITY[m.status] < MEETING_PRIORITY[last.status]
      || (m.status === last.status && m.created_at > last.created_at)) {
      selected.set(m.company_id, m);
    }
  }
  return selected;
}

export function attackStage(company, meeting, response, sentAt) {
  if (meeting?.status === "scheduled" || meeting?.status === "done") return meeting.status;
  if (meeting?.status === "scheduling" || response || REPLIED.has(company.status)) return "responded";
  return sentAt || company.status === "attacked" ? "sent" : "unsent";
}

const recent = (date, now, ms) => Boolean(date && now - Date.parse(date) < ms);
const orderText = (a, b) => String(a || "").localeCompare(String(b || ""), "ja");
const isResponse = (c) => c.clickCount || c.lpAppliedAt || c.lpCandidate;
const responseRank = (c) => c.lpAppliedAt || c.lpCandidate ? 0 : c.status === "replied" ? 1 : c.clickCount >= 2 ? 2 : 3;

export function sortAttackRows(rows, filters) {
  const nextRank = (c) => c.nextKey === "follow_click" ? 0 : c.nextDue ? 1 : c.nextKey === "manual" ? 2 : 3;
  const due = (a, b) => nextRank(a) - nextRank(b) || orderText(a.nextDue, b.nextDue);
  const unsentRank = (c) => !c.attackReady ? 4 : c.nextKey === "attack" ? 0 : c.next === NEXT_AFTER_FAIL ? 2 : 1;
  const sorters = {
    name: (a, b) => orderText(a.name, b.name),
    created: (a, b) => orderText(b.createdAt, a.createdAt),
    last_sent: (a, b) => orderText(b.lastSentAt, a.lastSentAt),
    next: due,
  };
  const byStage = {
    unsent: (a, b) => unsentRank(a) - unsentRank(b) || due(a, b),
    sent: sorters.last_sent,
    responded: (a, b) => responseRank(a) - responseRank(b) || Number(b.unhandledClick) - Number(a.unhandledClick)
      || orderText(b.lastClickAt, a.lastClickAt),
    scheduled: (a, b) => orderText(a.meetingAt, b.meetingAt),
    done: (a, b) => orderText(b.conductedAt || b.meetingAt, a.conductedAt || a.meetingAt),
  };
  const sort = sorters[filters.sort] || byStage[filters.stage];
  return rows.sort((a, b) => sort(a, b) || orderText(a.name, b.name) || orderText(a.id, b.id));
}

export function buildAttackRows(companies, approaches, meetings, events, names, campaigns, now = new Date()) {
  const today = todayJst(now);
  const agg = aggregateApproaches(approaches);
  const lp = aggregateLp(events);
  const meetingOf = primaryMeetings(meetings);
  const failures = new Map();
  const latestSent = new Map();
  const mgnClicked = new Set();
  for (const a of approaches) {
    if (a.sent_at && a.sent_at > (latestSent.get(a.company_id)?.sent_at || "")) latestSent.set(a.company_id, a);
    if (a.click_count > 0 && isMgnLp(a.destination_url)) mgnClicked.add(a.company_id);
    if (a.failed_at && !a.sent_at && a.failed_at > (failures.get(a.company_id) || "")) {
      failures.set(a.company_id, a.failed_at);
    }
  }

  return companies.map((c) => {
    const activity = agg.get(c.id);
    const meeting = meetingOf.get(c.id);
    const application = lp.get(c.id);
    const sent = latestSent.get(c.id);
    const lastSentAt = sent?.sent_at || c.last_sent_at || null;
    const clickCount = Math.max(c.click_count || 0, activity?.clickCount || 0);
    const next = nextFor(c, activity, today);
    const ownerId = meeting?.owner_id || c.owner_id;
    const row = {
      id: c.id, name: c.name, phone: c.phone || c.contacts?.phone || null, formUrl: c.form_url,
      status: c.status, statusLabel: STATUS_LABEL[c.status],
      industry: c.industry, region: prefectureOf(c.region), service: c.service,
      campaignName: campaigns.get(c.campaign_id) || null,
      ownerId, ownerName: names.get(ownerId) || null, createdAt: c.created_at,
      clickCount, lastClickAt: activity?.last_click_at || null, unhandledClick: hasUnhandledClick(c, activity),
      mgnClick: mgnClicked.has(c.id), lpAppliedAt: application?.appliedAt || null,
      lpServices: application?.services || [], lpCandidate: Boolean(application?.candidate),
      lastSentAt, lastAttacker: names.get(sent?.employee_id) || null,
      lastChannel: channelLabel(sent?.channel), lastFailedAt: failures.get(c.id) || null,
      next: next.label, nextKey: next.key, nextDue: next.due, overdue: next.overdue,
      meetingStatus: meeting?.status || null, meetingAt: meeting?.scheduled_at || null,
      meetingUrl: safeUrl(meeting?.meeting_url) || null, conductedAt: meeting?.conducted_at || null,
      attackReady: ATTACKABLE.has(c.status) && !recent(lastSentAt, now, RECENT_DAYS * 86400000)
        && (!next.due || next.due <= today),
    };
    return { ...row, stage: attackStage(c, meeting, isResponse(row), lastSentAt) };
  });
}

export function attackCounts(approaches, meetings, names) {
  const byOwner = new Map();
  function record(id, key) {
    if (!byOwner.has(id)) byOwner.set(id, { name: names.get(id) || (id ? "担当者名なし" : "担当なし"), sent: 0, booked: 0 });
    byOwner.get(id)[key]++;
  }
  for (const a of approaches) if (a.sent_at) record(a.employee_id || null, "sent");
  for (const m of meetings) {
    if (["scheduled", "done"].includes(m.status) && m.scheduled_at) record(m.owner_id || null, "booked");
  }
  return [...byOwner.values()].sort((a, b) => b.sent - a.sent || b.booked - a.booked || orderText(a.name, b.name));
}

// Keyset pagination keeps the board and totals independent of PostgREST's row limit.
async function allRows(makeQuery) {
  const rows = [];
  let after;
  for (;;) {
    let query = makeQuery().order("id").limit(500);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return rows;
    rows.push(...data);
    after = data.at(-1).id;
  }
}

const APPROACH_FIELDS = "id, company_id, employee_id, sent_at, failed_at, prepared_at, channel, first_click_at, last_click_at, click_count, destination_url";
const MEETING_FIELDS = "id, company_id, owner_id, status, scheduled_at, meeting_url, conducted_at, created_at";
const meetingsQuery = (base, fields, statuses) => base("gw_sales_meetings", fields).in("status", statuses);
const employeeQuery = (base) => base("gw_employees", "id, display_name");
const namesOf = (employees) => new Map(employees.map((m) => [m.id, m.display_name]));
const tenantQuery = (sb, ctx) => (table, fields) => sb.from(table).select(fields).eq("tenant_id", ctx.tenantId);

export async function loadAttackBoard(sb, ctx, filters) {
  const base = tenantQuery(sb, ctx);
  const companyFilters = { ...filters, queue: "", owner: "", visibility: "shown" };
  const [companies, approaches, meetings, events, employees, campaigns] = await Promise.all([
    allRows(() => applyListFilters(base(listSource(companyFilters), LIST_FIELDS + ", phone, contacts")
      .is("ng_reason", null).not("status", "in", "(lost,excluded)"), companyFilters, ctx)),
    allRows(() => base("gw_sales_approaches", APPROACH_FIELDS).or("sent_at.not.is.null,failed_at.not.is.null,click_count.gt.0")),
    allRows(() => meetingsQuery(base, MEETING_FIELDS, Object.keys(MEETING_PRIORITY))),
    allRows(() => base("gw_sales_events", "id, company_id, event_key, detail, occurred_at").in("event_key", LP_EVENT_KEYS)),
    allRows(() => employeeQuery(base)),
    allRows(() => base("gw_sales_campaigns", "id, name")),
  ]);
  const rows = buildAttackRows(companies, approaches, meetings, events, namesOf(employees), new Map(campaigns.map(c => [c.id, c.name])));
  const me = ctx.employee?.id;
  const visible = rows.filter(c => !filters.owner
    || (filters.owner === "mine" && (!c.ownerId || c.ownerId === me))
    || (filters.owner === "none" && !c.ownerId)
    || (filters.owner === "me" && me && c.ownerId === me)
    || c.ownerId === filters.owner);
  const counts = Object.fromEntries(ATTACK_STAGES.map(stage => [stage, 0]));
  for (const c of visible) counts[c.stage]++;
  const sorted = sortAttackRows(visible.filter(c => c.stage === filters.stage), filters);
  const totalPages = Math.max(1, Math.ceil(sorted.length / filters.limit));
  const page = Math.min(filters.page, totalPages);
  return {
    companies: sorted.slice((page - 1) * filters.limit, page * filters.limit), counts,
    total: sorted.length, page, totalPages, limit: filters.limit, campaigns,
    members: employees.sort((a, b) => orderText(a.display_name, b.display_name)),
  };
}

export async function loadAttackCounts(sb, ctx) {
  const base = tenantQuery(sb, ctx);
  const [approaches, meetings, employees] = await Promise.all([
    allRows(() => base("gw_sales_approaches", "id, employee_id, sent_at").not("sent_at", "is", null)),
    allRows(() => meetingsQuery(base, "id, owner_id, status, scheduled_at", ["scheduled", "done"]).not("scheduled_at", "is", null)),
    allRows(() => employeeQuery(base)),
  ]);
  return attackCounts(approaches, meetings, namesOf(employees));
}
