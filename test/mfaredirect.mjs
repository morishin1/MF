// 二段階認証が要るのに済んでいないとき、どの画面からでも「登録の場所」へ送れるか。
//
// ■ 何を守るテストか
//
//   js/api-client.js の api() は、API が 403 mfa_required を返すと
//   マイページ（/mypage.html#mfa）へ送る。ここが相対パス（mypage.html#mfa）だと、
//   /hr/ や /sales/ や /office/ の画面からは /hr/mypage.html のような存在しない場所へ飛び、
//   登録できないまま行き止まりになる。
//
//   実際に起きうる画面：hr/ceo-review.html は MFA 必須の /api/employees を呼ぶ。
//   MFA の強制は 2026-10-01 から（lib/mfa.js）。強制が始まると、経営者・人事が
//   二段階認証を済ませずに開いた時点で、この行き止まりになる。
//   呼び出し側の .catch では止められない（api() が throw する前に遷移するため）。
//
//   api-client.js を実際に動かして、遷移先を見る。
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(join(ROOT, "js/api-client.js"), "utf8");

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

/** その画面（pathname）で api-client.js を動かし、API が返す応答に対する遷移先を返す */
async function run(pathname, { status = 403, body = { error: "mfa_required", hint: "登録してください" } } = {}) {
  const store = { kp_session: JSON.stringify({
    access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, email: "a@example.com",
  }) };
  const sandbox = {
    window: {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    location: { href: "", pathname },
    fetch: async () => ({ ok: status < 400, status, json: async () => body }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "js/api-client.js" });
  let err = null;
  // 画面側の .catch では止められない、という実際の使い方に合わせて、例外は受けて捨てる
  await sandbox.window.API.api("/api/employees").catch((e) => { err = e; });
  return { href: sandbox.location.href, err };
}

console.log("— mfa_required は、どの階層の画面からでもマイページの登録へ送る —");

for (const p of [
  "/admin-members.html",      // ルート直下
  "/hr/ceo-review.html",      // 採用HR（MFA 必須の /api/employees を呼ぶ）
  "/sales/index.html",        // Sales
  "/office/monthly.html",     // Office（単価・請求額を返すので MFA を課す想定）
  "/biz/home.html",
]) {
  await ok(`${p} → /mypage.html#mfa（相対パスで /階層/mypage.html にならない）`, async () => {
    const { href, err } = await run(p);
    assert.equal(href, "/mypage.html#mfa");
    assert.equal(err?.code, "mfa_required", "呼び出し側には例外も返る");
  });
}

await ok("マイページの中では送らない（そこが登録の場所なので、回り続けない）", async () => {
  const { href, err } = await run("/mypage.html");
  assert.equal(href, "", "遷移しない");
  assert.equal(err?.code, "mfa_required");
});

await ok("mfa_required 以外の 403 では、送らない", async () => {
  const { href, err } = await run("/hr/applicants.html", { body: { error: "forbidden" } });
  assert.equal(href, "");
  assert.equal(err?.code, "forbidden");
});

await ok("成功したときは、送らない", async () => {
  const { href, err } = await run("/hr/applicants.html", { status: 200, body: { employees: [] } });
  assert.equal(href, "");
  assert.equal(err, null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
