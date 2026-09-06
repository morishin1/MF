// 「みんなの日報」に出す共有用サマリーを作る。
//
// ■ いちばん大事なこと：AIに、出してはいけないものを渡さない
//   公開してよいのは4つだけ。
//     今日やったこと / 成果 / 学び / 明日やること
//   出してはいけないのは、
//     AI評価点・未達理由・相談事項・個人評価・管理者コメント。
//
//   「これは書かないでください」と指示するだけでは足りない。
//   指示は破られることがあるし、破られたかどうかを毎回人が確かめられない。
//
//   だから、この関数に渡す材料からそもそも外してある（publicSource）。
//   渡していないものは、書きようがない。
//   評価用のプロンプト（lib/nippo-eval.js）とは呼び出しを分けているのは、
//   そのためだけ。まとめて1回で済ませると、同じ文脈に全部が乗ってしまう。
//
// ■ 未完了は「理由」を外して、件数だけ渡す
//   「3件のうち1件は明日に回した」は事実として共有してよい。
//   「なぜできなかったか」は本人と管理者の間の話なので渡さない。

import Anthropic from "@anthropic-ai/sdk";
import * as CLAUDE from "./claude.js";

export const PROMPT_VERSION = "share_v1";

export const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * 日報1件から、AIに渡してよい材料だけを抜き出す。
 *
 * ★ ここに項目を足すときは、それが全社員に見えてよいかを必ず考えること。
 *   この関数が、公開してよいものの境界そのものになっている。
 */
export function publicSource(n) {
  const items = (n.work_items || []).filter((w) => w.task);
  return {
    date: n.work_date,
    topPriority: n.top_priority || null,
    // task と result だけ。undone_reason（できなかった理由）は渡さない
    items: items.map((w) => ({ task: w.task, result: w.result || null })),
    doneCount: items.filter((w) => w.result).length,
    itemCount: items.length,
    kpiName: n.goal_today || null,
    kpiTarget: n.kgi_target ?? null,
    kpiActual: n.kgi_actual ?? null,
    tomorrow: n.tomorrow_plan || null,
  };
}

/** 共有するだけの中身があるか。空の日報からサマリーを作らない */
export const hasShareable = (src) =>
  Boolean(src.items.some((i) => i.result) || src.tomorrow);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["did", "result", "learn", "tomorrow"],
  properties: {
    did: { type: "string", description: "今日やったこと。1文。事実だけ" },
    result: {
      type: "string",
      description: "成果。数字があれば数字で。'—' を返してもよい（成果が書かれていない日）",
    },
    learn: {
      type: "string",
      description: "学び。日報から読み取れるものだけ。読み取れなければ '—' を返す",
    },
    tomorrow: { type: "string", description: "明日やること。1文。無ければ '—'" },
  },
};

const SYSTEM = [
  "あなたは株式会社エイトの社内グループウェアで、日報の共有用サマリーを作ります。",
  "",
  "このサマリーは、社内の他のメンバー全員が読みます。",
  "本人が「見せてもよい」と思える形にしてください。",
  "",
  "【守ること】",
  "・渡された日報の記述だけを使う。書かれていないことを足さない",
  "・評価しない。点数・優劣・「よくできています」のような講評を書かない",
  "・人物評価を書かない。行動と結果だけを書く",
  "・各項目1文、40〜80文字。長く書かない",
  "・材料が無い項目は、無理に埋めず '—' と返す",
  "・敬体（です・ます）で書く",
  "",
  "【学びについて】",
  "「学び」は、やったことと結果から読み取れる範囲で書いてください。",
  "読み取れないときに、それらしい一般論（「計画性が大切だと学びました」など）を",
  "書かないでください。読み取れなければ '—' を返すほうが正確です。",
].join("\n");

function prompt(src) {
  const kpi = src.kpiName
    ? `${src.kpiName}：目標 ${src.kpiTarget ?? "—"} / 実績 ${src.kpiActual ?? "—"}`
    : "（KPIなし）";

  return [
    `【${src.date} の日報】`,
    `今日の最優先：${src.topPriority || "（記載なし）"}`,
    `今日のKPI：${kpi}`,
    "",
    "やったこと：",
    ...src.items.map((i) => `・${i.task}${i.result ? ` → ${i.result}` : "（まだ結果なし）"}`),
    "",
    `終えた件数：${src.itemCount} 件のうち ${src.doneCount} 件`,
    `明日やること：${src.tomorrow || "（記載なし）"}`,
  ].join("\n");
}

/**
 * @returns {Promise<{ok:boolean, model?:string, result?:object, detail?:string}>}
 */
export async function summarizeForShare(nippo) {
  if (!isConfigured()) return { ok: false, detail: "not_configured" };

  const src = publicSource(nippo);
  if (!hasShareable(src)) return { ok: false, detail: "nothing_to_share" };

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: CLAUDE.MODEL,
      max_tokens: CLAUDE.MAX_TOKENS.short,
      system: SYSTEM,
      tools: [{ name: "share_summary", description: "共有用サマリーを返す", input_schema: SCHEMA }],
      tool_choice: { type: "tool", name: "share_summary" },
      messages: [{ role: "user", content: prompt(src) }],
    });
    const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "share_summary");
    if (!tu) return { ok: false, detail: "claude_no_tool_use" };

    const cut = (v) => {
      const s = String(v ?? "").trim();
      return !s || s === "—" || s === "-" ? null : s.slice(0, 300);
    };
    return {
      ok: true,
      model: CLAUDE.MODEL,
      result: {
        did: cut(tu.input.did),
        result: cut(tu.input.result),
        learn: cut(tu.input.learn),
        tomorrow: cut(tu.input.tomorrow),
      },
    };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 300) };
  }
}
