// MFクラウド会計「仕訳帳」インポート用 CSV（lib/mf-journal-csv.js）。
//   27列／日付は yyyy/MM/dd／UTF-8 BOM／24〜27列は空／複合仕訳は同一取引No・同一取引日／式の注入を防ぐ
//   仕入計上＝MF仕訳タイプ「債務」、支払＝「経費・債務支払」
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MF_COLUMNS, BOM, mfDate, purchaseEntry, paymentEntry, entryRows, entryBalanced, buildMfCsv, csvFileName, monthEnd, sampleEntries } from "../lib/mf-journal-csv.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

// 簡易 CSV パーサ（テスト用。引用符・改行・"" に対応）
function parse(csv) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) { if (c === '"') { if (csv[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* CRLF の CR */ }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const L = (side, account, amount, extra = {}) => ({ side, account, amount, subAccount: null, department: null, partner: null, taxClass: null, invoiceClass: null, taxAmount: null, ...extra });
const INV = { id: "inv-1", billingMonth: "2026-10", invoiceDate: "2026-10-31", journalDate: null, description: "10月分業務委託費" };

console.log("— 列 —");
ok("27列で、順番は要件どおり", () => {
  assert.equal(MF_COLUMNS.length, 27);
  assert.deepEqual(MF_COLUMNS.slice(0, 10), ["取引No", "取引日", "借方勘定科目", "借方補助科目", "借方部門", "借方取引先", "借方税区分", "借方インボイス", "借方金額(円)", "借方税額"]);
  assert.deepEqual(MF_COLUMNS.slice(10, 18), ["貸方勘定科目", "貸方補助科目", "貸方部門", "貸方取引先", "貸方税区分", "貸方インボイス", "貸方金額(円)", "貸方税額"]);
  assert.deepEqual(MF_COLUMNS.slice(18), ["摘要", "仕訳メモ", "タグ", "MF仕訳タイプ", "決算整理仕訳", "作成日時", "作成者", "最終更新日時", "最終更新者"]);
});

console.log("— 仕入計上 —");
const purchase = purchaseEntry({
  invoice: INV,
  journal: { lines: [L("debit", "外注費", 110000, { partner: "株式会社ABC", taxClass: "課対仕入10%", invoiceClass: "適格", taxAmount: 10000 }), L("credit", "未払金", 110000, { partner: "株式会社ABC" })], summary: "10月分業務委託費", memo: "", tags: [] },
});
ok("仕入計上の1行：2026/10/31・外注費／未払金・110000・債務", () => {
  const rows = entryRows(purchase, 1);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.length, 27);
  assert.equal(r[0], 1);
  assert.equal(r[1], "2026/10/31");
  assert.equal(r[2], "外注費");
  assert.equal(r[5], "株式会社ABC");
  assert.equal(r[6], "課対仕入10%");
  assert.equal(r[7], "適格");
  assert.equal(r[8], "110000");
  assert.equal(r[9], "10000");
  assert.equal(r[10], "未払金");
  assert.equal(r[13], "株式会社ABC");
  assert.equal(r[16], "110000");
  assert.equal(r[18], "10月分業務委託費");
  assert.equal(r[21], "債務");
  assert.deepEqual(r.slice(23), ["", "", "", ""], "24〜27列は空欄");
});
ok("取引日：仕訳日 → 請求日 → 対象月の末日", () => {
  const j = { lines: [L("debit", "外注費", 1), L("credit", "未払金", 1)] };
  assert.equal(purchaseEntry({ invoice: { ...INV, journalDate: "2026-11-02" }, journal: j }).date, "2026-11-02");
  assert.equal(purchaseEntry({ invoice: INV, journal: j }).date, "2026-10-31");
  assert.equal(purchaseEntry({ invoice: { ...INV, invoiceDate: null }, journal: j }).date, "2026-10-31");
  assert.equal(monthEnd("2026-02"), "2026-02-28");
});
ok("日付は yyyy/MM/dd（ハイフン区切りを残さない）", () => {
  assert.equal(mfDate("2026-10-05"), "2026/10/05");
  assert.equal(mfDate(null), "");
  const { csv } = buildMfCsv([purchase]);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(csv));
  assert.ok(/2026\/10\/31/.test(csv));
});

console.log("— 複合仕訳：同一取引No・同一取引日・貸借一致 —");
const compound = purchaseEntry({
  invoice: INV,
  journal: {
    lines: [L("debit", "通信費", 20000), L("debit", "消耗品費", 30000), L("debit", "外注費", 50000), L("credit", "未払金", 100000)],
    summary: "10月分まとめ請求", memo: "", tags: ["経理"],
  },
});
ok("3借方1貸方 → 3行。取引No・取引日は全行同じ。貸借の合計は一致", () => {
  assert.ok(entryBalanced(compound));
  const rows = entryRows(compound, 7);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r[0]), [7, 7, 7]);
  assert.deepEqual(rows.map((r) => r[1]), ["2026/10/31", "2026/10/31", "2026/10/31"]);
  assert.deepEqual(rows.map((r) => r[2]), ["通信費", "消耗品費", "外注費"]);
  assert.deepEqual(rows.map((r) => r[8]), ["20000", "30000", "50000"]);
  assert.equal(rows[0][10], "未払金");
  assert.equal(rows[0][16], "100000");
  assert.equal(rows[1][10], "", "余った側（貸方）は空");
  assert.equal(rows[2][16], "");
  const debit = rows.reduce((s, r) => s + Number(r[8] || 0), 0);
  const credit = rows.reduce((s, r) => s + Number(r[16] || 0), 0);
  assert.equal(debit, credit);
});
ok("複数の請求書：取引No は 1 から連番、複合は同じ番号で続く", () => {
  const { csv, rowCount, txnNos } = buildMfCsv([purchase, compound, purchase]);
  assert.equal(rowCount, 5);
  assert.deepEqual(txnNos, [1, 2, 3]);
  const rows = parse(csv.slice(1));
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ["1", "2", "2", "2", "3"]);
});
ok("貸借が合わない仕訳は entryBalanced=false", () => {
  const bad = { ...compound, lines: compound.lines.map((l) => (l.side === "credit" ? { ...l, amount: 90000 } : l)) };
  assert.ok(!entryBalanced(bad));
});

console.log("— 支払 —");
const pay = { id: "pay-1", paidOn: "2026-11-30", paidAmount: 110000, feeAmount: 0, sourceAccount: "普通預金", sourceSubAccount: null };
ok("支払の1行：2026/11/30・借方 未払金／貸方 普通預金・取引先・110000・経費・債務支払", () => {
  const r = paymentEntry({ invoice: INV, journal: { lines: purchase.lines }, payment: pay, vendorName: "株式会社ABC" });
  assert.ok(!r.error);
  const rows = entryRows(r.entry, 1);
  assert.equal(rows.length, 1);
  const x = rows[0];
  assert.equal(x[1], "2026/11/30");
  assert.equal(x[2], "未払金");
  assert.equal(x[5], "株式会社ABC");
  assert.equal(x[8], "110000");
  assert.equal(x[10], "普通預金");
  assert.equal(x[16], "110000");
  assert.equal(x[18], "10月分請求 支払");
  assert.equal(x[21], "経費・債務支払");
});
ok("振込手数料があれば借方に支払手数料を足し、貸方（口座）は支払額＋手数料", () => {
  const r = paymentEntry({ invoice: INV, journal: { lines: purchase.lines }, payment: { ...pay, feeAmount: 330 }, vendorName: "株式会社ABC", settings: { fee_account: "支払手数料", fee_tax_class: "課対仕入10%" } });
  assert.ok(entryBalanced(r.entry));
  const rows = entryRows(r.entry, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x[2]), ["未払金", "支払手数料"]);
  assert.equal(rows[0][16], "110330");
  assert.equal(rows[1][6], "課対仕入10%");
});
ok("貸方が複数で、支払額が請求額と違うときは按分しない（error）", () => {
  const two = [L("debit", "外注費", 100000), L("credit", "未払金", 60000), L("credit", "未払費用", 40000)];
  assert.ok(paymentEntry({ invoice: INV, journal: { lines: two }, payment: { ...pay, paidAmount: 90000 } }).error);
  assert.ok(!paymentEntry({ invoice: INV, journal: { lines: two }, payment: { ...pay, paidAmount: 100000 } }).error);
});
ok("支払元口座が無ければ error", () => {
  assert.ok(paymentEntry({ invoice: INV, journal: { lines: purchase.lines }, payment: { ...pay, sourceAccount: null } }).error);
});

console.log("— ファイルの形 —");
ok("UTF-8 BOM 付き・CRLF・ヘッダ行は27列", () => {
  const { csv } = buildMfCsv([purchase]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.startsWith(BOM));
  const buf = Buffer.from(csv, "utf8");
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf]);
  assert.ok(csv.includes("\r\n") && !/[^\r]\n/.test(csv));
  const rows = parse(csv.slice(1));
  assert.equal(rows[0].length, 27);
  assert.deepEqual(rows[0], MF_COLUMNS);
  assert.ok(rows.slice(1).every((r) => r.length === 27));
});
ok("カンマ・引用符・改行を含む値は引用符で囲む。式は ' を付けて無効にする", () => {
  const e = purchaseEntry({ invoice: INV, journal: { lines: [L("debit", "外注費", 1000, { partner: 'A,"B"社' }), L("credit", "未払金", 1000)], summary: "=SUM(A1)", memo: "1行目\n2行目", tags: [] } });
  const { csv } = buildMfCsv([e]);
  const r = parse(csv.slice(1))[1];
  assert.equal(r[5], 'A,"B"社');
  assert.equal(r[18], "'=SUM(A1)");
  assert.equal(r[19], "1行目\n2行目");
});
ok("タグは | で区切る", () => {
  const e = purchaseEntry({ invoice: INV, journal: { lines: [L("debit", "外注費", 1000), L("credit", "未払金", 1000)], tags: ["経理", "10月"] } });
  assert.equal(entryRows(e, 1)[0][20], "経理|10月");
});
ok("ファイル名", () => {
  assert.equal(csvFileName({ month: "2026-10", kind: "both", stamp: "20261013-0915" }), "mf-journal_2026-10_all_20261013-0915.csv");
  assert.equal(csvFileName({ month: "2026-10", kind: "purchase", stamp: "x" }), "mf-journal_2026-10_purchase_x.csv");
});

console.log("— インポート確認用のサンプル（docs/mf-import-test/）—");
ok("ダミーの4取引：どれも貸借一致・27列・複合仕訳を含み、70%控除・振込手数料も入る", () => {
  const es = sampleEntries();
  assert.equal(es.length, 4);
  assert.ok(es.every(entryBalanced));
  const { csv, rowCount, txnNos } = buildMfCsv(es);
  assert.equal(rowCount, 1 + 3 + 1 + 2);
  assert.deepEqual(txnNos, [1, 2, 3, 4]);
  const rows = parse(csv.slice(1));
  assert.ok(rows.every((r) => r.length === 27));
  assert.ok(rows.slice(1).every((r) => /MFインポート確認用/.test(r[18])), "本番の仕訳と区別できる摘要");
  assert.ok(rows.some((r) => r[7] === "70%控除"));
  assert.ok(rows.some((r) => r[2] === "支払手数料"));
  assert.deepEqual(rows.slice(2, 5).map((r) => r[0]), ["2", "2", "2"], "複合仕訳は同一取引No");
});
ok("書き出したファイル（docs/mf-import-test/mf-journal_import-test.csv）が、いまの lib の出力と一致する（列を変えたら node scripts/gen-mf-import-test.mjs で作り直す）", () => {
  const file = readFileSync(new URL("../docs/mf-import-test/mf-journal_import-test.csv", import.meta.url), "utf8");
  assert.equal(file, buildMfCsv(sampleEntries()).csv);
});

console.log(`\n${pass} ok / ${fail} NG`);
process.exit(fail ? 1 : 0);
