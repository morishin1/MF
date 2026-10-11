// AI営業の Claude 呼び出し（構造化出力で JSON を受け取る）。
//
// ■ SDK 0.39 で output_config を使う
//   SDK 0.39 の型には output_config が無いが、JS の SDK は知らない項目もそのまま送る。
//   送った形・受け取った形は test/salesaiclient.mjs が、SDK の fetch を差し替えて確かめる。
//   ・format: json_schema … 答えは text ブロックに JSON で入る（スキーマどおり）
//   ・effort … 考える量。分析は low、営業文は medium（費用を抑える）
//   ・tool_choice の強制は 5.5 系では 400 になるので使わない
//
// ■ 失敗の扱い
//   refusal（AI が断った）・max_tokens（途中で切れた）・JSON が読めない は、throw せず { ok:false, outcome } で返す。
//   ネットワーク・API のエラーは throw（呼んだ側が台帳に error として確定する）。

import Anthropic from "@anthropic-ai/sdk";
import { aiKey, LIMITS } from "./config.js";

export function aiClient({ fetchImpl } = {}) {
  const apiKey = aiKey();
  if (!apiKey) throw Object.assign(new Error("ai_not_configured"), { code: "ai_not_configured" });
  // 再試行しない：Vercel の 60 秒を超えると、関数ごと切られて分析も台帳の確定も残らない（予約は10分後に解放される）
  return new Anthropic({ apiKey, maxRetries: 0, timeout: LIMITS.timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/**
 * @returns {Promise<{ok:boolean, data?:object, outcome:string, error?:string, usage:object, latencyMs:number}>}
 */
export async function callJson(client, { model, system, user, schema, maxTokens, effort = "low" }) {
  const started = Date.now();
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: { type: "json_schema", schema } },
  });
  const usage = msg?.usage || {};
  const latencyMs = Date.now() - started;
  if (msg?.stop_reason === "refusal") return { ok: false, outcome: "refusal", error: "refusal", usage, latencyMs };
  if (msg?.stop_reason === "max_tokens") return { ok: false, outcome: "invalid_output", error: "max_tokens", usage, latencyMs };
  const text = (msg?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("not_object");
    return { ok: true, data, outcome: "ok", usage, latencyMs };
  } catch {
    return { ok: false, outcome: "invalid_output", error: "bad_json", usage, latencyMs };
  }
}

/** API のエラーを台帳の outcome にする */
export function errorOutcome(e) {
  const name = String(e?.name || e?.constructor?.name || "");
  if (/Timeout/i.test(name) || e?.code === "ETIMEDOUT") return { outcome: "timeout", error: "timeout" };
  return { outcome: "error", error: String(e?.status || e?.error?.error?.type || e?.code || e?.message || "error").slice(0, 200) };
}
