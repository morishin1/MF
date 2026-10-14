// /api/office/mf-csv — MFクラウド会計「仕訳帳」インポート用 CSV（仕入計上・支払）
//
//   GET  ?month=YYYY-MM&kind=purchase|payment|both&mode=unexported|all
//        … 出力の見込み（何件・どれが出せないか）。何も書かない
//   POST { month, kind, mode }
//        … CSV を出す（UTF-8 BOM 付き・27列）。出した記録を残す（出力バッチ・初回／最終の出力日時）
//
// ■ 入れる人：経営者・経理だけ（責任者は見られない）
//
// ■ 出す対象（対象月＝請求書の対象月）
//   仕入計上 … 確認済み（status=approved）で、仕訳が確定している請求書。取引日は 仕訳日 → 請求日 → 対象月の末日
//   支払     … 支払済みの支払だけ（支払予定は出さない）。仕入計上の仕訳が確定している請求書の、貸方（未払金など）を借方にして、
//              支払元口座を貸方にする。取引日は実支払日。振込手数料があれば借方に1行足す
//   mode     … unexported＝まだ CSV に出していないものだけ／all＝全件
//
// ■ 出せないものがあれば、CSV を出さずに 409（blocked）で理由を返す（貸借不一致など。直してから出す）
//
// ■ 「CSV 出力済み」は「MF に登録済み」ではない
//   出した記録（gw_office_mf_exports・items・初回／最終の出力日時）だけを残す。MF に取り込まれたかは、この画面では分からない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { ymd, time, when } from "../../lib/jst.js";
import { needRecord, fail, must, stop, nowIso, recordEvent, loadSettings, MONTH } from "../../lib/office-payables-api.js";
import { checkJournal } from "../../lib/office-payables-calc.js";
import { purchaseEntry, paymentEntry, buildMfCsv, csvFileName, sampleEntries } from "../../lib/mf-journal-csv.js";

const KINDS = ["purchase", "payment", "both"];
const MODES = ["unexported", "all"];

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });
  res.setHeader("Cache-Control", "no-store");
  if (!needRecord(res, ctx)) return;                             // CSV は 経営者・経理だけ
  try {
    const src = req.method === "GET" ? Object.fromEntries(new URL(req.url, "http://localhost").searchParams) : ((await readJson(req)) || {});
    // MFクラウドへの取り込み確認用の、ダミーのCSV（何も読まず・書かない）
    if (req.method === "GET" && src.sample === "1") return sendCsv(res, buildMfCsv(sampleEntries()), "mf-journal_import-test.csv");
    if (!MONTH.test(String(src.month || ""))) stop(400, { error: "invalid_request", detail: "month は YYYY-MM で指定してください" });
    if (!KINDS.includes(src.kind)) stop(400, { error: "invalid_request", detail: "kind は purchase / payment / both です" });
    if (!MODES.includes(src.mode)) stop(400, { error: "invalid_request", detail: "mode は unexported / all です" });
    const plan = await buildPlan(ctx, src);
    if (req.method === "GET") return json(res, 200, { month: src.month, kind: src.kind, mode: src.mode, ...plan.summary });
    return await exportCsv({ res, ctx, user, src, plan });
  } catch (e) {
    if (fail(res, e, "office/mf-csv")) return;
  }
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** 出す仕訳（entries）・出せないもの（blocked）・見込み（summary）を組み立てる */
async function buildPlan(ctx, { month, kind, mode }) {
  const sb = admin();
  const invoices = (await must(sb.from("gw_vendor_invoices").select("*").eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(2000)))
    .filter((i) => i.status === "approved");
  const ids = invoices.map((i) => i.id);
  const journals = ids.length ? await must(sb.from("gw_office_invoice_journals").select("*").eq("tenant_id", ctx.tenantId).in("invoice_id", ids).limit(10000)) : [];
  const payments = ids.length ? await must(sb.from("gw_office_payments").select("*").eq("tenant_id", ctx.tenantId).in("vendor_invoice_id", ids).limit(5000)) : [];
  const vendors = await must(sb.from("gw_office_vendors").select("id, name").eq("tenant_id", ctx.tenantId).limit(2000));
  const vName = new Map((vendors || []).map((v) => [v.id, v.name]));
  const partnerIds = [...new Set(invoices.map((i) => i.partner_company_id).filter(Boolean))];
  const partners = partnerIds.length ? await must(sb.from("gw_partner_companies").select("id, company_name").eq("tenant_id", ctx.tenantId).in("id", partnerIds).limit(2000)) : [];
  const pName = new Map((partners || []).map((p) => [p.id, p.company_name]));
  const { settings } = await loadSettings(ctx);

  const journalOf = (id) => {
    const rows = journals.filter((j) => j.invoice_id === id).sort((a, b) => (a.side === b.side ? a.line_no - b.line_no : a.side === "debit" ? -1 : 1));
    const first = rows[0];
    return {
      lines: rows.map((l) => ({
        side: l.side, account: l.account, subAccount: l.sub_account, department: l.department, partner: l.partner, taxClass: l.tax_class,
        invoiceClass: l.invoice_class, amount: num(l.amount), taxAmount: num(l.tax_amount),
      })),
      summary: first?.summary || null, memo: first?.memo || null, tags: first?.tags || [],
    };
  };

  const entries = [];
  const blocked = [];
  const label = (inv) => `${vName.get(inv.vendor_id) || pName.get(inv.partner_company_id) || "（支払先なし）"}${inv.invoice_no ? ` ${inv.invoice_no}` : ""}`;
  const stat = { purchase: { eligible: 0, targets: 0, notReady: 0, alreadyExported: 0 }, payment: { eligible: 0, targets: 0, notReady: 0, alreadyExported: 0 } };

  for (const inv of invoices) {
    const j = journalOf(inv.id);
    const vendorName = vName.get(inv.vendor_id) || pName.get(inv.partner_company_id) || null;
    const base = { id: inv.id, billingMonth: inv.billing_month, invoiceDate: inv.invoice_date, journalDate: inv.journal_date, description: inv.description };

    if (kind === "purchase" || kind === "both") {
      if (inv.journal_status !== "confirmed") stat.purchase.notReady++;
      else {
        stat.purchase.eligible++;
        if (inv.mf_purchase_last_exported_at) stat.purchase.alreadyExported++;
        if (mode === "all" || !inv.mf_purchase_last_exported_at) {
          stat.purchase.targets++;
          const chk = checkJournal(j.lines);
          if (!chk.ok) blocked.push({ invoiceId: inv.id, label: label(inv), kind: "purchase", reason: chk.errors.join(" ／ ") || "仕訳が正しくありません" });
          else entries.push(purchaseEntry({ invoice: base, journal: { ...j, lines: chk.lines } }));
        }
      }
    }

    if (kind === "payment" || kind === "both") {
      const paid = payments.find((p) => p.vendor_invoice_id === inv.id && p.status === "paid");
      const open = payments.find((p) => p.vendor_invoice_id === inv.id && p.status === "scheduled");
      if (!paid) { if (open) stat.payment.notReady++; continue; }       // 支払予定は出さない。支払済みだけ
      stat.payment.eligible++;
      if (paid.mf_payment_last_exported_at) stat.payment.alreadyExported++;
      if (mode === "unexported" && paid.mf_payment_last_exported_at) continue;
      stat.payment.targets++;
      if (inv.journal_status !== "confirmed") {
        blocked.push({ invoiceId: inv.id, label: label(inv), kind: "payment", reason: "仕入計上の仕訳が確定していません（支払の仕訳は、仕入計上の貸方から作ります）" });
        continue;
      }
      const chk = checkJournal(j.lines);
      if (!chk.ok) { blocked.push({ invoiceId: inv.id, label: label(inv), kind: "payment", reason: `仕入計上の仕訳が正しくありません：${chk.errors.join(" ／ ")}` }); continue; }
      const r = paymentEntry({
        invoice: base, journal: { ...j, lines: chk.lines }, vendorName, settings,
        payment: { id: paid.id, paidOn: paid.paid_on, paidAmount: num(paid.paid_amount ?? paid.amount), feeAmount: num(paid.fee_amount) || 0, sourceAccount: paid.source_account, sourceSubAccount: paid.source_sub_account },
      });
      if (r.error) blocked.push({ invoiceId: inv.id, label: label(inv), kind: "payment", reason: r.error });
      else entries.push(r.entry);
    }
  }
  // 取引日の順（同じ日は請求書の並び）。仕入計上 → 支払の順にはしない（日付順のほうが MF で読みやすい）
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === "purchase" ? -1 : 1));
  return {
    entries, blocked,
    summary: {
      purchase: stat.purchase, payment: stat.payment,
      entryCount: entries.length, blocked, canExport: entries.length > 0 && blocked.length === 0,
    },
  };
}

async function exportCsv({ res, ctx, user, src, plan }) {
  if (plan.blocked.length) {
    return json(res, 409, { error: "blocked", blocked: plan.blocked, hint: `${plan.blocked.length}件が出力できません。直してから、もう一度出力してください` });
  }
  if (!plan.entries.length) {
    return json(res, 409, { error: "nothing_to_export", hint: src.mode === "unexported" ? "未出力の対象がありません（出力済みも出すときは「全件」を選んでください）" : "出力できる対象がありません" });
  }
  const now = new Date();
  const stamp = `${ymd(now).replace(/-/g, "")}-${time(now).replace(":", "")}`;
  const csv = buildMfCsv(plan.entries);
  const batchCode = `MF-${src.month.replace("-", "")}-${stamp.slice(9)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const fileName = csvFileName({ month: src.month, kind: src.kind, stamp });
  const at = nowIso();
  const sb = admin();

  // 出した記録を先に残す。残せなければ CSV は渡さない（記録の無い CSV を作らない）
  const batch = await must(sb.from("gw_office_mf_exports").insert({
    tenant_id: ctx.tenantId, batch_code: batchCode, billing_month: src.month, kind: src.kind, mode: src.mode,
    invoice_count: new Set(plan.entries.map((e) => e.invoiceId)).size, row_count: csv.rowCount, file_name: fileName,
    exported_by: user.id, exported_by_name: ctx.employee?.display_name || null, exported_at: at,
  }).select("id").single());
  await must(sb.from("gw_office_mf_export_items").insert(plan.entries.map((e, i) => ({
    tenant_id: ctx.tenantId, export_id: batch.id, invoice_id: e.invoiceId, payment_id: e.paymentId || null, kind: e.kind, txn_no: csv.txnNos[i], exported_at: at,
  }))));
  for (const e of plan.entries) {
    if (e.kind === "purchase") {
      const cur = await must(sb.from("gw_vendor_invoices").select("mf_purchase_first_exported_at").eq("id", e.invoiceId).eq("tenant_id", ctx.tenantId).maybeSingle());
      await must(sb.from("gw_vendor_invoices").update({ mf_purchase_first_exported_at: cur?.mf_purchase_first_exported_at || at, mf_purchase_last_exported_at: at })
        .eq("id", e.invoiceId).eq("tenant_id", ctx.tenantId));
    } else {
      const cur = await must(sb.from("gw_office_payments").select("mf_payment_first_exported_at").eq("id", e.paymentId).eq("tenant_id", ctx.tenantId).maybeSingle());
      await must(sb.from("gw_office_payments").update({ mf_payment_first_exported_at: cur?.mf_payment_first_exported_at || at, mf_payment_last_exported_at: at })
        .eq("id", e.paymentId).eq("tenant_id", ctx.tenantId));
    }
    await recordEvent(ctx, user, src.month, "invoice.mf_export", { invoiceId: e.invoiceId, kind: e.kind, batchCode });
  }
  await recordEvent(ctx, user, src.month, "mf.export", { batchCode, kind: src.kind, mode: src.mode, entries: plan.entries.length, rows: csv.rowCount });

  sendCsv(res, csv, fileName, { "X-Mf-Batch": batchCode, "X-Mf-Rows": String(csv.rowCount), "X-Mf-Entries": String(plan.entries.length) });
}

function sendCsv(res, csv, fileName, extra = {}) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(csv.csv);
}
