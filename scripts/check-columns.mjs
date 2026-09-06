// db/*.sql の実際の列と、コードが insert / update / upsert に渡している
// 列名を突き合わせる。
//
// ■ なぜ要るのか
//   PostgREST は、知らない列が1つでも混ざると insert 全体を失敗させる。
//     Could not find the 'note' column of 'gw_employees' in the schema cache
//   本番で押してみるまで気づけないので、手元で先に見つける。
//
// ■ 使い方
//   node scripts/check-columns.mjs
//
// ■ 誤検知が出る
//   .from("表") のすぐ後ろにある別の関数の引数（gwLog の action/target/detail、
//   notifySlack の text/lines/link など）まで拾ってしまう。
//   出た行は、実際にその表へ書いているかを目で確かめること。
//   拾いすぎるほうを選んでいるのは、見落とすより害が小さいため。

import fs from "fs";
import path from "path";

// 1) db/*.sql から、テーブルごとの実際の列を組み立てる
const cols = new Map();          // table -> Set(column)
const add = (t, c) => {
  if (!cols.has(t)) cols.set(t, new Set());
  cols.get(t).add(c);
};

for (const f of fs.readdirSync("db").filter((x) => x.endsWith(".sql"))) {
  const sql = fs.readFileSync(path.join("db", f), "utf8");

  // create table ... ( ... );
  const re = /create table if not exists\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1];
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/--.*$/, "").trim();
      const c = /^([a-z_][a-z0-9_]*)\s+(uuid|text|date|timestamptz|timestamp|time|boolean|bool|integer|int|int2|int4|int8|smallint|bigint|numeric|decimal|real|double|jsonb|json|bytea|varchar|char|inet|interval)/i.exec(line);
      if (c) add(table, c[1]);
    }
  }
  // alter table ... add column if not exists <name>
  const re2 = /alter table\s+(?:public\.)?(\w+)[\s\S]{0,80}?add column if not exists\s+([a-z_][a-z0-9_]*)/gi;
  while ((m = re2.exec(sql))) add(m[1], m[2]);
}

// 2) コードの insert/update/upsert に渡している列名を拾う
const bad = [];
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
};
walk("lib"); walk("api");

for (const p of files) {
  const src = fs.readFileSync(p, "utf8");
  // .from("table") ... .insert({ ... }) / .update({ ... }) / .upsert({ ... })
  const re = /\.from\(\s*"(\w+)"\s*\)\s*[\s\S]{0,200}?\.(insert|update|upsert)\(\s*\{([\s\S]*?)\n(\s*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const [, table, op, body] = m;
    const known = cols.get(table);
    if (!known) continue;                       // 定義が拾えない表は飛ばす
    const line = src.slice(0, m.index).split("\n").length;
    for (const km of body.matchAll(/^\s{2,}([a-z_][a-z0-9_]*)\s*:/gm)) {
      const col = km[1];
      if (!known.has(col)) bad.push({ p, line, table, op, col });
    }
  }
}

console.log(`スキーマから読めた表: ${cols.size}`);
if (!bad.length) { console.log("★ 無い列への書き込み: 見つからず"); process.exit(0); }
console.log(`\n★ スキーマに無い列への書き込み: ${bad.length} 件\n`);
for (const b of bad) console.log(`  ${b.p}:${b.line}  ${b.table}.${b.col}  (${b.op})`);
