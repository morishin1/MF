// 採用HR Phase 4A：/api/hr/timerex/webhook（受信の入口）を通す。
//
// ■ 何を守るテストか
//
//   実payload・認証方式をまだ確認できていないため、このエンドポイントは
//   今はDBへ一切書き込まない（採用HR Phase 4A指示書「最重要」）。
//
//   1. GWログイン認証を要求しない（TimeRexからのサーバー間通信のため）
//   2. どんな内容で呼んでも、DBへ書き込まない（not_implementedを返すだけ）
//   3. 壊れたpayload（不正なJSON等）でも例外を投げない
//   4. GET等の他メソッドは405
import assert from "node:assert/strict";

const { default: webhook } = await import("../api/hr/timerex/webhook.js");

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== /api/hr/timerex/webhook（実装待ちの入口） ===\n");

await ok("GWログイン不要（requireUserを呼ばない）。POSTすれば応答が返る", async () => {
  const r = res();
  await webhook({ method: "POST", headers: {}, body: { any: "thing" } }, r);
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "not_implemented");
});

await ok("何を送っても、まだ実装していないと明示する（DB未接続でも落ちない）", async () => {
  const r = res();
  await webhook({ method: "POST", headers: {}, body: { event: "confirmed", applicant_id: "a1" } }, r);
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /実payload|認証方式/);
});

await ok("bodyが空でも例外を投げない", async () => {
  const r = res();
  await webhook({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 503);
});

await ok("GETは405", async () => {
  const r = res();
  await webhook({ method: "GET", headers: {} }, r);
  assert.equal(r.statusCode, 405);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
