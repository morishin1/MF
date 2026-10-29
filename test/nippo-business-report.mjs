import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canViewBusinessReport } from "../lib/nippo-business-report-access.js";
import { canManageProposals } from "../lib/sales-proposals.js";
const {
  BLAST_PROPOSAL_THRESHOLD, MEETING_GOAL_RATE, buildBusinessReport,
  businessReportWindows,
} = await import("../lib/nippo-business-report.js");

const date = "2026-10-29";
const now = "2026-10-29T08:00:00.000Z";
const windows = businessReportWindows("week", date);
assert.deepEqual(windows.current, { from: "2026-10-26", to: "2026-10-30", label: "10/26〜10/29" });
assert.deepEqual(windows.previous, { from: "2026-10-19", to: "2026-10-23", label: "10/19〜10/22" });
assert.equal(MEETING_GOAL_RATE, 10);
assert.equal(BLAST_PROPOSAL_THRESHOLD, 15);

// 全体営業レポートはSales管理権限のある責任者・owner・管理者だけ。
assert.equal(canViewBusinessReport({ roles: ["sales"], apps: ["sales"] }), false, "営業担当には全員横断集計を出さない");
assert.equal(canViewBusinessReport({ roles: ["manager"], apps: ["sales"] }), true, "Sales管理責任者");
assert.equal(canViewBusinessReport({ roles: ["owner"], apps: [] }), true, "owner");
assert.equal(canViewBusinessReport({ isAdmin: true, roles: [], apps: ["sales"] }), true, "Sales利用権限を持つ管理者");
assert.equal(canViewBusinessReport({ isAdmin: true, roles: [], apps: [] }), false, "Sales利用権限のない会計管理者");
assert.equal(canManageProposals({ roles: ["sales"], apps: ["sales"] }), false, "Sales担当者は管理権限を持たない");

const proposals = [];
const add = (id, fields) => proposals.push({
  id, tenant_id: "tenant-1", source_system: "manual", company_id: "company-" + id,
  company_name: "企業 " + id, title: "案件 " + id, proposal_owner_id: null,
  sales_owner_id: null, matched_at: null, sent_at: null, status: "prepare",
  close_reason: null, closed_at: null, archived_at: null, contact_stop: false,
  ...fields,
});
const employees = [
  { id: "owner-1", display_name: "営業A", email: "sales-a@example.com" },
  { id: "owner-2", display_name: "営業B", email: "sales-b@example.com" },
  { id: "match-1", display_name: "マッチング担当", email: "match@example.com" },
];
for (let i = 0; i < 10; i++) add("target-" + i, {
  company_id: "target-company", company_name: "目標達成企業", sent_at: date + "T02:00:00Z",
  status: i === 0 ? "meeting_done" : "reply_wait", sales_owner_id: "owner-1",
});
for (let i = 0; i < 10; i++) add("bottleneck-" + i, {
  company_id: "bottleneck-company", company_name: "要改善企業", sent_at: date + "T03:00:00Z",
  status: "reply_wait", proposal_owner_id: "owner-2",
});
for (let i = 0; i < BLAST_PROPOSAL_THRESHOLD; i++) add("blast-" + i, {
  company_id: "blast-company", company_name: "ブラスト候補", sent_at: "2026-10-01T02:00:00Z",
  status: i === 0 ? "lost" : "reply_wait", close_reason: i === 0 ? "client_declined" : null,
  closed_at: i === 0 ? date + "T04:00:00Z" : null, sales_owner_id: "owner-1",
});
for (let i = 0; i < 14; i++) add("review-" + i, {
  company_id: "review-company", company_name: "判定中企業", sent_at: "2026-10-01T02:00:00Z",
  status: "reply_wait",
});
add("blast-one-meeting", {
  company_id: "met-company", company_name: "面談あり企業", sent_at: "2026-10-01T02:00:00Z",
  status: "meeting_done",
});
add("loss-missing", {
  company_id: "loss-company", company_name: "失注企業", sent_at: date + "T01:00:00Z",
  status: "closed_no_reply", close_reason: null, closed_at: date + "T05:00:00Z",
});
for (let i = 0; i < 3; i++) add("match-" + i, {
  source_system: "enger", source_proposal_id: "enger-" + i, source_url: "https://enger.example/jobs/" + i,
  source_company_id: "enger-company-" + i, company_name: "ENGER企業 " + i,
  matching_owner_name: "マッチング担当", matching_owner_email: "match@example.com",
  matched_at: date + "T02:00:00Z", status: i === 0 ? "meeting_done" : "proposal_wait",
  sent_at: i === 0 ? date + "T04:00:00Z" : null,
});

const activities = [{ id: "meeting-activity", proposal_id: "target-0", kind: "meeting", result: "done", occurred_at: date + "T06:00:00Z" }];
const tasks = [
  { id: "prepare-task", proposal_id: "match-1", kind: "prepare", status: "open", assignee_id: "match-1", due_at: "2026-10-28T07:00:00Z" },
  { id: "duplicate-prepare-task", proposal_id: "match-1", kind: "prepare", status: "open", assignee_id: "match-1", due_at: "2026-10-27T07:00:00Z" },
];
const report = buildBusinessReport({
  period: "week", date, now, proposals, activities, tasks, employees,
  sync: { available: true, latestReceivedAt: now, unresolvedCount: 2 },
  sourceStateStatus: "available",
});
assert.equal(report.sales.current.proposalCount, 22, "current sent-date cohort excludes historical rows");
assert.equal(report.sales.current.meetingEventCount, 1, "completed meeting events are counted by event date");
assert.equal(report.sales.current.meetingCohortCount, 2);
assert.equal(report.sales.current.conversionRate, 9.1, "2 of 22 proposal cohort");
assert.equal(report.sales.current.closedCount, 2);
assert.equal(report.sales.current.missingReasonCount, 2);
assert.equal(report.sales.current.lossRows.length, 2);
assert.equal(report.sales.blasts.count, 1, "15 historical proposals and no completed meetings");
assert.equal(report.sales.blasts.rows[0].companyName, "ブラスト候補");
assert.equal(report.sales.blasts.rows[0].id, "blast-0", "Blast company has a direct source proposal");
assert.equal(report.sales.byOwner.find((row) => row.name === "営業B").bottleneck, true);
assert.equal(report.sales.byOwner.find((row) => row.name === "営業A").bottleneck, false);
assert.equal(report.matching.current.matchedCount, 3);
assert.equal(report.matching.current.proposalizedCount, 1);
assert.equal(report.matching.current.conversionRate, 33.3);
assert.equal(report.matching.backlogCount, 2);
assert.equal(report.matching.stalledCount, 1);
assert.equal(report.matching.stalledRows[0].id, "match-1");
assert.equal(report.matching.stalledRows[0].taskDueAt, "2026-10-27T07:00:00Z", "duplicate prepare tasks yield one stalled proposal using earliest overdue deadline");
assert(report.insights.some((action) => action.type === "conversion" && action.owner && action.dueDate));
assert(report.insights.some((action) => action.type === "blast" && action.owner && action.dueDate));
assert(report.insights.some((action) => action.type === "matching_stalled" && action.owner && action.dueDate));

const missing = buildBusinessReport({
  period: "day", date, now, proposals: null, activities: null, tasks: null,
  sync: { available: false }, sourceStateStatus: "unavailable",
});
assert.equal(missing.sales.current.proposalCount, null, "unavailable is not reported as zero");
assert.equal(missing.sales.current.lossReasons, null);
assert.equal(missing.sales.current.proposalRows, null);
assert.equal(missing.sales.blasts.count, null);
assert.equal(missing.matching.current.matchedCount, null);
assert.equal(missing.matching.current.rows, null);
const empty = buildBusinessReport({
  period: "day", date, now, proposals: [], activities: [], tasks: [], employees: [],
  sync: { available: true, latestReceivedAt: now, unresolvedCount: 0 }, sourceStateStatus: "available",
});
assert.equal(empty.sales.current.proposalCount, 0, "取得済みの空データは0件として表示");
assert.equal(empty.sales.current.conversionRate, null, "分母0の率は計算対象外");
assert.equal(empty.matching.current.matchedCount, 0);
assert.equal(empty.matching.status, "available");

const page = readFileSync(new URL("../nippo.html", import.meta.url), "utf8");
const api = readFileSync(new URL("../api/nippo/business-report.js", import.meta.url), "utf8");
const access = readFileSync(new URL("../lib/nippo-business-report-access.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../js/nippo-business-report.js", import.meta.url), "utf8");
assert.match(page, /全体営業・マッチング/);
assert.match(api, /query\.get\("access"\) === "1"/);
assert.match(api, /if \(!canViewBusinessReport\(ctx\)\)/, "API enforces report access");
assert.match(access, /canSell\(ctx\) && canManageProposals\(ctx\)/, "Sales access and manager access are both required");
assert.doesNotMatch(api, /tc_nippo|gw_nippo_ai_evals/, "report endpoint never reads personal report bodies");
assert.match(ui, /未取得/);
assert.match(ui, /\/sales\/proposals\.html\?id=/, "detail rows link to their Sales source record");
console.log("nippo business report metrics, access, and source links: OK");
