// 日報のAI評価。
//
// ■ 分けて考える
//   数字で出せるものはプログラムで計算し、AIには渡さない（systemMetrics）。
//   KGIの達成率を AI に数えさせても正確にならないし、その必要もない。
//   AI に任せるのは「文章の意味を読まないと分からないこと」だけ。
//
// ■ AI に守らせること
//   ・人格や性格を評価しない
//   ・日報に書かれていないことを推測しない
//   ・点数には必ず理由を付ける
//   ・材料が無い項目は 0点ではなく「材料不足」にする
//     （0点にすると「書けば点が増える」になり、日報が長くなるだけになる）
//
// ■ どのモデルを使うか
//   要件では OpenAI Responses API + gpt-5.6-terra + Structured Outputs。
//   OPENAI_API_KEY があればそれを使う。
//   無いときは、この会計システムで既に使っている Claude に切り替える。
//   Claude の tool_use も「決めたJSON Schemaの形でしか返らない」ので、
//   構造が崩れない点は同じ。どちらで出したかは model 列に残す。

import Anthropic from "@anthropic-ai/sdk";

// 評価基準を変えたら上げる。過去の評価がどの基準で出たか分かるようにするため
export const PROMPT_VERSION = "daily_eval_v1";

const OPENAI_MODEL = process.env.OPENAI_NIPPO_MODEL || "gpt-5.6-terra";
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

export const CRITERIA = [
  { key: "quantity",             short: "量",       label: "まず量をこなせる（完成度にこだわって止まらず、70〜80点でも早く出せる）" },
  { key: "report_consult",       short: "報連相",   label: "自分から報告・相談できる（分からないまま抱え込まない）" },
  { key: "action",               short: "行動",     label: "考えるだけで終わらず、行動する（「ここまでやりました」が言える）" },
  { key: "self_learning",        short: "学習",     label: "自分で学べる（教わるのを待たず、自分で調べて試せる）" },
  { key: "consistency",          short: "期限",     label: "モチベーションに左右されない（約束・役割・期限を基準にする）" },
  { key: "results",              short: "成果",     label: "努力ではなく成果を見る（何を改善し、何を生み出したか説明できる）" },
  { key: "feedback_improvement", short: "改善",     label: "フィードバックを改善につなげる（指摘を受けて次の行動を変えられる）" },
  { key: "forward_thinking",     short: "前進",     label: "論破より前進を選ぶ（チーム・顧客にとって何が良いかを考える）" },
  { key: "team_attitude",        short: "チーム",   label: "周囲の空気を悪くしない（批判で終わらず「ではどうするか」まで出す）" },
  { key: "customer_focus",       short: "顧客",     label: "顧客と向き合える（営業職でなくても顧客の課題・価値を考えられる）" },
];
const KEYS = CRITERIA.map((c) => c.key);

export const isConfigured = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

// -----------------------------------------------------------------------------
// 1) プログラムで出す数字。AIには「計算結果」として渡す
// -----------------------------------------------------------------------------
export function systemMetrics(n) {
  const items = n.work_items || [];
  const issues = n.issues || [];

  const rate = (n.kgi_target > 0 && n.kgi_actual != null)
    ? Math.round((n.kgi_actual / n.kgi_target) * 1000) / 10
    : null;

  // 提出時刻は日本時間で見る。サーバはUTCで動いている
  const submitted = n.submitted_at ? new Date(n.submitted_at) : null;
  const submittedHour = submitted
    ? new Date(submitted.getTime() + 9 * 3600000).getUTCHours()
    : null;

  return {
    kgiTarget: n.kgi_target ?? null,
    kgiActual: n.kgi_actual ?? null,
    kgiRate: rate,
    kgiAchieved: n.kgi_achieved ?? null,
    workCount: items.length,
    resultCount: items.filter((i) => i.result).length,
    issueCount: n.no_issues ? 0 : issues.length,
    noIssues: !!n.no_issues,
    consultedCount: issues.filter((i) => i.consulted).length,
    nextActionCount: issues.filter((i) => i.next_action).length,
    improveTagCount: (n.improve_tags || []).length,
    hasContribution: Boolean(n.contribution),
    // 明日の最優先に期限か完了条件が入っているか。「営業を頑張る」を見分ける
    tomorrowConcrete: Boolean(n.tomorrow_plan && (n.tomorrow_deadline || n.tomorrow_target)),
    submittedHour,
  };
}

// -----------------------------------------------------------------------------
// 2) AI へ渡す文章
// -----------------------------------------------------------------------------
const SYSTEM = [
  "あなたは株式会社エイトの日報評価AIです。",
  "",
  "目的は社員の人格や性格を評価することではありません。",
  "提出された日報に記録された具体的な行動事実だけを評価してください。",
  "",
  "【守ること】",
  "・日報に書かれていないことを推測しない（性格・心理状態・やる気・家庭環境・本人の意図）",
  "・「この人は主体性が足りません」のような人物評価を書かない",
  "・点数には必ず、日報のどの記述を根拠にしたかが分かる理由を付ける",
  "・評価材料が無い項目は 0点にせず status を not_enough_data にして score を null にする",
  "  （0点にすると「書けば点が増える」になり、日報が長くなるだけになるため）",
  "・頑張った量ではなく、何を前に進めたかを見る",
  "・批判ではなく、次の行動につながる書き方にする",
  "・「素晴らしい一日でした」「この調子で頑張りましょう」のような、具体性のない言葉を書かない",
  "・明日のアドバイスは1つに絞り、具体的な行動で書く",
  "・良かった点・改善点はそれぞれ最大3件。ai_comment は100〜200文字",
  "",
  "【数字について】",
  "KGIの達成率や件数はシステムが計算済みの値として渡します。",
  "自分で数え直さず、渡された数字をそのまま根拠に使ってください。",
  "",
  "【評価する10項目】",
  ...CRITERIA.map((c, i) => `${i + 1}. ${c.label}`),
].join("\n");

function userPrompt({ today, metrics, recent }) {
  const rows = (v, cols) => Array.isArray(v) && v.length
    ? v.map((r) => "  ・" + cols.map(([k, l]) => (r[k] ? `${l}：${r[k]}` : "")).filter(Boolean).join(" / ")).join("\n")
    : "（記載なし）";

  const m = metrics;
  const calc = [
    m.kgiTarget != null ? `目標 ${m.kgiTarget}` : "",
    m.kgiActual != null ? `実績 ${m.kgiActual}` : "",
    m.kgiRate != null ? `達成率 ${m.kgiRate}%` : "",
    m.kgiAchieved === true ? "達成" : m.kgiAchieved === false ? "未達" : "",
  ].filter(Boolean).join(" / ") || "（数値なし）";

  return [
    "以下は本日の日報です。",
    "",
    "【システムが計算した数字】",
    `KGI：${calc}`,
    `やったこと ${m.workCount} 件（うち結果まで書かれているもの ${m.resultCount} 件）`,
    m.noIssues ? "困りごと：特になし（本人が選択）"
               : `困りごと ${m.issueCount} 件（相談相手を書いたもの ${m.consultedCount} 件 / 次の行動を書いたもの ${m.nextActionCount} 件）`,
    `明日の最優先：${m.tomorrowConcrete ? "期限または完了条件あり" : "期限・完了条件の記載なし"}`,
    "",
    "【日報の本文】",
    `① 今日のKGI：${today.goal_today || "（記載なし）"}`,
    "",
    "② 今日やったこと・成果：",
    rows(today.work_items, [["task", "やったこと"], ["result", "結果・成果"]]),
    "",
    "③ 困ったこと・報告相談：",
    today.no_issues ? "（特になし）"
      : rows(today.issues, [["issue", "問題"], ["action_taken", "自分でやったこと"],
                            ["consulted", "相談相手"], ["next_action", "次の行動"]]),
    "",
    `④ 今日の改善・学び：${[(today.improve_tags || []).join("・"), today.challenge].filter(Boolean).join(" / ") || "（記載なし）"}`,
    "",
    `⑤ 顧客・チームのためにしたこと：${today.contribution || "（記載なし）"}`,
    "",
    `⑥ 明日の最優先：${[today.tomorrow_plan, today.tomorrow_deadline, today.tomorrow_target].filter(Boolean).join(" / ") || "（記載なし）"}`,
    "",
    recent?.length
      ? "【昨日の日報（前後関係の参考。評価の対象は本日ぶんだけ）】\n" +
        `やったこと ${(recent[0].work_items || []).length} 件 / ` +
        `明日の最優先：${recent[0].tomorrow_plan || "（記載なし）"}`
      : "",
  ].filter((l) => l !== null).join("\n");
}

// -----------------------------------------------------------------------------
// 3) 返してもらう形（Structured Outputs / tool_use で共通）
// -----------------------------------------------------------------------------
const scoreItem = {
  type: "object",
  additionalProperties: false,
  required: ["score", "status", "reason"],
  properties: {
    score: { type: ["integer", "null"], description: "0〜10。材料が無ければ null" },
    status: { type: "string", enum: ["evaluated", "not_enough_data"] },
    reason: { type: "string", description: "日報のどの記述を根拠にしたか。1文" },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "good_points", "improvement_points", "ai_comment", "tomorrow_advice"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: KEYS,
      properties: Object.fromEntries(KEYS.map((k) => [k, scoreItem])),
    },
    good_points: { type: "array", maxItems: 3, items: { type: "string" } },
    improvement_points: { type: "array", maxItems: 3, items: { type: "string" } },
    ai_comment: { type: "string", description: "100〜200文字" },
    tomorrow_advice: { type: "string", description: "明日の具体的な行動。1つ" },
  },
};

// -----------------------------------------------------------------------------
// 4) 呼び出し。失敗したら少し待って作り直す
// -----------------------------------------------------------------------------
const WAITS = [2000, 5000];   // 1回目→2秒→2回目→5秒→3回目

/**
 * @returns {Promise<{ok:boolean, model?:string, result?:object, raw?:object, attempts:number, detail?:string}>}
 */
export async function evaluateNippo({ today, recent = [] }) {
  const metrics = systemMetrics(today);
  const prompt = userPrompt({ today, metrics, recent });

  let attempts = 0;
  let last = "";
  for (let i = 0; i <= WAITS.length; i++) {
    attempts++;
    try {
      const { model, result, raw } = process.env.OPENAI_API_KEY
        ? await callOpenAI(prompt)
        : await callClaude(prompt);
      return { ok: true, model, result: finalize(result), raw, metrics, attempts };
    } catch (e) {
      last = String(e?.message || e);
      console.error(`[nippo-eval] ${attempts}回目に失敗:`, last);
      if (i < WAITS.length) await new Promise((r) => setTimeout(r, WAITS[i]));
    }
  }
  return { ok: false, attempts, detail: last, metrics };
}

async function callOpenAI(prompt) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "nippo_evaluation",
          strict: true,
          schema: SCHEMA,
        },
      },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`openai_failed: ${data.error?.message || `HTTP ${r.status}`}`);

  // output_text があればそれを、無ければ output を掘る
  const text = data.output_text
    || (data.output || []).flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text;
  if (!text) throw new Error("openai_empty_output");

  return { model: OPENAI_MODEL, result: JSON.parse(text), raw: data };
}

async function callClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY も ANTHROPIC_API_KEY も設定されていません");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2500,
    system: SYSTEM,
    tools: [{ name: "evaluate_nippo", description: "日報の評価結果を返す", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "evaluate_nippo" },
    messages: [{ role: "user", content: prompt }],
  });
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "evaluate_nippo");
  if (!tu) throw new Error("claude_no_tool_use");
  return { model: CLAUDE_MODEL, result: tu.input, raw: message };
}

/**
 * 合計点を出す。材料不足の項目は分母から外して100点満点に按分する。
 * 外さずに0点で足すと、書くことが少なかった日というだけで点が落ちる。
 */
function finalize(result) {
  const scores = result.scores || {};
  const rated = KEYS
    .map((k) => scores[k])
    .filter((s) => s && s.status === "evaluated" && Number.isFinite(s.score));

  const total = rated.length
    ? Math.round((rated.reduce((a, s) => a + s.score, 0) / (rated.length * 10)) * 100)
    : null;

  return {
    ...result,
    total_score: total,
    rated_count: rated.length,
    good_points: (result.good_points || []).slice(0, 3),
    improvement_points: (result.improvement_points || []).slice(0, 3),
  };
}
