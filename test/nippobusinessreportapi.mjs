import assert from "node:assert/strict";
import { mock } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (path) => pathToFileURL(join(root, path)).href;
let context = { tenantId: "tenant-1", isBusinessReportAllowed: false };
let databaseReads = 0;
const tablesRead = [];
const tenantFilters = [];
const query = (table) => {
  const q = {
    select() { return q; },
    eq(column, value) { tenantFilters.push([table, column, value]); return q; },
    order() { return q; }, range() { return q; },
    limit() { return q; }, neq() { return q; }, is() { return q; },
    then(resolve, reject) {
      databaseReads++;
      tablesRead.push(table);
      return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    },
  };
  return q;
};
mock.module(atRoot("lib/http.js"), {
  namedExports: {
    json(res, status, body) { res.statusCode = status; res.body = body; return body; },
    methodNotAllowed(res, allowed) { res.allowed = allowed; res.statusCode = 405; return null; },
  },
});
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "user-1" }) } });
mock.module(atRoot("lib/gw.js"), { namedExports: { gwContext: async () => context } });
mock.module(atRoot("lib/supabase.js"), { namedExports: {
  admin: () => ({ from: (table) => query(table) }),
  userClient: () => ({ from: (table) => query(table) }),
} });
mock.module(atRoot("lib/nippo-business-report-access.js"), {
  namedExports: { canViewBusinessReport: (ctx) => ctx.isBusinessReportAllowed === true },
});
mock.module(atRoot("lib/nippo-business-report.js"), {
  namedExports: { buildBusinessReport: () => ({ sales: {}, matching: {}, insights: [] }) },
});
mock.module(atRoot("lib/nippo.js"), {
  namedExports: { isDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ""), jstDate: () => "2026-10-29" },
});
process.env.SALES_SOURCE_STATE_ENABLED = "0";
const { default: handler } = await import(atRoot("api/nippo/business-report.js"));

async function call(url, method = "GET") {
  const res = { statusCode: 0, body: null, setHeader() {} };
  await handler({ method, url, headers: {} }, res);
  return res;
}
let response = await call("/api/nippo/business-report?period=day");
assert.equal(response.statusCode, 403, "営業担当相当の権限ではAPIが全件集計を拒否");
assert.equal(databaseReads, 0, "拒否時にSalesデータを一切読まない");

context = { tenantId: "tenant-1", isBusinessReportAllowed: true };
response = await call("/api/nippo/business-report?access=1");
assert.equal(response.statusCode, 200);
assert.deepEqual(response.body, { available: true });
assert.equal(databaseReads, 0, "タブ権限の確認ではSalesデータを読まない");

response = await call("/api/nippo/business-report?period=day&date=2026-10-29");
assert.equal(response.statusCode, 200);
assert.equal(databaseReads, 6, "承認済みレポートは同一テナントの6つのSales連携テーブルを読む");
assert.deepEqual([...new Set(tablesRead)].sort(), [
  "gw_employees", "gw_sales_proposal_activities", "gw_sales_proposal_sync_log",
  "gw_sales_proposal_tasks", "gw_sales_proposals",
].sort());
assert(tablesRead.every((table) => tenantFilters.some(([filteredTable, column, value]) =>
  filteredTable === table && column === "tenant_id" && value === "tenant-1")), "全件取得は現在のテナント条件を必ず付ける");
assert(!tablesRead.some((table) => table.includes("nippo")), "個人の日報テーブルを読まない");

response = await call("/api/nippo/business-report", "POST");
assert.equal(response.statusCode, 405, "レポートAPIは読み取り専用");
console.log("nippo business report API access and tenant data boundary: OK");
