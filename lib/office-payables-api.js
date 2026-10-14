// Office「請求・支払」の API 共通部品（api/office/vendors.js・invoices.js・mf-csv.js が使う）。
//
// ■ 権限（現行を維持する）
//   見る・請求書を登録／確認する … 経営者・責任者・経理（canAccessOffice。api/office/index.js と同じ。各 API ファイルの入口で判定する）
//   支払予定・支払済み・取消・仕訳の確定・支払先マスタ・MF CSV … 経営者・経理（canRecordPayment。責任者は見るだけ）
//   MFA は要求しない（Office の方針）。
//
// ■ 読み書き
//   この機能の新しい表は RLS 有効・ポリシー無し（db/134）。API が権限を確かめてから service role で読み書きする。
//   既存の表（gw_vendor_invoices・gw_office_payments）も、権限を確かめたあとは service role で扱う（テナントは必ず絞る）。
//
// ■ SQL が未適用のとき
//   「SQL を流してください」(503 not_ready) を返す。ほかの Office の機能は止めない。

import { json, dbSetupHint } from "./http.js";
import { admin } from "./supabase.js";
import { gwLog } from "./gw-audit.js";
import { ymd } from "./jst.js";
import { DEFAULT_CANDIDATES, DEFAULT_SETTINGS, isHolidayAdjust, isPaymentMethod, isInvoiceClass } from "./office-invoice-defs.js";

export const SQL = "db/134_office_payables_general.sql";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const INVOICE_BUCKET = "office-invoices";

export class Reply extends Error {
  constructor(status, body) { super(body?.error || "reply"); this.status = status; this.body = body; }
}
export const stop = (status, body) => { throw new Reply(status, body); };
export const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
export const nowIso = () => new Date().toISOString();
export const todayJst = () => ymd(new Date());

/** 支払・仕訳・マスタ・MF CSV を触れる人：経営者・経理（責任者は見るだけ） */
export const canRecordPayment = (ctx) => (ctx?.roles || []).some((r) => r === "owner" || r === "finance");

/** 支払・仕訳・マスタ・MF CSV は経営者・経理だけ。使えなければ 403 を返して false（権限の入口 canAccessOffice は、各 API ファイルに置く） */
export function needRecord(res, ctx) {
  if (canRecordPayment(ctx)) return true;
  json(res, 403, { error: "payment_forbidden", hint: "この操作は、経営者・経理だけができます（責任者は見るだけです）" });
  return false;
}

/** 例外を応答にする。戻り値 true＝応答した */
export function fail(res, e, tag) {
  if (e instanceof Reply) { json(res, e.status, e.body); return true; }
  const hint = dbSetupHint(e, SQL);
  if (hint) { json(res, 503, { error: "not_ready", message: hint }); return true; }
  if (e?.code === "23505") {
    json(res, 409, { error: "duplicate", hint: "同じ内容がすでに登録されています（支払先名・請求書番号・仕訳の行など）" });
    return true;
  }
  console.error(`[${tag}]`, e?.message || e);
  json(res, 500, { error: "failed" });
  return true;
}

/** 月次完了した月は書き込みを断る（api/office/close.js と同じ） */
export async function notClosed(ctx, month) {
  const rows = await must(admin().from("gw_office_month_closes").select("id")
    .eq("tenant_id", ctx.tenantId).eq("billing_month", month).is("reopened_at", null).limit(1));
  if (rows?.length) stop(409, { error: "month_closed", hint: "この月は月次完了済みです。直すときは、先に月次完了を取り消してください" });
}

/** 履歴（gw_office_events）と監査ログ。金額・個人名は入れない（id と状態まで） */
export async function recordEvent(ctx, user, month, kind, detail = {}) {
  try {
    await must(admin().from("gw_office_events").insert({
      tenant_id: ctx.tenantId, billing_month: month, kind, actor_id: user.id,
      actor_name: ctx.employee?.display_name || null, detail,
    }));
  } catch (e) { console.error("[office/payables] event failed:", e?.message || e); }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `office.${kind}`, target: `vendor_invoice:${detail.invoiceId || ""}`, detail: { month, ...detail } });
}

// ---------------------------------------------------------------------------
// 入力の整形
// ---------------------------------------------------------------------------
export const text = (v, max, label = "") => {
  const s = String(v ?? "").trim();
  if (s.length > max) stop(400, { error: "invalid_input", errors: [`${label || "入力"}は ${max} 字までです`] });
  return s || null;
};
export const yen = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(/[,\s円¥]/g, "")) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 999999999999 || !Number.isInteger(n)) return undefined;
  return n;
};
export const oneOf = (v, ok, label) => {
  if (v === null || v === undefined || v === "") return null;
  if (!ok(v)) stop(400, { error: "invalid_input", errors: [`${label}の値が正しくありません`] });
  return v;
};
export { isPaymentMethod, isInvoiceClass, isHolidayAdjust };

// ---------------------------------------------------------------------------
// 設定・候補リスト
// ---------------------------------------------------------------------------
const CAND_KEYS = ["accounts", "sub_accounts", "departments", "tax_classes"];

/** 会社の設定（無ければ既定）。候補リストは「既定 ∪ 会社の設定 ∪ 支払先マスタで使っている名称」 */
export async function loadSettings(ctx) {
  const row = await must(admin().from("gw_office_payables_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle());
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (row?.[k]) s[k] = row[k];
  const saved = row?.candidates && typeof row.candidates === "object" ? row.candidates : {};
  return { settings: s, saved, exists: Boolean(row) };
}

export function mergeCandidates(saved, vendors = []) {
  const out = {};
  for (const k of CAND_KEYS) {
    const used = [];
    for (const v of vendors) {
      if (k === "accounts") used.push(v.std_debit_account, v.std_credit_account);
      if (k === "sub_accounts") used.push(v.std_debit_sub_account, v.std_credit_sub_account);
      if (k === "departments") used.push(v.std_department);
      if (k === "tax_classes") used.push(v.std_tax_class);
    }
    const list = [...(saved[k] || []), ...DEFAULT_CANDIDATES[k], ...used].map((x) => String(x || "").trim()).filter(Boolean);
    out[k] = [...new Set(list)];
  }
  return out;
}

/** 支払先マスタの1行 → 画面・API の形 */
export function vendorView(v) {
  return {
    id: v.id, name: v.name, shortName: v.short_name, partnerCompanyId: v.partner_company_id, registrationNo: v.invoice_reg_no,
    closingDay: v.closing_day, paymentMonthOffset: v.payment_month_offset, paymentDay: v.payment_day,
    stdDebitAccount: v.std_debit_account, stdDebitSubAccount: v.std_debit_sub_account, stdDepartment: v.std_department,
    stdTaxClass: v.std_tax_class, stdInvoiceClass: v.std_invoice_class,
    stdCreditAccount: v.std_credit_account, stdCreditSubAccount: v.std_credit_sub_account,
    stdPaymentMethod: v.std_payment_method, stdSourceAccount: v.std_source_account,
    lastJournal: v.last_journal || null, lastJournalAt: v.last_journal_at || null,
    memo: v.memo, active: v.is_active !== false,
  };
}
