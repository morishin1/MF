// 休暇: Office一次承認→KEIEI最終承認。最終承認まで予定は作らず、Google失敗でも確定。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

const request = {
  id: "12345678-1234-4abc-8def-1234567890ab",
  tenant_id: "t1", employee_id: "e1", kind: "leave", title: "休暇",
  body: null, leave_type: "paid", starts_on: "2026-10-20", ends_on: "2026-10-20", days: 1,
  status: "pending", approved_at: null, owner_approved_at: null, decision_note: null,
  gcal_calendar_id: null, gcal_event_id: null, gcal_link: null, gcal_error: null,
  applicant: { id: "e1", display_name: "山田 太郎" },
};
const order = [];
const requestUpdates = [];
const calendarRows = [];
let calendarResult = { calendarId: "cal", error: "temporary calendar error" };
let notifyCalls = 0, slackCalls = 0, auditCalls = 0;
let currentRoles = ["hr"];

function shaped() {
  return {
    id: request.id, kind: request.kind, status: request.status,
    approved_at: request.approved_at, owner_approved_at: request.owner_approved_at,
    decision_note: request.decision_note, gcal_link: request.gcal_link, gcal_error: request.gcal_error,
  };
}
function table(name) {
  let patch = null, deleting = false;
  const filters = [];
  const q = {
    select() { return q; },
    eq(k, v) { filters.push([k, v]); return q; },
    update(v) { patch = v; return q; },
    delete() { deleting = true; return q; },
    maybeSingle() {
      if (name === "gw_requests") return Promise.resolve({ data: { ...request, applicant: { ...request.applicant } }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    single() {
      if (name !== "gw_requests" || !patch) return Promise.resolve({ data: null, error: null });
      requestUpdates.push({ ...patch });
      if (Object.prototype.hasOwnProperty.call(patch, "status")) order.push("db-status");
      else order.push("db-calendar-meta");
      Object.assign(request, patch);
      return Promise.resolve({ data: shaped(), error: null });
    },
    upsert(row) {
      if (name === "gw_calendar_events") {
        order.push("internal-calendar");
        const i = calendarRows.findIndex((x) => x.source === row.source && x.source_id === row.source_id);
        if (i >= 0) calendarRows[i] = { ...calendarRows[i], ...row };
        else calendarRows.push({ ...row });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve, reject) {
      let out = { data: null, error: null };
      if (deleting && name === "gw_calendar_events") {
        for (let i = calendarRows.length - 1; i >= 0; i--) {
          if (filters.every(([k, v]) => calendarRows[i][k] === v)) calendarRows.splice(i, 1);
        }
      }
      return Promise.resolve(out).then(resolve, reject);
    },
  };
  return q;
}
const sb = { from: table };

mock.module(atRoot("lib/auth.js"), { namedExports: {
  requireUser: async () => ({ id: "u-reviewer" }),
} });
mock.module(atRoot("lib/gw.js"), { namedExports: {
  gwContext: async () => ({
    tenantId: "t1", roles: currentRoles,
    employee: { id: "e-reviewer", display_name: "人事 花子" },
  }),
} });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => sb } });
mock.module(atRoot("lib/expenses.js"), { namedExports: { canReviewRequest: () => true } });
mock.module(atRoot("lib/gcal.js"), { namedExports: {
  syncAllDay: async () => {
    order.push("google-calendar");
    return { ...calendarResult };
  },
} });
mock.module(atRoot("lib/notify.js"), { namedExports: {
  notify: async () => { notifyCalls++; throw new Error("notification temporarily unavailable"); },
} });
mock.module(atRoot("lib/slack.js"), { namedExports: {
  notifySlack: async () => { slackCalls++; throw new Error("slack temporarily unavailable"); },
} });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: {
  gwLog: async () => { auditCalls++; throw new Error("audit temporarily unavailable"); },
} });

const { default: handler } = await import(atRoot("api/requests/decide.js"));

function response() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = JSON.parse(b); };
  return r;
}
async function post(action) {
  const res = response();
  await handler({ method: "POST", url: "/api/requests/decide", body: { id: request.id, action }, headers: {} }, res);
  return res;
}

// 1. Office一次承認: まだGoogle/社内カレンダーには反映せず経営へ渡す。
const first = await post("approve");
assert.equal(first.statusCode, 200, JSON.stringify(first.body));
assert.equal(request.status, "pending_owner");
assert.equal(first.body.request.status, "pending_owner");
assert.equal(first.body.calendar.reason, "awaiting_final_approval");
assert.equal(request.owner_approved_at, null);
assert.equal(calendarRows.length, 0, "一次承認では社内カレンダーを作らない");
assert.ok(!order.includes("google-calendar"), "一次承認ではGoogle Calendarを呼ばない");
assert.equal(requestUpdates.filter(x => "status" in x).length, 1, "一次承認は一度だけ");
assert.equal(auditCalls, 1, "一次承認の監査は残す");

// 2. Officeは最終承認・最終却下を実行できない。
const unauthorized = await post("approve");
assert.equal(unauthorized.statusCode, 403, JSON.stringify(unauthorized.body));
const deniedReject = await post("reject");
assert.equal(deniedReject.statusCode, 403, JSON.stringify(deniedReject.body));
assert.equal(request.status, "pending_owner", "不正な二次処理で状態が変わらない");

// 3. KEIEIのownerが最終承認し、カレンダー同期失敗でも承認状態は確定する。
currentRoles = ["owner"];
const second = await post("approve");
assert.equal(second.statusCode, 200, JSON.stringify(second.body));
assert.equal(request.status, "approved");
assert.equal(second.body.request.status, "approved");
assert.equal(second.body.calendar.synced, false);
assert.match(second.body.calendar.error, /temporary calendar error/);
assert.ok(request.owner_approved_at, "最終承認日時を残す");
assert.ok(request.approved_at, "Office一次承認日時を残す");
assert.ok(order.indexOf("google-calendar") > order.lastIndexOf("db-status"), "最終承認保存後にGoogle同期");
assert.equal(calendarRows.length, 1, "社内カレンダーは同期成功");
assert.equal(notifyCalls, 2, "両段階の通知失敗は承認を中断しない");
assert.equal(auditCalls, 2, "両段階の監査ログも呼ばれる");

// 4. 承認済みの再試行は重複承認せず、カレンダーだけ安全に補修。
calendarResult = { calendarId:"cal", eventId:"leave-event", link:"https://calendar.example/leave-event", error:null, reused:true };
const beforeNotify = notifyCalls, beforeSlack = slackCalls, beforeAudit = auditCalls;
const third = await post("approve");
assert.equal(third.statusCode, 200, JSON.stringify(third.body));
assert.equal(third.body.replayed, true);
assert.equal(third.body.calendar.synced, true);
assert.equal(request.gcal_event_id, "leave-event");
assert.equal(request.gcal_error, null);
assert.equal(calendarRows.length, 1, "再同期時も同じ予定のまま");
assert.equal(notifyCalls, beforeNotify, "再試行で通知を重複させない");
assert.equal(slackCalls, beforeSlack, "再試行でSlackを重複させない");
assert.equal(auditCalls, beforeAudit, "再試行で監査を重複させない");
assert.equal(requestUpdates.filter(x => "status" in x).length, 2, "一次と最終の各1更新のみ");

// 5. 申請中（一次承認済み）の取消はGoogle API不要。
request.status = "pending_owner";
request.gcal_event_id = null;
request.gcal_error = null;
currentRoles = ["hr"];
const cancelled = await post("cancel");
assert.equal(cancelled.statusCode, 200);
assert.equal(cancelled.body.request.status, "cancelled");
assert.equal(cancelled.body.calendar.reason, "not_approved");

console.log("休暇のOffice→KEIEI二段階・権限・カレンダー失敗時の分離：通過");
