// 経営（/keiei）の画面が呼ぶ API の view を、静的に確かめる。
//
// ■ なぜ要るのか
//   ホーム（経営ハブ）に統合して、旧 view（dashboard・expenses・revenue・cash・accounting）は
//   画面から呼ばなくなった。ただし API の旧 view は、後方互換のため物理削除していない。
//   削除してよいのは「呼び出しが 0 件」と確かめたあと（別の作業）。このテストは、その確認の入口：
//     1. 画面（リポジトリ内のフロント）が呼ぶ view は、hub・security・payroll・onboarding だけ
//     2. 旧 view の呼び出しは、フロントに 0 件
//     3. API には、旧 view がまだ残っている（消していない）
//     4. 旧画面のブックマーク（#dashboard など）は、ホームへ送る
//   本番のアクセスログに、リポジトリ外からの呼び出しが無いことは、ここでは確かめられない（削除の前に、ログで確認する）
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

// フロント（画面）のファイルを集める。API・lib・テスト・docs・node_modules は除く
const SKIP_DIRS = new Set(["node_modules", ".git", "api", "lib", "test", "docs", "db", "_archive", "agent", "scripts"]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([".html", ".js"].includes(extname(name))) out.push(p);
  }
  return out;
}
const front = walk(ROOT);
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => p.slice(ROOT.length + 1);

const OLD = ["dashboard", "expenses", "revenue", "cash", "accounting"];
const USED = ["hub", "security", "payroll", "onboarding"];

// 画面が /api/keiei?view=<名前> と書いている箇所（リテラル）
const literal = [];
for (const f of front) for (const m of read(f).matchAll(/\/api\/keiei\?view=([a-z_]+)/g)) literal.push([rel(f), m[1]]);
// keiei/index.html は、API_VIEW の対応表を通して呼ぶ
const index = read(join(ROOT, "keiei/index.html"));
const map = /const API_VIEW = \{([^}]*)\}/.exec(index);
const mapped = map ? [...map[1].matchAll(/(\w+)\s*:\s*"(\w+)"/g)].map((m) => [m[1], m[2]]) : [];

console.log("— 画面が呼ぶ view —");

ok("keiei/index.html の API_VIEW（画面→view の対応表）がある", () => {
  assert.ok(map, "API_VIEW が見つからない");
  assert.deepEqual(Object.fromEntries(mapped), { home: "hub", security: "security", payroll: "payroll", onboarding: "onboarding" });
});

ok("画面が API を呼ぶのは、この対応表の1か所だけ（ほかにリテラルで /api/keiei?view= と書いた画面は無い）", () => {
  assert.deepEqual(literal, [], JSON.stringify(literal));
  assert.match(index, /\/api\/keiei\?view=\$\{encodeURIComponent\(API_VIEW\[view\]\)\}/);
});

ok("画面が呼ぶ view は hub・security・payroll・onboarding だけ", () => {
  const called = new Set([...literal.map((x) => x[1]), ...mapped.map((x) => x[1])]);
  assert.deepEqual([...called].sort(), [...USED].sort());
});

ok("旧 view（dashboard・expenses・revenue・cash・accounting）の呼び出しは、フロントに 0 件", () => {
  const all = [...literal.map((x) => x[1]), ...mapped.map((x) => x[1])];
  for (const v of OLD) assert.equal(all.includes(v), false, `${v} を呼んでいる`);
  // 「?view=dashboard」のような文字列が、テスト以外のフロントに書かれていない（動的に組み立てていない）
  for (const f of front) {
    const t = read(f);
    for (const v of OLD) assert.equal(new RegExp(`keiei\\?view=${v}\\b`).test(t), false, `${rel(f)} に keiei?view=${v}`);
  }
});

ok("旧画面のメニュー・描画は、フロントに残っていない（入口を外した）", () => {
  const layout = read(join(ROOT, "js/keiei-layout.js"));
  for (const v of OLD) assert.equal(new RegExp(`key:\\s*"${v}"`).test(layout), false, `メニューに ${v}`);
  for (const v of OLD) assert.equal(new RegExp(`^\\s{4}${v}\\(d\\)\\s*\\{`, "m").test(index), false, `RENDER に ${v}`);
  assert.deepEqual([...index.matchAll(/^\s{4}(\w+)\(d\)\s*\{/gm)].map((m) => m[1]).sort(), ["home", "onboarding", "payroll", "security"]);
});

ok("旧画面のブックマーク（#dashboard など）は、ホームへ送る", () => {
  const m = /const LEGACY = new Set\(\[([^\]]*)\]\)/.exec(index);
  assert.ok(m, "LEGACY が無い");
  assert.deepEqual([...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).sort(), [...OLD].sort());
});

console.log("\n— API には、旧 view がまだ残っている（物理削除していない）—");

ok("api/keiei/index.js の VIEWS に、旧 view が全部ある。ハンドラも残っている", () => {
  const api = read(join(ROOT, "api/keiei/index.js"));
  const v = /const VIEWS = \[([^\]]*)\]/.exec(api);
  const list = [...v[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
  for (const name of [...OLD, ...USED]) assert.ok(list.includes(name), `${name} が VIEWS に無い`);
  for (const name of OLD) assert.match(api, new RegExp(`view === "${name}"`), `${name} のハンドラが無い`);
  for (const fn of ["async function dashboard(", "async function revenue(", "async function cash(", "async function accounting(", "async function expenseOf("]) {
    assert.ok(api.includes(fn), `${fn} が消えている`);
  }
});

ok("旧 view を使う集計（lib/keiei.js の buildDashboard など）も、まだ残っている", () => {
  const lib = read(join(ROOT, "lib/keiei.js"));
  for (const fn of ["export function buildDashboard", "export function summarizeExpenses", "export function summarizePayroll"]) {
    assert.ok(lib.includes(fn), `${fn} が消えている`);
  }
});

console.log("\n— 呼び出しの一覧（削除の前に、本番ログとつき合わせる）—");
for (const v of [...USED, ...OLD]) console.log(`  ${v.padEnd(11)} フロントの呼び出し ${USED.includes(v) ? "あり（画面が使う）" : "0件（後方互換のため API に残す）"}`);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
