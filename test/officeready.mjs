// Office の本番準備の確認 SQL（db/check_office_ready.sql）を守る。
//
// ■ 何を守るテストか
//   1. 読むだけ（create / insert / update / delete / drop / alter / grant が無い）。本番で、そのまま Run してよい
//   2. Office の SQL（105・106・107・115・117・119）が作る表・ポリシー・関数・一意索引を、確認がすべて見ている
//      （migration に足したのに確認から漏れて、本番で「✅ なのに画面が 503」を作らない）
//   3. 画面（api/office/*）が使う表は、確認の項目にある
// 実際の PostgreSQL 16 で、未適用＝❌・全部適用＝✅ になることは、PR の作成時に確認した（test/sql/run.sh と同じ一時クラスタ）。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
// コメントと文字列を除いた本文（キーワードの検査用）
const code = (s) => s.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const CHECK = read("db/check_office_ready.sql");
const MIGS = {
  "105": "db/105_office_timesheet_base.sql",
  "106": "db/106_office_contract_terms.sql",
  "107": "db/107_office_timesheets.sql",
  "115": "db/115_office_split.sql",
  "117": "db/117_office_payables.sql",
  "119": "db/119_app_grants.sql",
};
// 確認の parts（mig, kind, obj, col）を読む
const parts = [...CHECK.matchAll(/\('(\d{3})',\s*'(\w+)',\s*'([^']+)',\s*(?:'([^']+)'|null)\)/g)]
  .map(([, mig, kind, obj, col]) => ({ mig, kind, obj, col: col || null }));
const has = (mig, kind, obj, col = null) => parts.some((p) => p.mig === mig && p.kind === kind && p.obj === obj && (col === null || p.col === col));

ok("確認 SQL は読むだけ（書き込み・定義の変更が無い）", () => {
  const body = code(CHECK);
  assert.ok(!/\b(create|insert|update|delete|drop|alter|truncate|grant|revoke)\b/i.test(body), "書き込みの語がある");
  assert.ok(/\bselect\b/i.test(body));
  // 文は1つだけ（; は最後の1つ）
  assert.equal((body.match(/;/g) || []).length, 1, "文が1つではない");
});

ok("確認の項目が読み取れる（6本の SQL すべてに項目がある）", () => {
  for (const m of Object.keys(MIGS)) assert.ok(parts.some((p) => p.mig === m), `${m} の項目が無い`);
});

ok("各 SQL が作る表は、すべて確認している", () => {
  for (const [m, f] of Object.entries(MIGS)) {
    for (const [, t] of read(f).matchAll(/create table if not exists public\.(\w+)/g)) {
      assert.ok(has(m, "table", t), `${f} の表 ${t} を確認していない`);
    }
  }
});

ok("新しい表のポリシー（105・106・107・117・119）は、すべて確認している", () => {
  for (const m of ["105", "106", "107", "117", "119"]) {
    for (const [, pol, t] of read(MIGS[m]).matchAll(/create policy (\w+) on public\.(\w+)/g)) {
      assert.ok(has(m, "policy", t, pol), `${MIGS[m]} のポリシー ${pol} を確認していない`);
    }
  }
});

ok("117 の二重計上・二重支払・二重完了を止める一意索引は、すべて確認している", () => {
  for (const [, ix] of read(MIGS["117"]).matchAll(/create unique index if not exists (\w+)/g)) {
    assert.ok(has("117", "index", ix), `一意索引 ${ix} を確認していない`);
  }
});

ok("115・119 の新しい関数を確認している", () => {
  assert.ok(has("115", "function", "gw_is_office_finance(uuid)"));
  assert.ok(has("115", "function", "gw_request_can_review(uuid)"));
  assert.ok(has("119", "function", "gw_has_app(uuid,text)"));
  assert.match(read(MIGS["119"]), /function public\.gw_has_app\(p_tenant uuid, p_app text\)/);
});

ok("105 が gw_submissions に足す列を、すべて確認している", () => {
  const add = read(MIGS["105"]).match(/alter table public\.gw_submissions([\s\S]*?);/)[1];
  for (const [, col] of add.matchAll(/add column if not exists (\w+)/g)) {
    assert.ok(has("105", "column", "gw_submissions", col), `gw_submissions.${col} を確認していない`);
  }
});

ok("画面（api/office/*）が使う Office の表は、確認の項目か前提（A）にある", () => {
  const dir = join(ROOT, "api/office");
  const used = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    for (const [, t] of readFileSync(join(dir, f), "utf8").matchAll(/\.from\("(gw_[a-z_]+)"\)/g)) used.add(t);
  }
  const officeTables = new Set(Object.values(MIGS).flatMap((f) => [...read(f).matchAll(/create table if not exists public\.(\w+)/g)].map((x) => x[1])));
  for (const t of used) {
    if (!officeTables.has(t)) continue;   // Office の SQL 以外の表（社員名簿など）は前提
    assert.ok(parts.some((p) => p.kind === "table" && p.obj === t), `api/office が使う ${t} を確認していない`);
  }
  assert.ok(used.size > 0);
});

ok("適用の順番が、確認の冒頭に書いてある（099 → 100 → 105 → 106 → 107 → 115 → 117 → 119）", () => {
  assert.match(CHECK, /099 → 100 → 105 → 106 → 107 → 115 → 117 → 119/);
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
