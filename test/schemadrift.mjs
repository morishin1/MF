// コードが使う列と、SQLが作る列がずれていないか。
//
// 本番で gw_devices.source が欠けて機能が死んだ。
// check_status は 054 を「適用済み」と出していたので気づけなかった。
// 同じ種類のずれを、機械で洗う。
//
// 切り出しは固定長の窓ではなく、括弧の対応を数えて
// **そのクエリのチェーンが終わるところまで**にする。
// 窓で切ると、後ろにある gwLog({action, detail, …}) を
// 列として拾ってしまい、偽物だらけになる。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);


// ---- SQL が作る列 ----
const cols = new Map();
const add = (t, c) => {
  if (!cols.has(t)) cols.set(t, new Set());
  cols.get(t).add(c);
};

const sql = readdirSync(join(ROOT, "db"))
  .filter((f) => f.endsWith(".sql") && f !== "000_install_fresh.sql" && f !== "check_status.sql")
  .sort()
  .map((f) => readFileSync(join(ROOT, "db", f), "utf8"))
  .join("\n");

for (const m of sql.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
  for (const line of m[2].split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("--")) continue;
    if (/^(constraint|primary\s+key|unique|check|foreign\s+key|exclude|like)\b/i.test(s)) continue;
    const c = s.match(/^(\w+)\s+/);
    if (c) add(m[1], c[1]);
  }
}
// 1つの alter table で、列をいくつも足すことがある。
//
//   alter table public.gw_devices
//     add column if not exists revoked_at  timestamptz,
//     add column if not exists lost_at     timestamptz,
//     …
//
// ここを「最初の1つ」しか拾っていなかったので、2つめ以降が
// 「SQL に無い列」として出ていた。文の終わり（;）まで読む
for (const m of sql.matchAll(/alter\s+table\s+(?:public\.)?(\w+)([^;]*);/gi)) {
  for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
    add(m[1], c[1]);
  }
}
for (const m of sql.matchAll(
  /alter\s+table\s+(?:public\.)?(\w+)\s+rename\s+column\s+(\w+)\s+to\s+(\w+)/gi)) {
  add(m[1], m[3]);
}

/**
 * 埋め込みを外す。
 *
 *   "id, employee:gw_employees(id, display_name), created_at"
 *     → "id, , created_at"
 *
 * 埋め込みの中は向こうの表の列。こちらの表には無くて当たり前なので、
 * 残すと「欠けている」と言い続けることになる
 */
function stripEmbedded(spec) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === "(") {
      // 別名が無い埋め込み（gw_employees(...)）は、直前の名前ごと落とす
      if (depth === 0) out = out.replace(/[\w.]+$/, "");
      depth++;
      continue;
    }
    if (c === ")") { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;
    out += c;
  }
  // 埋め込みの前に付いている「別名:表名」も落とす
  return out.split(",").map((x) => (x.includes(":") ? "" : x)).join(",");
}

/** i の位置の開き括弧に対応する閉じ括弧の位置。見つからなければ -1 */
function closer(src, i) {
  const open = src[i];
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    // 文字列とテンプレートを飛ばす
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      j++;
      while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; }
      continue;
    }
    if (c === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
    if (c === "/" && src[j + 1] === "*") { j = src.indexOf("*/", j) + 1; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** .from( の位置から、そのチェーンが終わるところまでを返す */
function chain(src, from) {
  let i = from;
  while (i < src.length) {
    if (src[i] === "(" || src[i] === "{" || src[i] === "[") {
      const e = closer(src, i);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const q = src[i++];
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    // チェーンは . か空白でつながる。それ以外が来たら終わり
    if (/[\s.]/.test(src[i])) { i++; continue; }
    if (/[\w$]/.test(src[i])) { while (i < src.length && /[\w$]/.test(src[i])) i++; continue; }
    break;
  }
  return src.slice(from, i);
}

// ---- コードが使う列 ----
const code = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) code.push(p);
  }
};
walk(join(ROOT, "api"));
walk(join(ROOT, "lib"));

const used = new Map();
const note = (t, c, f) => {
  const k = `${t}.${c}`;
  if (!used.has(k)) used.set(k, new Set());
  used.get(k).add(f.replace(ROOT + "/", ""));
};

for (const f of code) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\.from\(\s*["'`](gw_\w+)["'`]\s*\)/g)) {
    const table = m[1];
    const win = chain(src, m.index);

    // .select("a, b" + "c")
    for (const sel of win.matchAll(/\.select\(\s*((?:["'`][^"'`]*["'`]\s*\+?\s*)+)/g)) {
      let spec = "";
      for (const part of sel[1].matchAll(/["'`]([^"'`]*)["'`]/g)) spec += part[1];

      // 埋め込み（employee:gw_employees(id, display_name)）の中は、
      // 向こうの表の列。こちらの表の列ではないので、まるごと落とす。
      // 落とさないと「display_name が無い」と、ありもしない欠けを出す
      spec = stripEmbedded(spec);

      for (const raw of spec.split(",")) {
        const c = raw.trim().split(/[\s(:]/)[0];
        if (/^\w+$/.test(c) && c !== "*" && !/^\d+$/.test(c)) note(table, c, f);
      }
    }
    // 絞り込み
    for (const e of win.matchAll(
      /\.(?:eq|neq|in|is|not|lt|lte|gt|gte|order|contains)\(\s*["'`](\w+)["'`]/g)) {
      note(table, e[1], f);
    }
    // insert/update/upsert の直後のオブジェクト。括弧を数えて正確に切る
    for (const w of win.matchAll(/\.(?:insert|update|upsert)\(\s*(?:\[\s*)?\{/g)) {
      const brace = win.indexOf("{", w.index);
      const end = closer(win, brace);
      if (end < 0) continue;
      const body = win.slice(brace + 1, end);
      // 入れ子のオブジェクトは飛ばす（detail: {...} の中は列ではない）
      let depth = 0;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === "{" || c === "[" || c === "(") depth++;
        else if (c === "}" || c === "]" || c === ")") depth--;
        else if (depth === 0) {
          const rest = body.slice(i);
          const k = rest.match(/^(\w+)\s*:/);
          const before = body.slice(0, i).replace(/\s+$/, "");
          if (k && (before === "" || /[{,]$/.test(before))) {
            note(table, k[1], f);
            i += k[0].length - 1;
          }
        }
      }
    }
  }
}

// ---- 突き合わせ ----
// 列ではないもの（Supabase のオプションや JS の綴り）は除く
const NOT_A_COLUMN = new Set(["onConflict", "ignoreDuplicates", "count", "head", "ascending",
                              "nullsFirst", "returning", "defaultToNull"]);
let bad = 0;
const unknown = new Set();
const rows = [];
for (const [k, files] of [...used.entries()].sort()) {
  const [t, c] = k.split(".");
  if (NOT_A_COLUMN.has(c)) continue;
  if (!cols.has(t)) { unknown.add(t); continue; }
  if (!cols.get(t).has(c)) { rows.push(`  ${k}  ←  ${[...files].join(", ")}`); bad++; }
}

console.log(`SQL の表 ${cols.size} ／ コードが使う列 ${used.size} 通り`);
if (unknown.size) console.log(`（SQLに無い表：${[...unknown].join(", ")}）`);
if (bad) {
  console.log(`\nNG: SQL に無い列を、コードが使っています（${bad} 件）`);
  console.log(rows.join("\n"));
} else {
  console.log("\nコードが使う列は、すべて SQL で作られている");
}
process.exit(bad ? 1 : 0);
