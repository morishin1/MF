// AI営業の Claude 呼び出し（lib/sales-ai/client.js）が、SDK 0.39 で正しい形のリクエストを送り、答えを読めるか。
//
// ■ 何を守るテストか（外へは出ない。SDK の fetch を差し替える）
//   1. 送る形：model・max_tokens・system・messages・output_config（effort・json_schema）。tool_choice を送らない
//      （5.5 系で tool_choice の強制は 400。SDK 0.39 の型に output_config は無いが、そのまま送られること）
//   2. キーは SALES_AI_ANTHROPIC_API_KEY だけ。ANTHROPIC_API_KEY（既存の AI）へは落ちない
//   3. 答え：考えるブロックの後ろの text を JSON として読む。refusal・max_tokens・壊れた JSON は ok:false
//   4. 既存の AI の設定（lib/claude.js の MODEL）は AI営業の設定で変わらない
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (p) => join(ROOT, p);

delete process.env.SALES_AI_ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = "sk-existing-should-not-be-used";
const { aiClient, callJson, errorOutcome } = await import(at("lib/sales-ai/client.js"));
const { MODELS } = await import(at("lib/sales-ai/config.js"));

let n = 0, bad = 0;
const t = async (name, fn) => {
  n++;
  try { await fn(); console.log(`  ok ${name}`); } catch (e) { bad++; console.log(`NG ${name}\n   ${e.stack || e.message}`); }
};

const SCHEMA = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
function fakeFetch(reply) {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: MODELS.light, stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 300 }, ...reply,
    }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
  };
  return { f, seen };
}

console.log("\n=== キー ===");
await t("SALES_AI_ANTHROPIC_API_KEY が無ければ止める（ANTHROPIC_API_KEY を使わない）", () => {
  assert.throws(() => aiClient(), (e) => e.code === "ai_not_configured");
});
process.env.SALES_AI_ANTHROPIC_API_KEY = "sk-sales-ai-test";

console.log("\n=== 送る形・読む形 ===");
await t("output_config（effort・json_schema）をそのまま送り、tool_choice は送らない", async () => {
  const { f, seen } = fakeFetch({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text: '{"a":"x"}' }] });
  const r = await callJson(aiClient({ fetchImpl: f }), { model: MODELS.light, system: "sys", user: "u", schema: SCHEMA, maxTokens: 6000, effort: "low" });
  assert.equal(seen.length, 1);
  const b = seen[0].body;
  assert.ok(seen[0].url.endsWith("/v1/messages"));
  assert.equal(b.model, "claude-haiku-5-5");
  assert.equal(b.max_tokens, 6000);
  assert.equal(b.system, "sys");
  assert.deepEqual(b.messages, [{ role: "user", content: "u" }]);
  assert.deepEqual(b.output_config, { effort: "low", format: { type: "json_schema", schema: SCHEMA } });
  assert.equal(b.tool_choice, undefined);
  assert.equal(b.tools, undefined);
  assert.equal(seen[0].headers["x-api-key"], "sk-sales-ai-test", "AI営業のキーで送る");
  assert.deepEqual(r.data, { a: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.usage.output_tokens, 300);
});
await t("refusal は ok:false（outcome refusal）", async () => {
  const { f } = fakeFetch({ stop_reason: "refusal", content: [] });
  const r = await callJson(aiClient({ fetchImpl: f }), { model: MODELS.light, system: "s", user: "u", schema: SCHEMA, maxTokens: 10 });
  assert.equal(r.ok, false); assert.equal(r.outcome, "refusal");
});
await t("max_tokens で切れたら ok:false（invalid_output）", async () => {
  const { f } = fakeFetch({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"a":' }] });
  const r = await callJson(aiClient({ fetchImpl: f }), { model: MODELS.light, system: "s", user: "u", schema: SCHEMA, maxTokens: 10 });
  assert.equal(r.ok, false); assert.equal(r.outcome, "invalid_output");
});
await t("JSON が読めなければ ok:false", async () => {
  const { f } = fakeFetch({ stop_reason: "end_turn", content: [{ type: "text", text: "すみません" }] });
  const r = await callJson(aiClient({ fetchImpl: f }), { model: MODELS.light, system: "s", user: "u", schema: SCHEMA, maxTokens: 10 });
  assert.equal(r.ok, false); assert.equal(r.error, "bad_json");
});
await t("API のエラー（429）は throw し、outcome error にできる", async () => {
  const f = async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } }), { status: 429, headers: { "content-type": "application/json" } });
  const c = aiClient({ fetchImpl: f });
  c.maxRetries = 0;
  await assert.rejects(() => c.messages.create({ model: MODELS.light, max_tokens: 10, messages: [{ role: "user", content: "u" }] }, { maxRetries: 0 }),
    (e) => errorOutcome(e).outcome === "error");
});

console.log("\n=== 既存の AI の設定を変えない ===");
await t("lib/claude.js の MODEL は AI営業のモデルと別", async () => {
  const { MODEL } = await import(at("lib/claude.js"));
  assert.equal(MODEL, process.env.ANTHROPIC_MODEL || "claude-opus-5");
  assert.notEqual(MODELS.light, MODEL);
});

console.log(`\n合計 ${n} 件中 ${n - bad} 件 通過`);
if (bad) process.exit(1);
