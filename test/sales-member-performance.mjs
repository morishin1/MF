// /sales ダッシュボードのOffice風カレンダー・役割別実績の回帰テスト
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { dayJst, monthBounds, summarizePerformance, PERFORMANCE_KEYS } from "../lib/sales-member-performance.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "sales/index.html"), "utf8");
const ui = readFileSync(resolve(ROOT, "js/sales-performance-calendar.js"), "utf8");
new Script(ui, { filename: "sales-performance-calendar.js" });
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline);
new Script(inline[1], { filename: "sales/index.html" });
for (const text of ["sp-calendar", "sp-member", "sp-day", "sp-metric", "sp-month", "SalesPerformanceCalendar.init()"]) {
  assert.ok(html.includes(text), text + " is connected");
}
assert.equal(monthBounds("bad"), null);
assert.equal(monthBounds("2026-13"), null);
assert.equal(monthBounds("2026-10").sinceIso, "2026-09-30T15:00:00.000Z");
assert.equal(monthBounds("2026-10").untilIso, "2026-10-31T15:00:00.000Z");
assert.equal(dayJst("2026-10-19T15:30:00Z"), "2026-10-20");

const FUJIMOTO = "00000000-0000-4000-8000-000000000101";
const NAKAMURA = "00000000-0000-4000-8000-000000000102";
const IKENAGA = "00000000-0000-4000-8000-000000000103";
const KUDO = "00000000-0000-4000-8000-000000000104";
const employees = [
  { id: FUJIMOTO, display_name: "藤本", email: "fujimoto@eight.example" },
  { id: NAKAMURA, display_name: "中村", email: "nakamura@eight.example" },
  { id: IKENAGA, display_name: "池永", email: "ikenaga@eight.example" },
  { id: KUDO, display_name: "工藤", email: "kudo@eight.example" },
];
const proposals = [
  { id: "p-a", matched_at: "2026-10-19T15:30:00Z", sent_at: "2026-10-21T03:00:00Z",
    matching_owner_email: "FUJIMOTO@EIGHT.EXAMPLE" },
  { id: "p-b", matched_at: null, sent_at: "2026-10-22T03:00:00Z", matching_owner_email: null },
  { id: "p-c", matched_at: "2026-10-20T04:00:00Z", sent_at: null,
    matching_owner_email: "not-mapped@outside.example" },
];
const activities = [
  { id: "a-s", proposal_id: "p-a", kind: "sent", result: "sent",
    employee_id: null, occurred_at: "2026-10-21T03:00:00Z" },
  { id: "b-s", proposal_id: "p-b", kind: "sent", result: "sent",
    employee_id: FUJIMOTO, occurred_at: "2026-10-22T03:00:00Z" },
  { id: "a-1", proposal_id: "p-a", kind: "call", result: "no_answer",
    employee_id: NAKAMURA, occurred_at: "2026-10-21T03:10:00Z" },
  { id: "a-2", proposal_id: "p-a", kind: "call", result: "connected",
    employee_id: NAKAMURA, occurred_at: "2026-10-22T04:00:00Z" },
  { id: "a-3", proposal_id: "p-a", kind: "reply", result: "replied",
    employee_id: NAKAMURA, occurred_at: "2026-10-23T04:00:00Z" },
  { id: "a-4", proposal_id: "p-a", kind: "cs_decision", result: "needs_detail",
    employee_id: NAKAMURA, occurred_at: "2026-10-23T04:00:00Z" },
  { id: "a-5", proposal_id: "p-a", kind: "meeting", result: "scheduled",
    employee_id: IKENAGA, occurred_at: "2026-10-25T04:00:00Z" },
  { id: "a-6", proposal_id: "p-a", kind: "result", result: "won",
    employee_id: IKENAGA, occurred_at: "2026-10-28T04:00:00Z" },
  { id: "a-7", proposal_id: "p-a", kind: "result", result: "won",
    employee_id: IKENAGA, occurred_at: "2026-11-01T04:00:00Z" },
];
const handoffs = [
  { id: "h1", from_owner_id: NAKAMURA, actor_employee_id: FUJIMOTO,
    to_stage: "closing", created_at: "2026-10-23T05:00:00Z" },
  { id: "h2", from_owner_id: NAKAMURA, actor_employee_id: FUJIMOTO,
    to_stage: "cs", created_at: "2026-10-23T05:00:00Z" },
];
const approaches = [
  { id: "a1", employee_id: KUDO, channel: "form", sent_at: "2026-10-21T01:00:00Z" },
  { id: "a2", employee_id: KUDO, channel: "form", sent_at: "2026-10-21T02:00:00Z" },
  { id: "a3", employee_id: KUDO, channel: "email", sent_at: "2026-10-21T02:00:00Z" },
  { id: "a4", employee_id: KUDO, channel: "form", sent_at: null },
];
const input = {
  month: "2026-10", employees, memberIds: employees.map((x) => x.id),
  settings: { csMembers: [NAKAMURA, KUDO], closingMembers: [IKENAGA] },
  approaches, proposals, activities, handoffs, manager: true,
};
const all = summarizePerformance(input);
const row = (id) => all.members.find((r) => r.employeeId === id);
assert.equal(all.totals.attacks, 2);
assert.equal(row(FUJIMOTO).totals.matches, 1); // email match is case insensitive, no name guessing
assert.equal(all.totals.matches, 2); // one mapped + one unattributed
assert.equal(all.totals.sent, 2); // dx.enger and Sales manual
assert.equal(row(FUJIMOTO).totals.sent, 2);
assert.equal(row(NAKAMURA).totals.calls, 2);
assert.equal(row(NAKAMURA).totals.connected, 1); // reply does not double count
assert.equal(row(NAKAMURA).totals.decisions, 1);
assert.equal(row(NAKAMURA).totals.handoffs, 1); // actor wasn't CS; credit source CS
assert.equal(row(IKENAGA).totals.meetings, 1);
assert.equal(row(IKENAGA).totals.won, 1);
assert.equal(row(KUDO).totals.attacks, 2);
assert.deepEqual(row(KUDO).role, ["CS"]);
assert.equal(row(FUJIMOTO).days["2026-10-20"].matches, 1);
assert.equal(row(NAKAMURA).days["2026-10-23"].connected, 0); // duplicate of Oct 22
assert.ok(all.members.some((r) => r.employeeId === null && r.totals.matches === 1)); // don't invent ownership
for (const metric of PERFORMANCE_KEYS) {
  assert.equal(Object.values(all.days).reduce((sum, day) => sum + day[metric], 0), all.totals[metric],
    metric + " daily totals equal month totals");
}
const self = summarizePerformance({ ...input, manager: false, viewerId: NAKAMURA });
assert.equal(self.members.length, 1); // privacy: no other member data
assert.equal(self.members[0].employeeId, NAKAMURA);
assert.equal(self.totals.attacks, 0);
assert.equal(self.totals.calls, 2);
assert.equal(self.totals.won, 0);
assert.ok(!JSON.stringify(self).includes("藤本"));
console.log("PASS Sales team calendar: day boundaries, attribution, roles, double count, privacy, UI scripts");
