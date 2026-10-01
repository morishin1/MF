// 本番 DB の前提チェック（db/check_onboarding_ready.sql）が、いまのコードとずれていないかを見張る。
//
// ■ なぜ要るか
//   このチェックは「いまの main の API が読み書きする表・列」を、SQL に手で書き写したもの。
//   API に列を足したのに、チェックに足し忘れると、本番で「チェックは全部 OK なのに、画面が 503」になる。
//   （通知書の前提チェック check_labor_notice.sql が、gw_procedures を「任意」と書いていたのも、書き写しのずれだった）
//   ここでは、コードの select に出てくる列が、すべてチェックの列の一覧に入っていることを確かめる。
//
// ■ 見るもの
//   ① API・lib の .from("表").select("列, 列") の列が、チェックの表ごとの列の一覧に入っている
//   ② 同じく、api/hr/index.js の P_FIELDS・I_FIELDS、lib/gw.js gwContext の select、通知書の列（NOTICE_COLS_FILE）
//   ③ コードが読む表は、すべてチェックの表の一覧にある（新しい表を足したのに、チェックに足し忘れない）
//   ④ チェックは読み取り専用（コメントと文字列を除いて、書き込み・定義変更の文が無い）
//   ⑤ 「出どころ」に書いたファイルが、実際に db/ にある（名前の打ち間違い・改名に気づく）
//   ⑥ 最小の流し方（docs/onboarding-db-prereq.md）が、test/sql/run.sh で確かめている順と同じ
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const sql = read("db/check_onboarding_ready.sql");

// ---- チェックの表ごとの列（spec の行: 'テーブル', array['列', ...]) ----
const specCols = new Map();
for (const m of sql.matchAll(/'([a-z_0-9]+)',\s*array\[([^\]]*)\]\)/g)) {
  const set = specCols.get(m[1]) || new Set();
  for (const c of m[2].matchAll(/'([a-z_0-9]+)'/g)) set.add(c[1]);
  specCols.set(m[1], set);
}

const cols = (s) => String(s).split(",").map((x) => x.trim()).filter(Boolean);

// ---- コードが select する列 ----
// 読む対象は、入社管理・通知書の一連の動きが通るファイルだけ（lib/ は、そこから呼ばれるもの）
const FILES = [
  "api/hr/index.js", "api/onboarding/status.js", "api/onboarding/start.js", "api/onboarding/notice.js",
  "lib/gw.js", "lib/auth.js", "lib/onboard-advance.js", "lib/hr-run.js", "lib/labor-notice-db.js",
];
const used = new Map();   // 表 → Set(列)
const note = (tbl, list, where) => {
  const set = used.get(tbl) || new Map();
  for (const c of list) if (c !== "*") set.set(c, where);
  used.set(tbl, set);
};
for (const f of FILES) {
  const src = read(f);
  for (const m of src.matchAll(/\.from\("([a-z_0-9]+)"\)\s*\.select\(\s*"([^"]*)"/g)) note(m[1], cols(m[2]), f);
}

// 文字列を + でつないだ select（1行に収まらないもの）は、式を評価して取り出す
const evalExpr = (expr) => new Function(`return (${expr});`)();
{
  const hr = read("api/hr/index.js");
  const a = hr.indexOf("const P_FIELDS"), b = hr.indexOf("export default");
  const { P_FIELDS, I_FIELDS } = new Function(`${hr.slice(a, b)}; return { P_FIELDS, I_FIELDS };`)();
  note("gw_procedures", cols(P_FIELDS), "api/hr/index.js P_FIELDS");
  note("gw_procedure_items", cols(I_FIELDS), "api/hr/index.js I_FIELDS");
  const gw = read("lib/gw.js");
  const g = gw.match(/\.from\("gw_employees"\)\s*\.select\(([\s\S]*?)\)\s*\.eq\("user_id"/);
  assert.ok(g, "lib/gw.js gwContext の select が見つかりません（書き方が変わったら、このテストも直す）");
  note("gw_employees", cols(evalExpr(g[1])), "lib/gw.js gwContext");
}
const { NOTICE_COLS_FILE } = await import("../lib/labor-notice-db.js");
note("gw_labor_notices", cols(NOTICE_COLS_FILE), "lib/labor-notice-db.js NOTICE_COLS_FILE");

test("① ② コードが select する列は、すべてチェックの列の一覧に入っている", () => {
  const lacking = [];
  for (const [tbl, map] of used) {
    const have = specCols.get(tbl);
    if (!have) continue;                       // 表そのものが無い場合は、③ が言う
    for (const [c, where] of map) if (!have.has(c)) lacking.push(`${tbl}.${c}（${where}）`);
  }
  assert.deepEqual(lacking, [], `チェックの列の一覧に足りません: ${lacking.join(", ")}`);
});

test("③ コードが読む表は、すべてチェックの表の一覧にある", () => {
  // チェックの対象にしない表（通知を送るときだけ読む。無くても通知が出ないだけ）
  const NOT_CHECKED = new Set(["gw_push_subs", "gw_reminder_prefs"]);
  const missing = [...used.keys()].filter((t) => !specCols.has(t) && !NOT_CHECKED.has(t));
  assert.deepEqual(missing, [], `チェックに無い表: ${missing.join(", ")}`);
});

test("③b gw_tasks・gw_notifications・gw_sensitive_access_log・gw_activity_log は、書き込む列がチェックの一覧に入っている", () => {
  // select ではなく insert する表。書く列は、コードの insert({...}) の鍵
  const want = {
    gw_tasks: read("lib/hr-run.js"),
    gw_notifications: read("lib/notify.js"),
    gw_sensitive_access_log: read("lib/sensitive-log.js"),
    gw_activity_log: read("lib/gw-audit.js"),
  };
  const keysAfter = (src, marker) => {
    const i = src.indexOf(marker);
    assert.ok(i >= 0, `${marker} が見つかりません`);
    const body = src.slice(i, i + 700);
    return [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
  };
  const tasks = keysAfter(want.gw_tasks, "const rows = [...byWho.entries()].map(([employeeId, v]) => ({");
  const notif = keysAfter(want.gw_notifications, "const payload = list.map((r) => ({");
  const sens = keysAfter(want.gw_sensitive_access_log, "await admin().from(\"gw_sensitive_access_log\").insert({");
  const lacking = [];
  for (const [tbl, keys] of [["gw_tasks", tasks], ["gw_notifications", notif], ["gw_sensitive_access_log", sens]]) {
    for (const k of keys) if (!specCols.get(tbl)?.has(k)) lacking.push(`${tbl}.${k}`);
  }
  assert.deepEqual(lacking, [], `書き込む列がチェックに足りません: ${lacking.join(", ")}`);
  for (const k of ["tenant_id", "actor_id", "action", "target", "detail"]) assert.ok(specCols.get("gw_activity_log").has(k), `gw_activity_log.${k}`);
});

test("④ チェックは読み取り専用（コメントと文字列を除いて、書き込み・定義変更の文が無い）", () => {
  const stripped = sql
    .replace(/--[^\n]*/g, "")                    // 行コメント
    .replace(/'(?:[^']|'')*'/g, "''");           // 文字列（query_to_xml の中の select も、ここで消える）
  assert.doesNotMatch(stripped, /\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|comment|notify|vacuum|copy|set|reset|do|call|execute)\b/i,
    "読み取り専用のはずのチェックに、書き込み・定義変更の文があります");
  assert.match(stripped, /^\s*with\b/i, "with で始まる 1 本の select であること");
  assert.equal((stripped.match(/;/g) || []).length, 1, "文は 1 本だけ（末尾の ; ひとつ）");
});

test("④b query_to_xml に渡す文字列も、select の count だけ", () => {
  const inner = [...sql.matchAll(/query_to_xml\(\s*'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  assert.ok(inner.length >= 2, "データの確認（owner・hr／重複）が query_to_xml で書かれているはず");
  for (const q of inner) {
    assert.match(q, /^select count\(\*\)/i, `count 以外の文が混ざっています: ${q}`);
    assert.doesNotMatch(q, /\b(insert|update|delete|truncate|create|alter|drop|grant|revoke)\b/i);
  }
});

test("⑤ 「出どころ」に書いた db/ のファイルは、実際にある", () => {
  const named = new Set([...sql.matchAll(/db\/([0-9a-z_]+\.sql)/g)].map((m) => m[1]));
  assert.ok(named.size >= 10);
  const gone = [...named].filter((f) => !existsSync(join(ROOT, "db", f)));
  assert.deepEqual(gone, [], `db/ に無いファイル名: ${gone.join(", ")}`);
});

test("⑤b 出力の列は、決めた 6 つ。判定は、必須で存在・不足・任意（あり）・任意（なし）・集計だけ", () => {
  assert.match(sql, /as "判定"/);
  for (const c of ["確認する対象（実体）", "不足の中身", "無いと起きること", "使うところ", "出どころ（参考。番号でなく実体で見る）"]) {
    assert.ok(sql.includes(`"${c}"`), `列 ${c}`);
  }
  for (const v of ["'必須で存在'", "'不足'", "'任意（あり）'", "'任意（なし）'", "'集計'"]) assert.ok(sql.includes(v), v);
  // 区分は 必須 / 任意 だけ
  const kinds = new Set([...sql.matchAll(/^\s*\(\d{3},\s*'([^']+)'/gm)].map((m) => m[1]));
  assert.deepEqual([...kinds].sort(), ["任意", "必須"]);
});

test("⑤c 番号（ord）は重ならない", () => {
  const ords = [...sql.matchAll(/^\s*\((\d{3}),\s*'(?:必須|任意)'/gm)].map((m) => m[1]);
  assert.equal(new Set(ords).size, ords.length, `重なった番号: ${ords.filter((o, i) => ords.indexOf(o) !== i).join(", ")}`);
  assert.ok(ords.length >= 45, `行が少なすぎます（${ords.length}）`);
});

test("⑥ 最小の流し方（docs）は、test/sql/run.sh で確かめている順と同じ", () => {
  const doc = read("docs/onboarding-db-prereq.md");
  const block = doc.match(/<!-- chain:start -->([\s\S]*?)<!-- chain:end -->/);
  assert.ok(block, "docs/onboarding-db-prereq.md に <!-- chain:start --> … <!-- chain:end --> がありません");
  const inDoc = [...block[1].matchAll(/db\/([0-9a-z_]+)\.sql/g)].map((m) => m[1]);
  const run = read("test/sql/run.sh").match(/^CHAIN="([^"]+)"/m);
  assert.ok(run, "test/sql/run.sh に CHAIN=\"…\" がありません");
  assert.deepEqual(inDoc, run[1].split(/\s+/), "文書の流す順と、run.sh で確かめている順が違います");
  for (const f of inDoc) assert.ok(existsSync(join(ROOT, "db", `${f}.sql`)), `${f}.sql が無い`);
});

test("⑦ 流さないと決めたもの（給与系 099〜105・104 ほか）は、最小の流し方に入っていない", () => {
  const doc = read("docs/onboarding-db-prereq.md");
  const block = doc.match(/<!-- chain:start -->([\s\S]*?)<!-- chain:end -->/)[1];
  for (const banned of ["099_owner_only", "099_access_hr_office", "099_hr_timerex_ceo", "100_hr_pay", "100_office_access", "101_hr_pay_clear", "102_contracts_pay_rls", "103_tool_access", "104_onboarding_guide", "105_compensation"]) {
    assert.ok(!block.includes(banned), `${banned} は、最小の流し方に入れない`);
  }
});
