// Office「請求・支払」の計算（lib/office-payables-calc.js・lib/office-invoice-defs.js）。
//   1. 支払期日の決定順：請求書の明記 → 経理の入力 → 支払先マスタから自動計算 → 未設定（推測しない）
//   2. 休日調整：前営業日／翌営業日／調整しない
//   3. 仕訳の貸借チェック（単一・複合・不一致のブロック）、インボイス区分は1か所の定義
//   4. 一覧の状態（期限超過・7日以内・今日）と NEXT ACTION（常に1つ）
import assert from "node:assert/strict";
import {
  computeDueFromTerms, decideDue, termsLabel, checkJournal, defaultJournal, suggestTax, deriveState, nextAction, isRealDate, addDays,
} from "../lib/office-payables-calc.js";
import { INVOICE_CLASSES, isInvoiceClass, MF_TYPE } from "../lib/office-invoice-defs.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("— インボイス区分は1か所（MFクラウドの名称）—");
ok("6つ：適格・80%控除・70%控除・50%控除・30%控除・控除なし", () => {
  assert.deepEqual(INVOICE_CLASSES, ["適格", "80%控除", "70%控除", "50%控除", "30%控除", "控除なし"]);
  assert.ok(isInvoiceClass("70%控除"));
  assert.ok(!isInvoiceClass("70％控除"));
});
ok("MF仕訳タイプ：仕入計上＝債務、支払＝経費・債務支払", () => {
  assert.equal(MF_TYPE.purchase, "債務");
  assert.equal(MF_TYPE.payment, "経費・債務支払");
});

console.log("— 支払期日の決定順 —");
const vendor = { payment_month_offset: 1, payment_day: 31 };   // 月末締め翌月末払い
ok("支払条件の読める形", () => {
  assert.equal(termsLabel({ closingDay: 31, monthOffset: 1, payDay: 31 }), "月末締め翌月末払い");
  assert.equal(termsLabel({ closingDay: 20, monthOffset: 1, payDay: 25 }), "20日締め翌月25日払い");
  assert.equal(termsLabel({ closingDay: null, monthOffset: null, payDay: null }), null);
});
ok("マスタから自動計算：10月分 → 11月30日（月末）", () => {
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 1, payDay: 31, adjust: "none" }), "2026-11-30");
  assert.equal(computeDueFromTerms({ billingMonth: "2026-01", monthOffset: 1, payDay: 31, adjust: "none" }), "2026-02-28");
});
ok("条件が足りなければ null（推測しない）", () => {
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: null, payDay: null }), null);
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 1, payDay: null }), null);
  assert.equal(computeDueFromTerms({ billingMonth: "bad", monthOffset: 1, payDay: 31 }), null);
});
ok("請求書の明記が最優先", () => {
  const d = decideDue({ invoiceDue: "2026-11-15", manualDue: "2026-11-20", vendor, billingMonth: "2026-10", adjust: "none" });
  assert.deepEqual(d, { date: "2026-11-15", source: "invoice" });
});
ok("明記が無ければ経理の入力", () => {
  const d = decideDue({ invoiceDue: null, manualDue: "2026-11-20", vendor, billingMonth: "2026-10", adjust: "none" });
  assert.deepEqual(d, { date: "2026-11-20", source: "manual" });
});
ok("どちらも無ければ支払先マスタから自動計算", () => {
  const d = decideDue({ vendor, billingMonth: "2026-10", adjust: "none" });
  assert.deepEqual(d, { date: "2026-11-30", source: "master" });
});
ok("全部無ければ「支払期日未設定」（日付を作らない）", () => {
  assert.deepEqual(decideDue({ vendor: {}, billingMonth: "2026-10" }), { date: null, source: null });
  assert.deepEqual(decideDue({ vendor: null, billingMonth: "2026-10" }), { date: null, source: null });
});
ok("実在しない日付は無視する（2026-11-31）", () => {
  const d = decideDue({ invoiceDue: "2026-11-31", vendor, billingMonth: "2026-10", adjust: "none" });
  assert.equal(d.source, "master");
});

console.log("— 休日調整（前営業日／翌営業日／調整しない）—");
// 2026-11-30 は月曜（営業日）。2026-11-23 は祝日（勤労感謝の日）、2026-10-31 は土曜
ok("調整しない：土曜でもそのまま（2026-10-31）", () => {
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 0, payDay: 31, adjust: "none" }), "2026-10-31");
});
ok("前営業日：土曜の 10/31 → 金曜の 10/30", () => {
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 0, payDay: 31, adjust: "prev" }), "2026-10-30");
});
ok("翌営業日：土曜の 10/31 → 月曜の 11/2", () => {
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 0, payDay: 31, adjust: "next" }), "2026-11-02");
});
ok("祝日（11/23）も寄せる：前＝11/20、翌＝11/24", () => {
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 1, payDay: 23, adjust: "prev" }), "2026-11-20");
  assert.equal(computeDueFromTerms({ billingMonth: "2026-10", monthOffset: 1, payDay: 23, adjust: "next" }), "2026-11-24");
});
ok("請求書に明記された日付は、休日でも調整しない", () => {
  const d = decideDue({ invoiceDue: "2026-10-31", vendor, billingMonth: "2026-10", adjust: "prev" });
  assert.equal(d.date, "2026-10-31");
});

console.log("— 仕訳：単一・複合・貸借の一致 —");
const L = (side, account, amount, extra = {}) => ({ side, account, amount, ...extra });
ok("単一仕訳：借方 外注費 110,000／貸方 未払金 110,000 → OK", () => {
  const r = checkJournal([L("debit", "外注費", 110000, { taxClass: "課対仕入10%", invoiceClass: "適格" }), L("credit", "未払金", 110000)], { total: 110000 });
  assert.ok(r.ok);
  assert.equal(r.diff, 0);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});
ok("複合仕訳：通信費 20,000＋消耗品費 30,000＋外注費 50,000／未払金 100,000 → 差額 0", () => {
  const r = checkJournal([L("debit", "通信費", 20000), L("debit", "消耗品費", 30000), L("debit", "外注費", 50000), L("credit", "未払金", 100000)], { total: 100000 });
  assert.ok(r.ok);
  assert.equal(r.debit, 100000);
  assert.equal(r.credit, 100000);
  assert.equal(r.diff, 0);
});
ok("貸借不一致：差額が出て、ok=false（確定・CSVに進めない）", () => {
  const r = checkJournal([L("debit", "通信費", 20000), L("debit", "消耗品費", 30000), L("credit", "未払金", 100000)], { total: 100000 });
  assert.ok(!r.ok);
  assert.equal(r.diff, -50000);
  assert.match(r.errors.join(" "), /貸借が一致しません（差額 -50,000円）/);
  assert.equal(r.lineErrors.length, 0, "行そのものは正しいので、下書きの保存はできる");
});
ok("借方だけ・貸方だけはエラー", () => {
  assert.ok(!checkJournal([L("debit", "外注費", 1000)]).ok);
  assert.ok(!checkJournal([L("credit", "未払金", 1000)]).ok);
  assert.ok(!checkJournal([]).ok);
});
ok("勘定科目が空・金額が0以下・小数はエラー（行のエラー）", () => {
  const r = checkJournal([L("debit", "", 1000), L("debit", "外注費", 0), L("debit", "外注費", 10.5), L("credit", "未払金", 1000)]);
  assert.ok(!r.ok);
  assert.ok(r.lineErrors.length >= 3);
});
ok("インボイス区分は6つのうちから（70%控除は通る・未知は弾く）", () => {
  assert.ok(checkJournal([L("debit", "外注費", 1000, { invoiceClass: "70%控除" }), L("credit", "未払金", 1000)]).ok);
  assert.ok(!checkJournal([L("debit", "外注費", 1000, { invoiceClass: "適格請求書" }), L("credit", "未払金", 1000)]).ok);
});
ok("請求額と仕訳の合計が違うときは警告（源泉徴収・値引きがあり得るので止めない）", () => {
  const r = checkJournal([L("debit", "外注費", 100000), L("credit", "未払金", 100000)], { total: 110000 });
  assert.ok(r.ok);
  assert.equal(r.warnings.length, 1);
});
ok("税額の目安：110,000円（10%）→ 10,000円、8%、対象外は null", () => {
  assert.equal(suggestTax(110000, "課対仕入10%"), 10000);
  assert.equal(suggestTax(108, "課対仕入8%軽"), 8);
  assert.equal(suggestTax(1000, "対象外"), null);
  assert.equal(suggestTax(1000, null), null);
});

console.log("— 仕訳の初期値：前回使った仕訳 → 支払先マスタの標準仕訳 —");
const V = { name: "株式会社ABC", std_debit_account: "外注費", std_tax_class: "課対仕入10%", std_invoice_class: "適格", std_credit_account: "未払金" };
ok("標準仕訳：借方 外注費・貸方 未払金・取引先・税区分・インボイス", () => {
  const j = defaultJournal({ vendor: V, total: 110000 });
  assert.equal(j.source, "vendor");
  assert.equal(j.lines[0].account, "外注費");
  assert.equal(j.lines[0].taxClass, "課対仕入10%");
  assert.equal(j.lines[0].invoiceClass, "適格");
  assert.equal(j.lines[0].taxAmount, 10000);
  assert.equal(j.lines[1].account, "未払金");
  assert.equal(j.lines[0].partner, "株式会社ABC");
});
ok("前回使った仕訳があれば、そちらが初期値（金額は今回の請求額に合わせる）", () => {
  const last = { lines: [L("debit", "通信費", 50000, { taxClass: "課対仕入10%" }), L("credit", "未払金", 50000)], summary: "回線料" };
  const j = defaultJournal({ vendor: V, total: 22000, last });
  assert.equal(j.source, "last");
  assert.equal(j.lines[0].account, "通信費");
  assert.equal(j.lines[0].amount, 22000);
  assert.equal(j.summary, "回線料");
});
ok("前回が複合仕訳なら、科目だけ引き継いで金額は空（勝手に按分しない）", () => {
  const last = { lines: [L("debit", "通信費", 20000), L("debit", "消耗品費", 30000), L("credit", "未払金", 50000)] };
  const j = defaultJournal({ vendor: V, total: 60000, last });
  assert.ok(j.lines.every((l) => l.amount === null));
});

console.log("— 状態と NEXT ACTION —");
const TODAY = "2026-11-10";
const inv = (o = {}) => ({ status: "approved", payment_due_on: "2026-11-30", journal_status: "confirmed", mf_purchase_last_exported_at: null, ...o });
ok("期限超過：未払いで支払期日が過ぎている", () => {
  const s = deriveState({ invoice: inv({ payment_due_on: "2026-11-05" }), payment: null, today: TODAY });
  assert.ok(s.overdue);
  assert.ok(!s.within7);
});
ok("期限超過：支払予定があっても、期日を過ぎて未払いなら期限超過", () => {
  const s = deriveState({ invoice: inv({ payment_due_on: "2026-11-05" }), payment: { status: "scheduled", scheduled_on: "2026-11-12" }, today: TODAY });
  assert.ok(s.overdue);
});
ok("支払済みは期限超過にならない", () => {
  const s = deriveState({ invoice: inv({ payment_due_on: "2026-11-05" }), payment: { status: "paid", scheduled_on: "2026-11-05", paid_on: "2026-11-06" }, today: TODAY });
  assert.ok(!s.overdue);
  assert.equal(s.payState, "paid");
});
ok("7日以内：今日〜7日後（11/17 まで）。8日後は入らない", () => {
  assert.ok(deriveState({ invoice: inv({ payment_due_on: "2026-11-17" }), payment: null, today: TODAY }).within7);
  assert.ok(!deriveState({ invoice: inv({ payment_due_on: "2026-11-18" }), payment: null, today: TODAY }).within7);
});
ok("今日支払：支払予定日が今日", () => {
  const s = deriveState({ invoice: inv(), payment: { status: "scheduled", scheduled_on: TODAY }, today: TODAY });
  assert.ok(s.payToday);
});
ok("期日未設定は期限超過・7日以内に入らない", () => {
  const s = deriveState({ invoice: inv({ payment_due_on: null }), payment: null, today: TODAY });
  assert.ok(!s.overdue && !s.within7);
});
ok("MF状態：仕訳済み・未出力 → unexported／出力後 → exported／支払済みで支払未出力 → partial", () => {
  assert.equal(deriveState({ invoice: inv(), payment: null, today: TODAY }).mfState, "unexported");
  assert.equal(deriveState({ invoice: inv({ mf_purchase_last_exported_at: "2026-11-01T00:00:00Z" }), payment: null, today: TODAY }).mfState, "exported");
  assert.equal(deriveState({ invoice: inv({ mf_purchase_last_exported_at: "2026-11-01T00:00:00Z" }), payment: { status: "paid", scheduled_on: "2026-11-05" }, today: TODAY }).mfState, "partial");
  assert.equal(deriveState({ invoice: inv({ journal_status: "none" }), payment: null, today: TODAY }).mfState, "na");
});
ok("NEXT ACTION は常に1つ。アップロード直後 → 内容を確認", () => {
  assert.equal(nextAction({ invoice: inv({ status: "received", journal_status: "none" }), payment: null, today: TODAY }).key, "confirm");
});
ok("確認済み・仕訳なし → 仕訳を設定", () => {
  assert.equal(nextAction({ invoice: inv({ journal_status: "none" }), payment: null, today: TODAY }).key, "journal");
  assert.equal(nextAction({ invoice: inv({ journal_status: "draft" }), payment: null, today: TODAY }).key, "journal");
});
ok("仕訳済み・支払予定なし → 支払予定を登録", () => {
  assert.equal(nextAction({ invoice: inv(), payment: null, today: TODAY }).key, "schedule");
  assert.equal(nextAction({ invoice: inv(), payment: { status: "void" }, today: TODAY }).key, "schedule");
});
ok("支払日到来 → 支払を確認／まだ先なら待つ（ボタンなし）", () => {
  assert.equal(nextAction({ invoice: inv(), payment: { status: "scheduled", scheduled_on: TODAY }, today: TODAY }).key, "pay");
  assert.equal(nextAction({ invoice: inv(), payment: { status: "scheduled", scheduled_on: "2026-11-30" }, today: TODAY }).key, "wait");
});
ok("支払済み・MF未出力 → MF CSVへ出力", () => {
  const n = nextAction({ invoice: inv({ mf_purchase_last_exported_at: "2026-11-01T00:00:00Z" }), payment: { status: "paid", scheduled_on: "2026-11-05" }, today: TODAY });
  assert.equal(n.key, "export");
});
ok("全部完了 → 完了", () => {
  const n = nextAction({ invoice: inv({ mf_purchase_last_exported_at: "x" }), payment: { status: "paid", scheduled_on: "2026-11-05", mf_payment_last_exported_at: "y" }, today: TODAY });
  assert.deepEqual([n.key, n.done], ["done", true]);
});
ok("取り消した請求書は取り消し済み", () => {
  assert.equal(nextAction({ invoice: inv({ status: "void" }), payment: null, today: TODAY }).key, "void");
});
ok("日付の部品：isRealDate・addDays", () => {
  assert.ok(isRealDate("2026-02-28") && !isRealDate("2026-02-30") && !isRealDate("2026-2-3"));
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
});

console.log(`\n${pass} ok / ${fail} NG`);
process.exit(fail ? 1 : 0);
