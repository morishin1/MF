// /api/office/invoices — 請求・支払（支払管理）：請求書の登録 → 確認 → 仕訳 → 支払予定 → 支払済み
//
//   GET  ?month=YYYY-MM   … その月の請求書（1請求書＝1行）・サマリー・支払先・設定・候補リスト
//   GET  ?id=<請求書id>    … 1件の詳細（ファイルの署名付きURL・基本情報・支払条件・仕訳・支払・MF出力・履歴・次にやること）
//   POST { action, … }
//        upload          … 請求書ファイル（PDF／JPEG／PNG）の置き場所（署名付きアップロードURL）を出す
//        read            … 置いたファイルを AI で読む → 読取候補を返す（保存しない。確定は人）
//        register        … 請求書を登録する（一般経費。支払先マスタ vendorId が必須）
//        update          … 基本情報を直す（支払済みは直せない）
//        preview_due     … 支払先マスタから支払期日を計算して見せる（保存しない）
//        confirm         … 内容を確認済みにする（一般経費。BP 請求書は月次の照合・承認で行う）
//        unconfirm       … 確認を取り消す（理由が要る。支払予定が無いときだけ）
//        save_journal    … 仕訳を保存する（confirm: true で確定。貸借が合わないと確定できない）
//        schedule        … 支払予定を入れる（確認済みだけ）
//        pay             … 支払済みにする（支払予定のあるものだけ）
//        cancel_payment  … 支払予定・支払済みを取り消す（理由が要る。物理削除しない）
//        void            … 請求書を取り消す（一般経費。支払済みなら断る。理由が要る）
//
// ■ 入れる人：見る・登録・確認＝経営者・責任者・経理／仕訳・支払・マスタ・取消＝経営者・経理（lib/office-payables-api.js）
// ■ 既存の仕組みを再利用する
//   gw_vendor_invoices（BP 請求書と同じ表。invoice_kind='general' で区別）・gw_office_payments（支払予定 → 支払済み → 取消）・
//   gw_office_events（履歴）・月次完了のガード。BP 請求書の登録・照合・承認は api/office/payables.js のまま。
// ■ AI は読取候補を出すだけ。確定にしない（「読取候補 → 人が確認 → 確定」）
// ■ 月次完了した月は、書き込みを断る

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { detectDoc } from "../../lib/hr-docs.js";
import { readInvoice } from "../../lib/office-invoice-ai.js";
import {
  fail, must, stop, text, yen, oneOf, nowIso, todayJst, notClosed, recordEvent, UUID, MONTH, INVOICE_BUCKET,
  canRecordPayment, loadSettings, mergeCandidates, vendorView, isPaymentMethod, isInvoiceClass,
} from "../../lib/office-payables-api.js";
import {
  decideDue, termsLabel, isRealDate, checkJournal, defaultJournal, deriveState, nextAction,
} from "../../lib/office-payables-calc.js";
import {
  MAX_FILE_BYTES, FILE_MIME_EXT, INVOICE_CLASSES, PAYMENT_METHODS, HOLIDAY_ADJUST, DUE_SOURCE_LABEL, JOURNAL_STATUS_LABEL, TAG_SEPARATOR,
} from "../../lib/office-invoice-defs.js";

const EXT = { pdf: "pdf", jpeg: "jpg", png: "png" };
const MIME_OF = { pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png" };
const VIEW_TTL = 60 * 5;

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
      const q = new URL(req.url, "http://localhost").searchParams;
      if (q.get("id")) return json(res, 200, await detail(ctx, user, q.get("id")));
      const month = q.get("month");
      if (!MONTH.test(String(month || ""))) stop(400, { error: "invalid_request", detail: "month は YYYY-MM で指定してください" });
      return json(res, 200, await listPayload(ctx, month, { withVoid: q.get("void") === "1" }));
    }
    const body = (await readJson(req)) || {};
    // 仕訳・支払・取消・取り消しは、経営者・経理だけ（責任者は、見る・登録・確認まで）
    const RECORD = ["save_journal", "schedule", "pay", "cancel_payment", "void", "unconfirm"];
    const actions = { upload, read, register, update, preview_due: previewDue, confirm, unconfirm, save_journal: saveJournal, schedule, pay, cancel_payment: cancelPayment, void: voidInvoice };
    const fn = actions[body.action];
    if (!fn) return json(res, 400, { error: "invalid_action", detail: Object.keys(actions).join(", ") });
    if (RECORD.includes(body.action) && !canRecordPayment(ctx)) {
      return json(res, 403, { error: "payment_forbidden", hint: "この操作は、経営者・経理だけができます（責任者は見るだけです）" });
    }
    return await fn({ res, ctx, user, body });
  } catch (e) {
    if (fail(res, e, "office/invoices")) return;
  }
}

// ---------------------------------------------------------------------------
// 読む
// ---------------------------------------------------------------------------
const num = (v) => (v === null || v === undefined ? null : Number(v));

function paymentView(p) {
  if (!p) return null;
  return {
    id: p.id, status: p.status, amount: num(p.amount), scheduledOn: p.scheduled_on, method: p.method || null,
    sourceAccount: p.source_account || null, sourceSubAccount: p.source_sub_account || null, memo: p.memo || null,
    paidOn: p.paid_on || null, paidAmount: num(p.paid_amount), feeAmount: num(p.fee_amount),
    cancelReason: p.cancel_reason || null, cancelledAt: p.cancelled_at || null, createdAt: p.created_at,
    mfExportedAt: p.mf_payment_last_exported_at || null, mfFirstExportedAt: p.mf_payment_first_exported_at || null,
  };
}

function rowView({ inv, payment, vendor, partnerName, today }) {
  const s = deriveState({ invoice: inv, payment, today });
  const next = nextAction({ invoice: inv, payment, today });
  const pay = paymentView(payment);
  return {
    id: inv.id, kind: inv.invoice_kind || "bp", status: inv.status,
    vendorId: inv.vendor_id || null, vendorName: vendor?.name || partnerName || null,
    invoiceNo: inv.invoice_no || null, hasFile: Boolean(inv.file_path || inv.submission_id), fileName: inv.file_name || null,
    invoiceDate: inv.invoice_date || null, receivedOn: inv.received_on, billingMonth: inv.billing_month,
    closing: inv.closing_day ? (inv.closing_day >= 31 ? "月末" : `${inv.closing_day}日`) : null, paymentTerms: inv.payment_terms || null,
    dueOn: inv.payment_due_on || null, dueSource: inv.due_source || null,
    subtotal: num(inv.subtotal_amount), tax: num(inv.tax_amount), total: num(inv.total_amount),
    description: inv.description || null,
    journalStatus: inv.journal_status || "none", journalLabel: JOURNAL_STATUS_LABEL[inv.journal_status || "none"],
    payment: pay,
    mf: {
      state: s.mfState, purchaseExportedAt: inv.mf_purchase_last_exported_at || null, paymentExportedAt: payment?.mf_payment_last_exported_at || null,
      purchasePending: s.purchasePending, paymentPending: s.paymentPending,
    },
    flags: {
      unconfirmed: s.unconfirmed, scheduled: s.payState === "scheduled", paid: s.payState === "paid", overdue: s.overdue,
      within7: s.within7, payToday: s.payToday, unjournaled: s.unjournaled, mfPending: s.mfPending, void: s.void, noDue: !s.void && !inv.payment_due_on,
    },
    next,
  };
}

function summaryOf(rows) {
  const live = rows.filter((r) => !r.flags.void);
  const c = (f) => live.filter(f).length;
  return {
    unconfirmed: c((r) => r.flags.unconfirmed), scheduled: c((r) => r.flags.scheduled), within7: c((r) => r.flags.within7),
    payToday: c((r) => r.flags.payToday), overdue: c((r) => r.flags.overdue), paid: c((r) => r.flags.paid),
    unjournaled: c((r) => r.flags.unjournaled), mfPending: c((r) => r.flags.mfPending), total: live.length,
  };
}

async function partnerNames(ctx, invoices) {
  const ids = [...new Set(invoices.map((i) => i.partner_company_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await must(admin().from("gw_partner_companies").select("id, company_name").eq("tenant_id", ctx.tenantId).in("id", ids).limit(2000));
  return new Map((rows || []).map((p) => [p.id, p.company_name]));
}

async function listPayload(ctx, month, { withVoid = false } = {}) {
  const sb = admin();
  const today = todayJst();
  const invoices = await must(sb.from("gw_vendor_invoices").select("*").eq("tenant_id", ctx.tenantId).eq("billing_month", month).order("received_on").limit(2000));
  const ids = (invoices || []).map((i) => i.id);
  const payments = ids.length ? await must(sb.from("gw_office_payments").select("*").eq("tenant_id", ctx.tenantId).in("vendor_invoice_id", ids).limit(5000)) : [];
  const vendors = await must(sb.from("gw_office_vendors").select("*").eq("tenant_id", ctx.tenantId).order("name").limit(2000));
  const vById = new Map((vendors || []).map((v) => [v.id, v]));
  const pNames = await partnerNames(ctx, invoices || []);
  const { settings, saved } = await loadSettings(ctx);
  const closed = await must(sb.from("gw_office_month_closes").select("id").eq("tenant_id", ctx.tenantId).eq("billing_month", month).is("reopened_at", null).limit(1));

  const all = (invoices || []).map((inv) => rowView({
    inv, payment: (payments || []).find((p) => p.vendor_invoice_id === inv.id && p.status !== "void") || null,
    vendor: vById.get(inv.vendor_id), partnerName: pNames.get(inv.partner_company_id), today,
  }));
  return {
    month, today, closed: Boolean(closed?.length),
    canRecord: canRecordPayment(ctx),
    summary: summaryOf(all),
    rows: withVoid ? all : all.filter((r) => !r.flags.void),
    vendors: (vendors || []).filter((v) => v.is_active !== false).map((v) => ({
      ...vendorView(v), termsLabel: termsLabel({ closingDay: v.closing_day, monthOffset: v.payment_month_offset, payDay: v.payment_day }),
    })),
    settings: {
      holidayAdjust: settings.holiday_adjust, defaultCreditAccount: settings.default_credit_account,
      defaultSourceAccount: settings.default_source_account, defaultPaymentMethod: settings.default_payment_method,
      feeAccount: settings.fee_account, feeTaxClass: settings.fee_tax_class,
    },
    candidates: mergeCandidates(saved, vendors || []),
    options: { invoiceClasses: INVOICE_CLASSES, paymentMethods: PAYMENT_METHODS, holidayAdjust: HOLIDAY_ADJUST, dueSource: DUE_SOURCE_LABEL },
  };
}

const idOf = (id) => {
  if (!id || !UUID.test(String(id))) stop(400, { error: "invalid_request", detail: "id が正しくありません" });
  return String(id);
};
async function loadInvoice(ctx, id) {
  const inv = await must(admin().from("gw_vendor_invoices").select("*").eq("id", idOf(id)).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!inv) stop(404, { error: "invoice_not_found" });
  return inv;
}
async function activePayment(ctx, invoiceId) {
  const rows = await must(admin().from("gw_office_payments").select("*").eq("tenant_id", ctx.tenantId).eq("vendor_invoice_id", invoiceId).neq("status", "void").order("created_at", { ascending: false }).limit(1));
  return rows?.[0] || null;
}
async function vendorOf(ctx, id) {
  if (!id) return null;
  return await must(admin().from("gw_office_vendors").select("*").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
}
async function journalOf(ctx, invoiceId) {
  const rows = await must(admin().from("gw_office_invoice_journals").select("*").eq("tenant_id", ctx.tenantId).eq("invoice_id", invoiceId).limit(200));
  const sorted = [...(rows || [])].sort((a, b) => (a.side === b.side ? a.line_no - b.line_no : a.side === "debit" ? -1 : 1));
  const first = sorted[0];
  return {
    lines: sorted.map((l) => ({
      side: l.side, account: l.account, subAccount: l.sub_account, department: l.department, partner: l.partner, taxClass: l.tax_class,
      invoiceClass: l.invoice_class, amount: num(l.amount), taxAmount: num(l.tax_amount),
    })),
    summary: first?.summary || null, memo: first?.memo || null, tags: first?.tags || [],
  };
}

async function detail(ctx, user, id) {
  const inv = await loadInvoice(ctx, id);
  const today = todayJst();
  const sb = admin();
  const payments = await must(sb.from("gw_office_payments").select("*").eq("tenant_id", ctx.tenantId).eq("vendor_invoice_id", inv.id).order("created_at").limit(100));
  const active = (payments || []).filter((p) => p.status !== "void").pop() || null;
  const vendor = await vendorOf(ctx, inv.vendor_id);
  const pNames = await partnerNames(ctx, [inv]);
  const { settings, saved } = await loadSettings(ctx);
  const vendors = await must(sb.from("gw_office_vendors").select("*").eq("tenant_id", ctx.tenantId).limit(2000));
  const row = rowView({ inv, payment: active, vendor, partnerName: pNames.get(inv.partner_company_id), today });
  const journal = await journalOf(ctx, inv.id);
  const check = journal.lines.length ? checkJournal(journal.lines, { total: inv.total_amount }) : null;
  const suggestion = defaultJournal({ vendor, total: inv.total_amount, settings, last: vendor?.last_journal || null });

  // ファイル（署名付きURL。5分で切れる。閲覧を監査ログに残す）
  let file = null;
  if (inv.file_path) {
    const { data } = await sb.storage.from(INVOICE_BUCKET).createSignedUrl(inv.file_path, VIEW_TTL);
    file = { url: data?.signedUrl || null, name: inv.file_name, mime: inv.file_mime, size: inv.file_size };
  } else if (inv.submission_id) {
    const sub = await must(sb.from("gw_submissions").select("file_name, mime_type, size_bytes, storage_path").eq("id", inv.submission_id).eq("tenant_id", ctx.tenantId).maybeSingle());
    if (sub?.storage_path) {
      const { data } = await sb.storage.from("billing-submissions").createSignedUrl(sub.storage_path, VIEW_TTL);
      file = { url: data?.signedUrl || null, name: sub.file_name, mime: sub.mime_type, size: sub.size_bytes };
    }
  }
  if (file) await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "office.invoice.view", target: `vendor_invoice:${inv.id}`, detail: { month: inv.billing_month } });

  // MF 出力の記録（CSV を出した記録。MF に登録された記録ではない）
  const items = await must(sb.from("gw_office_mf_export_items").select("*").eq("tenant_id", ctx.tenantId).eq("invoice_id", inv.id).limit(200));
  const batchIds = [...new Set((items || []).map((i) => i.export_id))];
  const batches = batchIds.length ? await must(sb.from("gw_office_mf_exports").select("*").eq("tenant_id", ctx.tenantId).in("id", batchIds).limit(200)) : [];
  const bById = new Map((batches || []).map((b) => [b.id, b]));
  const exports = (items || []).map((i) => {
    const b = bById.get(i.export_id) || {};
    return { kind: i.kind, txnNo: i.txn_no, exportedAt: i.exported_at, batchCode: b.batch_code || null, exportedByName: b.exported_by_name || null, mode: b.mode || null };
  }).sort((a, b) => String(a.exportedAt).localeCompare(String(b.exportedAt)));

  const events = await must(sb.from("gw_office_events").select("kind, actor_name, detail, created_at, billing_month").eq("tenant_id", ctx.tenantId).eq("billing_month", inv.billing_month).order("created_at").limit(1000));
  const history = (events || []).filter((e) => e.detail?.invoiceId === inv.id).map((e) => ({ kind: e.kind, at: e.created_at, by: e.actor_name || null, reason: e.detail?.reason || null }));

  return {
    invoice: {
      ...row, registrationNo: inv.registration_no || null, paymentMethod: inv.payment_method || null,
      sourceAccount: inv.source_account || null, sourceSubAccount: inv.source_sub_account || null,
      journalDate: inv.journal_date || null, approvedAt: inv.approved_at || null,
      dueSourceLabel: inv.due_source ? DUE_SOURCE_LABEL[inv.due_source] : "支払期日未設定",
      mfFirstExportedAt: inv.mf_purchase_first_exported_at || null, voidReason: inv.void_reason || null,
    },
    vendor: vendor ? vendorView(vendor) : null,
    file,
    journal: { ...journal, status: inv.journal_status || "none", balance: check ? { debit: check.debit, credit: check.credit, diff: check.diff, errors: check.errors, warnings: check.warnings } : null },
    suggestion,
    payments: (payments || []).map(paymentView),
    exports, history,
    candidates: mergeCandidates(saved, vendors || []),
    settings: { defaultSourceAccount: settings.default_source_account, defaultPaymentMethod: settings.default_payment_method, holidayAdjust: settings.holiday_adjust },
    canRecord: canRecordPayment(ctx),
  };
}

// ---------------------------------------------------------------------------
// 請求書ファイル（アップロード → AI 読取 → 登録）
// ---------------------------------------------------------------------------
async function upload({ res, ctx, body }) {
  const ext = FILE_MIME_EXT[String(body.mimeType || "")];
  if (!ext) return json(res, 400, { error: "unsupported_mime", hint: "PDF・JPEG・PNG のいずれかにしてください" });
  const size = Number(body.sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return json(res, 400, { error: "invalid_request", detail: "sizeBytes が不正です" });
  if (size > MAX_FILE_BYTES) return json(res, 400, { error: "file_too_large", hint: "10MBまでです", max: MAX_FILE_BYTES });
  const uploadId = crypto.randomUUID();
  const path = `${ctx.tenantId}/${uploadId}.${ext}`;
  const { data, error } = await admin().storage.from(INVOICE_BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
  return json(res, 200, { uploadId, path, uploadUrl: data.signedUrl, token: data.token });
}

/** 置かれたファイルを読む。パスは、こちらが決めた形（<テナント>/<uploadId>.<拡張子>）だけ */
async function findUploaded(ctx, uploadId) {
  if (!UUID.test(String(uploadId || ""))) return null;
  for (const ext of Object.values(EXT)) {
    const path = `${ctx.tenantId}/${uploadId}.${ext}`;
    const dl = await admin().storage.from(INVOICE_BUCKET).download(path);
    if (!dl.error && dl.data) return { path, bytes: Buffer.from(await dl.data.arrayBuffer()) };
  }
  return null;
}

const normName = (s) => String(s || "").normalize("NFKC").replace(/株式会社|有限会社|合同会社|\(株\)|（株）|\(有\)|（有）|\s|　/g, "").toLowerCase();

async function read({ res, ctx, body }) {
  const found = await findUploaded(ctx, body.uploadId);
  if (!found) return json(res, 404, { error: "no_file", hint: "置いたファイルを読めませんでした。もう一度アップロードしてください" });
  const r = await readInvoice({ buffer: found.bytes });
  if (!r.ok) {
    if (r.detail) console.error("[office/invoices] AI read failed:", r.code, r.detail);
    return json(res, 422, { error: "read_failed", code: r.code, message: r.message });
  }
  // 支払先の候補（登録番号が一致 → 名称が一致）。選ぶのは人
  const vendors = await must(admin().from("gw_office_vendors").select("id, name, invoice_reg_no, is_active").eq("tenant_id", ctx.tenantId).limit(2000));
  const c = r.candidates;
  let match = null;
  if (c.registrationNo) match = (vendors || []).find((v) => v.invoice_reg_no === c.registrationNo && v.is_active !== false) || null;
  if (!match && c.payeeName) {
    const n = normName(c.payeeName);
    match = (vendors || []).find((v) => v.is_active !== false && n && normName(v.name) === n) || null;
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: null, action: "office.invoice.read", target: `upload:${body.uploadId}`, detail: { ok: true, model: r.model } });
  return json(res, 200, {
    done: "read", model: r.model, confidence: r.confidence, candidates: c, warnings: r.warnings, notes: r.notes,
    vendorMatch: match ? { id: match.id, name: match.name } : null,
    note: "AI の読取候補です。内容を確認して、必要なら直してから登録してください（自動では確定しません）",
  });
}

// ---------------------------------------------------------------------------
// 登録・更新
// ---------------------------------------------------------------------------
function amountsFrom(b, errors) {
  const subtotal = yen(b.subtotal);
  const tax = yen(b.tax);
  const total = yen(b.total);
  for (const [v, label] of [[subtotal, "小計"], [tax, "消費税"], [total, "合計（税込）"]]) if (v === undefined) errors.push(`${label}は、0以上の整数（円）で入れてください`);
  if (errors.length) return null;
  let s = subtotal, x = tax, t = total;
  if (t === null && s !== null) t = s + (x ?? 0);
  if (s === null && t !== null) s = t - (x ?? 0);
  if (x === null && s !== null && t !== null) x = t - s;
  if (t === null || s === null) { errors.push("合計（または小計）を入れてください"); return null; }
  if (s < 0 || x < 0) { errors.push("小計と消費税が合計と合いません（合計 − 消費税 が負になります）"); return null; }
  if (s + x !== t) { errors.push(`小計＋消費税（${(s + x).toLocaleString("ja-JP")}円）と合計（${t.toLocaleString("ja-JP")}円）が合いません`); return null; }
  if (t <= 0) { errors.push("合計は 1円以上にしてください"); return null; }
  return { subtotal: s, tax: x, total: t };
}

function dateField(v, label, errors, { required = false } = {}) {
  if (v === null || v === undefined || v === "") { if (required) errors.push(`${label}を入れてください`); return null; }
  if (!isRealDate(v)) { errors.push(`${label}は、実在する日付（YYYY-MM-DD）で入れてください`); return null; }
  return v;
}

async function register({ res, ctx, user, body }) {
  const errors = [];
  const month = body.month;
  if (!MONTH.test(String(month || ""))) errors.push("対象月を YYYY-MM で入れてください");
  if (!body.vendorId || !UUID.test(String(body.vendorId))) errors.push("支払先を選んでください（無ければ先に支払先を登録してください）");
  const invoiceDate = dateField(body.invoiceDate, "請求日", errors, { required: true });
  const receivedOn = dateField(body.receivedOn, "受領日", errors) || todayJst();
  const amounts = amountsFrom(body, errors);
  const invoiceDue = dateField(body.invoiceDueOn ?? (body.dueSource === "invoice" ? body.paymentDueOn : null), "支払期日（請求書の記載）", errors);
  const manualDue = dateField(body.dueSource === "invoice" ? null : body.paymentDueOn, "支払期日", errors);
  if (errors.length) return json(res, 400, { error: "invalid_input", errors, hint: errors.join(" ／ ") });

  const vendor = await vendorOf(ctx, body.vendorId);
  if (!vendor) return json(res, 404, { error: "vendor_not_found", hint: "支払先が見つかりません" });
  if (vendor.is_active === false) return json(res, 409, { error: "vendor_inactive", hint: "この支払先は無効です。有効にするか、別の支払先を選んでください" });
  await notClosed(ctx, month);

  const invoiceNo = text(body.invoiceNo, 100, "請求書番号");
  if (invoiceNo) {
    const dup = await must(admin().from("gw_vendor_invoices").select("id, status").eq("tenant_id", ctx.tenantId).eq("vendor_id", vendor.id).eq("invoice_no", invoiceNo).limit(5));
    if ((dup || []).some((d) => d.status !== "void")) return json(res, 409, { error: "duplicate_invoice_no", hint: "この支払先の同じ請求書番号が、すでに登録されています" });
  }

  // ファイル
  let file = null;
  if (body.uploadId) {
    const found = await findUploaded(ctx, body.uploadId);
    if (!found) return json(res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした。もう一度アップロードしてください" });
    const fmt = detectDoc(found.bytes);
    if (!EXT[fmt] || found.bytes.length > MAX_FILE_BYTES) {
      await admin().storage.from(INVOICE_BUCKET).remove([found.path]);
      return json(res, 400, { error: "unsupported_file", hint: "PDF・JPEG・PNG（10MBまで）を選んでください" });
    }
    const sha = crypto.createHash("sha256").update(found.bytes).digest("hex");
    const same = await must(admin().from("gw_vendor_invoices").select("id, status").eq("tenant_id", ctx.tenantId).eq("file_sha256", sha).limit(20));
    if ((same || []).some((r) => r.status !== "void") && body.allowDuplicate !== true) {
      return json(res, 409, { error: "duplicate_file", uploadId: body.uploadId, hint: "同じファイルが、すでに登録されています。別のファイルではありませんか？（それでも登録するときは、確認してもう一度押してください）" });
    }
    const name = String(body.fileName || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 160) || `invoice.${EXT[fmt]}`;
    file = { path: found.path, name, mime: MIME_OF[fmt], size: found.bytes.length, sha };
  }

  // 支払期日：請求書の明記 → 経理の入力 → 支払先マスタから計算 → 未設定
  const { settings } = await loadSettings(ctx);
  const due = decideDue({ invoiceDue, manualDue, vendor, billingMonth: month, adjust: settings.holiday_adjust });
  const closingDay = body.closingDay ? Number(body.closingDay) : vendor.closing_day;
  if (closingDay != null && !(Number.isInteger(closingDay) && closingDay >= 1 && closingDay <= 31)) return json(res, 400, { error: "invalid_input", errors: ["締め日は 1〜31（31＝月末）で入れてください"] });
  const terms = text(body.paymentTerms, 100, "支払条件") || termsLabel({ closingDay: vendor.closing_day, monthOffset: vendor.payment_month_offset, payDay: vendor.payment_day });
  const method = oneOf(body.paymentMethod, isPaymentMethod, "支払方法") || vendor.std_payment_method || null;
  const sourceAccount = text(body.sourceAccount, 100, "支払元口座") || vendor.std_source_account || null;

  const inv = await must(admin().from("gw_vendor_invoices").insert({
    tenant_id: ctx.tenantId, invoice_kind: "general", vendor_id: vendor.id, partner_company_id: vendor.partner_company_id || null,
    billing_month: month, invoice_no: invoiceNo, invoice_date: invoiceDate, received_on: receivedOn,
    subtotal_amount: amounts.subtotal, tax_amount: amounts.tax, total_amount: amounts.total,
    closing_day: closingDay ?? null, payment_terms: terms, payment_due_on: due.date, due_source: due.source,
    registration_no: text(body.registrationNo, 20, "登録番号") || vendor.invoice_reg_no || null, description: text(body.description, 200, "摘要"),
    payment_method: method, source_account: sourceAccount, source_sub_account: text(body.sourceSubAccount, 100, "支払元口座の補助科目"),
    file_path: file?.path || null, file_name: file?.name || null, file_mime: file?.mime || null, file_size: file?.size || null, file_sha256: file?.sha || null,
    created_by: user.id,
  }).select("id").single());
  await recordEvent(ctx, user, month, "invoice.register", { invoiceId: inv.id, vendorId: vendor.id, hasFile: Boolean(file), dueSource: due.source, aiRead: body.aiRead === true });
  return json(res, 200, { done: "register", invoiceId: inv.id, ...(await listPayload(ctx, month)) });
}

async function update({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  if (inv.status === "void") return json(res, 409, { error: "void", hint: "取り消した請求書は直せません" });
  if ((inv.invoice_kind || "bp") !== "general") return json(res, 409, { error: "not_general", hint: "BP 請求書は、月次の画面で直します" });
  const pay = await activePayment(ctx, inv.id);
  if (pay?.status === "paid") return json(res, 409, { error: "paid", hint: "支払済みです。直すときは、先に支払を取り消してください" });
  await notClosed(ctx, inv.billing_month);
  const b = body.fields || body;
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const errors = [];
  const patch = {};
  let vendor = null;
  if (has("vendorId")) {
    if (!UUID.test(String(b.vendorId || ""))) errors.push("支払先を選んでください");
    else { vendor = await vendorOf(ctx, b.vendorId); if (!vendor) return json(res, 404, { error: "vendor_not_found" }); patch.vendor_id = vendor.id; patch.partner_company_id = vendor.partner_company_id || null; }
  }
  if (has("invoiceNo")) patch.invoice_no = text(b.invoiceNo, 100, "請求書番号");
  if (has("invoiceDate")) patch.invoice_date = dateField(b.invoiceDate, "請求日", errors, { required: true });
  if (has("receivedOn")) patch.received_on = dateField(b.receivedOn, "受領日", errors, { required: true });
  if (has("description")) patch.description = text(b.description, 200, "摘要");
  if (has("registrationNo")) patch.registration_no = text(b.registrationNo, 20, "登録番号");
  if (has("paymentTerms")) patch.payment_terms = text(b.paymentTerms, 100, "支払条件");
  if (has("closingDay")) {
    const d = b.closingDay === null || b.closingDay === "" ? null : Number(b.closingDay);
    if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 31)) errors.push("締め日は 1〜31（31＝月末）で入れてください");
    else patch.closing_day = d;
  }
  if (has("paymentMethod")) patch.payment_method = oneOf(b.paymentMethod, isPaymentMethod, "支払方法");
  if (has("sourceAccount")) patch.source_account = text(b.sourceAccount, 100, "支払元口座");
  if (has("sourceSubAccount")) patch.source_sub_account = text(b.sourceSubAccount, 100, "支払元口座の補助科目");
  let amountChanged = false;
  if (has("subtotal") || has("tax") || has("total")) {
    const a = amountsFrom({ subtotal: has("subtotal") ? b.subtotal : inv.subtotal_amount, tax: has("tax") ? b.tax : inv.tax_amount, total: has("total") ? b.total : null }, errors);
    if (a) {
      amountChanged = a.total !== Number(inv.total_amount);
      if (amountChanged && pay) return json(res, 409, { error: "has_payment", hint: "支払予定が入っています。金額を直すときは、先に支払予定を取り消してください" });
      patch.subtotal_amount = a.subtotal; patch.tax_amount = a.tax; patch.total_amount = a.total;
    }
  }
  if (has("billingMonth")) {
    if (!MONTH.test(String(b.billingMonth || ""))) errors.push("対象月を YYYY-MM で入れてください");
    else if (b.billingMonth !== inv.billing_month) {
      if (pay) return json(res, 409, { error: "has_payment", hint: "支払予定が入っています。対象月を直すときは、先に支払予定を取り消してください" });
      if (inv.mf_purchase_last_exported_at) return json(res, 409, { error: "exported", hint: "MF 用 CSV に出力済みです。対象月は直せません" });
      await notClosed(ctx, b.billingMonth);
      patch.billing_month = b.billingMonth;
    }
  }
  // 支払期日：請求書の明記 → 経理の入力 → 支払先マスタから計算（recomputeDue）→ 未設定
  if (has("paymentDueOn") || b.recomputeDue === true) {
    const v = vendor || await vendorOf(ctx, inv.vendor_id);
    const month = patch.billing_month || inv.billing_month;
    const dueIn = has("paymentDueOn") && b.paymentDueOn ? dateField(b.paymentDueOn, "支払期日", errors) : null;
    const { settings } = await loadSettings(ctx);
    const d = decideDue({
      invoiceDue: b.dueSource === "invoice" ? dueIn : null, manualDue: b.dueSource === "invoice" ? null : dueIn,
      vendor: v, billingMonth: month, adjust: settings.holiday_adjust,
    });
    patch.payment_due_on = d.date; patch.due_source = d.source;
  }
  if (errors.length) return json(res, 400, { error: "invalid_input", errors, hint: errors.join(" ／ ") });
  if (!Object.keys(patch).length) return json(res, 400, { error: "invalid_input", errors: ["直す項目がありません"] });
  const nextVendor = patch.vendor_id || inv.vendor_id;
  if (patch.invoice_no !== undefined || patch.vendor_id) {
    const no = patch.invoice_no !== undefined ? patch.invoice_no : inv.invoice_no;
    if (no) {
      const dup = await must(admin().from("gw_vendor_invoices").select("id, status").eq("tenant_id", ctx.tenantId).eq("vendor_id", nextVendor).eq("invoice_no", no).neq("id", inv.id).limit(5));
      if ((dup || []).some((d) => d.status !== "void")) return json(res, 409, { error: "duplicate_invoice_no", hint: "この支払先の同じ請求書番号が、すでに登録されています" });
    }
  }
  // 金額を直したら、確定した仕訳は下書きに戻す（仕訳の合計が請求額と合わなくなるため）
  let journalReset = false;
  if (amountChanged && inv.journal_status === "confirmed") { patch.journal_status = "draft"; patch.journal_confirmed_at = null; journalReset = true; }
  await must(admin().from("gw_vendor_invoices").update({ ...patch, updated_at: nowIso() }).eq("id", inv.id).eq("tenant_id", ctx.tenantId));
  await recordEvent(ctx, user, patch.billing_month || inv.billing_month, "invoice.update", { invoiceId: inv.id, fields: Object.keys(patch), journalReset });
  return json(res, 200, { done: "update", journalReset, ...(await detail(ctx, user, inv.id)) });
}

async function previewDue({ res, ctx, body }) {
  const errors = [];
  if (!MONTH.test(String(body.month || ""))) errors.push("対象月を YYYY-MM で入れてください");
  const vendor = await vendorOf(ctx, body.vendorId);
  if (!vendor) errors.push("支払先を選んでください");
  if (errors.length) return json(res, 400, { error: "invalid_input", errors });
  const { settings } = await loadSettings(ctx);
  const d = decideDue({ vendor, billingMonth: body.month, adjust: settings.holiday_adjust });
  return json(res, 200, {
    done: "preview_due", date: d.date, source: d.source, sourceLabel: d.source ? DUE_SOURCE_LABEL[d.source] : "支払期日未設定",
    termsLabel: termsLabel({ closingDay: vendor.closing_day, monthOffset: vendor.payment_month_offset, payDay: vendor.payment_day }),
    closingDay: vendor.closing_day, holidayAdjust: settings.holiday_adjust,
  });
}

// ---------------------------------------------------------------------------
// 確認・仕訳
// ---------------------------------------------------------------------------
async function confirm({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  if ((inv.invoice_kind || "bp") !== "general") return json(res, 409, { error: "bp_invoice", hint: "BP 請求書は、月次の画面で契約条件と照合して承認します" });
  if (inv.status === "void") return json(res, 409, { error: "void", hint: "取り消した請求書です" });
  if (inv.status === "approved") return json(res, 409, { error: "already_confirmed", hint: "確認済みです" });
  if (!inv.vendor_id) return json(res, 409, { error: "no_vendor", hint: "支払先を選んでから、確認してください" });
  await notClosed(ctx, inv.billing_month);
  const now = nowIso();
  const rows = await must(admin().from("gw_vendor_invoices").update({ status: "approved", approved_at: now, approved_by: user.id, updated_at: now })
    .eq("id", inv.id).eq("tenant_id", ctx.tenantId).eq("status", "received").select("id"));
  if (!rows?.length) return json(res, 409, { error: "state_changed", hint: "他の操作で状態が変わりました。開き直してください" });
  await recordEvent(ctx, user, inv.billing_month, "invoice.confirm", { invoiceId: inv.id });
  return json(res, 200, { done: "confirm", ...(await detail(ctx, user, inv.id)) });
}

async function unconfirm({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  const reason = text(body.reason, 500, "理由");
  if (!reason) return json(res, 400, { error: "reason_required", hint: "確認を取り消す理由を入れてください" });
  if (inv.status !== "approved" || (inv.invoice_kind || "bp") !== "general") return json(res, 409, { error: "not_confirmed", hint: "確認済みの一般経費の請求書だけ、取り消せます" });
  if (await activePayment(ctx, inv.id)) return json(res, 409, { error: "has_payment", hint: "支払予定が入っています。先に支払を取り消してください" });
  if (inv.mf_purchase_last_exported_at) return json(res, 409, { error: "exported", hint: "MF 用 CSV に出力済みです。確認は取り消せません" });
  await notClosed(ctx, inv.billing_month);
  await must(admin().from("gw_vendor_invoices").update({ status: "received", approved_at: null, approved_by: null, updated_at: nowIso() })
    .eq("id", inv.id).eq("tenant_id", ctx.tenantId));
  await recordEvent(ctx, user, inv.billing_month, "invoice.unconfirm", { invoiceId: inv.id, reason });
  return json(res, 200, { done: "unconfirm", ...(await detail(ctx, user, inv.id)) });
}

function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,、\s]+/);
  const out = [...new Set(list.map((t) => String(t ?? "").trim().split(TAG_SEPARATOR).join("").replace(/[,"\r\n]/g, "")).filter(Boolean))];
  if (out.length > 10) stop(400, { error: "invalid_input", errors: ["タグは 10 個までです"] });
  return out.map((t) => { if (t.length > 30) stop(400, { error: "invalid_input", errors: ["タグは 30 字までです"] }); return t; });
}

async function saveJournal({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  if (inv.status === "void") return json(res, 409, { error: "void", hint: "取り消した請求書です" });
  if (inv.status !== "approved") return json(res, 409, { error: "not_confirmed", hint: "先に請求書の内容を確認してください" });
  await notClosed(ctx, inv.billing_month);
  const confirmIt = body.confirm === true;
  const vendor = await vendorOf(ctx, inv.vendor_id);
  const pNames = vendor ? new Map() : await partnerNames(ctx, [inv]);
  const partnerDefault = vendor?.name || pNames.get(inv.partner_company_id) || null;
  const chk = checkJournal((Array.isArray(body.lines) ? body.lines : []).map((l) => ({ ...l, partner: l?.partner || partnerDefault })), { total: inv.total_amount });
  if (chk.lineErrors.length) return json(res, 400, { error: "invalid_journal", errors: chk.lineErrors, hint: chk.lineErrors.join(" ／ ") });
  if (confirmIt && !chk.ok) {
    return json(res, 409, { error: "journal_unbalanced", diff: chk.diff, debit: chk.debit, credit: chk.credit, errors: chk.errors, hint: chk.errors.join(" ／ ") });
  }
  if (inv.mf_purchase_last_exported_at && body.acknowledgeExported !== true) {
    return json(res, 409, { error: "exported_change", hint: "仕入計上の CSV は出力済みです。仕訳を直すと、MF 側の仕訳と食い違います。直すときは、確認して続けてください" });
  }
  const journalDate = body.journalDate ? (isRealDate(body.journalDate) ? body.journalDate : stop(400, { error: "invalid_input", errors: ["取引日は、実在する日付（YYYY-MM-DD）で入れてください"] })) : null;
  const summary = text(body.summary, 200, "摘要");
  const memo = text(body.memo, 500, "仕訳メモ");
  const tags = cleanTags(body.tags);

  const sb = admin();
  const old = await must(sb.from("gw_office_invoice_journals").select("*").eq("tenant_id", ctx.tenantId).eq("invoice_id", inv.id).limit(200));
  const stamp = nowIso();
  const lineNo = { debit: 0, credit: 0 };
  const rows = chk.lines.map((l) => ({
    tenant_id: ctx.tenantId, invoice_id: inv.id, line_no: ++lineNo[l.side], side: l.side, account: l.account, sub_account: l.subAccount,
    department: l.department, partner: l.partner, tax_class: l.taxClass, invoice_class: l.invoiceClass, amount: l.amount, tax_amount: l.taxAmount,
    summary, memo, tags, created_by: user.id, created_at: stamp, updated_at: stamp,
  }));
  await must(sb.from("gw_office_invoice_journals").delete().eq("tenant_id", ctx.tenantId).eq("invoice_id", inv.id));
  try {
    await must(sb.from("gw_office_invoice_journals").insert(rows));
  } catch (e) {
    if (old?.length) await sb.from("gw_office_invoice_journals").insert(old.map(({ id: _id, ...r }) => r));
    throw e;
  }
  await must(sb.from("gw_vendor_invoices").update({
    journal_status: confirmIt ? "confirmed" : "draft", journal_date: journalDate,
    journal_confirmed_at: confirmIt ? stamp : null, journal_confirmed_by: confirmIt ? user.id : null, updated_at: stamp,
  }).eq("id", inv.id).eq("tenant_id", ctx.tenantId));
  // 確定した仕訳を、支払先の「前回使った仕訳」にする（次回の初期値）
  if (confirmIt && vendor) {
    await must(sb.from("gw_office_vendors").update({
      last_journal: { lines: chk.lines, summary, tags }, last_journal_at: stamp, updated_at: stamp,
    }).eq("id", vendor.id).eq("tenant_id", ctx.tenantId));
  }
  await recordEvent(ctx, user, inv.billing_month, confirmIt ? "journal.confirm" : "journal.save", { invoiceId: inv.id, lines: rows.length, afterExport: Boolean(inv.mf_purchase_last_exported_at) });
  return json(res, 200, { done: "save_journal", warnings: chk.warnings, ...(await detail(ctx, user, inv.id)) });
}

// ---------------------------------------------------------------------------
// 支払（支払予定 → 支払済み → 取消）
// ---------------------------------------------------------------------------
async function schedule({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  if (inv.status !== "approved") return json(res, 409, { error: "not_confirmed", hint: "請求書の内容を確認（BP 請求書は照合・承認）してから、支払予定を入れてください" });
  await notClosed(ctx, inv.billing_month);
  if (!isRealDate(body.scheduledOn)) return json(res, 400, { error: "invalid_input", errors: ["支払予定日を、実在する日付（YYYY-MM-DD）で入れてください"] });
  const amount = body.amount === undefined || body.amount === null || body.amount === "" ? num(inv.total_amount) : yen(body.amount);
  if (amount === undefined || amount === null) return json(res, 400, { error: "invalid_input", errors: ["支払金額は、0以上の整数（円）で入れてください"] });
  const method = oneOf(body.method, isPaymentMethod, "支払方法") || inv.payment_method || null;
  if (await activePayment(ctx, inv.id)) return json(res, 409, { error: "already_scheduled", hint: "支払予定は、すでに入っています" });
  const p = await must(admin().from("gw_office_payments").insert({
    tenant_id: ctx.tenantId, vendor_invoice_id: inv.id, billing_month: inv.billing_month, amount, scheduled_on: body.scheduledOn, status: "scheduled",
    method, source_account: text(body.sourceAccount, 100, "支払元口座") || inv.source_account || null,
    source_sub_account: text(body.sourceSubAccount, 100, "支払元口座の補助科目") || inv.source_sub_account || null,
    memo: text(body.memo, 500, "メモ"), created_by: user.id,
  }).select("id").single());
  await recordEvent(ctx, user, inv.billing_month, "payment.schedule", { invoiceId: inv.id, paymentId: p.id, scheduledOn: body.scheduledOn, sameAsInvoice: amount === num(inv.total_amount) });
  return json(res, 200, { done: "schedule", ...(await detail(ctx, user, inv.id)) });
}

async function pay({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  await notClosed(ctx, inv.billing_month);
  const p = await activePayment(ctx, inv.id);
  if (!p) return json(res, 409, { error: "not_scheduled", hint: "支払予定が入っていません。先に支払予定を入れてください" });
  if (p.status === "paid") return json(res, 409, { error: "already_paid", hint: "支払済みです" });
  if (!isRealDate(body.paidOn)) return json(res, 400, { error: "invalid_input", errors: ["実支払日を、実在する日付（YYYY-MM-DD）で入れてください"] });
  if (body.paidOn > todayJst()) return json(res, 400, { error: "invalid_input", errors: ["実支払日は、今日以前にしてください（先の日付は、支払予定日として入れます）"] });
  const paidAmount = body.paidAmount === undefined || body.paidAmount === null || body.paidAmount === "" ? num(p.amount) : yen(body.paidAmount);
  const fee = body.feeAmount === undefined || body.feeAmount === null || body.feeAmount === "" ? 0 : yen(body.feeAmount);
  if (paidAmount === undefined || paidAmount === null || fee === undefined) return json(res, 400, { error: "invalid_input", errors: ["実支払額・振込手数料は、0以上の整数（円）で入れてください"] });
  const now = nowIso();
  const rows = await must(admin().from("gw_office_payments").update({
    status: "paid", paid_on: body.paidOn, paid_by: user.id, paid_amount: paidAmount, fee_amount: fee,
    source_account: text(body.sourceAccount, 100, "支払元口座") || p.source_account || inv.source_account || null,
    source_sub_account: text(body.sourceSubAccount, 100, "支払元口座の補助科目") || p.source_sub_account || inv.source_sub_account || null,
    memo: body.memo !== undefined ? text(body.memo, 500, "メモ") : p.memo || null, updated_at: now,
  }).eq("id", p.id).eq("tenant_id", ctx.tenantId).eq("status", "scheduled").select("id"));
  if (!rows?.length) return json(res, 409, { error: "state_changed", hint: "他の操作で状態が変わりました。開き直してください" });
  await recordEvent(ctx, user, inv.billing_month, "payment.paid", { invoiceId: inv.id, paymentId: p.id, paidOn: body.paidOn, differsFromPlan: paidAmount !== num(p.amount), hasFee: fee > 0 });
  return json(res, 200, { done: "pay", ...(await detail(ctx, user, inv.id)) });
}

async function cancelPayment({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  await notClosed(ctx, inv.billing_month);
  const reason = text(body.reason, 500, "理由");
  if (!reason) return json(res, 400, { error: "reason_required", hint: "取り消す理由を入れてください" });
  const p = await activePayment(ctx, inv.id);
  if (!p) return json(res, 409, { error: "not_scheduled", hint: "取り消す支払がありません" });
  if (p.mf_payment_last_exported_at && body.acknowledgeExported !== true) {
    return json(res, 409, { error: "exported_change", hint: "この支払は MF 用 CSV に出力済みです。取り消すと、MF 側の仕訳と食い違います。確認して続けてください" });
  }
  const now = nowIso();
  await must(admin().from("gw_office_payments").update({ status: "void", cancel_reason: reason, cancelled_at: now, cancelled_by: user.id, updated_at: now })
    .eq("id", p.id).eq("tenant_id", ctx.tenantId));
  await recordEvent(ctx, user, inv.billing_month, "payment.cancel", { invoiceId: inv.id, paymentId: p.id, was: p.status, reason, afterExport: Boolean(p.mf_payment_last_exported_at) });
  return json(res, 200, { done: "cancel_payment", ...(await detail(ctx, user, inv.id)) });
}

async function voidInvoice({ res, ctx, user, body }) {
  const inv = await loadInvoice(ctx, body.id);
  if ((inv.invoice_kind || "bp") !== "general") return json(res, 409, { error: "bp_invoice", hint: "BP 請求書の取り消しは、月次の画面で行います" });
  if (inv.status === "void") return json(res, 409, { error: "already_void", hint: "取り消し済みです" });
  await notClosed(ctx, inv.billing_month);
  const reason = text(body.reason, 500, "理由");
  if (!reason) return json(res, 400, { error: "reason_required", hint: "取り消す理由を入れてください" });
  const p = await activePayment(ctx, inv.id);
  if (p?.status === "paid") return json(res, 409, { error: "paid", hint: "支払済みです。先に支払を取り消してください" });
  if ((inv.mf_purchase_last_exported_at || p?.mf_payment_last_exported_at) && body.acknowledgeExported !== true) {
    return json(res, 409, { error: "exported_change", hint: "MF 用 CSV に出力済みです。取り消すと、MF 側の仕訳と食い違います。確認して続けてください" });
  }
  const now = nowIso();
  if (p) await must(admin().from("gw_office_payments").update({ status: "void", cancel_reason: `請求書の取り消し：${reason}`.slice(0, 500), cancelled_at: now, cancelled_by: user.id, updated_at: now }).eq("id", p.id).eq("tenant_id", ctx.tenantId));
  await must(admin().from("gw_vendor_invoices").update({ status: "void", void_reason: reason, voided_at: now, updated_at: now }).eq("id", inv.id).eq("tenant_id", ctx.tenantId));
  await recordEvent(ctx, user, inv.billing_month, "invoice.void", { invoiceId: inv.id, reason, hadPayment: Boolean(p) });
  return json(res, 200, { done: "void", ...(await listPayload(ctx, inv.billing_month)) });
}
