// 書類の内容抽出ユーティリティ
//
// PDF / 画像 は Claude にそのまま（base64 の document / image ブロックで）渡す。
// Excel(.xlsx/.xls) / CSV は Claude が直接読めないため、サーバ側で表をテキスト化してから渡す。
//
// セキュリティ: ここでもファイルは保存せず、メモリ上の Buffer を扱うだけ。

import * as XLSX from "xlsx";

// 表計算系（サーバでテキスト化してから AI に渡す）MIME
const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",                                          // .xls
  "text/csv",                                                          // .csv
  "application/csv",
]);

// トークン保護のため 1 シートあたりの上限行数
const MAX_ROWS_PER_SHEET = 300;

export function isSpreadsheet(mimeType) {
  return SPREADSHEET_MIMES.has(mimeType);
}

/**
 * Excel/CSV の Buffer を、AI に渡すためのプレーンテキスト（シートごとの CSV）へ変換する。
 * 複数シートがある場合は見出しを付けて連結する。
 * @param {Buffer} buffer  ファイル本体
 * @returns {string} シートごとに整形した CSV テキスト
 */
export function extractSpreadsheetText(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  if (!wb.SheetNames?.length) return "";

  const parts = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    // header:1 で 2 次元配列（行→セル）に。空行は詰める。
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
    if (!rows.length) continue;

    const clipped = rows.slice(0, MAX_ROWS_PER_SHEET);
    const csv = clipped.map((r) => r.map(cellToCsv).join(",")).join("\n");
    const omitted = rows.length - clipped.length;
    const note = omitted > 0 ? `\n(... 以下 ${omitted} 行省略)` : "";
    parts.push(`# シート: ${name}\n${csv}${note}`);
  }
  return parts.join("\n\n");
}

// CSV セルのエスケープ（カンマ・改行・ダブルクォートを含む場合のみ）
function cellToCsv(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
