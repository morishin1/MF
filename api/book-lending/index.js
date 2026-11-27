import { requireUser } from "../../lib/auth.js";
import { gwContext, canOfficeHr, isLaborAdvisor, isTaxAdvisor } from "../../lib/gw.js";
import { json, methodNotAllowed, readJson } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { readAll } from "../../lib/pg-read.js";
import { jstDate } from "../../lib/devices.js";
import { normalizeIsbn } from "../../js/book-isbn.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const BOOK_FIELDS = "id,copy_no,title,isbn,confirmed,revision";
const LOAN_FIELDS = "id,borrower_name,loaned_on,returned_on";

function invalid(res, message) { return json(res, 400, { error: "invalid_input", message }); }
function conflict(res, message) { return json(res, 409, { error: "conflict", message }); }
function dbError(res) { return json(res, 500, { error: "db_error", message: "台帳を読み書きできませんでした。もう一度お試しください。" }); }
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > jstDate()) return false;
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || isLaborAdvisor(ctx) || isTaxAdvisor(ctx)) return json(res, 403, { error: "forbidden" });
  const manager = canOfficeHr(ctx);
  const q = new URL(req.url, "http://localhost").searchParams;
  if (req.method === "GET" && !q.has("manage") && !q.has("history") && !q.has("lookup")) {
    if (!manager && !ctx.employee) return json(res, 403, { error: "forbidden" });
    return listBooks(res, ctx.tenantId, false);
  }
  if (!manager) return json(res, 403, { error: "forbidden" });
  if (req.method === "GET") {
    if (q.has("lookup")) return lookup(res, q.get("lookup"));
    if (q.has("history")) {
      if (!UUID.test(q.get("history"))) return invalid(res, "書籍を選び直してください。");
      const { data, error } = await admin().from("gw_book_loans").select(LOAN_FIELDS)
        .eq("tenant_id", ctx.tenantId).eq("book_id", q.get("history"))
        .order("loaned_on", { ascending: false }).order("created_at", { ascending: false }).limit(30);
      return error ? dbError(res) : json(res, 200, { loans: data });
    }
    return listBooks(res, ctx.tenantId, true);
  }
  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const body = await readJson(req);
  if (!UUID.test(body?.bookId)) return invalid(res, "書籍を選び直してください。");
  if (["register", "edit", "confirm"].includes(body.action)) return saveBook(res, ctx.tenantId, body);
  if (["lend", "return"].includes(body.action)) return recordLoan(res, ctx.tenantId, body);
  return invalid(res, "操作を選び直してください。");
}

async function listBooks(res, tenantId, manage) {
  const sb = admin();
  const fields = manage ? BOOK_FIELDS + ",loans:gw_book_loans(" + LOAN_FIELDS + ")" : "isbn,title,loans:gw_book_loans(id)";
  const rows = await readAll(() => {
    const query = sb.from("gw_lending_books").select(fields).eq("tenant_id", tenantId)
      .is("loans.returned_on", null).order("copy_no");
    return manage ? query : query.eq("confirmed", true);
  });
  if (!rows) return dbError(res);
  if (manage) return json(res, 200, { books: rows.map(({ loans, ...book }) => ({ ...book, loan: loans[0] ?? null })) });
  const stock = new Map();
  for (const { loans, isbn, title } of rows) {
    if (loans.length) continue;
    const edition = stock.get(isbn) ?? { title, isbn, copies: 0 };
    edition.copies++;
    stock.set(isbn, edition);
  }
  return json(res, 200, { books: [...stock.values()] });
}

async function saveBook(res, tenantId, b) {
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const isbn = normalizeIsbn(b.isbn);
  if (!title || title.length > 300) return invalid(res, "書名を300文字以内で入力してください。");
  if (!isbn) return invalid(res, "ISBNの桁数と数字を確認してください。");
  const books = admin().from("gw_lending_books");
  const values = { title, isbn };
  if (b.action === "register") {
    const { error } = await books.insert({ id: b.bookId, tenant_id: tenantId, ...values, confirmed: true });
    if (!error) return json(res, 201, { ok: true });
    if (error.code === "23505") return conflict(res, "登録済みです。一覧を確認してください。");
    return dbError(res);
  }
  if (!Number.isSafeInteger(b.revision) || b.revision < 1) return invalid(res, "一覧から開き直してください。");
  let query = books.update({ ...values, ...(b.action === "confirm" ? { confirmed: true } : {}), revision: b.revision + 1 })
    .eq("tenant_id", tenantId).eq("id", b.bookId).eq("revision", b.revision);
  if (b.action === "confirm") query = query.eq("confirmed", false);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) return dbError(res);
  return data ? json(res, 200, { ok: true }) : conflict(res, "書籍が更新されています。一覧から開き直してください。");
}

async function recordLoan(res, tenantId, b) {
  if (!UUID.test(b.loanId)) return invalid(res, "貸出記録を選び直してください。");
  if (!validDate(b.date)) return invalid(res, "今日までの有効な日付を入力してください。");
  const loans = admin().from("gw_book_loans");
  if (b.action === "lend") {
    const name = typeof b.borrower === "string" ? b.borrower.trim() : "";
    if (!name || name.length > 100) return invalid(res, "借りる方の氏名を100文字以内で入力してください。");
    const { error } = await loans.insert({ tenant_id: tenantId, book_id: b.bookId, id: b.loanId, borrower_name: name, loaned_on: b.date });
    if (!error) return json(res, 201, { ok: true });
    if (error.code === "23505") return conflict(res, "この本の貸出はすでに記録されています。");
    if (error.code === "23503") return conflict(res, "現物を確認済みの書籍を選んでください。");
    if (error.code === "23P01") return invalid(res, "直前の返却日以降の日付を入力してください。");
    return dbError(res);
  }
  // Match this loan as well as this copy, so a repeated return cannot close a later loan.
  const { data, error } = await loans.update({ returned_on: b.date }).eq("tenant_id", tenantId)
    .eq("book_id", b.bookId).eq("id", b.loanId).is("returned_on", null).select("id").maybeSingle();
  if (error?.code === "23514") return invalid(res, "貸出日以降の返却日を入力してください。");
  if (error) return dbError(res);
  return data ? json(res, 200, { ok: true }) : conflict(res, "貸出状況が変わりました。一覧を確認してください。");
}

async function lookup(res, query) {
  const title = (query || "").trim();
  if (title.length < 2 || title.length > 300) return invalid(res, "書名を2〜300文字で入力してください。");
  const url = new URL("https://ndlsearch.ndl.go.jp/api/opensearch");
  url.search = new URLSearchParams({ title, dpid: "iss-ndl-opac", mediatype: "books", cnt: "20" });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: "error" });
    if (!response.ok) throw new Error("unavailable");
    const xml = await response.text();
    if (!/<rss[\s>]/i.test(xml)) throw new Error("invalid_response");
    return json(res, 200, { xml });
  } catch {
    return json(res, 503, { error: "lookup_unavailable", message: "国立国会図書館サーチに接続できませんでした。ISBNを手入力できます。" });
  }
}
