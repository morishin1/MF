// マネーフォワード クラウド会計「仕訳帳」インポート用 CSV（27列）を組み立てる。純関数。
//
// ■ 列（2026年10月時点の MFクラウド会計「仕訳帳」インポート形式。要件書の定義）
//   1 取引No  2 取引日  3〜10 借方（勘定科目・補助科目・部門・取引先・税区分・インボイス・金額(円)・税額）
//   11〜18 貸方（同じ8項目）  19 摘要  20 仕訳メモ  21 タグ  22 MF仕訳タイプ  23 決算整理仕訳
//   24 作成日時  25 作成者  26 最終更新日時  27 最終更新者（24〜27 は空欄）
//   列の並びを変えるときは MF_COLUMNS だけを直す（test/mfjournalcsv.mjs が27列を検査する）。
//
// ■ 書き方
//   ・日付は yyyy/MM/dd  ・金額は整数（カンマなし）  ・UTF-8 の BOM 付き・改行は CRLF
//   ・= + - @ で始まる文字は ' を付けて式にしない（Excel で開いても計算されない）
//   ・複合仕訳は「同一取引No・同一取引日」で複数行。借方と貸方を上から順に1行ずつ組にし、
//     余った側の列は空にする。貸借の合計は一致していること（API が確かめてから出す）
//   ・仕入計上＝MF仕訳タイプ「債務」。支払＝「経費・債務支払」（支払日は実支払日）
//
// ■ ここで確かめられないこと（MFクラウドの実インポートで確認する）
//   ・複合仕訳の「余った側を空にする」書き方が、そのまま取り込めるか
//   ・税区分・補助科目・部門・取引先の名称が MF のマスタと一致するか（不一致は取込エラーか新規作成になる）
//   ・タグを複数付けるときの区切り（TAG_SEPARATOR）
//   確認用のテストファイルは docs/mf-import-test/ にある。

import { MF_TYPE, TAG_SEPARATOR } from "./office-invoice-defs.js";

export const MF_COLUMNS = [
  "取引No", "取引日",
  "借方勘定科目", "借方補助科目", "借方部門", "借方取引先", "借方税区分", "借方インボイス", "借方金額(円)", "借方税額",
  "貸方勘定科目", "貸方補助科目", "貸方部門", "貸方取引先", "貸方税区分", "貸方インボイス", "貸方金額(円)", "貸方税額",
  "摘要", "仕訳メモ", "タグ", "MF仕訳タイプ", "決算整理仕訳",
  "作成日時", "作成者", "最終更新日時", "最終更新者",
];

export const BOM = "﻿";
const EOL = "\r\n";

/** YYYY-MM-DD → yyyy/MM/dd */
export const mfDate = (ymd) => (/^\d{4}-\d{2}-\d{2}/.test(String(ymd || "")) ? String(ymd).slice(0, 10).replace(/-/g, "/") : "");

const guard = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
function cell(v, { text = true } = {}) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (text) s = guard(s);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const yen = (n) => (n === null || n === undefined || n === "" ? "" : String(Math.round(Number(n))));

/** 末日 */
export const monthEnd = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * 仕入計上の仕訳（entry）を作る。
 *   invoice: { id, billingMonth, invoiceDate, journalDate, description }
 *   journal: { lines:[{side,account,subAccount,department,partner,taxClass,invoiceClass,amount,taxAmount}], summary, memo, tags }
 * 取引日 = 仕訳日（journalDate）→ 請求日 → 対象月の末日
 */
export function purchaseEntry({ invoice, journal }) {
  return {
    kind: "purchase", invoiceId: invoice.id,
    date: invoice.journalDate || invoice.invoiceDate || monthEnd(invoice.billingMonth),
    lines: journal.lines, summary: journal.summary || invoice.description || "", memo: journal.memo || "",
    tags: journal.tags || [], type: MF_TYPE.purchase,
  };
}

/**
 * 支払の仕訳（entry）を作る。仕入計上の貸方（未払金など）を借方に、支払元口座を貸方に置く。
 *   payment: { id, paidOn, paidAmount, feeAmount, sourceAccount, sourceSubAccount }
 *   settings: { fee_account, fee_tax_class, default_source_account }
 * 戻り値: { entry } か { error }（貸方が複数で、支払額が請求額と違うときは按分しない）
 */
export function paymentEntry({ invoice, journal, payment, vendorName, settings = {} }) {
  const credits = (journal.lines || []).filter((l) => l.side === "credit");
  if (!credits.length) return { error: "仕入計上の仕訳に貸方がありません" };
  const creditTotal = credits.reduce((s, l) => s + l.amount, 0);
  const paid = Math.round(Number(payment.paidAmount ?? creditTotal));
  const fee = Math.round(Number(payment.feeAmount || 0));
  let amounts;
  if (paid === creditTotal) amounts = credits.map((l) => l.amount);
  else if (credits.length === 1) amounts = [paid];
  else return { error: "支払額が請求額と違い、貸方が複数あるため按分できません。仕訳の貸方を1行にするか、支払額を請求額に合わせてください" };
  const source = payment.sourceAccount || settings.default_source_account;
  if (!source) return { error: "支払元口座（貸方の科目）が決まっていません" };
  const lines = credits.map((l, i) => ({
    side: "debit", account: l.account, subAccount: l.subAccount || null, department: l.department || null,
    partner: l.partner || vendorName || null, taxClass: "対象外", invoiceClass: null, amount: amounts[i], taxAmount: null,
  }));
  if (fee > 0) {
    lines.push({
      side: "debit", account: settings.fee_account || "支払手数料", subAccount: null, department: null,
      partner: null, taxClass: settings.fee_tax_class || null, invoiceClass: null, amount: fee, taxAmount: null,
    });
  }
  lines.push({
    side: "credit", account: source, subAccount: payment.sourceSubAccount || null, department: null,
    partner: vendorName || null, taxClass: "対象外", invoiceClass: null, amount: paid + fee, taxAmount: null,
  });
  const n = Number(String(invoice.billingMonth).slice(5, 7));
  return {
    entry: {
      kind: "payment", invoiceId: invoice.id, paymentId: payment.id, date: payment.paidOn, lines,
      summary: `${n}月分請求 支払`, memo: "", tags: journal.tags || [], type: MF_TYPE.payment,
    },
  };
}

/** 仕訳（entry）の貸借が一致しているか */
export function entryBalanced(entry) {
  const sum = (side) => entry.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
  return sum("debit") === sum("credit");
}

/** entry を CSV の行（27列の配列）にする。借方と貸方を上から1行ずつ組にし、余った側は空 */
export function entryRows(entry, txnNo) {
  const D = entry.lines.filter((l) => l.side === "debit");
  const C = entry.lines.filter((l) => l.side === "credit");
  const n = Math.max(D.length, C.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = D[i];
    const c = C[i];
    rows.push([
      txnNo, mfDate(entry.date),
      d?.account ?? "", d?.subAccount ?? "", d?.department ?? "", d?.partner ?? "", d?.taxClass ?? "", d?.invoiceClass ?? "", d ? yen(d.amount) : "", d ? yen(d.taxAmount) : "",
      c?.account ?? "", c?.subAccount ?? "", c?.department ?? "", c?.partner ?? "", c?.taxClass ?? "", c?.invoiceClass ?? "", c ? yen(c.amount) : "", c ? yen(c.taxAmount) : "",
      entry.summary || "", entry.memo || "", (entry.tags || []).join(TAG_SEPARATOR), entry.type || "", "",
      "", "", "", "",
    ]);
  }
  return rows;
}

const NUMERIC_COLS = new Set([0, 8, 9, 16, 17]);

/**
 * entries を CSV にする。取引No は 1 から連番（複合仕訳の行は同じ番号）。
 * 戻り値: { csv, rowCount, txnNos }（txnNos は entries と同じ順）
 */
export function buildMfCsv(entries) {
  const lines = [MF_COLUMNS.map((h) => cell(h, { text: false })).join(",")];
  const txnNos = [];
  let count = 0;
  entries.forEach((e, i) => {
    const no = i + 1;
    txnNos.push(no);
    for (const r of entryRows(e, no)) {
      lines.push(r.map((v, k) => cell(v, { text: !NUMERIC_COLS.has(k) })).join(","));
      count++;
    }
  });
  return { csv: BOM + lines.join(EOL) + EOL, rowCount: count, txnNos };
}

/** ファイル名：mf-journal_2026-10_purchase_20261013-0915.csv */
export function csvFileName({ month, kind, stamp }) {
  const k = { purchase: "purchase", payment: "payment", both: "all" }[kind] || kind;
  return `mf-journal_${month}_${k}_${stamp}.csv`;
}

/**
 * MFクラウドへの取り込み確認用の、ダミーの仕訳（4取引）。実データではない。
 * 本番の仕訳に混ぜないよう、摘要に【MFインポート確認用】を付ける。取り込んで形が合うかを見たら、MF 側で削除する。
 *   1 仕入計上（単一）／2 仕入計上（複合：3借方1貸方）／3 支払／4 支払（振込手数料つき・複合）
 */
export function sampleEntries() {
  const tag = ["MFインポート確認用"];
  const L = (side, account, amount, extra = {}) => ({ side, account, amount, subAccount: null, department: null, partner: null, taxClass: null, invoiceClass: null, taxAmount: null, ...extra });
  const abc = "テスト株式会社ABC";
  return [
    { kind: "purchase", invoiceId: "sample-1", date: "2026-10-31", summary: "【MFインポート確認用】10月分業務委託費", memo: "", tags: tag, type: MF_TYPE.purchase,
      lines: [L("debit", "外注費", 110000, { partner: abc, taxClass: "課対仕入10%", invoiceClass: "適格", taxAmount: 10000 }), L("credit", "未払金", 110000, { partner: abc })] },
    { kind: "purchase", invoiceId: "sample-2", date: "2026-10-31", summary: "【MFインポート確認用】10月分まとめ請求（複合仕訳）", memo: "", tags: tag, type: MF_TYPE.purchase,
      lines: [L("debit", "通信費", 20000, { partner: "テスト商事", taxClass: "課対仕入10%", invoiceClass: "適格", taxAmount: 1818 }),
        L("debit", "消耗品費", 30000, { partner: "テスト商事", taxClass: "課対仕入10%", invoiceClass: "適格", taxAmount: 2727 }),
        L("debit", "外注費", 50000, { partner: "テスト商事", taxClass: "課対仕入10%", invoiceClass: "70%控除", taxAmount: 4545 }),
        L("credit", "未払金", 100000, { partner: "テスト商事" })] },
    { kind: "payment", invoiceId: "sample-1", date: "2026-11-30", summary: "【MFインポート確認用】10月分請求 支払", memo: "", tags: tag, type: MF_TYPE.payment,
      lines: [L("debit", "未払金", 110000, { partner: abc, taxClass: "対象外" }), L("credit", "普通預金", 110000, { partner: abc, taxClass: "対象外" })] },
    { kind: "payment", invoiceId: "sample-2", date: "2026-11-30", summary: "【MFインポート確認用】10月分まとめ請求 支払（振込手数料つき）", memo: "", tags: tag, type: MF_TYPE.payment,
      lines: [L("debit", "未払金", 100000, { partner: "テスト商事", taxClass: "対象外" }), L("debit", "支払手数料", 330, { taxClass: "課対仕入10%", taxAmount: 30 }),
        L("credit", "普通預金", 100330, { partner: "テスト商事", taxClass: "対象外" })] },
  ];
}
