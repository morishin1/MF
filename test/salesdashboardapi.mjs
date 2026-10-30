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
    { id: "matched-current", tenant_id: "tenant-1", source_system: "enger", source_proposal_id: "e-current", company_id: "co-1", company_name: "企業A", sales_owner_id: "owner-1", matched_at: "2026-10-29T05:00:00.000Z", sent_at: null, status: "proposal_wait", archived_at: null },
    { id: "matched-previous", tenant_id: "tenant-1", source_system: "enger", source_proposal_id: "e-previous", company_id: "co-1", company_name: "企業A", sales_owner_id: "owner-1", matched_at: "2026-10-28T05:00:00.000Z", sent_at: null, status: "proposal_wait", archived_at: null },
    { id: "sent-previous", tenant_id: "tenant-1", source_system: "enger", source_proposal_id: "e-sent-previous", company_id: "co-2", company_name: "企業B", sales_owner_id: "owner-2", matched_at: null, sent_at: "2026-10-28T05:00:00.000Z", status: "meeting_done", archived_at: null },
    { id: "sent-current", tenant_id: "tenant-1", source_system: "manual", company_id: "co-3", company_name: "企業C", sales_owner_id: "owner-2", matched_at: null, sent_at: "2026-10-28T16:00:00.000Z", status: "reply_wait", archived_at: null },
    { id: "lost-current", tenant_id: "tenant-1", source_system: "manual", company_id: "co-4", company_name: "企業D", sales_owner_id: "owner-1", matched_at: null, sent_at: "2026-10-28T16:00:00.000Z", status: "lost", close_reason: "client_declined", closed_at: "2026-10-29T05:00:00.000Z", archived_at: null },
    { id: "archived", tenant_id: "tenant-1", source_system: "manual", company_id: "co-5", company_name: "対象外", matched_at: "2026-10-29T05:00:00.000Z", sent_at: "2026-10-29T05:00:00.000Z", status: "reply_wait", archived_at: "2026-10-29T06:00:00Z" },
    { id: "other-tenant", tenant_id: "tenant-2", source_system: "enger", source_proposal_id: "e-other", company_id: "co-6", company_name: "別テナント", matched_at: "2026-10-29T05:00:00.000Z", sent_at: "2026-10-29T05:00:00.000Z", status: "reply_wait", archived_at: null },
  ],
  gw_sales_proposal_activities: [
    { id: "meeting-1", tenant_id: "tenant-1", proposal_id: "sent-previous", kind: "meeting", result: "done", occurred_at: "2026-10-28T16:00:00.000Z" },
    { id: "meeting-other", tenant_id: "tenant-2", proposal_id: "other-tenant", kind: "meeting", result: "done", occurred_at: "2026-10-29T05:00:00.000Z" },
  ],
  gw_employees: [
    { id: "owner-1", tenant_id: "tenant-1", display_name: "担当A" },
    { id: "owner-2", tenant_id: "tenant-1", display_name: "担当B" },
    { id: "owner-other", tenant_id: "tenant-2", display_name: "他社担当" },
  ],
};

function from(table) {
  const filters = [];
  let range = null;
  let order = null;
  let limit = null;
  let columns = null;
  const q = {
    select(value) { columns = value.split(","); return q; },
    eq(column, value) { filters.push({ op: "eq", column, value }); queryFilters.push([table, column, value]); return q; },
    is(column, value) { filters.push({ op: "is", column, value }); return q; },
    in(column, value) { filters.push({ op: "in", column, value }); return q; },
    gte(column, value) { filters.push({ op: "gte", column, value }); queryFilters.push([table, column, value]); return q; },
    lt(column, value) { filters.push({ op: "lt", column, value }); queryFilters.push([table, column, value]); return q; },
    order(column, options) { order = { column, options }; return q; },
    range(start, end) { range = [start, end]; return q; },
    limit(value) { limit = value; return q; },
    then(resolve, reject) {
      assert.ok(filters.some(f => f.op === "eq" && f.column === "tenant_id" && f.value === context.tenantId), "each query is tenant scoped");
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
      if (order) data = data.sort((a, b) => String(a[order.column] || "").localeCompare(String(b[order.column] || "")
        * (order.options?.ascending === false ? -1 : 1)));
      if (range) data = data.slice(range[0], range[1] + 1);
      if (limit != null) data = data.slice(0, limit);
      if (columns) data = data.map(row => Object.fromEntries(columns.map(key=>[key,row[key]])));
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
const { default: handler } = await import(atRoot("api/sales/dashboard-analysis.js"));

async function call(url, method = "GET") {
  const res = { statusCode: 0, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value; } };
  await handler({ method, url, headers: {} }, res);
  return res;
}

let response = await call("/api/sales/dashboard-analysis?period=custom&from=2026-10-29&to=2026-10-29");
assert.equal(response.statusCode, 403, "Sales権限が無い場合は拒否");
assert.equal(tablesRead.length, 0, "権限確認前にデータを読まない");
context = { tenantId: "tenant-1", allowed: true };
response = await call("/api/sales/dashboard-analysis?period=custom&from=2026-02-30&to=2026-03-01");
assert.equal(response.statusCode, 400, "存在しない日付を拒否");
assert.equal(tablesRead.length, 0, "期間検証前にデータを読まない");
response = await call("/api/sales/dashboard-analysis?period=custom&from=2026-10-30&to=2026-10-29");
assert.equal(response.statusCode, 400, "開始日が終了日より後の期間を拒否");

response = await call("/api/sales/dashboard-analysis?period=custom&from=2026-10-29&to=2026-10-29");
assert.equal(response.statusCode, 200);
assert.equal(response.headers["Cache-Control"], "private, no-store");
assert.deepEqual(response.body.period, { key: "custom", label: "期間指定", from: "2026-10-29", to: "2026-10-29", days: 1 });
assert.deepEqual(response.body.previousPeriod, { label: "直前1日間", from: "2026-10-28", to: "2026-10-28", days: 1 });
assert.equal(response.body.metrics.matchingCount, 1);
assert.equal(response.body.previousMetrics.matchingCount, 1);
assert.equal(response.body.metrics.unsubmittedMatchedCount, 1);
assert.equal(response.body.metrics.proposalSentCount, 2);
assert.equal(response.body.previousMetrics.proposalSentCount, 1);
assert.equal(response.body.metrics.meetingEventCount, 1, "実施件数は期間内の面談実施記録");
assert.equal(response.body.metrics.meetingCohortCount, 0, "当期送信提案コホートは、他提案の当期面談を数えない");
assert.equal(response.body.metrics.conversionRate, 0);
assert.equal(response.body.previousMetrics.meetingCohortCount, 1);
assert.equal(response.body.previousMetrics.conversionRate, 100);
assert.equal(response.body.metrics.lossReasons[0].label, "企業側の見送り");
assert.equal(response.body.metrics.byOwner.find((row) => row.ownerId === "owner-2").meetingEventCount, 1);
assert.equal(response.body.dataStatus.sourceState, "not_enabled");
assert(tablesRead.every((table) => queryFilters.some(([filteredTable, column, value]) =>
  filteredTable === table && column === "tenant_id" && value === "tenant-1")), "全クエリにテナント条件を付ける");
assert(queryFilters.some(([table, column, value]) => table === "gw_sales_proposals" && column === "matched_at" && value === "2026-10-27T15:00:00.000Z"), "マッチングはJST前期間開始から読む");
assert(queryFilters.some(([table, column, value]) => table === "gw_sales_proposal_activities" && column === "occurred_at" && value === "2026-10-29T15:00:00.000Z"), "面談は翌日JSTの境界を含めない");
response = await call("/api/sales/dashboard-analysis?period=today", "POST");
assert.equal(response.statusCode, 405, "ダッシュボード分析APIはGETのみ");
console.log("Sales dashboard analysis API: permission, tenant isolation, range validation, JST periods, comparison, and cohort separation OK");

rows.gw_sales_proposal_activities.push({id:"sent-action",tenant_id:"tenant-1",proposal_id:"sent-current",kind:"sent",employee_id:"owner-1",occurred_at:"2026-10-28T16:00:00Z"});
response=await call("/api/sales/dashboard-analysis?period=custom&from=2026-10-29&to=2026-10-29");
assert.equal(response.body.metrics.sentRecords.find(row=>row.proposalId==="sent-current").ownerName,"担当A","select includes actual sending employee");
const original=rows.gw_sales_proposals;
rows.gw_sales_proposals=Array.from({length:1001},(_,i)=>({id:"page-"+String(i).padStart(5,"0"),tenant_id:"tenant-1",sent_at:"2026-10-29T01:00:00Z",archived_at:null,status:"reply_wait"}));
response=await call("/api/sales/dashboard-analysis?period=custom&from=2026-10-29&to=2026-10-29");
assert.equal(response.body.metrics.proposalSentCount,1001,"second page included");
rows.gw_sales_proposals=Array.from({length:20001},(_,i)=>({id:"limit-"+String(i).padStart(5,"0"),tenant_id:"tenant-1",sent_at:"2026-10-29T01:00:00Z",archived_at:null,status:"reply_wait"}));
response=await call("/api/sales/dashboard-analysis?period=custom&from=2026-10-29&to=2026-10-29");
assert.equal(response.statusCode,503);
assert.equal(response.body.error,"dashboard_data_limit","limit never silently truncates");
rows.gw_sales_proposals=original;
