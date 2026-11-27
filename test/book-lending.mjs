import assert from "node:assert/strict";
import { mock } from "node:test";
import { createMemDb } from "./_memdb.mjs";
import { normalizeIsbn } from "../js/book-isbn.js";

const bookId = "00000000-0000-4000-8000-000000000001";
const loanId = "00000000-0000-4000-8000-000000000002";
const db = createMemDb({ schema: { gw_lending_books: { unique: [["id"]], defaults: () => ({ revision: 1 }) },
  gw_book_loans: { unique: [["id"]], defaults: () => ({ returned_on: null }) } } });
let ctx = { tenantId: "company", employee: {}, isAdmin: true, roles: [] };
mock.module("../lib/supabase.js", { namedExports: { admin: db.admin } });
mock.module("../lib/auth.js", { namedExports: { requireUser: async () => ({ id: "member" }) } });
mock.module("../lib/gw.js", { namedExports: {
  gwContext: async () => ctx, canOfficeHr: c => c.isAdmin, isLaborAdvisor: c => c.roles.includes("labor_advisor"), isTaxAdvisor: c => c.roles.includes("tax_advisor"),
} });
const { default: handler } = await import("../api/book-lending/index.js");
async function call(method, body, query = "") {
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handler({ method, url: "/api/book-lending" + query, body }, res);
  return { status: res.statusCode, ...res.body };
}
const title = "栢木先生のITパスポート教室 平成30年度";
assert.equal(normalizeIsbn("ISBN-13: ９７８－４－７７４１－９３２４－３"), "9784774193243");
assert.equal(normalizeIsbn("0-8044-2957-X"), "9780804429573");
assert.equal(normalizeIsbn("978-4-7741-9324-0"), null);
assert.equal(normalizeIsbn("1234567890128"), null);
const newBook = { action: "register", title, isbn: "9784774193243", bookId };
assert.equal((await call("POST", newBook)).status, 201);
assert.equal((await call("POST", newBook)).status, 409);
ctx = { ...ctx, isAdmin: false };
for (const query of ["?manage=1", "?history=" + bookId, "?lookup=isbn"]) assert.equal((await call("GET", null, query)).status, 403);
assert.equal((await call("POST", newBook)).status, 403);
ctx = { ...ctx, isAdmin: true };
const lend = { action: "lend", bookId, loanId, borrower: "テスト", date: "2025-12-01" };
assert.equal((await call("POST", { ...lend, date: "2025-02-30" })).status, 400);
assert.equal((await call("POST", lend)).status, 201);
ctx.tenantId = "other";
assert.equal((await call("POST", { ...lend, action: "return" })).status, 409);
ctx.tenantId = "company";
assert.equal((await call("POST", { ...lend, action: "return" })).status, 200);
assert.equal((await call("POST", { ...lend, action: "return" })).status, 409);
assert.equal((await call("GET", null, "?history=" + bookId)).loans[0].borrower_name, "テスト");
const edit = { ...newBook, action: "edit", revision: 1, isbn: "bad" };
assert.equal((await call("POST", edit)).status, 400);
assert.equal((await call("POST", { ...edit, isbn: newBook.isbn })).status, 200);
assert.equal((await call("POST", { ...edit, isbn: newBook.isbn })).status, 409);
let requested;
const net = mock.method(globalThis, "fetch", async url => { requested = new URL(url); return new Response("<rss></rss>"); });
assert.equal((await call("GET", null, "?lookup=" + encodeURIComponent(title))).status, 200);
assert.equal(requested.origin, "https://ndlsearch.ndl.go.jp");
assert.equal(requested.searchParams.get("title"), title);
assert.equal(requested.searchParams.get("mediatype"), "books");
net.mock.mockImplementation(async () => { throw new Error("offline"); });
assert.equal((await call("GET", null, "?lookup=isbn")).status, 503);
net.mock.restore();
console.log("書籍貸出のISBN・権限・履歴・重複操作・書誌検索を確認しました。");
