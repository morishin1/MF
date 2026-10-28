// 即時Gmail取込API：偽の認証・GAS応答だけを使う。実Gmail・DB・ネットワークには接続しない。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL("../" + path, import.meta.url));
const tenant = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const secret = "synthetic_manual_key_for_tests_only_32_plus";
const endpoint = "https://script.google.com/macros/s/synthetic-test-deployment/exec";
const settings = {
  HR_INBOX_SYNC_ENABLED: "1", HR_INBOX_TENANT_ID: tenant,
  HR_INBOX_SYNC_SECRET: "synthetic_ingest_key_for_tests_only_32_plus",
  HR_INBOX_GAS_WEBAPP_URL: endpoint, HR_INBOX_MANUAL_SECRET: secret,
};
const originalEnv = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalError = console.error;
let authenticated = true, role = "recruiter", currentTenant = tenant;
let authCalls = 0, contextCalls = 0, calls = [], logs = [];
let upstream = { ok: true, inserted: 2, duplicates: 1, processed: 3 };
let upstreamOk = true, rawResponse = null, fetchError = null;

mock.module(at("lib/auth.js"), { namedExports: {
  requireUser: async (_req, res) => {
    authCalls++;
    if (authenticated) return { id: "synthetic-user" };
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
    return null;
  },
} });
mock.module(at("lib/gw.js"), { namedExports: {
  gwContext: async (id) => {
    assert.equal(id, "synthetic-user");
    contextCalls++;
    return { tenantId: currentTenant, roles: [role] };
  },
  canRecruit: (ctx) => ctx.roles.includes("recruiter"),
} });
const { default: handler, config } = await import(at("api/hr/inbox-sync-now.js"));
assert.ok(config.maxDuration > 30, "GAS timeout must leave time to return a safe result");

globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  if (fetchError) throw fetchError;
  return { ok: upstreamOk, text: async () => rawResponse ?? JSON.stringify(upstream) };
};
console.error = (...args) => logs.push(args.join(" "));
function reset() {
  Object.assign(process.env, settings);
  authenticated = true; role = "recruiter"; currentTenant = tenant;
  authCalls = 0; contextCalls = 0; calls = []; logs = [];
  upstream = { ok: true, inserted: 2, duplicates: 1, processed: 3 };
  upstreamOk = true; rawResponse = null; fetchError = null;
}
async function call(method = "POST", body = {}) {
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handler({ method, url: "/api/hr/inbox-sync-now", body }, res);
  assert.equal(res.headers["Cache-Control"], "private,no-store");
  return res;
}
let passed = 0;
async function check(name, fn) {
  reset();
  await fn();
  passed++;
  console.log("  ok", name);
}

try {
  await check("POST以外は認証・GAS起動前に拒否", async () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
      const res = await call(method);
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers.Allow, "POST");
    }
    assert.equal(authCalls, 0); assert.equal(contextCalls, 0); assert.equal(calls.length, 0);
  });
  await check("未ログインはGASを起動しない", async () => {
    authenticated = false;
    assert.equal((await call()).statusCode, 401);
    assert.equal(contextCalls, 0); assert.equal(calls.length, 0);
  });
  await check("採用HR権限・所属テナントが必須", async () => {
    role = "member";
    assert.equal((await call()).statusCode, 403);
    role = "recruiter"; currentTenant = null;
    assert.equal((await call()).statusCode, 403);
    assert.equal(calls.length, 0);
  });
  await check("別法人は起動不可・リクエスト本文で法人を差し替えられない", async () => {
    currentTenant = otherTenant;
    const res = await call("POST", { tenantId: tenant, url: endpoint });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "sync_not_configured");
    assert.equal(calls.length, 0);
  });
  await check("設定欠落・不正URL・短い鍵をすべて閉じる", async () => {
    const invalid = [
      ["HR_INBOX_SYNC_ENABLED", undefined], ["HR_INBOX_SYNC_ENABLED", "0"],
      ["HR_INBOX_TENANT_ID", "not-a-uuid"], ["HR_INBOX_TENANT_ID", otherTenant],
      ["HR_INBOX_GAS_WEBAPP_URL", ""],
      ["HR_INBOX_GAS_WEBAPP_URL", "https://example.com/macros/s/test/exec"],
      ["HR_INBOX_GAS_WEBAPP_URL", "https://script.google.com.evil.example/macros/s/test/exec"],
      ["HR_INBOX_GAS_WEBAPP_URL", "http://script.google.com/macros/s/test/exec"],
      ["HR_INBOX_GAS_WEBAPP_URL", endpoint + "?extra=1"],
      ["HR_INBOX_MANUAL_SECRET", undefined], ["HR_INBOX_MANUAL_SECRET", "x".repeat(31)],
      ["HR_INBOX_SYNC_SECRET", undefined], ["HR_INBOX_SYNC_SECRET", "x".repeat(31)],
    ];
    for (const [key, value] of invalid) {
      Object.assign(process.env, settings);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
      const res = await call();
      assert.equal(res.statusCode, 503, key + " must fail closed");
      assert.equal(res.body.error, "sync_not_configured");
    }
    assert.equal(calls.length, 0);
  });
  await check("正しい固定宛先へ一意nonce付きHMACだけを送る", async () => {
    const res = await call("POST", {
      url: "https://example.com/untrusted", tenantId: otherTenant,
      secret: "untrusted", signature: "untrusted", applicant: { email: "synthetic@example.com" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, dryRun: false, inserted: 2, duplicates: 1, processed: 3 });
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(url, endpoint); assert.equal(options.method, "POST");
    assert.equal(options.redirect, "follow");
    assert.equal(options.headers["Content-Type"], "text/plain; charset=utf-8");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload).sort(), ["nonce", "signature", "timestamp"]);
    assert.match(payload.nonce, /^[a-f0-9]{32}$/);
    assert.ok(Math.abs(Date.now() - Number(payload.timestamp) * 1000) < 2000);
    assert.equal(payload.signature, crypto.createHmac("sha256", secret)
      .update(payload.timestamp + "." + payload.nonce + ".hr-inbox-sync-now").digest("hex"));
    await call();
    assert.notEqual(JSON.parse(calls[1].options.body).nonce, payload.nonce);
    assert.ok(!options.body.includes(secret));
    assert.ok(!JSON.stringify(res.body).includes(secret));
  });
  await check("DRY RUNと候補件数だけを返し余分な応答は捨てる", async () => {
    upstream = { ok: true, dryRun: true, candidates: 7, secret, body: "synthetic private mail" };
    const res = await call();
    assert.deepEqual(res.body, { ok: true, dryRun: true, inserted: 0, duplicates: 0, processed: 7 });
    assert.equal(logs.length, 0);
  });
  await check("件数は安全な整数範囲・dryRunは真偽値だけ", async () => {
    upstream = { ok: true, dryRun: "true", inserted: -1, duplicates: 101, processed: 1.5 };
    assert.deepEqual((await call()).body,
      { ok: true, dryRun: false, inserted: 0, duplicates: 0, processed: 0 });
    upstream = { ok: true, inserted: "4", duplicates: 100, processed: "not-a-number" };
    assert.deepEqual((await call()).body,
      { ok: true, dryRun: false, inserted: 4, duplicates: 100, processed: 0 });
  });
  await check("通信障害・タイムアウトは未取込と断言せず結果不明", async () => {
    for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
      fetchError = Object.assign(new Error("synthetic private detail: " + secret), { name });
      const res = await call();
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, "sync_result_unknown");
      assert.match(res.body.hint, /一覧を更新/);
      assert.ok(!JSON.stringify(res.body).includes(secret));
    }
    assert.ok(logs.every((line) => !line.includes(secret) && !line.includes("private detail")));
  });
  await check("JSONでない・過大な応答は結果不明にする", async () => {
    for (const raw of ["<html>sign in</html>", "{", JSON.stringify({ ok: true, extra: "x".repeat(4100) })]) {
      rawResponse = raw;
      const res = await call();
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, "sync_result_unknown");
    }
  });
  await check("GAS busyは再起動せず409・認証や再送拒否は502", async () => {
    for (const code of ["busy", "unauthorized", "duplicate_request", "sync_failed"]) {
      upstream = { ok: false, code };
      const before = calls.length;
      const res = await call();
      assert.equal(res.statusCode, code === "busy" ? 409 : 502);
      assert.equal(res.body.error, code);
      assert.equal(calls.length, before + 1, "upstream failure must not be automatically retried");
    }
  });
  await check("任意のGASエラー文字列をブラウザへ流さない", async () => {
    upstream = { ok: false, code: "synthetic private detail: " + secret };
    const res = await call();
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "sync_failed");
    assert.ok(!JSON.stringify(res.body).includes(secret));
  });
  await check("HTTP失敗・ok不正は成功表示しない", async () => {
    upstreamOk = false;
    assert.equal((await call()).statusCode, 502);
    upstreamOk = true;
    for (const value of [null, {}, { ok: "true" }]) {
      upstream = value;
      const res = await call();
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, "sync_failed");
    }
  });
  console.log(`HR instant Gmail sync API: ${passed} checks PASS`);
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  mock.restoreAll();
}
