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
import * as CLAUDE from "./claude.js";
import { ACTIONS, ACTION_KEYS, score, promptRubric } from "./scoring.js";
import { coachingRule } from "./autonomy.js";

// 評価基準を変えたら上げる。過去の評価がどの基準で出たか分かるようにするため。
// v2 = 10項目の単純合計をやめ、成果40/行動30/成長20/チーム10 の重み付けにした
// v3 = 朝に描いた状態との差を、いちばん先に見るようにした
export const PROMPT_VERSION = "daily_eval_v3";

const OPENAI_MODEL = process.env.OPENAI_NIPPO_MODEL || "gpt-5.6-terra";
const CLAUDE_MODEL = CLAUDE.MODEL;

// 10か条の定義は lib/scoring.js が持つ。ここでは名前だけ変えて使う
export const CRITERIA = ACTIONS;
const KEYS = ACTION_KEYS;

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
const systemPrompt = (level) => [
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
  "",
  "【朝に描いた状態との差を、いちばん先に見る】",
  "この日報は、朝に「今日の終わりに“今日は良かった”と言える状態」を",
  "先に描いてから、終業時に結果を書く形になっています。",
  "・描いた状態と実際の差が、いちばん大事な材料です。ここから読んでください",
  "・差があったときは、何が足りなかったかではなく、",
  "  どこで想定と違ったかを書く（見積もりか、進め方か、途中で入った別の仕事か）",
  "・描いた状態に届いていても、そのまま流さない。",
  "  届いたのは、描き方が実態に合っていたからか、それとも低く見積もったからか",
  "・朝に描いていない日は、そのことに一度だけ触れる。責める書き方はしない",
  "・明日のアドバイスは「明日変えること」に本人が書いたことと矛盾させない。",
  "  同じことなら、より具体的にして返す",
  "・良かった点・改善点はそれぞれ最大3件。ai_comment は100〜200文字",
  "",
  "【blocker_candidates（止まっている仕事）】",
  "困りごとのうち、本人だけでは外せないもの（他部署の返事待ち・判断待ち・",
  "権限が要るもの・条件が決まらないもの）だけを最大2件あげてください。",
  "本人が次の行動を書けているものは、まだ止まっていないので入れません。",
  "あくまで候補です。実際に上げるかどうかは本人が決めます。",
  "該当が無ければ空の配列を返してください。",
  "",
  "【数字について】",
  "KGIの達成率や件数はシステムが計算済みの値として渡します。",
  "自分で数え直さず、渡された数字をそのまま根拠に使ってください。",
  "総合点もシステムが計算します。あなたは10か条の点と理由だけを返してください。",
  "",
  promptRubric(),
  "",
  // 同じ日報でも、返し方は相手の自走レベルで変える。
  // L3の人に手順を出すと、いつまでも自分で考えなくなる。
  // L1の人に「どこに原因があると思いますか」と聞いても、答える材料がない
  coachingRule(level),
  "",
  "【点数について】",
  "自走レベルは点数には影響させません。レベルで採点を甘くも辛くもしないでください。",
  "変わるのは tomorrow_advice と ai_comment の書き方だけです。",
].filter(Boolean).join("\n");

function userPrompt({ today, metrics, recent, blockers = [] }) {
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
    // 朝に描いた状態を先に置く。AIにここから読ませたいので、本文の一番上にする
    today.morning_at
      ? [
          "【朝に描いた状態（結果を見る前に、本人が書いたもの）】",
          today.goal_image ? `3か月後どうなっていたいか：${today.goal_image}` : "",
          `今日の終わりに「今日は良かった」と言える状態：${today.success_image || "（記載なし）"}`,
          `本人の自己評価：${MET_LABEL[today.success_met] || "（未選択）"}`,
        ].filter(Boolean).join("\n")
      : "【朝に描いた状態】この日は朝の入力がありません（終業時のみ）",
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
    `⑥ 明日変えること（やり方をどう変えるか）：${today.tomorrow_change || "（記載なし）"}`,
    "",
    `⑦ 明日の最優先（何をやるか）：${[today.tomorrow_plan, today.tomorrow_deadline, today.tomorrow_target].filter(Boolean).join(" / ") || "（記載なし）"}`,
    "",
    recent?.length
      ? "【昨日の日報（前後関係の参考。評価の対象は本日ぶんだけ）】\n" +
        `やったこと ${(recent[0].work_items || []).length} 件 / ` +
        `明日の最優先：${recent[0].tomorrow_plan || "（記載なし）"}`
      : "",
    "",
    // 止まったままの仕事があるなら、明日の1件はそこから出したほうがよい。
    // 何日も止まっているものを置いたまま別のことを勧めても前に進まない
    blockers.length
      ? "【いま止まっている仕事（何日も外れていないもの）】\n" +
        blockers.map((b) =>
          `・${b.title}（${b.days}日目${b.escalation_level > 0 ? "・相談済み" : "・まだ本人が抱えている"}）`).join("\n") +
        "\n止まったままのものがあるときは、明日のアドバイスをそこから出してください。"
      : "",
  ].filter((l) => l !== null).join("\n");
}

// -----------------------------------------------------------------------------
// 3) 返してもらう形（Structured Outputs / tool_use で共通）
// -----------------------------------------------------------------------------
const MET_LABEL = {
  o: "朝に描いた状態になれた",
  d: "途中まではなれた",
  x: "朝に描いた状態にはならなかった",
};

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
  required: ["scores", "good_points", "improvement_points", "ai_comment",
             "gap", "tomorrow_advice", "blocker_candidates"],
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
    // 朝に描いた状態と、実際の差。この仕組みの中心なので独立した項目にする
    gap: {
      type: "string",
      description: "朝に描いた状態と実際の差。1〜2文。"
        + "朝の入力が無い日は空文字にする。届いていた場合も、なぜ届いたかを書く",
    },
    tomorrow_advice: { type: "string", description: "明日の具体的な行動。1つ" },
    // 止まりそうな困りごと。ここでは候補を出すだけで、Blockerは作らない。
    // 上げるかどうかは本人が押す
    blocker_candidates: {
      type: "array", maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why"],
        properties: {
          title: { type: "string", description: "止まっている内容。日報の言葉のまま" },
          why: { type: "string", description: "自力では外せないと判断した理由。1文" },
        },
      },
    },
  },
};

// -----------------------------------------------------------------------------
// 4) 呼び出し。失敗したら少し待って作り直す
// -----------------------------------------------------------------------------
const WAITS = [2000, 5000];   // 1回目→2秒→2回目→5秒→3回目

/**
 * @returns {Promise<{ok:boolean, model?:string, result?:object, raw?:object, attempts:number, detail?:string}>}
 */
export async function evaluateNippo({ today, recent = [], level = 1, blockers = [] }) {
  const metrics = systemMetrics(today);
  const prompt = userPrompt({ today, metrics, recent, blockers });
  const system = systemPrompt(level);

  let attempts = 0;
  let last = "";
  for (let i = 0; i <= WAITS.length; i++) {
    attempts++;
    try {
      const { model, result, raw } = process.env.OPENAI_API_KEY
        ? await callOpenAI(prompt, system)
        : await callClaude(prompt, system);
      return { ok: true, model, result: finalize(result), raw, metrics, attempts };
    } catch (e) {
      last = String(e?.message || e);
      console.error(`[nippo-eval] ${attempts}回目に失敗:`, last);
      if (i < WAITS.length) await new Promise((r) => setTimeout(r, WAITS[i]));
    }
  }
  return { ok: false, attempts, detail: last, metrics };
}

async function callOpenAI(prompt, system) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: system },
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

async function callClaude(prompt, system) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY も ANTHROPIC_API_KEY も設定されていません");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE.MAX_TOKENS.normal,
    system,
    tools: [{ name: "evaluate_nippo", description: "日報の評価結果を返す", input_schema: SCHEMA }],
    tool_choice: { type: "tool", name: "evaluate_nippo" },
    messages: [{ role: "user", content: prompt }],
  });
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "evaluate_nippo");
  if (!tu) throw new Error("claude_no_tool_use");
  return { model: CLAUDE_MODEL, result: tu.input, raw: message };
}

/**
 * 総合点を出す。10か条の単純平均ではなく、
 * 成果40 / 行動30 / 成長20 / チーム10 の重み付け（lib/scoring.js）で出す。
 * 材料不足の項目は分母から外す。0点で足すと、
 * 書くことが少なかった日というだけで点が落ちるため。
 */
function finalize(result) {
  const s = score(result.scores || {});

  return {
    ...result,
    total_score: s.total,
    categories: s.categories,
    rated_count: s.ratedActions,
    gap: String(result.gap || "").trim() || null,
    good_points: (result.good_points || []).slice(0, 3),
    improvement_points: (result.improvement_points || []).slice(0, 3),
    blocker_candidates: (result.blocker_candidates || []).slice(0, 2),
  };
}
