// Office「請求・支払」の計算（純関数。DB・日時に触らない。today は呼ぶ側が渡す）。
//
//   ・支払期日の決め方（請求書の明記 → 経理の入力 → 支払先マスタから自動計算 → 未設定）
//   ・仕訳の貸借チェック（複合仕訳。差額 0円でなければ確定・CSV出力できない）
//   ・一覧の状態（未確認／支払予定／7日以内／今日支払／期限超過／支払済み／未仕訳／MF未出力）と NEXT ACTION

import { domDate, ymAdd, daysInMonth } from "./holidays.js";
import { isInvoiceClass, MAX_JOURNAL_LINES, MAX_YEN } from "./office-invoice-defs.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isRealDate(s) {
  if (!DATE_RE.test(String(s || ""))) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// 支払期日
// ---------------------------------------------------------------------------
const MONTH_LABEL = ["当月", "翌月", "翌々月", "3か月後", "4か月後", "5か月後", "6か月後"];
const dayLabel = (d) => (d >= 31 ? "末" : `${d}日`);

/** 「月末締め翌月末払い」のような読める形。条件が無ければ null */
export function termsLabel({ closingDay, monthOffset, payDay }) {
  const hasPay = Number.isInteger(monthOffset) && Number.isInteger(payDay);
  const hasClose = Number.isInteger(closingDay);
  if (!hasPay && !hasClose) return null;
  const close = hasClose ? `${closingDay >= 31 ? "月末" : `${closingDay}日`}締め` : "";
  const pay = hasPay ? `${MONTH_LABEL[monthOffset] || `${monthOffset}か月後`}${dayLabel(payDay)}払い` : "";
  return `${close}${pay}`;
}

/**
 * 支払先マスタの条件から支払期日を計算する。
 * 対象月＝締め月として、monthOffset か月後の payDay 日（31＝月末）。休日は adjust（prev／next／none）で寄せる。
 * 条件が足りなければ null（推測しない）
 */
export function computeDueFromTerms({ billingMonth, monthOffset, payDay, adjust = "prev" }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth || ""))) return null;
  if (!Number.isInteger(monthOffset) || !Number.isInteger(payDay) || payDay < 1 || payDay > 31) return null;
  const ym = ymAdd(billingMonth, monthOffset);
  return domDate(ym, Math.min(payDay, daysInMonth(ym)), adjust === "next" ? "next" : adjust === "none" ? "" : "prev");
}

/**
 * 支払期日の決定順：
 *   1) 請求書に明記された支払期日（invoiceDue）
 *   2) 経理担当が入力した支払期日（manualDue）
 *   3) 支払先マスタから自動計算
 *   4) 不明 → { date: null, source: null }（「支払期日未設定」。推測して確定しない）
 */
export function decideDue({ invoiceDue, manualDue, vendor, billingMonth, adjust }) {
  if (isRealDate(invoiceDue)) return { date: invoiceDue, source: "invoice" };
  if (isRealDate(manualDue)) return { date: manualDue, source: "manual" };
  const auto = computeDueFromTerms({
    billingMonth, adjust,
    monthOffset: vendor?.payment_month_offset ?? vendor?.monthOffset,
    payDay: vendor?.payment_day ?? vendor?.payDay,
  });
  if (auto) return { date: auto, source: "master" };
  return { date: null, source: null };
}

// ---------------------------------------------------------------------------
// 仕訳
// ---------------------------------------------------------------------------
const toYen = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(/[,\s円¥]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** 税込金額から税額の目安（切り捨て）。税区分名の「10%」「8%」から率を読む。読めなければ null */
export function suggestTax(amount, taxClass) {
  const m = /(\d+)\s*%/.exec(String(taxClass || ""));
  const a = Number(amount);
  if (!m || !Number.isFinite(a) || /対象外|不課税|非課税/.test(String(taxClass))) return null;
  const rate = Number(m[1]);
  return Math.floor((a * rate) / (100 + rate));
}

/**
 * 仕訳明細の検査と合計。
 * lines: [{ side:'debit'|'credit', account, subAccount, department, partner, taxClass, invoiceClass, amount, taxAmount }]
 * 戻り値: { ok, debit, credit, diff, errors[], lineErrors[], warnings[], lines[] }（lines は整形済み。lineErrors は貸借の不一致を除いた誤り）
 * ok は「貸借が一致し、各行が正しい」。請求書の税込金額と違うときは warnings（源泉徴収・値引きがあり得る）
 */
export function checkJournal(lines, { total } = {}) {
  const errors = [];
  const warnings = [];
  const src = Array.isArray(lines) ? lines : [];
  if (!src.length) errors.push("仕訳の行がありません");
  if (src.length > MAX_JOURNAL_LINES) errors.push(`仕訳は ${MAX_JOURNAL_LINES} 行までです`);
  const out = src.map((l, i) => {
    const n = i + 1;
    const side = l?.side === "debit" || l?.side === "credit" ? l.side : null;
    if (!side) errors.push(`${n}行目：借方か貸方を選んでください`);
    const account = String(l?.account ?? "").trim();
    if (!account) errors.push(`${n}行目：勘定科目を入れてください`);
    const amount = toYen(l?.amount);
    if (amount === null || Number.isNaN(amount)) errors.push(`${n}行目：金額を入れてください`);
    else if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_YEN) errors.push(`${n}行目：金額は 1円以上の整数にしてください`);
    const tax = toYen(l?.taxAmount);
    if (tax !== null && (Number.isNaN(tax) || !Number.isInteger(tax) || tax < 0)) errors.push(`${n}行目：税額は 0円以上の整数にしてください`);
    const cls = String(l?.invoiceClass ?? "").trim();
    if (cls && !isInvoiceClass(cls)) errors.push(`${n}行目：インボイス区分は ${"適格・80%控除・70%控除・50%控除・30%控除・控除なし"} から選んでください`);
    const field = (k, max) => {
      const s = String(l?.[k] ?? "").trim();
      if (s.length > max) errors.push(`${n}行目：${k} が長すぎます（${max}字まで）`);
      return s || null;
    };
    return {
      side, account, amount: Number.isFinite(amount) ? amount : 0,
      subAccount: field("subAccount", 100), department: field("department", 100), partner: field("partner", 200),
      taxClass: field("taxClass", 100), invoiceClass: cls || null,
      taxAmount: tax === null || Number.isNaN(tax) ? null : tax,
    };
  });
  const sum = (side) => out.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
  const debit = sum("debit");
  const credit = sum("credit");
  if (src.length && !out.some((l) => l.side === "debit")) errors.push("借方の行がありません");
  if (src.length && !out.some((l) => l.side === "credit")) errors.push("貸方の行がありません");
  const diff = debit - credit;
  const lineErrors = [...errors];       // 貸借の不一致を除く（下書きの保存は、行が正しければ通す）
  if (diff !== 0 && out.some((l) => l.side === "debit") && out.some((l) => l.side === "credit")) {
    errors.push(`貸借が一致しません（差額 ${diff.toLocaleString("ja-JP")}円）`);
  }
  const t = Number(total);
  if (Number.isFinite(t) && diff === 0 && debit !== t) {
    warnings.push(`仕訳の合計（${debit.toLocaleString("ja-JP")}円）が、請求書の税込金額（${t.toLocaleString("ja-JP")}円）と違います`);
  }
  return { ok: errors.length === 0 && diff === 0, debit, credit, diff, errors, lineErrors, warnings, lines: out };
}

/** 支払先マスタ・前回の仕訳から作る、仕訳の初期値（請求書の税込金額で1借方・1貸方） */
export function defaultJournal({ vendor, total, settings = {}, last = null }) {
  const amount = Math.round(Number(total) || 0);
  const lastLines = Array.isArray(last?.lines) && last.lines.length ? last.lines : null;
  if (lastLines) {
    // 前回の仕訳の科目・区分を引き継ぐ。金額は今回の請求額に合わせる（複数行のときは科目だけ引き継ぎ、金額は空）
    const single = lastLines.filter((l) => l.side === "debit").length === 1 && lastLines.filter((l) => l.side === "credit").length === 1;
    return {
      source: "last",
      lines: lastLines.map((l) => ({
        side: l.side, account: l.account, subAccount: l.subAccount || null, department: l.department || null,
        partner: l.partner || vendor?.name || null, taxClass: l.taxClass || null, invoiceClass: l.invoiceClass || null,
        amount: single ? amount : null, taxAmount: single && l.side === "debit" ? suggestTax(amount, l.taxClass) : null,
      })),
      summary: last.summary || null, memo: null, tags: Array.isArray(last.tags) ? last.tags : [],
    };
  }
  const debitAccount = vendor?.std_debit_account || null;
  const creditAccount = vendor?.std_credit_account || settings.default_credit_account || "未払金";
  return {
    source: debitAccount ? "vendor" : "blank",
    lines: [
      {
        side: "debit", account: debitAccount, subAccount: vendor?.std_debit_sub_account || null, department: vendor?.std_department || null,
        partner: vendor?.name || null, taxClass: vendor?.std_tax_class || null, invoiceClass: vendor?.std_invoice_class || null,
        amount, taxAmount: suggestTax(amount, vendor?.std_tax_class),
      },
      {
        side: "credit", account: creditAccount, subAccount: vendor?.std_credit_sub_account || null, department: vendor?.std_department || null,
        partner: vendor?.name || null, taxClass: null, invoiceClass: null, amount, taxAmount: null,
      },
    ],
    summary: null, memo: null, tags: [],
  };
}

// ---------------------------------------------------------------------------
// 一覧の状態・NEXT ACTION
// ---------------------------------------------------------------------------
/**
 * 請求書1件の状態を出す。
 *   invoice: { status, payment_due_on, journal_status, mf_purchase_last_exported_at }
 *   payment: 有効な支払（status<>void）or null  { status, scheduled_on, mf_payment_last_exported_at }
 *   today:   YYYY-MM-DD（日本時間）
 */
export function deriveState({ invoice, payment, today }) {
  const void_ = invoice.status === "void";
  const confirmed = invoice.status === "approved";
  const paid = payment?.status === "paid";
  const scheduled = payment?.status === "scheduled";
  const dueOn = invoice.payment_due_on || null;
  const planOn = scheduled ? payment.scheduled_on : dueOn;
  const open = !void_ && !paid;
  const overdue = open && Boolean(dueOn) && dueOn < today;
  const within7 = open && Boolean(planOn) && planOn >= today && planOn <= addDays(today, 7);
  const payToday = open && Boolean(planOn) && planOn === today;
  const journalDone = invoice.journal_status === "confirmed";
  const purchaseExported = Boolean(invoice.mf_purchase_last_exported_at);
  const paymentExported = Boolean(payment?.mf_payment_last_exported_at);
  const purchasePending = !void_ && journalDone && !purchaseExported;
  const paymentPending = !void_ && paid && !paymentExported;
  const mfPending = purchasePending || paymentPending;
  const mfEligible = !void_ && (journalDone || paid);
  const mfState = !mfEligible ? "na" : mfPending ? (purchaseExported || paymentExported ? "partial" : "unexported") : "exported";
  const payState = void_ ? "void" : paid ? "paid" : scheduled ? "scheduled" : "unpaid";
  return {
    void: void_, confirmed, unconfirmed: !void_ && !confirmed, payState, overdue, within7, payToday,
    unjournaled: !void_ && !journalDone, journalDone, purchaseExported, paymentExported,
    purchasePending, paymentPending, mfPending, mfState, planOn, dueOn,
  };
}

/** 詳細の上部に出す「次にやること」を1つだけ */
export function nextAction({ invoice, payment, today }) {
  const s = deriveState({ invoice, payment, today });
  if (s.void) return { key: "void", label: "取り消し済み", done: true };
  if (s.unconfirmed) return { key: "confirm", label: "内容を確認" };
  if (!s.journalDone) return { key: "journal", label: "仕訳を設定" };
  if (!payment || payment.status === "void") return { key: "schedule", label: "支払予定を登録" };
  if (payment.status === "scheduled") {
    if (payment.scheduled_on <= today) return { key: "pay", label: "支払を確認" };
    return { key: "wait", label: `支払予定日（${payment.scheduled_on}）を待つ`, waiting: true };
  }
  if (s.mfPending) return { key: "export", label: "MF CSVへ出力" };
  return { key: "done", label: "完了", done: true };
}
