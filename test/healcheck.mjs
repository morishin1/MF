// check_status が「もう一度流す」と言う列は、本当に流し直せば直るのか。
//
// 列が create table の中にしか書かれていない場合、
// 表が既にあると create table if not exists は何もしない。
// つまり流し直しても直らない。言っていることが嘘になる。
import { readFileSync, readdirSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const dir = atRoot("db");
const status = readFileSync(`${dir}/check_status.sql`, "utf8");

// parts(...) の中身を読む
const block = status.slice(status.indexOf("parts(mig, obj, col, how) as (values"),
                           status.indexOf("missing as ("));
const rows = [...block.matchAll(/\('(\d{3})',\s*'([a-z_]+)',\s*'([a-z_0-9]+)',\s*'(rerun|manual)'\)/g)]
  .map((m) => ({ mig: m[1], obj: m[2], col: m[3], how: m[4] }));

const files = Object.fromEntries(readdirSync(dir)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .map((f) => [f.slice(0, 3), readFileSync(`${dir}/${f}`, "utf8")]));

let bad = 0;
console.log(`parts に ${rows.length} 件`);
// 0件で「通過」と出す検査は、検査になっていない
if (rows.length < 30) {
  console.log("NG: parts を読めていません（切り出しか正規表現がずれています）");
  process.exit(1);
}

for (const r of rows) {
  // その番号のファイルだけでなく、あとの番号で足されることもある
  const src = Object.entries(files)
    .filter(([n]) => n >= r.mig)
    .map(([, s]) => s).join("\n");

  // alter table <obj> add column if not exists <col>
  const re = new RegExp(
    `alter\\s+table\\s+(public\\.)?${r.obj}\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+${r.col}\\b`, "i");
  // 途中で改行されている書き方も拾う
  const re2 = new RegExp(
    `alter\\s+table\\s+(public\\.)?${r.obj}\\s*\\n?\\s*add\\s+column\\s+if\\s+not\\s+exists\\s+${r.col}\\b`, "i");

  const healable = re.test(src) || re2.test(src);
  const said = r.how === "rerun";
  if (healable !== said) {
    console.log(`NG ${r.mig}: ${r.obj}.${r.col} … `
      + (healable ? "流し直せば直るのに manual と書いてある"
                  : "流し直しても直らないのに rerun と書いてある"));
    bad++;
  }
}
console.log(bad ? `\n${bad} 件、助言が実態と違う` : "\n直し方の書き分けは、実態と合っている");
process.exit(bad ? 1 : 0);
