// /api/office/vendors — 支払先マスタ・請求書の設定（休日調整・候補リスト）
//
//   GET                       … 支払先（有効・無効とも）・設定・候補リスト
//   POST { action, … }
//        create       … 支払先を作る
//        update       … 支払先を直す（送った項目だけ）
//        set_active   … 有効／無効にする（消さない。請求書から参照されるため）
//        save_settings… 休日調整・既定の科目・候補リスト
//
// ■ 入れる人：見る＝経営者・責任者・経理／書く＝経営者・経理（lib/office-payables-api.js）
// ■ 勘定科目・補助科目・部門・税区分は「自由入力＋候補リスト」。MFクラウドの正式名称と一致させるのは人（MF の API 同期はしない）
// ■ 履歴（gw_office_events）には、名称・金額を入れない（id と変えた項目名まで）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { ymd } from "../../lib/jst.js";
import {
  needRecord, fail, must, stop, text, oneOf, nowIso, UUID, canRecordPayment, recordEvent, loadSettings, mergeCandidates, vendorView,
  isPaymentMethod, isInvoiceClass, isHolidayAdjust,
} from "../../lib/office-payables-api.js";
import { termsLabel } from "../../lib/office-payables-calc.js";
import { INVOICE_CLASSES, PAYMENT_METHODS, HOLIDAY_ADJUST } from "../../lib/office-invoice-defs.js";

const REG = /^T\d{13}$/;
const int = (v, lo, hi, label) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) stop(400, { error: "invalid_input", errors: [`${label}は ${lo}〜${hi} の整数で入れてください`] });
  return n;
};

/** 画面の形（camelCase）→ DB の列。送られた項目だけ返す（update は部分更新） */
function parseVendor(b, { requireName }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has("name") || requireName) {
    const n = text(b.name, 200, "支払先名称");
    if (!n) stop(400, { error: "invalid_input", errors: ["支払先名称を入れてください"] });
    out.name = n;
  }
  if (has("shortName")) out.short_name = text(b.shortName, 100, "略称");
  if (has("registrationNo")) {
    const r = String(b.registrationNo ?? "").normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
    if (r && !REG.test(r)) stop(400, { error: "invalid_input", errors: ["適格請求書発行事業者の登録番号は T＋13桁の数字です"] });
    out.invoice_reg_no = r || null;
  }
  if (has("closingDay")) out.closing_day = int(b.closingDay, 1, 31, "標準締め日（31＝月末）");
  if (has("paymentMonthOffset") || has("paymentDay")) {
    const o = int(b.paymentMonthOffset, 0, 6, "支払月（締め月から何か月後か）");
    const d = int(b.paymentDay, 1, 31, "支払日（31＝月末）");
    if ((o === null) !== (d === null)) stop(400, { error: "invalid_input", errors: ["標準の支払条件は、何か月後かと支払日を両方入れてください"] });
    out.payment_month_offset = o;
    out.payment_day = d;
  }
  const strs = [["stdDebitAccount", "std_debit_account", 100], ["stdDebitSubAccount", "std_debit_sub_account", 100],
    ["stdDepartment", "std_department", 100], ["stdTaxClass", "std_tax_class", 100],
    ["stdCreditAccount", "std_credit_account", 100], ["stdCreditSubAccount", "std_credit_sub_account", 100],
    ["stdSourceAccount", "std_source_account", 100], ["memo", "memo", 2000]];
  for (const [k, col, max] of strs) if (has(k)) out[col] = text(b[k], max, k);
  if (has("stdInvoiceClass")) out.std_invoice_class = oneOf(b.stdInvoiceClass, isInvoiceClass, "標準インボイス区分");
  if (has("stdPaymentMethod")) out.std_payment_method = oneOf(b.stdPaymentMethod, isPaymentMethod, "標準の支払方法");
  if (has("partnerCompanyId")) {
    if (b.partnerCompanyId && !UUID.test(String(b.partnerCompanyId))) stop(400, { error: "invalid_input", errors: ["BP 会社の指定が正しくありません"] });
    out.partner_company_id = b.partnerCompanyId || null;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "POST" && !needRecord(res, ctx)) return;      // 書くのは 経営者・経理だけ
  try {
    if (req.method === "GET") return json(res, 200, await payload(ctx));
    const body = (await readJson(req)) || {};
    const actions = { create, update, set_active: setActive, save_settings: saveSettings };
    const fn = actions[body.action];
    if (!fn) return json(res, 400, { error: "invalid_action", detail: Object.keys(actions).join(", ") });
    return await fn({ res, ctx, user, body });
  } catch (e) {
    if (fail(res, e, "office/vendors")) return;
  }
}

async function payload(ctx) {
  const rows = await must(admin().from("gw_office_vendors").select("*").eq("tenant_id", ctx.tenantId).order("name").limit(2000));
  const { settings, saved } = await loadSettings(ctx);
  return {
    canEdit: canRecordPayment(ctx),
    vendors: (rows || []).map((v) => ({ ...vendorView(v), termsLabel: termsLabel({ closingDay: v.closing_day, monthOffset: v.payment_month_offset, payDay: v.payment_day }) })),
    settings: {
      holidayAdjust: settings.holiday_adjust, defaultCreditAccount: settings.default_credit_account,
      defaultSourceAccount: settings.default_source_account, defaultPaymentMethod: settings.default_payment_method,
      feeAccount: settings.fee_account, feeTaxClass: settings.fee_tax_class,
    },
    candidates: mergeCandidates(saved, rows || []),
    savedCandidates: { accounts: saved.accounts || [], sub_accounts: saved.sub_accounts || [], departments: saved.departments || [], tax_classes: saved.tax_classes || [] },
    options: { invoiceClasses: INVOICE_CLASSES, paymentMethods: PAYMENT_METHODS, holidayAdjust: HOLIDAY_ADJUST },
  };
}

const month = () => ymd(new Date()).slice(0, 7);

async function create({ res, ctx, user, body }) {
  const v = parseVendor(body.vendor || {}, { requireName: true });
  const dup = await must(admin().from("gw_office_vendors").select("id").eq("tenant_id", ctx.tenantId).eq("name", v.name).maybeSingle());
  if (dup) return json(res, 409, { error: "duplicate_name", hint: "同じ名称の支払先が、すでにあります", id: dup.id });
  const row = await must(admin().from("gw_office_vendors").insert({ ...v, tenant_id: ctx.tenantId, created_by: user.id, updated_by: user.id }).select("*").single());
  await recordEvent(ctx, user, month(), "vendor.create", { vendorId: row.id });
  return json(res, 200, { done: "create", vendor: vendorView(row), ...(await payload(ctx)) });
}

async function update({ res, ctx, user, body }) {
  if (!UUID.test(String(body.id || ""))) return json(res, 400, { error: "invalid_request", detail: "id が正しくありません" });
  const cur = await must(admin().from("gw_office_vendors").select("id, name").eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!cur) return json(res, 404, { error: "vendor_not_found" });
  const v = parseVendor(body.vendor || {}, { requireName: false });
  if (!Object.keys(v).length) return json(res, 400, { error: "invalid_input", errors: ["直す項目がありません"] });
  if (v.name && v.name !== cur.name) {
    const dup = await must(admin().from("gw_office_vendors").select("id").eq("tenant_id", ctx.tenantId).eq("name", v.name).maybeSingle());
    if (dup) return json(res, 409, { error: "duplicate_name", hint: "同じ名称の支払先が、すでにあります" });
  }
  await must(admin().from("gw_office_vendors").update({ ...v, updated_by: user.id, updated_at: nowIso() }).eq("id", cur.id).eq("tenant_id", ctx.tenantId));
  await recordEvent(ctx, user, month(), "vendor.update", { vendorId: cur.id, fields: Object.keys(v) });
  return json(res, 200, { done: "update", ...(await payload(ctx)) });
}

async function setActive({ res, ctx, user, body }) {
  if (!UUID.test(String(body.id || ""))) return json(res, 400, { error: "invalid_request", detail: "id が正しくありません" });
  const cur = await must(admin().from("gw_office_vendors").select("id").eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!cur) return json(res, 404, { error: "vendor_not_found" });
  const active = body.active !== false;
  await must(admin().from("gw_office_vendors").update({ is_active: active, updated_by: user.id, updated_at: nowIso() }).eq("id", cur.id).eq("tenant_id", ctx.tenantId));
  await recordEvent(ctx, user, month(), active ? "vendor.activate" : "vendor.deactivate", { vendorId: cur.id });
  return json(res, 200, { done: "set_active", ...(await payload(ctx)) });
}

const CAND = ["accounts", "sub_accounts", "departments", "tax_classes"];
async function saveSettings({ res, ctx, user, body }) {
  const s = body.settings || {};
  const cur = await loadSettings(ctx);
  const row = { tenant_id: ctx.tenantId, updated_by: user.id, updated_at: nowIso() };
  if (s.holidayAdjust !== undefined) {
    if (!isHolidayAdjust(s.holidayAdjust)) return json(res, 400, { error: "invalid_input", errors: ["休日の調整は、前営業日・翌営業日・調整しない から選んでください"] });
    row.holiday_adjust = s.holidayAdjust;
  }
  for (const [k, col] of [["defaultCreditAccount", "default_credit_account"], ["defaultSourceAccount", "default_source_account"],
    ["feeAccount", "fee_account"], ["feeTaxClass", "fee_tax_class"]]) if (s[k] !== undefined) row[col] = text(s[k], 100, k);
  if (s.defaultPaymentMethod !== undefined) row.default_payment_method = oneOf(s.defaultPaymentMethod, isPaymentMethod, "既定の支払方法");
  if (s.candidates !== undefined) {
    const c = {};
    for (const k of CAND) {
      const list = Array.isArray(s.candidates?.[k]) ? s.candidates[k] : [];
      if (list.length > 300) return json(res, 400, { error: "invalid_input", errors: ["候補は 300 件までです"] });
      c[k] = [...new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean))].map((x) => x.slice(0, 100));
    }
    row.candidates = c;
  }
  if (cur.exists) await must(admin().from("gw_office_payables_settings").update(row).eq("tenant_id", ctx.tenantId));
  else await must(admin().from("gw_office_payables_settings").insert(row));
  await recordEvent(ctx, user, month(), "payables.settings", { fields: Object.keys(row).filter((k) => !["tenant_id", "updated_by", "updated_at"].includes(k)) });
  return json(res, 200, { done: "save_settings", ...(await payload(ctx)) });
}
