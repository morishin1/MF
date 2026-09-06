// 試用期間の判定。
//
// ■ 何を自動化して、何を自動化しないか
//   自動化する   … 材料集め（日報・KGI・週次評価の集計）と、基準の当てはめ
//   自動化しない … 本採用・延長・不採用の決定
//
//   決定を機械に寄せない理由は db/028_probation.sql の頭に書いた。
//   要点だけ言えば、数字が基準を割ったことは機械が正確に出せるが、
//   その理由（長期の外出、体調、担当業務の性質）は日報に書かれていない。
//
// ■ AIには点を付けさせない
//   点はもう週次で付いている。ここでAIに任せるのは
//   「その期間に何が起きたかの要約」と「面談で確認したほうがよい点」だけ。
//   AIに本採用の可否を言わせると、それが結論として一人歩きする。

import Anthropic from "@anthropic-ai/sdk";
import * as CLAUDE from "./claude.js";
import { CRITERIA } from "./nippo-eval.js";

export const PROMPT_VERSION = "probation_v1";

const OPENAI_MODEL = process.env.OPENAI_NIPPO_MODEL || "gpt-5.6-terra";
const CLAUDE_MODEL = CLAUDE.MODEL;
const KEYS = CRITERIA.map((c) => c.key);

export const isConfigured = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

export const DEFAULTS = {
  months: 3,
  checkpoints: ["1m", "3m"],
  thresholds: { submitRate: 90, kgiRate: 70, weeklyAvg: 70, consultRate: 50, resultRate: 80 },
};

export const CHECKPOINT_LABEL = { "1m": "1か月", "3m": "3か月", "6m": "6か月", final: "本採用判断" };

const CHECK_LABEL = {
  submitRate:  { label: "日報の提出率", unit: "%" },
  kgiRate:     { label: "KGIの達成率", unit: "%" },
  weeklyAvg:   { label: "週次評価の平均", unit: "点" },
  consultRate: { label: "困りごとを相談まで書けた割合", unit: "%" },
  resultRate:  { label: "やったことを結果まで書けた割合", unit: "%" },
};

/** 設定を読む。足りないキーは既定で埋める */
export function settingsOf(row) {
  const p = row?.probation || {};
  return {
    months: Number(p.months) || DEFAULTS.months,
    checkpoints: Array.isArray(p.checkpoints) && p.checkpoints.length
      ? p.checkpoints.filter((c) => CHECKPOINT_LABEL[c])
      : DEFAULTS.checkpoints,
    thresholds: { ...DEFAULTS.thresholds, ...(p.thresholds || {}) },
  };
}

const addMonths = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const monthsOf = (cp) => ({ "1m": 1, "3m": 3, "6m": 6 }[cp] ?? null);

/**
 * その人のチェックポイントを、入社日から組み立てる。
 * 台帳を別に持たないのは、入社日を直したときに食い違わせないため。
 */
export function checkpointsFor(employee, settings, today) {
  if (!employee.joined_on) return [];
  const list = [...settings.checkpoints];
  if (!list.includes("final")) list.push("final");

  return list.map((cp) => {
    const m = monthsOf(cp) ?? settings.months;
    const to = addMonths(employee.joined_on, m);
    return {
      checkpoint: cp,
      label: CHECKPOINT_LABEL[cp],
      periodFrom: employee.joined_on,
      periodTo: to,
      // その日を過ぎたら集計できる。過ぎるまでは「まだ先」
      due: to,
      reached: to <= today,
      daysLeft: Math.ceil((new Date(`${to}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000),
    };
  });
}

/** 平日の数。土日は分母に入れない（祝日までは見ていない） */
export function workdaysBetween(from, to) {
  let n = 0;
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

// -----------------------------------------------------------------------------
// 集計と、基準の当てはめ
// -----------------------------------------------------------------------------
export function computeMetrics({ from, to, nippos, weeks, evals }) {
  const workdays = workdaysBetween(from, to);

  const withKgi = nippos.filter((n) => n.kgi_achieved === true || n.kgi_achieved === false);
  const kgiOk = withKgi.filter((n) => n.kgi_achieved === true).length;

  const workItems = nippos.flatMap((n) => n.work_items || []);
  const issues = nippos.flatMap((n) => (n.no_issues ? [] : (n.issues || [])));

  const weekTotals = weeks
    .map((w) => w.eval_total ?? w.ai_total)
    .filter((v) => v != null);

  // 項目別の平均。管理者が確定した点を優先し、無ければAIの点
  const perKey = {};
  for (const k of KEYS) {
    const vals = weeks
      .map((w) => w.eval_scores?.[k] ?? pick(w.ai_scores?.[k]))
      .filter((v) => Number.isFinite(v));
    perKey[k] = vals.length
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
      : null;
  }

  // 週ごとの推移。伸びているか落ちているかを見る
  const trend = weeks
    .map((w) => ({ weekStart: w.week_start, total: w.eval_total ?? w.ai_total ?? null }))
    .filter((t) => t.total != null);
  const half = Math.floor(trend.length / 2);
  const firstHalf = trend.slice(0, half);
  const lastHalf = trend.slice(trend.length - half);
  const avg = (list) => (list.length ? list.reduce((a, t) => a + t.total, 0) / list.length : null);

  return {
    from, to, workdays,
    submitted: nippos.length,
    submitRate: workdays ? Math.round((nippos.length / workdays) * 100) : null,

    kgiTotal: withKgi.length,
    kgiAchieved: kgiOk,
    kgiRate: withKgi.length ? Math.round((kgiOk / withKgi.length) * 100) : null,

    workCount: workItems.length,
    resultCount: workItems.filter((w) => w.result).length,
    resultRate: workItems.length
      ? Math.round((workItems.filter((w) => w.result).length / workItems.length) * 100) : null,

    issueCount: issues.length,
    consultedCount: issues.filter((i) => i.consulted).length,
    consultRate: issues.length
      ? Math.round((issues.filter((i) => i.consulted).length / issues.length) * 100) : null,

    weeks: weeks.length,
    weeklyAvg: weekTotals.length
      ? Math.round((weekTotals.reduce((a, b) => a + b, 0) / weekTotals.length) * 10) / 10 : null,
    perKey,
    trend,
    // 後半が前半より上がっているか。伸びしろの目安として出す
    improving: firstHalf.length && lastHalf.length
      ? Math.round((avg(lastHalf) - avg(firstHalf)) * 10) / 10 : null,

    dailyEvals: evals.length,
    strugglingDays: nippos.filter((n) => n.mood === "苦戦").length,
  };
}

/**
 * 基準に当てはめる。ここは全部プログラム。AIは関与しない。
 * 材料が無い項目は「判定なし」にする。0扱いにすると、
 * 記録が少ない人ほど不利になる。
 */
export function applyChecks(metrics, thresholds) {
  const checks = {};
  for (const [key, th] of Object.entries(thresholds)) {
    const value = metrics[key];
    checks[key] = value == null
      ? { value: null, threshold: th, pass: null, label: CHECK_LABEL[key]?.label || key,
          unit: CHECK_LABEL[key]?.unit || "" }
      : { value, threshold: th, pass: value >= th, label: CHECK_LABEL[key]?.label || key,
          unit: CHECK_LABEL[key]?.unit || "" };
  }

  const judged = Object.values(checks).filter((c) => c.pass !== null);
  const failed = judged.filter((c) => !c.pass).length;

  // 判定がひとつも付かないときは verdict を出さない。
  // 「材料が無い」を「基準を満たしていない」にしないため
  const verdict = !judged.length ? null
    : failed === 0 ? "meets"
    : failed <= 1 ? "partial"
    : "below";

  return { checks, verdict, judged: judged.length, failed };
}

const pick = (s) => (s && s.status === "evaluated" && Number.isFinite(s.score) ? s.score : null);

// -----------------------------------------------------------------------------
// AIの所見。点は付けさせない
// -----------------------------------------------------------------------------
const SYSTEM = [
  "あなたは株式会社エイトの、試用期間の記録をまとめるAIです。",
  "",
  "★ あなたは本採用の可否を判断しません。それは人が決めます。",
  "  「本採用すべき」「見送るべき」といった結論を書かないでください。",
  "  あなたの役割は、面談する人が短時間で状況をつかめるように、",
  "  記録された事実を整理し、確認したほうがよい点を挙げることです。",
  "",
  "【守ること】",
  "・記録にないことを推測しない（性格・心理状態・やる気・家庭環境・意欲）",
  "・人物評価をしない。期間中に記録された行動事実と数字だけを扱う",
  "・数字に触れるときは、必ず渡された数字をそのまま使う",
  "・基準を下回った項目があっても、その理由を推測しない。",
  "  「なぜそうなったかを本人に確認する」形の質問として questions に入れる",
  "・strengths / concerns はそれぞれ最大3件。questions は最大3件",
  "・summary は200〜300文字",
  "・「頑張っている」「意欲が高い」のような、記録から確かめられない表現を使わない",
].join("\n");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "strengths", "concerns", "questions"],
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", maxItems: 3, items: { type: "string" } },
    concerns: { type: "array", maxItems: 3, items: { type: "string" } },
    questions: {
      type: "array", maxItems: 3, items: { type: "string" },
      description: "面談で本人に確認するとよいこと。理由を決めつけず、聞く形にする",
    },
  },
};

export async function summarizeProbation({ employee, checkpoint, metrics, checks, weeks }) {
  const label = (k) => CRITERIA.find((c) => c.key === k)?.short || k;
  const m = metrics;

  const checkLines = Object.entries(checks).map(([, c]) =>
    c.pass === null
      ? `${c.label}：判定なし（材料不足）`
      : `${c.label}：${c.value}${c.unit}（基準 ${c.threshold}${c.unit}）${c.pass ? "満たす" : "下回る"}`
  ).join("\n");

  const prompt = [
    `【対象】${employee.display_name}さん（${employee.employment_type || "—"}／入社 ${employee.joined_on}）`,
    `【区切り】${CHECKPOINT_LABEL[checkpoint]}（${m.from} 〜 ${m.to}）`,
    "",
    "【基準への当てはめ（システムが計算）】",
    checkLines,
    "",
    "【期間中の記録】",
    `日報の提出：${m.submitted} / ${m.workdays} 日`,
    m.kgiRate != null ? `KGI達成：${m.kgiAchieved} / ${m.kgiTotal} 日（${m.kgiRate}%）` : "KGI：数値の記録なし",
    `やったこと ${m.workCount} 件（結果まで書かれたもの ${m.resultCount} 件）`,
    `困りごと ${m.issueCount} 件（相談相手を書いたもの ${m.consultedCount} 件）`,
    `調子が「苦戦」だった日：${m.strugglingDays} 日`,
    m.weeklyAvg != null ? `週次評価の平均：${m.weeklyAvg} 点 / 100（${m.weeks} 週）` : "週次評価：まだなし",
    m.improving != null
      ? `週次評価の推移：期間の後半は前半より ${m.improving > 0 ? "+" : ""}${m.improving} 点`
      : "",
    "",
    "【項目別の平均点（10点満点）】",
    CRITERIA.map((c) => `${c.short}：${m.perKey[c.key] ?? "—"}`).join(" / "),
    "",
    "【各週の総評】",
    weeks.map((w) => [
      `■ ${w.week_start} の週：${w.eval_total ?? w.ai_total ?? "—"} 点`,
      w.eval_comment ? `  （管理者）${w.eval_comment}` : (w.ai_summary ? `  ${w.ai_summary}` : ""),
    ].filter(Boolean).join("\n")).join("\n") || "（週次評価なし）",
  ].filter(Boolean).join("\n");

  try {
    return { ok: true, ...(await call(SYSTEM, prompt, SCHEMA, "summarize_probation")) };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

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
    return { model: OPENAI_MODEL, result: JSON.parse(text) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY も ANTHROPIC_API_KEY も設定されていません");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE.MAX_TOKENS.normal,
    system,
    tools: [{ name: toolName, description: "試用期間の記録をまとめて返す", input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: prompt }],
  });
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
  if (!tu) throw new Error("claude_no_tool_use");
  return { model: CLAUDE_MODEL, result: tu.input };
}
