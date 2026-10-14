// /api/office/payables — 仕入請求（BP請求書）の登録・照合・承認と、支払（支払予定 → 支払済）
//
//   GET  ?month=YYYY-MM          … その月の仕入請求書（明細・照合・支払）と、まだ請求書が登録されていない BP 契約
//   POST { action, month, … }
//        register        … 請求書を登録する（ヘッダ＋明細。明細は 要員×現場契約。BP請求書受領 の印を立てる）
//        approve         … 照合して承認する。契約条件（仕入単価）と合わないときは、理由（note）が要る
//        schedule        … 支払予定を入れる（承認済みの請求書だけ）
//        pay             … 支払済にする（支払予定のあるものだけ）
//        cancel_payment  … 支払予定・支払済を取り消す（理由が要る）
//        void            … 請求書を取り消す（支払済なら断る。先に支払を取り消す）
//
// ■ 入れる人：経営者・責任者・経理（canAccessOffice。api/office/index.js と同じ）。
//   ただし、支払（schedule・pay・cancel_payment）は経営者・経理だけ（責任者は見るだけ）。
//   MFA は要求しない（Office の方針。test/mfatest.mjs）。ここは支払の「記録」で、振込そのものは行わない。
//
// ■ 照合は保存しない。毎回、契約条件（gw_site_contract_terms.purchase_unit_price）と確定した稼働時間から計算する
//   （lib/office-calc.js expectedPurchase・matchVendorInvoice）。仕入側の精算ルールが未確定のところは「照合できない」とし、
//   推測で金額を出さない。差があっても自動で否認・修正しない（人が理由を書いて承認する）。
//
// ■ 月次完了（api/office/close.js）した月は、書き込みを断る。
//
// ■ 読むのはログインした人の権限（RLS）、書くのは権限を確かめたあとの service_role。
//   履歴（gw_office_events）には、金額・単価・個人名を入れない（id と状態だけ）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { isBillingMonth } from "../../lib/billing-progress.js";
import { monthRange } from "../../lib/timecard.js";
import { normalizeTerms, termsForMonth, expectedPurchase, matchVendorInvoice, isRealDate } from "../../lib/office-calc.js";

const SQL = "db/117_office_payables.sql";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 50;
const MAX_AMOUNT = 999999999999.99;

const INVOICE_FIELDS = "id, partner_company_id, billing_month, invoice_no, received_on, submission_id, subtotal_amount, "
  + "tax_amount, total_amount, status, mismatch_note, approved_at, void_reason, voided_at, created_at";
const LINE_FIELDS = "id, invoice_id, site_contract_id, employee_id, billing_month, amount, work_minutes, note, voided_at";
const PAYMENT_FIELDS = "id, vendor_invoice_id, billing_month, amount, scheduled_on, status, paid_on, created_at, updated_at";
const TERMS_FIELDS = "id, site_contract_id, valid_from, valid_to, pricing_type, sales_unit_price, purchase_unit_price, "
  + "settlement_mode, settle_min_minutes, settle_max_minutes, settle_unit_minutes, rounding_mode, rounding_scope, "
  + "over_rate_per_hour, under_rate_per_hour, prorate, amount_rounding";

class Reply extends Error {
  constructor(status, body) { super(body?.error || "reply"); this.status = status; this.body = body; }
}
const stop = (status, body) => { throw new Reply(status, body); };
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

/** 支払を記録できる人：経営者・経理（責任者は見るだけ） */
export const canRecordPayment = (ctx) => (ctx?.roles || []).some((r) => r === "owner" || r === "finance");

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });

  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const month = new URL(req.url, "http://localhost").searchParams.get("month");
      if (!isBillingMonth(month)) stop(400, { error: "invalid_request", detail: "month は YYYY-MM で指定してください" });
      return json(res, 200, await payload(req, ctx, month));
    }
    const body = (await readJson(req)) || {};
    const actions = { register, approve, schedule, pay, cancel_payment: cancelPayment, void: voidInvoice };
    const fn = actions[body.action];
    if (!fn) return json(res, 400, { error: "invalid_action", detail: Object.keys(actions).join(", ") });
    if (!isBillingMonth(body.month)) stop(400, { error: "invalid_request", detail: "month は YYYY-MM で指定してください" });
    if (["schedule", "pay", "cancel_payment"].includes(body.action) && !canRecordPayment(ctx)) {
      return json(res, 403, { error: "payment_forbidden", hint: "支払の記録は、経営者・経理だけができます" });
    }
    await notClosed(ctx, body.month);
    return await fn({ req, res, ctx, user, body, month: body.month });
  } catch (e) {
    if (e instanceof Reply) return json(res, e.status, e.body);
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    if (e?.code === "23505") return json(res, 409, { error: "duplicate", hint: "同じ契約・月の請求、または同じ請求書の支払が、すでに登録されています" });
    console.error("[office/payables]", e?.message || e);
    return json(res, 500, { error: "payables_failed" });
  }
}

// ---------------------------------------------------------------------------
// 読む
// ---------------------------------------------------------------------------
async function notClosed(ctx, month) {
  const rows = await must(admin().from("gw_office_month_closes").select("id")
    .eq("tenant_id", ctx.tenantId).eq("billing_month", month).is("reopened_at", null).limit(1));
  if (rows?.length) stop(409, { error: "month_closed", hint: "この月は月次完了済みです。直すときは、先に月次完了を取り消してください" });
}

/** BP 契約ごとの「契約どおりならいくらか」（仕入単価 × 確定した稼働時間） */
async function expectedByContract(sb, ctx, month, contractIds) {
  if (!contractIds.length) return new Map();
  const [terms, sheets] = await Promise.all([
    must(sb.from("gw_site_contract_terms").select(TERMS_FIELDS).eq("tenant_id", ctx.tenantId)
      .in("site_contract_id", contractIds).lt("valid_from", monthRange(month).to).limit(5000)),
    must(sb.from("gw_timesheets").select("site_contract_id, status, total_minutes").eq("tenant_id", ctx.tenantId)
      .eq("target_month", month).in("site_contract_id", contractIds).limit(2000)),
  ]);
  const out = new Map();
  for (const id of contractIds) {
    const rows = (terms || []).filter((t) => t.site_contract_id === id).map(normalizeTerms);
    const sheet = (sheets || []).find((s) => s.site_contract_id === id);
    const minutes = sheet?.status === "confirmed" ? sheet.total_minutes : null;
    out.set(id, { ...expectedPurchase({ terms: termsForMonth(rows, month), minutes }), minutes });
  }
  return out;
}

async function payload(req, ctx, month) {
  const sb = userClient(req);
  const [invoices, lines, payments, contracts] = await Promise.all([
    must(sb.from("gw_vendor_invoices").select(INVOICE_FIELDS).eq("tenant_id", ctx.tenantId).eq("billing_month", month)
      .order("received_on").limit(1000)),
    must(sb.from("gw_vendor_invoice_lines").select(LINE_FIELDS).eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(5000)),
    must(sb.from("gw_office_payments").select(PAYMENT_FIELDS).eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(1000)),
    must(sb.from("gw_site_contracts").select("id, employee_id, engagement_kind, site_company, period_from, period_to")
      .eq("tenant_id", ctx.tenantId).eq("engagement_kind", "bp").lt("period_from", monthRange(month).to).limit(2000)),
  ]);
  const range = monthRange(month);
  const bpContracts = (contracts || []).filter((c) => !c.period_to || c.period_to >= range.from);
  const contractIds = [...new Set([...bpContracts.map((c) => c.id), ...(lines || []).map((l) => l.site_contract_id).filter(Boolean)])];
  const expected = await expectedByContract(sb, ctx, month, contractIds);

  const empIds = [...new Set([...bpContracts.map((c) => c.employee_id), ...(lines || []).map((l) => l.employee_id).filter(Boolean)])];
  const emps = empIds.length ? await must(admin().from("gw_employees").select("id, display_name, partner_company_id")
    .eq("tenant_id", ctx.tenantId).in("id", empIds).limit(2000)) : [];
  const empById = new Map((emps || []).map((e) => [e.id, e]));
  const partnerIds = [...new Set([...(emps || []).map((e) => e.partner_company_id), ...(invoices || []).map((i) => i.partner_company_id)].filter(Boolean))];
  const partners = partnerIds.length ? await must(sb.from("gw_partner_companies").select("id, company_name")
    .eq("tenant_id", ctx.tenantId).in("id", partnerIds).limit(2000)) : [];
  const partnerName = new Map((partners || []).map((p) => [p.id, p.company_name]));
  const contractById = new Map((contracts || []).map((c) => [c.id, c]));

  const view = (inv) => {
    const ls = (lines || []).filter((l) => l.invoice_id === inv.id);
    const active = ls.filter((l) => !l.voided_at);
    const m = matchVendorInvoice({
      invoice: { subtotal: inv.subtotal_amount, tax: inv.tax_amount, total: inv.total_amount },
      lines: active.map((l) => ({ amount: l.amount, expected: expected.get(l.site_contract_id) })),
    });
    const pay = (payments || []).find((p) => p.vendor_invoice_id === inv.id && p.status !== "void") || null;
    return {
      id: inv.id, invoiceNo: inv.invoice_no, receivedOn: inv.received_on, submissionId: inv.submission_id,
      partnerName: partnerName.get(inv.partner_company_id) || null,
      subtotal: Number(inv.subtotal_amount), tax: Number(inv.tax_amount), total: Number(inv.total_amount),
      status: inv.status, mismatchNote: inv.mismatch_note, approvedAt: inv.approved_at, voidReason: inv.void_reason,
      match: { state: m.state, issues: m.issues },
      lines: ls.map((l) => {
        const i = active.indexOf(l);
        const e = expected.get(l.site_contract_id) || null;
        return {
          id: l.id, siteContractId: l.site_contract_id, employeeName: empById.get(l.employee_id)?.display_name || null,
          siteCompany: contractById.get(l.site_contract_id)?.site_company || null,
          amount: Number(l.amount), note: l.note, voided: Boolean(l.voided_at),
          expected: e ? e.expected : null, expectedReasons: e ? e.reasons : [],
          match: i >= 0 ? m.lines[i] : null,
        };
      }),
      payment: pay ? { id: pay.id, amount: Number(pay.amount), scheduledOn: pay.scheduled_on, status: pay.status, paidOn: pay.paid_on } : null,
    };
  };

  const lined = new Set((lines || []).filter((l) => !l.voided_at).map((l) => l.site_contract_id));
  return {
    month,
    canRecordPayment: canRecordPayment(ctx),
    invoices: (invoices || []).map(view),
    // まだ請求書（明細）が登録されていない BP 契約
    pending: bpContracts.filter((c) => !lined.has(c.id)).map((c) => {
      const e = empById.get(c.employee_id);
      const x = expected.get(c.id);
      return {
        siteContractId: c.id, employeeName: e?.display_name || null, siteCompany: c.site_company,
        partnerName: partnerName.get(e?.partner_company_id) || null,
        expected: x?.expected ?? null, expectedReasons: x?.reasons || [],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 書く
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const money = (v) => {
  const n = typeof v === "string" ? Number(v.replace(/[,\s円]/g, "")) : Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return undefined;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return undefined;     // 小数2桁まで
  return Math.round(n * 100) / 100;
};
const text = (v, max) => {
  const s = String(v ?? "").trim();
  if (s.length > max) stop(400, { error: "invalid_request", detail: `${max} 字までです` });
  return s || null;
};

async function event(ctx, user, month, kind, detail, { employeeId = null, siteContractId = null } = {}) {
  try {
    await must(admin().from("gw_office_events").insert({
      tenant_id: ctx.tenantId, billing_month: month, employee_id: employeeId, site_contract_id: siteContractId,
      kind, actor_id: user.id, actor_name: ctx.employee?.display_name || null, detail,
    }));
  } catch (e) { console.error("[office/payables] event failed:", e?.message || e); }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `office.${kind}`, target: `vendor_invoice:${detail.invoiceId || ""}`, detail: { month, ...detail } });
}

async function invoiceOf(ctx, id, month) {
  if (!id || !UUID.test(String(id))) stop(400, { error: "invalid_request", detail: "id が正しくありません" });
  const inv = await must(admin().from("gw_vendor_invoices").select(INVOICE_FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!inv) stop(404, { error: "invoice_not_found" });
  if (inv.billing_month !== month) stop(400, { error: "invalid_request", detail: "請求書の対象月が違います" });
  return inv;
}
async function activePayment(ctx, invoiceId) {
  // 有効な支払は1件だけ（db/117 の部分ユニーク uq_gw_office_payments_active）
  const rows = await must(admin().from("gw_office_payments").select(PAYMENT_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("vendor_invoice_id", invoiceId).neq("status", "void").order("created_at", { ascending: false }).limit(1));
  return rows?.[0] || null;
}

/** BP請求書受領の印を立てる（既存の月初作業管理の印。行が無ければ作る） */
async function markReceived(ctx, c, month) {
  const sb = admin();
  const p = await must(sb.from("gw_billing_progress").select("id, bp_invoice_received")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", c.employee_id).eq("site_contract_id", c.id).eq("billing_month", month).maybeSingle());
  if (p?.bp_invoice_received) return false;
  const now = nowIso();
  if (p) await must(sb.from("gw_billing_progress").update({ bp_invoice_received: true, bp_invoice_received_at: now, updated_at: now }).eq("id", p.id));
  else {
    await must(sb.from("gw_billing_progress").insert({
      tenant_id: ctx.tenantId, employee_id: c.employee_id, site_contract_id: c.id, billing_month: month,
      bp_invoice_received: true, bp_invoice_received_at: now,
    }));
  }
  return true;
}

async function register({ req, res, ctx, user, body, month }) {
  const errors = [];
  const receivedOn = body.receivedOn;
  if (!isRealDate(receivedOn)) errors.push("受領日を、実在する日付（YYYY-MM-DD）で入れてください");
  const subtotal = money(body.subtotal);
  const tax = body.tax === undefined || body.tax === null || body.tax === "" ? 0 : money(body.tax);
  const total = body.total === undefined || body.total === null || body.total === "" ? (subtotal ?? 0) + (tax ?? 0) : money(body.total);
  if (subtotal === undefined) errors.push("小計（税抜）は、0以上の数（小数2桁まで）で入れてください");
  if (tax === undefined) errors.push("消費税は、0以上の数（小数2桁まで）で入れてください");
  if (total === undefined) errors.push("合計は、0以上の数（小数2桁まで）で入れてください");
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) errors.push("明細（要員）を1件以上入れてください");
  if (lines.length > MAX_LINES) errors.push(`明細は ${MAX_LINES} 件までです`);
  const parsed = lines.map((l, i) => {
    const amount = money(l?.amount);
    if (!l?.siteContractId || !UUID.test(String(l.siteContractId))) errors.push(`明細${i + 1}：現場契約を指定してください`);
    if (amount === undefined) errors.push(`明細${i + 1}：金額（税抜）は、0以上の数（小数2桁まで）で入れてください`);
    return { siteContractId: l?.siteContractId, amount, note: text(l?.note, 500) };
  });
  if (new Set(parsed.map((p) => p.siteContractId)).size !== parsed.length) errors.push("同じ現場契約が、明細に2回入っています");
  if (body.submissionId && !UUID.test(String(body.submissionId))) errors.push("ファイルの指定が正しくありません");
  if (errors.length) return json(res, 400, { error: "invalid_input", errors, hint: errors.join(" ／ ") });

  // 契約：この会社の BP 契約だけ（RLS で読む）
  const ids = parsed.map((p) => p.siteContractId);
  const contracts = await must(userClient(req).from("gw_site_contracts").select("id, employee_id, engagement_kind")
    .eq("tenant_id", ctx.tenantId).in("id", ids).limit(MAX_LINES));
  const byId = new Map((contracts || []).map((c) => [c.id, c]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) return json(res, 404, { error: "contract_not_found" });
  if ((contracts || []).some((c) => c.engagement_kind !== "bp")) {
    return json(res, 409, { error: "not_vendor", hint: "売上のみの契約です。仕入請求（BP請求書）はありません" });
  }
  // 発注先（BP会社）：明細の要員の BP 会社が1つにそろっていること
  const emps = await must(admin().from("gw_employees").select("id, partner_company_id")
    .eq("tenant_id", ctx.tenantId).in("id", [...new Set(contracts.map((c) => c.employee_id))]).limit(MAX_LINES));
  const partners = [...new Set((emps || []).map((e) => e.partner_company_id).filter(Boolean))];
  if (partners.length > 1) return json(res, 400, { error: "partner_mismatch", hint: "別々の BP 会社の要員が、1枚の請求書に入っています" });

  if (body.submissionId) {
    const sub = await must(userClient(req).from("gw_submissions").select("id, kind")
      .eq("tenant_id", ctx.tenantId).eq("id", body.submissionId).maybeSingle());
    if (!sub) return json(res, 404, { error: "submission_not_found" });
  }

  // 二重計上：同じ契約・月の、取り消していない明細があれば断る
  const dup = await must(admin().from("gw_vendor_invoice_lines").select("id, site_contract_id")
    .eq("tenant_id", ctx.tenantId).eq("billing_month", month).in("site_contract_id", ids).is("voided_at", null).limit(MAX_LINES));
  if (dup?.length) return json(res, 409, { error: "duplicate_line", hint: "この要員・月の仕入請求は、すでに登録されています（取り消してから登録し直してください）" });

  const sb = admin();
  const inv = await must(sb.from("gw_vendor_invoices").insert({
    tenant_id: ctx.tenantId, partner_company_id: partners[0] || null, billing_month: month,
    invoice_no: text(body.invoiceNo, 100), received_on: receivedOn, submission_id: body.submissionId || null,
    subtotal_amount: subtotal, tax_amount: tax, total_amount: total, created_by: user.id,
  }).select("id").single());
  try {
    await must(sb.from("gw_vendor_invoice_lines").insert(parsed.map((p) => ({
      tenant_id: ctx.tenantId, invoice_id: inv.id, site_contract_id: p.siteContractId,
      employee_id: byId.get(p.siteContractId).employee_id, billing_month: month, amount: p.amount, note: p.note,
    }))));
  } catch (e) {
    await sb.from("gw_vendor_invoices").delete().eq("id", inv.id).eq("tenant_id", ctx.tenantId);
    throw e;
  }
  for (const c of contracts) {
    const marked = await markReceived(ctx, c, month);
    await event(ctx, user, month, "vendor_invoice.register", { invoiceId: inv.id, marks: marked ? ["bp_invoice_received"] : [] },
      { employeeId: c.employee_id, siteContractId: c.id });
  }
  return json(res, 200, { done: "register", invoiceId: inv.id, ...(await payload(req, ctx, month)) });
}

/** 照合の結果（承認・画面の両方で同じ計算） */
async function matchOf(req, ctx, inv) {
  const lines = await must(admin().from("gw_vendor_invoice_lines").select(LINE_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("invoice_id", inv.id).is("voided_at", null).limit(MAX_LINES));
  const expected = await expectedByContract(userClient(req), ctx, inv.billing_month, [...new Set(lines.map((l) => l.site_contract_id).filter(Boolean))]);
  return matchVendorInvoice({
    invoice: { subtotal: inv.subtotal_amount, tax: inv.tax_amount, total: inv.total_amount },
    lines: lines.map((l) => ({ amount: l.amount, expected: expected.get(l.site_contract_id) })),
  });
}

async function approve({ req, res, ctx, user, body, month }) {
  const inv = await invoiceOf(ctx, body.id, month);
  if (inv.status !== "received") return json(res, 409, { error: "not_received", hint: inv.status === "approved" ? "承認済みです" : "取り消した請求書です" });
  const m = await matchOf(req, ctx, inv);
  const note = text(body.note, 500);
  if (m.state !== "match" && !note) {
    return json(res, 409, {
      error: "mismatch_note_required", state: m.state, issues: m.issues,
      hint: "契約条件と一致しない（または照合できない）ため、承認する理由を入れてください",
    });
  }
  const now = nowIso();
  const rows = await must(admin().from("gw_vendor_invoices").update({
    status: "approved", approved_at: now, approved_by: user.id, mismatch_note: m.state === "match" ? null : note, updated_at: now,
  }).eq("id", inv.id).eq("tenant_id", ctx.tenantId).eq("status", "received").select("id"));
  if (!rows?.length) return json(res, 409, { error: "state_changed", hint: "他の操作で状態が変わりました。開き直してください" });
  await event(ctx, user, month, "vendor_invoice.approve", { invoiceId: inv.id, match: m.state, codes: m.issues.map((i) => i.code) });
  return json(res, 200, { done: "approve", ...(await payload(req, ctx, month)) });
}

async function schedule({ req, res, ctx, user, body, month }) {
  const inv = await invoiceOf(ctx, body.id, month);
  if (inv.status !== "approved") return json(res, 409, { error: "not_approved", hint: "請求書を照合・承認してから、支払予定を入れてください" });
  if (!isRealDate(body.scheduledOn)) return json(res, 400, { error: "invalid_input", errors: ["支払予定日を、実在する日付（YYYY-MM-DD）で入れてください"] });
  const amount = body.amount === undefined || body.amount === null || body.amount === "" ? Number(inv.total_amount) : money(body.amount);
  if (amount === undefined) return json(res, 400, { error: "invalid_input", errors: ["支払額は、0以上の数（小数2桁まで）で入れてください"] });
  if (await activePayment(ctx, inv.id)) return json(res, 409, { error: "already_scheduled", hint: "支払予定は、すでに入っています" });
  const p = await must(admin().from("gw_office_payments").insert({
    tenant_id: ctx.tenantId, vendor_invoice_id: inv.id, billing_month: month, amount, scheduled_on: body.scheduledOn,
    status: "scheduled", created_by: user.id,
  }).select("id").single());
  await event(ctx, user, month, "payment.schedule", { invoiceId: inv.id, paymentId: p.id, scheduledOn: body.scheduledOn, sameAsInvoice: amount === Number(inv.total_amount) });
  return json(res, 200, { done: "schedule", ...(await payload(req, ctx, month)) });
}

async function pay({ req, res, ctx, user, body, month }) {
  const inv = await invoiceOf(ctx, body.id, month);
  const p = await activePayment(ctx, inv.id);
  if (!p) return json(res, 409, { error: "not_scheduled", hint: "支払予定が入っていません。先に支払予定を入れてください" });
  if (p.status === "paid") return json(res, 409, { error: "already_paid", hint: "支払済みです" });
  if (!isRealDate(body.paidOn)) return json(res, 400, { error: "invalid_input", errors: ["支払日を、実在する日付（YYYY-MM-DD）で入れてください"] });
  const now = nowIso();
  const rows = await must(admin().from("gw_office_payments").update({ status: "paid", paid_on: body.paidOn, paid_by: user.id, updated_at: now })
    .eq("id", p.id).eq("tenant_id", ctx.tenantId).eq("status", "scheduled").select("id"));
  if (!rows?.length) return json(res, 409, { error: "state_changed", hint: "他の操作で状態が変わりました。開き直してください" });
  await event(ctx, user, month, "payment.paid", { invoiceId: inv.id, paymentId: p.id, paidOn: body.paidOn });
  return json(res, 200, { done: "pay", ...(await payload(req, ctx, month)) });
}

async function cancelPayment({ req, res, ctx, user, body, month }) {
  const inv = await invoiceOf(ctx, body.id, month);
  const reason = text(body.reason, 500);
  if (!reason) return json(res, 400, { error: "reason_required", hint: "取り消す理由を入れてください" });
  const p = await activePayment(ctx, inv.id);
  if (!p) return json(res, 409, { error: "not_scheduled", hint: "取り消す支払がありません" });
  await must(admin().from("gw_office_payments").update({ status: "void", updated_at: nowIso() }).eq("id", p.id).eq("tenant_id", ctx.tenantId));
  await event(ctx, user, month, "payment.cancel", { invoiceId: inv.id, paymentId: p.id, was: p.status });
  return json(res, 200, { done: "cancel_payment", ...(await payload(req, ctx, month)) });
}

async function voidInvoice({ req, res, ctx, user, body, month }) {
  const inv = await invoiceOf(ctx, body.id, month);
  if (inv.status === "void") return json(res, 409, { error: "already_void", hint: "取り消し済みです" });
  const reason = text(body.reason, 500);
  if (!reason) return json(res, 400, { error: "reason_required", hint: "取り消す理由を入れてください" });
  const p = await activePayment(ctx, inv.id);
  if (p?.status === "paid") return json(res, 409, { error: "paid", hint: "支払済みです。先に支払を取り消してください" });
  const now = nowIso();
  const sb = admin();
  if (p) await must(sb.from("gw_office_payments").update({ status: "void", updated_at: now }).eq("id", p.id).eq("tenant_id", ctx.tenantId));
  await must(sb.from("gw_vendor_invoice_lines").update({ voided_at: now }).eq("invoice_id", inv.id).eq("tenant_id", ctx.tenantId).is("voided_at", null));
  await must(sb.from("gw_vendor_invoices").update({ status: "void", void_reason: reason, voided_at: now, updated_at: now })
    .eq("id", inv.id).eq("tenant_id", ctx.tenantId));
  await event(ctx, user, month, "vendor_invoice.void", { invoiceId: inv.id, hadPayment: Boolean(p) });
  return json(res, 200, { done: "void", ...(await payload(req, ctx, month)) });
}
