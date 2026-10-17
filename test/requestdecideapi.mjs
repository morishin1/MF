// GW-05: 休暇承認は先にDBへ確定し、カレンダー/通知の一時失敗で「承認失敗」に戻さない。
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
    tenantId: "t1", roles: ["hr"],
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

// 1回目：Google/通知/監査の一時失敗があっても、承認は200で確定する。
const first = await post("approve");
assert.equal(first.statusCode, 200, JSON.stringify(first.body));
assert.equal(request.status, "approved");
assert.equal(first.body.request.status, "approved");
assert.equal(first.body.calendar.synced, false);
assert.match(first.body.calendar.error, /temporary calendar error/);
assert.ok(order.indexOf("db-status") >= 0 && order.indexOf("google-calendar") > order.indexOf("db-status"),
  "承認をDBへ確定したあとに外部カレンダーを同期する");
assert.equal(calendarRows.length, 1, "社内カレンダーは作成済み");
assert.equal(notifyCalls, 1, "通知失敗は承認結果を500にしない");
assert.equal(auditCalls, 1, "監査ログ失敗も承認結果を500にしない");

// 2回目：利用者が再実行しても409にせず、カレンダーだけ補修。通知は二重に送らない。
calendarResult = { calendarId: "cal", eventId: "leave-event", link: "https://calendar.example/leave-event", error: null, reused: true };
const beforeNotify = notifyCalls, beforeSlack = slackCalls, beforeAudit = auditCalls;
const second = await post("approve");
assert.equal(second.statusCode, 200, JSON.stringify(second.body));
assert.equal(second.body.replayed, true);
assert.equal(second.body.calendar.synced, true);
assert.equal(request.gcal_event_id, "leave-event");
assert.equal(request.gcal_error, null);
assert.equal(calendarRows.length, 1, "社内カレンダーもupsertで1件のまま");
assert.equal(notifyCalls, beforeNotify, "再同期では本人通知を二重送信しない");
assert.equal(slackCalls, beforeSlack, "再同期ではSlackを二重送信しない");
assert.equal(auditCalls, beforeAudit, "再同期では承認ログを二重記録しない");
assert.equal(requestUpdates.filter((x) => Object.prototype.hasOwnProperty.call(x, "status")).length, 1,
  "承認状態の更新は初回だけ");

console.log("すべて通過");
