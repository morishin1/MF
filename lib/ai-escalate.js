// AIの会話を、管理部への問い合わせ用に自動要約する（要件 §11）。
//
// 要件は「AIが自動要約する」だが、相談のたびにもう1回AI APIを呼ぶと
// コストが倍になる（§26 のAPIコスト対策と逆行する）。エスカレーションの要約は
// 定型で十分組み立てられる内容（直前の質問・直前の回答・カテゴリ・参照資料）
// なので、ここはAIを呼ばずテンプレートで組み立てる。

import { categoryLabel } from "./ai-knowledge.js";

/**
 * @param {{title?:string, category?:string}} thread
 * @param {Array<{role:string, content:string}>} messages 時系列順
 * @param {Array<{title:string}>} sources 直近の回答が使った出典（無ければ空配列）
 * @returns {{subject:string, summary:string, category:string}}
 */
export function buildEscalationSummary(thread, messages, sources = []) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const category = thread?.category || "other";

  const subject = (thread?.title || lastUser?.content || "AIへの相談")
    .replace(/\s+/g, " ").slice(0, 80);

  const lines = [
    `【相談内容】\n${lastUser?.content || "（内容なし）"}`,
    `【AIが回答した内容】\n${lastAssistant?.content || "（AIはまだ回答していません）"}`,
    `【解決できなかった理由】\nAIの回答では解決しなかったため、担当者への相談を希望`,
    `【関連カテゴリ】${categoryLabel(category)}`,
  ];
  if (sources.length) {
    lines.push(`【参照資料】${sources.map((s) => s.title).join("、")}`);
  }

  return { subject, summary: lines.join("\n\n"), category };
}
