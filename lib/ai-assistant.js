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
- 丁寧だが簡潔に。前置きは短く`;

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

function buildPrompt(question, knowledgeRows) {
  if (!knowledgeRows.length) {
    return `質問: ${question}\n\n参考資料: （関連する社内資料が見つかりませんでした）`;
  }
  const docs = knowledgeRows.map((k, i) =>
    `[資料${i + 1}] knowledgeId=${k.id} カテゴリ=${categoryLabel(k.category)} タイトル=${k.title}\n${k.content}`)
    .join("\n\n");
  return `質問: ${question}\n\n参考資料:\n${docs}`;
}

/**
 * @param {{question:string, knowledgeRows:Array<object>}} opts
 * @returns {Promise<{answer:string, category:string, usedKnowledgeIds:string[], confident:boolean, model:string}>}
 */
export async function askAssistant({ question, knowledgeRows }) {
  if (!aiConfigured()) {
    return {
      answer: "現在AIが設定されていないため回答できません。お手数ですが「管理部へ問い合わせる」からご連絡ください。",
      category: "other", usedKnowledgeIds: [], confident: false, model: null,
    };
  }
  const prompt = buildPrompt(question, knowledgeRows);
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
