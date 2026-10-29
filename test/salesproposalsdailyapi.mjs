import assert from "node:assert/strict";
import { mock } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (path) => pathToFileURL(join(root, path)).href;
let context = { tenantId: "tenant-1", allowed: false };
const tablesRead = [];
const queryFilters = [];
const rows = {
  gw_sales_proposals: [
    { id: "sent-1", tenant_id: "tenant-1", source_system: "manual", company_name: "A", title: "案件A", sent_at: "2026-10-28T15:00:00.000Z", status: "meeting_done", archived_at: null },
    { id: "sent-2", tenant_id: "tenant-1", source_system: "enger", source_proposal_id: "enger-2", company_name: "B", title: "案件B", sent_at: "2026-10-29T02:00:00.000Z", status: "reply_wait", archived_at: null },
    { id: "next-day", tenant_id: "tenant-1", source_system: "manual", sent_at: "2026-10-29T15:00:00.000Z", status: "reply_wait", archived_at: null },
    { id: "loss", tenant_id: "tenant-1", source_system: "manual", sent_at: "2026-10-20T00:00:00.000Z", status: "closed_no_reply", close_reason: "no_reply", closed_at: "2026-10-28T15:00:00.000Z", archived_at: null },
    { id: "archived", tenant_id: "tenant-1", source_system: "manual", sent_at: "2026-10-28T16:00:00.000Z", status: "reply_wait", archived_at: "2026-10-28T17:00:00.000Z" },
    { id: "other-tenant", tenant_id: "tenant-2", source_system: "manual", sent_at: "2026-10-28T16:00:00.000Z", status: "reply_wait", archived_at: null },
  ],
  gw_sales_proposal_activities: [
    { id: "a1", tenant_id: "tenant-1", proposal_id: "sent-1", kind: "call", result: "connected", occurred_at: "2026-10-28T15:10:00.000Z" },
    { id: "a2", tenant_id: "tenant-1", proposal_id: "sent-1", kind: "meeting", result: "done", occurred_at: "2026-10-28T15:20:00.000Z" },
    { id: "a3", tenant_id: "tenant-1", proposal_id: "sent-2", kind: "mail", occurred_at: "2026-10-29T14:00:00.000Z" },
    { id: "a4", tenant_id: "tenant-1", proposal_id: "next-day", kind: "reply", occurred_at: "2026-10-29T15:00:00.000Z" },
    { id: "a5", tenant_id: "tenant-1", proposal_id: "archived", kind: "call", occurred_at: "2026-10-28T16:00:00.000Z" },
    { id: "a6", tenant_id: "tenant-2", proposal_id: "other-tenant", kind: "call", occurred_at: "2026-10-28T16:00:00.000Z" },
  ],
};

function from(table) {
  const filters = [];
  let range = null;
  let order = null;
  const q = {
    select() { return q; },
    eq(column, value) { filters.push({ op: "eq", column, value }); queryFilters.push([table, column, value]); return q; },
    is(column, value) { filters.push({ op: "is", column, value }); return q; },
    in(column, value) { filters.push({ op: "in", column, value }); return q; },
    gte(column, value) { filters.push({ op: "gte", column, value }); queryFilters.push([table, column, value]); return q; },
    lt(column, value) { filters.push({ op: "lt", column, value }); queryFilters.push([table, column, value]); return q; },
    order(column, options) { order = { column, options }; return q; },
    range(start, end) { range = [start, end]; return q; },
    then(resolve, reject) {
      tablesRead.push(table);
      let data = (rows[table] || []).filter((row) => filters.every((filter) => {
        const value = row[filter.column];
        if (filter.op === "eq") return value === filter.value;
        if (filter.op === "is") return value === filter.value;
        if (filter.op === "in") return filter.value.includes(value);
        if (filter.op === "gte") return value != null && value >= filter.value;
        if (filter.op === "lt") return value != null && value < filter.value;
        return true;
      }));
      if (order) data = data.sort((a, b) => String(a[order.column] || "").localeCompare(String(b[order.column] || ""))
        * (order.options?.ascending === false ? -1 : 1));
      if (range) data = data.slice(range[0], range[1] + 1);
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return q;
}

mock.module(atRoot("lib/http.js"), { namedExports: {
  json(res, status, body) { res.statusCode = status; res.body = body; return body; },
  methodNotAllowed(res, allowed) { res.statusCode = 405; res.allowed = allowed; return null; },
  dbSetupHint: () => null,
} });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "user-1" }) } });
mock.module(atRoot("lib/gw.js"), { namedExports: {
  gwContext: async () => context,
  canSell: (ctx) => ctx.allowed === true,
} });
mock.module(atRoot("lib/supabase.js"), { namedExports: { userClient: () => ({ from }) } });
process.env.SALES_SOURCE_STATE_ENABLED = "0";
const { default: handler } = await import(atRoot("api/sales/proposals/daily-analysis.js"));

async function call(url, method = "GET") {
  const res = { statusCode: 0, body: null, setHeader() {} };
  await handler({ method, url, headers: {} }, res);
  return res;
}

let response = await call("/api/sales/proposals/daily-analysis?date=2026-10-29");
assert.equal(response.statusCode, 403, "Sales権限が無い場合は拒否");
assert.equal(tablesRead.length, 0, "権限確認前にデータを読まない");
context = { tenantId: "tenant-1", allowed: true };
response = await call("/api/sales/proposals/daily-analysis?date=2026-02-30");
assert.equal(response.statusCode, 400, "存在しない日付を拒否");
assert.equal(tablesRead.length, 0, "日付検証前にデータを読まない");

response = await call("/api/sales/proposals/daily-analysis?date=2026-10-29");
assert.equal(response.statusCode, 200);
assert.equal(response.body.date, "2026-10-29");
assert.equal(response.body.proposalSentCount, 2);
assert.equal(response.body.meetingEventCount, 1);
assert.equal(response.body.meetingCohortCount, 1);
assert.equal(response.body.conversionRate, 50);
assert.equal(response.body.callCount, 1);
assert.equal(response.body.mailCount, 1);
assert.equal(response.body.replyCount, 0);
assert.equal(response.body.actionCount, 3);
assert.equal(response.body.closedCount, 1);
assert.equal(response.body.sourceStateStatus, "not_enabled");
assert(tablesRead.every((table) => queryFilters.some(([filteredTable, column, value]) =>
  filteredTable === table && column === "tenant_id" && value === "tenant-1")), "全クエリにテナント条件を付ける");
assert(queryFilters.some(([table, column, value]) => table === "gw_sales_proposals" && column === "sent_at" && value === "2026-10-28T15:00:00.000Z"), "提案はJSTの開始境界から読む");
assert(queryFilters.some(([table, column, value]) => table === "gw_sales_proposal_activities" && column === "occurred_at" && value === "2026-10-29T15:00:00.000Z"), "活動は翌日JSTの境界を含めない");
response = await call("/api/sales/proposals/daily-analysis", "POST");
assert.equal(response.statusCode, 405, "日別分析APIはGETのみ");
console.log("Sales proposal daily analysis API: permission, tenant scope, JST window, and counts OK");
