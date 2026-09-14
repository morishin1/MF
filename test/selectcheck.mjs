// SELECT し忘れた列を、機械で洗う。
//
// ■ なぜ要るのか
//
//   api/devices/pair.js が enrollment_id を SELECT していないのに
//   p.enrollment_id を見ていた。undefined なので判定が常に偽になり、
//   インストーラは永久に ready:false を受け取っていた。
//
//   画面に出るのは「時間内に終わりませんでした」だけ。
//   ログにも何も出ない。実機で動かして、はじめて分かった。
//
//   テストが通っていたのは、偽の Supabase が行を丸ごと返していたから。
//   そこは直したが、テストの通らない経路は依然として残る。
//   だから、読まずに済ませられる形で洗う。
//
// ■ どう見るか
//
//   const { data: p } = await sb.from("表").select("列, 列, …")
//   …のあと、その関数の中で p.列 を使っているものを拾い、
//   SELECT に無いものを挙げる。
//
//   間違いを減らすため、**その表に実在する列**だけを対象にする。
//   p.length や p.map は列ではないので、はじめから見ない。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);




// ---- SQL が作る列 ------------------------------------------------------------
const cols = new Map();
const add = (t, c) => {
  if (!cols.has(t)) cols.set(t, new Set());
  cols.get(t).add(c);
};
const sqlText = readdirSync(join(ROOT, "db"))
  .filter((f) => f.endsWith(".sql") && f !== "check_status.sql")
  .sort()
  .map((f) => readFileSync(join(ROOT, "db", f), "utf8"))
  .join("\n");

for (const m of sqlText.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
  for (const line of m[2].split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("--")) continue;
    if (/^(constraint|primary\s+key|unique|check|foreign\s+key|exclude|like)\b/i.test(s)) continue;
    const c = s.match(/^(\w+)\s+/);
    if (c) add(m[1], c[1]);
  }
}
for (const m of sqlText.matchAll(
  /alter\s+table\s+(?:public\.)?(\w+)\s*\n?\s*add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
  add(m[1], m[2]);
}

// ---- 括弧の対応 ---------------------------------------------------------------
function skip(src, j) {
  const c = src[j];
  if (c === '"' || c === "'" || c === "`") {
    const q = c; j++;
    while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; }
    return j;
  }
  if (c === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; return j; }
  if (c === "/" && src[j + 1] === "*") { return src.indexOf("*/", j) + 1; }
  return j;
}

// pos を囲んでいる、いちばん内側の { } の終わりを返す
function blockEnd(src, pos) {
  const stack = [];
  for (let j = 0; j < pos; j++) {
    const k = skip(src, j);
    if (k !== j) { j = k; continue; }
    if (src[j] === "{") stack.push(j);
    else if (src[j] === "}") stack.pop();
  }
  if (!stack.length) return src.length;
  const open = stack[stack.length - 1];
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const k = skip(src, j);
    if (k !== j) { j = k; continue; }
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return j; }
  }
  return src.length;
}

// ---- 洗う ---------------------------------------------------------------------
function files(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (e.endsWith(".js")) out.push(p);
  }
  return out;
}

const targets = [...files(join(ROOT, "api")), ...files(join(ROOT, "lib"))];

// 列の名前と紛らわしいが、列ではないもの
const NOT_COLS = new Set(["length", "map", "filter", "find", "forEach", "slice",
  "then", "catch", "toString", "constructor"]);

const findings = [];

// 行コメントを落とす（中身の位置は変えない）。
//
// チェーンの途中に説明を書き足しただけで見落とす、を避ける。
// 消すのではなく同じ長さの空白に替えるので、行番号も位置もずれない
function decomment(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

for (const file of targets) {
  const raw = readFileSync(file, "utf8");
  const src = decomment(raw);

  // const { data: NAME, … } = await …from("表")…select("列, …")…
  const re = /const\s*\{\s*data\s*:\s*(\w+)[^}]*\}\s*=\s*await\s+([\s\S]{0,1500}?)\.maybeSingle\(\)|const\s*\{\s*data\s*:\s*(\w+)[^}]*\}\s*=\s*await\s+([\s\S]{0,1500}?)\.single\(\)/g;

  for (const m of src.matchAll(re)) {
    const name = m[1] || m[3];
    const chain = m[2] || m[4];
    const at = m.index + m[0].length;

    const tbl = chain.match(/\.from\(\s*["'`](\w+)["'`]\s*\)/);
    const sel = chain.match(/\.select\(\s*([\s\S]*?)\s*\)\s*(?:\.|$)/);
    if (!tbl || !sel) continue;

    const table = tbl[1];
    const known = cols.get(table);
    if (!known) continue;                       // 知らない表は見ない

    // "a, b" + "c, d" のように繋いで書いてあることがある
    let parts = [...sel[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]).join(",");

    // `${FIELDS}, …` のように定数を挟んでいるものは、その定数を引く。
    // 引けなければ見ない（列が分からないのに「無い」とは言えない）
    parts = parts.replace(/\$\{(\w+)\}/g, (whole, id) => {
      const def = src.match(new RegExp(
        `const\\s+${id}\\s*=\\s*((?:["'\`][^"'\`]*["'\`]\\s*\\+?\\s*)+);`));
      if (!def) return "\u0000";
      return [...def[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]).join("");
    });
    if (!parts || parts.includes("*") || parts.includes("\u0000")) continue;
    if (/\$\{/.test(parts)) continue;
    const picked = new Set(parts.split(",").map((s) => s.trim().split(":").pop().trim())
      .filter(Boolean));

    // その関数の終わりまでを見る
    const end = blockEnd(src, m.index);
    const body = src.slice(at, end);

    const used = new Set();
    for (const u of body.matchAll(new RegExp(`\\b${name}\\s*\\??\\.\\s*(\\w+)`, "g"))) {
      used.add(u[1]);
    }

    for (const f of used) {
      if (NOT_COLS.has(f)) continue;
      if (picked.has(f)) continue;
      if (!known.has(f)) continue;              // その表の列でなければ、別のもの
      const line = src.slice(0, at).split("\n").length;
      findings.push({
        file: file.replace(ROOT + "/", ""), line, table, name, field: f,
        sel: parts.slice(0, 70),
      });
    }
  }
}

if (!findings.length) {
  console.log("SELECT の取り忘れは見つかりませんでした");
  process.exit(0);
}

console.log("SELECT に無い列を使っています:\n");
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}`);
  console.log(`    ${f.name}.${f.field}  ← ${f.table} の列ですが SELECT に入っていません`);
  console.log(`    select: ${f.sel}…\n`);
}
console.log(`${findings.length} 件`);
process.exit(1);
