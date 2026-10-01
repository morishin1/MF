// 社内AIチャットの回答生成。
//
// 毎回すべてのナレッジをAIへ渡さない（要件 §26）。呼び出し側（api/ai/ask.js）が
// lib/ai-knowledge.js の searchKnowledge で関連度の高い数件だけに絞ってから、
// ここへ渡す。
//
// 返答はいつもの「道具を強制して決まった形のJSONを返させる」方式
// （lib/ai-json.js の askJson）。文章で返させて後から読み取ると、
// 出典の対応付けが崩れる。

import { askJson, aiConfigured } from "./ai-json.js";
import { CATEGORY_CODES, categoryLabel } from "./ai-knowledge.js";

export { aiConfigured };

const SYSTEM_PROMPT = `あなたは株式会社エイトの社内アシスタントです。総務・人事・経理・IT・社内システムについて、社員からの質問に答えます。

必ず守ること:
- 渡された社内資料（参考資料）を優先して答える。資料に無いことを一般論やあなたの知識で断定しない
- 根拠のないことを断定しない。資料から読み取れないときは、その旨を正直に答える
- 参考資料に答えが見つからない場合は「確認できません」とはっきり伝え、推測で社内ルールを作らない
- 個人情報（給与・評価・マイナンバー等）には答えない。そのような質問には「個人情報のため担当者にご確認ください」と答える
- 自分の権限で見られる資料以外は使わない（渡された資料だけを根拠にする）
- 回答で使った資料は usedKnowledgeIds に番号で挙げる。使っていない資料は挙げない
- 資料が無い・答えられない場合でも、断らずに「どこに相談すればよいか」を案内する
- これまでの会話が渡されたときは、その続きとして答える。「それ」「そこ」「もう少し詳しく」
  のような指示語・追質問は、会話の流れから何を指しているか補って答える
- 丁寧だが簡潔に。前置きは短く`;

// 会話履歴は「それはどこ？」「もう少し詳しく」のような追質問を成立させるために渡す。
// ただし毎回すべての過去メッセージを渡すとトークンがふくらむ（§26）ので、直近だけ・
// 1件あたりも全体も上限を切ってから渡す
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS_PER_MESSAGE = 600;
const MAX_HISTORY_TOTAL_CHARS = 4000;

function formatHistory(history) {
  const recent = (history || []).slice(-MAX_HISTORY_MESSAGES);
  let used = 0;
  const lines = [];
  for (const m of recent) {
    if (used >= MAX_HISTORY_TOTAL_CHARS) break;
    const label = m.role === "user" ? "社員" : m.role === "assistant" ? "AI" : "システム";
    const room = MAX_HISTORY_TOTAL_CHARS - used;
    const content = String(m.content || "").slice(0, Math.min(MAX_HISTORY_CHARS_PER_MESSAGE, room));
    if (!content) continue;
    used += content.length;
    lines.push(`${label}: ${content}`);
  }
  return lines.join("\n");
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "社員への回答本文" },
    category: { type: "string", enum: CATEGORY_CODES, description: "この質問の分類" },
    usedKnowledgeIds: {
      type: "array", items: { type: "string" },
      description: "回答の根拠に実際に使った参考資料の番号（knowledgeId）。無ければ空配列",
    },
    confident: { type: "boolean", description: "資料にもとづいて自信を持って答えられたか" },
  },
  required: ["answer", "category", "usedKnowledgeIds", "confident"],
};

function buildPrompt(question, knowledgeRows, history) {
  const parts = [];
  const historyText = formatHistory(history);
  if (historyText) {
    parts.push(`これまでの会話（この続きとして今回の質問に答える。「それ」「もう少し詳しく」等の`
      + `指示語は、この会話の流れから補う）:\n${historyText}`);
  }
  parts.push(`今回の質問: ${question}`);
  parts.push(knowledgeRows.length
    ? `参考資料:\n${knowledgeRows.map((k, i) =>
        `[資料${i + 1}] knowledgeId=${k.id} カテゴリ=${categoryLabel(k.category)} タイトル=${k.title}\n${k.content}`)
        .join("\n\n")}`
    : "参考資料: （関連する社内資料が見つかりませんでした）");
  return parts.join("\n\n");
}

/**
 * @param {{question:string, knowledgeRows:Array<object>, history?:Array<{role:string, content:string}>}} opts
 * @returns {Promise<{answer:string, category:string, usedKnowledgeIds:string[], confident:boolean, model:string}>}
 */
export async function askAssistant({ question, knowledgeRows, history = [] }) {
  if (!aiConfigured()) {
    return {
      answer: "現在AIが設定されていないため回答できません。お手数ですが「管理部へ問い合わせる」からご連絡ください。",
      category: "other", usedKnowledgeIds: [], confident: false, model: null,
    };
  }
  const prompt = buildPrompt(question, knowledgeRows, history);
  const { model, result } = await askJson(SYSTEM_PROMPT, prompt, ANSWER_SCHEMA, "answer_question", "normal");
  const validIds = new Set(knowledgeRows.map((k) => k.id));
  return {
    answer: String(result.answer || "").trim() || "確認できませんでした。",
    category: CATEGORY_CODES.includes(result.category) ? result.category : "other",
    usedKnowledgeIds: (result.usedKnowledgeIds || []).filter((id) => validIds.has(id)),
    confident: Boolean(result.confident),
    model,
  };
}
