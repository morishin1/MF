// MFクラウド会計「仕訳帳」インポートの確認用サンプル（ダミーの4取引）を、docs/mf-import-test/ に書き出す。
//   node scripts/gen-mf-import-test.mjs
// 画面の［MFクラウドCSV］→「インポート確認用のサンプルCSV」と同じ中身（lib/mf-journal-csv.js の sampleEntries）。
// test/mfjournalcsv.mjs が、書き出したファイルと lib の出力が一致していることを確かめる（列を変えたら、ここも作り直す）。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMfCsv, sampleEntries } from "../lib/mf-journal-csv.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "mf-import-test", "mf-journal_import-test.csv");
mkdirSync(dirname(out), { recursive: true });
const { csv, rowCount } = buildMfCsv(sampleEntries());
writeFileSync(out, csv, "utf8");
console.log(`書き出しました：${out}（${rowCount}行・UTF-8 BOM付き）`);
