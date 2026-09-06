// 週次・月次のまとめ。
//
// ■ 考え方は日次と同じ
//   数字で出せるものはプログラムが計算し、AIには「計算済みの値」として渡す。
//   AIに任せるのは、1週間ぶんの日報を読まないと分からないことだけ。
//
// ■ 毎回1週間ぶんの本文を全部送らない
//   日次の評価（gw_nippo_ai_evals）が既に各日の要点を持っているので、
//   週次ではそれを束ねて渡す。本文は KGI と成果だけに絞る。
//   1週間ぶんの全文を毎回送ると、そのぶん高くつくわりに精度は上がらない。

import Anthropic from "@anthropic-ai/sdk";
import * as CLAUDE from "./claude.js";
import { ACTIONS as CRITERIA, ACTION_KEYS, score, promptRubric, CATEGORIES } from "./scoring.js";

// v2 = 10項目の単純合計をやめ、成果40/行動30/成長20/チーム10 の重み付けにした
export const WEEKLY_PROMPT_VERSION = "weekly_eval_v2";
export const MONTHLY_PROMPT_VERSION = "monthly_summary_v2";

const OPENAI_MODEL = process.env.OPENAI_NIPPO_MODEL || "gpt-5.6-terra";
const CLAUDE_MODEL = CLAUDE.MODEL;
const KEYS = ACTION_KEYS;

export const isConfigured = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

/** 月曜から数えた平日の日付。土日は分母に入れない */
export function weekdaysOf(weekStart) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** その月の1日（YYYY-MM-01） */
export const monthStart = (s) => `${String(s).slice(0, 7)}-01`;

// -----------------------------------------------------------------------------
// 週次：プログラムで出す数字
// -----------------------------------------------------------------------------
export function weeklyMetrics({ weekStart, nippos, evals }) {
  const days = weekdaysOf(weekStart);
  const submittedDays = new Set(nippos.map((n) => n.work_date));

  const withKgi = nippos.filter((n) => n.kgi_achieved !== null && n.kgi_achieved !== undefined);
  const achieved = withKgi.filter((n) => n.kgi_achieved === true).length;

  const workCount = nippos.reduce((a, n) => a + (n.work_items || []).length, 0);
  const resultCount = nippos.reduce(
    (a, n) => a + (n.work_items || []).filter((w) => w.result).length, 0);
  const issueCount = nippos.reduce((a, n) => a + (n.no_issues ? 0 : (n.issues || []).length), 0);
  const consulted = nippos.reduce(
    (a, n) => a + (n.issues || []).filter((i) => i.consulted).length, 0);

  // 日次のAI点の平均。項目ごとに、評価できた日だけで平均する
  const perKey = {};
  for (const k of KEYS) {
    const vals = evals
      .map((e) => e.scores?.[k])
      .filter((s) => s && s.status === "evaluated" && Number.isFinite(s.score))
      .map((s) => s.score);
    perKey[k] = vals.length
      ? { avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10, days: vals.length }
      : { avg: null, days: 0 };
  }

  return {
    weekStart,
    submitted: submittedDays.size,
    workdays: days.length,
    submitRate: Math.round((submittedDays.size / days.length) * 100),
    missingDays: days.filter((d) => !submittedDays.has(d)),
    kgiTotal: withKgi.length,
    kgiAchieved: achieved,
    kgiRate: withKgi.length ? Math.round((achieved / withKgi.length) * 100) : null,
    workCount,
    resultCount,
    issueCount,
    consultedCount: consulted,
    dailyAvg: perKey,
    // 日次AI点の平均を、週の総合点と同じ重み付けで100点に換算する。
    // ここだけ単純平均だと、日次と週次で数字の意味がずれる
    dailyAvgTotal: score(
      Object.fromEntries(Object.entries(perKey).map(([k, v]) => [k, v.avg])),
    ).total,
  };
}

// -----------------------------------------------------------------------------
// 週次：AIに渡す形
// -----------------------------------------------------------------------------
const WEEKLY_SYSTEM = [
  "あなたは株式会社エイトの週次評価AIです。",
  "",
  "1週間ぶんの日報と、システムが計算した数字を読み、",
  "社内行動指針の10か条を各0〜10点で評価してください。",
  "総合点はシステムが計算します。あなたは10か条の点と理由だけを返してください。",
  "",
  "【守ること】",
  "・日報に書かれていないことを推測しない（性格・心理状態・やる気・意図）",
  "・人物評価をしない。その週に記録された具体的な行動事実だけを見る",
  "・点数には必ず、どの日のどの記述を根拠にしたかが分かる理由を付ける",
  "・材料が無い項目は 0点にせず status を not_enough_data にする",
  "・日次のAI点の平均は参考値。1週間を通して見たときの評価を自分で決めてよい",
  "・強み・改善項目はそれぞれ最大3件。次週の重点行動は最大2件で、具体的な行動で書く",
  "・summary は150〜250文字",
  "・提出率が低い週は、その事実に触れる（ただし理由は推測しない）",
  "",
  promptRubric(),
].join("\n");

const scoreItem = {
  type: "object",
  additionalProperties: false,
  required: ["score", "status", "reason"],
  properties: {
    score: { type: ["integer", "null"] },
    status: { type: "string", enum: ["evaluated", "not_enough_data"] },
    reason: { type: "string" },
  },
};

const WEEKLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "strengths", "improvements", "focus", "summary"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: KEYS,
      properties: Object.fromEntries(KEYS.map((k) => [k, scoreItem])),
    },
    strengths: { type: "array", maxItems: 3, items: { type: "string" } },
    improvements: { type: "array", maxItems: 3, items: { type: "string" } },
    focus: { type: "array", maxItems: 2, items: { type: "string" } },
    summary: { type: "string" },
  },
};

function weeklyPrompt({ metrics, nippos, evals, review }) {
  const m = metrics;
  const byDate = new Map(evals.map((e) => [e.work_date, e]));

  const days = nippos.map((n) => {
    const e = byDate.get(n.work_date);
    const items = (n.work_items || []);
    return [
      `■ ${n.work_date}（調子:${n.mood || "—"}）`,
      `  KGI：${n.goal_today || "（記載なし）"}` +
        (n.kgi_target != null ? ` 目標${n.kgi_target}` : "") +
        (n.kgi_actual != null ? ` 実績${n.kgi_actual}` : "") +
        (n.kgi_achieved === true ? " 達成" : n.kgi_achieved === false ? " 未達" : ""),
      items.length
        ? `  成果：${items.map((w) => `${w.task}→${w.result}`).join(" / ")}`
        : "  成果：（記載なし）",
      n.no_issues
        ? "  困りごと：特になし"
        : (n.issues || []).length
          ? `  困りごと：${(n.issues || []).map((i) =>
              `${i.issue}（自分で:${i.action_taken || "—"} / 相談:${i.consulted || "なし"} / 次:${i.next_action || "—"}）`).join(" / ")}`
          : "  困りごと：（記載なし）",
      n.contribution ? `  顧客・チーム：${n.contribution}` : "",
      e?.ai_comment ? `  （その日のAI所見）${e.ai_comment}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");

  const avg = CRITERIA
    .map((c) => `${c.short}:${m.dailyAvg[c.key].avg ?? "—"}（${m.dailyAvg[c.key].days}日ぶん）`)
    .join(" / ");

  return [
    `【対象週】${m.weekStart} からの1週間`,
    "",
    "【システムが計算した数字】",
    `日報の提出：${m.submitted} / ${m.workdays} 日（${m.submitRate}%）` +
      (m.missingDays.length ? ` 未提出：${m.missingDays.join("、")}` : ""),
    m.kgiRate != null ? `KGI達成：${m.kgiAchieved} / ${m.kgiTotal} 日（${m.kgiRate}%）` : "KGI：数値の記録なし",
    `やったこと ${m.workCount} 件（結果まで書かれたもの ${m.resultCount} 件）`,
    `困りごと ${m.issueCount} 件（相談相手を書いたもの ${m.consultedCount} 件）`,
    `日次AI点の平均（参考）：${avg}`,
    "",
    "【本人の振り返り】",
    review?.q1 ? `最もKGIに貢献した行動：${review.q1}` : "（未記入）",
    review?.q2 ? `数字が伸びた／伸びなかった理由：${review.q2}` : "",
    review?.q3 ? `来週やめる・続ける・新しく試すこと：${review.q3}` : "",
    review?.q4 ? `来週のKGI・KPI：${review.q4}` : "",
    "",
    "【その週の日報】",
    days || "（提出なし）",
  ].filter(Boolean).join("\n");
}

/** @returns {Promise<{ok, model?, result?, raw?, detail?}>} */
export async function evaluateWeek({ metrics, nippos, evals, review }) {
  const prompt = weeklyPrompt({ metrics, nippos, evals, review });
  try {
    const r = await call(WEEKLY_SYSTEM, prompt, WEEKLY_SCHEMA, "evaluate_week");
    return { ok: true, ...r, result: withTotal(r.result) };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/** 成果40/行動30/成長20/チーム10 で100点に換算する。材料不足の項目は分母から外す */
function withTotal(result) {
  const s = score(result.scores || {});
  return {
    ...result,
    total: s.total,
    categories: s.categories,
    ratedCount: s.ratedActions,
  };
}

// -----------------------------------------------------------------------------
// 月次
// -----------------------------------------------------------------------------
export function monthlyMetrics({ month, weeks, prevWeeks, nippos, workdays }) {
  const scored = weeks.filter((w) => (w.eval_total ?? w.ai_total) != null);
  const avg = (list) => {
    const v = list.map((w) => w.eval_total ?? w.ai_total).filter((x) => x != null);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };

  // 項目別の平均。管理者が直した点があればそちらを使う
  const perKey = {};
  for (const k of KEYS) {
    const vals = weeks
      .map((w) => (w.eval_scores?.[k] ?? pick(w.ai_scores?.[k])))
      .filter((v) => Number.isFinite(v));
    perKey[k] = vals.length
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
      : null;
  }

  const withKgi = nippos.filter((n) => n.kgi_achieved === true || n.kgi_achieved === false);
  const thisAvg = avg(weeks);
  const prevAvg = avg(prevWeeks);

  const ranked = Object.entries(perKey)
    .filter(([, v]) => v !== null)
    .sort((a, b) => b[1] - a[1]);

  return {
    month,
    weeks: weeks.length,
    scoredWeeks: scored.length,
    avgScore: thisAvg,
    prevAvgScore: prevAvg,
    diff: thisAvg != null && prevAvg != null ? Math.round((thisAvg - prevAvg) * 10) / 10 : null,
    submitted: nippos.length,
    workdays,
    submitRate: workdays ? Math.round((nippos.length / workdays) * 100) : null,
    kgiTotal: withKgi.length,
    kgiAchieved: withKgi.filter((n) => n.kgi_achieved === true).length,
    kgiRate: withKgi.length
      ? Math.round((withKgi.filter((n) => n.kgi_achieved === true).length / withKgi.length) * 100)
      : null,
    perKey,
    // 4区分の内訳。管理者が「どこで点が付いているか」を見るため
    categories: score(perKey).categories,
    topKeys: ranked.slice(0, 3).map(([k, v]) => ({ key: k, score: v })),
    lowKeys: ranked.slice(-3).reverse().map(([k, v]) => ({ key: k, score: v })),
  };
}

const pick = (s) => (s && s.status === "evaluated" && Number.isFinite(s.score) ? s.score : null);

const MONTHLY_SYSTEM = [
  "あなたは株式会社エイトの月次サマリーAIです。",
  "",
  "1か月ぶんの週次評価とその数字を読み、本人の成長を確認する文章を書きます。",
  "",
  "【守ること】",
  "・人物評価をしない。記録された行動事実と数字だけを扱う",
  "・強み・改善項目はそれぞれ3件まで。どの数字・どの記録から言えるかを添える",
  "・summary は200〜300文字",
  "・前月と比べて上がった／下がったを書くときは、必ず数字を添える",
  "・「頑張りましょう」のような具体性のない言葉を書かない",
  "・改善項目は、次の月に何をするかが分かる書き方にする",
  "",
  "【learned（今月できるようになったこと）】",
  "この仕組みで一番残したいのは「昨日より今日、何ができるようになったか」です。",
  "・先月までは一人でできなかったが、今月は一人でできるようになった行動を書く",
  "・「〜できるようになった」で終わる一文にする",
  "  例：「問い合わせフォーム営業を一人で実施できるようになった」",
  "  例：「返信データを分析して営業対象を改善できるようになった」",
  "・記録から読み取れないときは、無理に書かず空の配列を返す",
  "・成長した「気がする」ではなく、日報のどの記録から言えるかを確かめてから書く",
  "・単に量が増えただけのものは書かない（できることが増えていない）",
].join("\n");

const MONTHLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "strengths", "improvements", "learned"],
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", maxItems: 3, items: { type: "string" } },
    improvements: { type: "array", maxItems: 3, items: { type: "string" } },
    // 「今月できるようになったこと」。この仕組みで一番残したいもの
    learned: {
      type: "array", maxItems: 3, items: { type: "string" },
      description: "先月まで一人でできなかったが、今月できるようになったこと",
    },
  },
};

export async function summarizeMonth({ metrics, weeks, prevMonth }) {
  const m = metrics;
  const label = (k) => CRITERIA.find((c) => c.key === k)?.short || k;

  const prompt = [
    `【対象月】${m.month}`,
    "",
    "【システムが計算した数字】",
    `週次評価の平均：${m.avgScore ?? "—"} 点 / 100（${m.scoredWeeks} 週ぶん）`,
    m.prevAvgScore != null
      ? `前月の平均：${m.prevAvgScore} 点（差 ${m.diff > 0 ? "+" : ""}${m.diff}）`
      : "前月の記録なし",
    `日報の提出：${m.submitted} / ${m.workdays} 日（${m.submitRate ?? "—"}%）`,
    m.kgiRate != null ? `KGI達成：${m.kgiAchieved} / ${m.kgiTotal} 日（${m.kgiRate}%）` : "KGI：数値の記録なし",
    "",
    "【区分別（100点の内訳）】",
    (m.categories || []).map((c) =>
      `${c.label} ${c.points ?? "—"} / ${c.weight}点`).join(" / "),
    "",
    "【10か条の平均点（10点満点。なぜその評価かを見るための内訳）】",
    CRITERIA.map((c) => `${c.short}：${m.perKey[c.key] ?? "—"}`).join(" / "),
    "",
    "【各週の記録】",
    weeks.map((w) => [
      `■ ${w.week_start} の週：${w.eval_total ?? w.ai_total ?? "—"} 点`,
      w.ai_summary ? `  ${w.ai_summary}` : "",
      w.eval_comment ? `  （管理者）${w.eval_comment}` : "",
    ].filter(Boolean).join("\n")).join("\n") || "（週次評価なし）",
    "",
    `参考：この月に高かった項目 ${m.topKeys.map((t) => `${label(t.key)}(${t.score})`).join("、") || "—"}`,
    `参考：この月に低かった項目 ${m.lowKeys.map((t) => `${label(t.key)}(${t.score})`).join("、") || "—"}`,
    "",
    // 「先月までできなかった」を判断するには、先月の記録が要る。
    // これが無いと learned は毎月同じことを書きがちになる
    prevMonth?.learned?.length
      ? "【先月できるようになったこと（これと同じことは書かない）】\n" +
        prevMonth.learned.map((l) => `・${l}`).join("\n")
      : "【先月の記録】なし（この月がはじめての記録です）",
  ].join("\n");

  try {
    const r = await call(MONTHLY_SYSTEM, prompt, MONTHLY_SCHEMA, "summarize_month");
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

// -----------------------------------------------------------------------------
// モデル呼び出し。日次と同じ考え方で、OpenAI が無ければ Claude に切り替える
// -----------------------------------------------------------------------------
async function call(system, prompt, schema, toolName) {
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
        text: { format: { type: "json_schema", name: toolName, strict: true, schema } },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`openai_failed: ${data.error?.message || `HTTP ${r.status}`}`);
    const text = data.output_text
      || (data.output || []).flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text;
    if (!text) throw new Error("openai_empty_output");
    return { model: OPENAI_MODEL, result: JSON.parse(text), raw: data };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY も ANTHROPIC_API_KEY も設定されていません");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE.MAX_TOKENS.normal,
    system,
    tools: [{ name: toolName, description: "評価結果を返す", input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: prompt }],
  });
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
  if (!tu) throw new Error("claude_no_tool_use");
  return { model: CLAUDE_MODEL, result: tu.input, raw: message };
}
