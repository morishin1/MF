// 提案（未適用）db/proposal_app_grants_marketing.sql を、流さずに確かめる。
//
// ■ 守るもの（2026-10-24 メンバー管理：Marketing の割当との整合）
//   1. 既存のメンバーに marketing を自動で付けない（gw_app_grants への INSERT が無い）
//   2. 広げたあとの app_key は、いまのコードの APP_KEYS（lib/app-grants.js）をすべて含み、marketing を足すだけ
//   3. 戻す SQL は、付けた marketing が残っていれば止まる（黙って権限を消さない）。戻した制約は db/119 と同じ
//   4. 内部ロールからの導出（APP_FROM_ROLES）で marketing に入れる人はいない（入口は明示した人だけ）
// 実際の DB での確かめ（流す・2回流す・付ける・戻す）は docs/member-list-bulk-ux.md に結果を残した（使い捨ての PostgreSQL 16）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (sql) => sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const keysOf = (sql) => {
  const m = /add constraint gw_app_grants_app_key_check check \(app_key in \(([^)]*)\)\)/i.exec(code(sql));
  return m ? m[1].split(",").map((s) => s.trim().replace(/'/g, "")) : null;
};
const { APP_KEYS, APP_FROM_ROLES } = await import(join(ROOT, "lib/app-grants.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("NG:", name, "\n   ", e.message); } };

const up = read("db/proposal_app_grants_marketing.sql");
const down = read("db/proposal_rollback_app_grants_marketing.sql");

ok("既存のメンバーに自動で付けない（INSERT も UPDATE も無い）", () => {
  assert.ok(!/insert\s+into\s+public\.gw_app_grants/i.test(code(up)));
  assert.ok(!/update\s+public\.gw_app_grants/i.test(code(up)));
});
ok("広げたあとの app_key ＝ いまの APP_KEYS ＋ marketing", () => {
  assert.deepEqual(keysOf(up), APP_KEYS);
});
ok("db/119 が無ければ止まる（前提の確認）", () => {
  assert.match(code(up), /to_regclass\('public\.gw_app_grants'\) is null/);
});
ok("戻す SQL：marketing が残っていれば止まる。消す行はコメントのまま", () => {
  assert.match(code(down), /raise exception 'marketing の権限が/);
  assert.ok(!/^\s*delete from public\.gw_app_grants/im.test(code(down)), "消す行は、コメントを外したときだけ");
  assert.deepEqual(keysOf(down), APP_KEYS.filter((key) => key !== "marketing"));
});
ok("内部ロールからの導出で marketing に入れる人はいない", () => {
  assert.ok(Object.values(APP_FROM_ROLES).every((list) => !list.includes("marketing")));
});

console.log(`\n${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
