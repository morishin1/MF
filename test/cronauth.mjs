// 定期実行（api/cron/*）の入口：本番で CRON_SECRET が未設定なら、誰が叩いても動かない（503）。
//   lib/cron-auth.js の判定と、すべての api/cron/*.js がそれを最初に呼ぶことを確かめる。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cronAuthorized } from "../lib/cron-auth.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const res = () => { const r = { statusCode: 0, body: null, setHeader() {} }; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const run = (env, auth) => { const r = res(); const passed = cronAuthorized({ headers: auth ? { authorization: auth } : {} }, r, env); return { passed, r }; };

ok("本番で CRON_SECRET が未設定 → 503（ヘッダーがあっても無くても動かない）", () => {
  for (const auth of [undefined, "Bearer x", "Bearer "]) {
    const { passed, r } = run({ VERCEL_ENV: "production" }, auth);
    assert.equal(passed, false);
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.error, "not_configured");
  }
});
ok("CRON_SECRET があれば、Bearer が一致するときだけ通す（本番でも、手元でも）", () => {
  for (const VERCEL_ENV of ["production", "preview", undefined]) {
    const env = { VERCEL_ENV, CRON_SECRET: "s3cret" };
    assert.equal(run(env, "Bearer s3cret").passed, true);
    for (const bad of [undefined, "Bearer wrong", "s3cret", "Bearer s3cret "]) {
      const { passed, r } = run(env, bad);
      assert.equal(passed, false, String(bad));
      assert.equal(r.statusCode, 401);
    }
  }
});
ok("手元・プレビュー（本番でない）で未設定なら、これまでどおり通す", () => {
  assert.equal(run({}, undefined).passed, true);
  assert.equal(run({ VERCEL_ENV: "preview" }, undefined).passed, true);
});
ok("すべての api/cron/*.js が、最初に cronAuthorized を通す（自前の if (secret) を残さない）", () => {
  const files = readdirSync(join(ROOT, "api/cron")).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 9);
  for (const f of files) {
    const src = readFileSync(join(ROOT, "api/cron", f), "utf8");
    assert.match(src, /if \(!cronAuthorized\(req, res\)\) return;/, f);
    assert.doesNotMatch(src, /if \(secret\) \{/, f);
    const body = src.slice(src.indexOf("export default"));
    const gate = body.indexOf("cronAuthorized(");
    for (const use of ["admin()", "from(\""]) {
      const at = body.indexOf(use);
      assert.ok(at < 0 || gate < at, `${f}: ${use} より前に認証する`);
    }
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
