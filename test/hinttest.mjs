import assert from "node:assert/strict";
import { dbSetupHint } from "../lib/http.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };
const F = "db/048_timecard.sql";

ok("実際に出たエラーで発火する", () => {
  // 本番で出たそのままの文言
  const h = dbSetupHint({
    code: "PGRST205",
    message: "Could not find the table 'public.gw_time_entries' in the schema cache",
  }, F);
  assert.ok(h, "hint が出ない");
  assert.match(h, /テーブルがまだ作られていません/);
  assert.match(h, /db\/048_timecard\.sql/);
});

ok("コードが無くても、文言だけで拾う", () => {
  assert.ok(dbSetupHint({ message: "Could not find the table 'public.x' in the schema cache" }, F));
});

ok("Postgres の生エラーでも拾う", () => {
  assert.ok(dbSetupHint({ code: "42P01", message: 'relation "public.gw_time_entries" does not exist' }, F));
});

ok("関係ないエラーでは出さない", () => {
  assert.equal(dbSetupHint({ code: "23505", message: "duplicate key value violates unique constraint" }, F), null);
  assert.equal(dbSetupHint({ code: "42501", message: "new row violates row-level security policy" }, F), null);
  assert.equal(dbSetupHint(null, F), null);
  assert.equal(dbSetupHint({}, F), null);
});

ok("ファイル名はそのまま出る", () => {
  const h = dbSetupHint({ code: "PGRST205", message: "schema cache" }, "db/049_action_triage.sql");
  assert.match(h, /db\/049_action_triage\.sql/);
});

console.log(`\n${n} 件 すべて通りました`);
