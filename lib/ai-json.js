// AIに「決まった形のJSON」を返させる。
//
// 文章で返させて後から読み取ろうとすると、書き方が少し変わるだけで壊れる。
// スキーマを渡して、その形以外を返せないようにする。
//
// OpenAI の鍵があればそちら、無ければ Anthropic。
// 両方無ければ、呼び出し側が「AIは使えません」を返す。
//
// 同じことを lib/growth-ai.js と lib/nippo-period.js も持っている。
// あちらは動いているので触らない。新しく書くものはここを使う。

import Anthropic from "@anthropic-ai/sdk";
import * as CLAUDE from "./claude.js";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export const aiConfigured = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

/**
 * @param {string} system   立場と守ってほしいこと
 * @param {string} prompt   材料
 * @param {object} schema   返してほしい形（JSON Schema）
 * @param {string} toolName 道具の名前。ログで区別するためのもの
 * @param {"short"|"normal"|"long"} size
 * @returns {Promise<{model:string, result:object}>}
 */
export async function askJson(system, prompt, schema, toolName, size = "normal") {
  if (process.env.OPENAI_API_KEY) {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [{ role: "system", content: system }, { role: "user", content: prompt }],
        text: { format: { type: "json_schema", name: toolName, strict: false, schema } },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`openai_failed: ${data.error?.message || `HTTP ${r.status}`}`);
    const text = data.output_text
      || (data.output || []).flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text;
    if (!text) throw new Error("openai_empty_output");
    return { model: OPENAI_MODEL, result: JSON.parse(text) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY も ANTHROPIC_API_KEY も設定されていません");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: CLAUDE.MODEL,
    max_tokens: CLAUDE.MAX_TOKENS[size] || CLAUDE.MAX_TOKENS.normal,
    system,
    tools: [{ name: toolName, description: "結果を返す", input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: prompt }],
  });
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
  if (!tu) throw new Error("claude_no_tool_use");
  return { model: CLAUDE.MODEL, result: tu.input };
}
