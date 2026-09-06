// 3か月育成計画のドラフトと、翌月のKGI/KPIのドラフト。
//
// ■ AIが作るのはドラフトまで（§6 §32 §41）
//   自動確定しない。管理者と本人が確認して確定する。
//   計画は「これから3か月、この人に何を任せるか」を決めるもので、
//   AIが決めてよい類のものではない。
//
// ■ AIに渡すもの・渡さないもの
//   渡す … 職務・業務範囲・育成期間・週の所定労働時間・研修・現在の自走レベル
//   渡さない … 賃金・手当・社会保険
//   賃金を渡すと「この賃金ならこの水準まで」といった案が出る。
//   育成目標は労働条件から切り離す（§2-1）。
//
// ■ 数字は「届きそうで、少し足りない」に置く
//   初月から未達が続くと、KPIそのものを見なくなる。
//   逆に全部達成する数字にすると、何も変わらない。

import Anthropic from "@anthropic-ai/sdk";
import * as CLAUDE from "./claude.js";
import { STAGES, KPI_KINDS } from "./growth.js";
import { LEVELS } from "./autonomy.js";

export const PROMPT_VERSION = "growth_plan_v1";

const OPENAI_MODEL = process.env.OPENAI_NIPPO_MODEL || "gpt-5.6-terra";
const CLAUDE_MODEL = CLAUDE.MODEL;

export const isConfigured = () =>
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);

const KIND_KEYS = KPI_KINDS.map((k) => k.key);

// -----------------------------------------------------------------------------
// 3か月計画のドラフト
// -----------------------------------------------------------------------------
const PLAN_SYSTEM = [
  "あなたは株式会社エイトの育成計画づくりを手伝うAIです。",
  "労働条件通知書から読み取った職務・業務範囲をもとに、",
  "3か月の育成計画のドラフトを作ります。",
  "",
  "【これはドラフトです】",
  "確定するのは管理者と本人です。決めきった書き方をせず、",
  "「この線でどうか」という案として書いてください。",
  "",
  "【3か月KGIの書き方】",
  "・「○○ができるようになる」の形で1文にする",
  "・「頑張る」「意識する」ではなく、できたかどうかが分かる書き方にする",
  "・その人の業務範囲の中で書く。範囲外の仕事を目標にしない",
  "",
  "【3か月を3段階に分ける】",
  ...STAGES.map((s) => `MONTH ${s.monthNo}：${s.title}（想定レベル L${s.level}）`),
  "この3段階は変えないでください。各月のKGIを、その人の業務に合わせて書きます。",
  "",
  "【KPIの決め方】",
  "・1か月あたり4〜6個まで。7個以上あると、どれも追わなくなります",
  "・数字は「届きそうで、少し足りない」ところに置く",
  "  初月から未達が続くとKPIを見なくなり、全部達成する数字だと何も変わらない",
  "・週の所定労働時間から見て、明らかに終わらない量にしない",
  "・kind は次から選ぶ：",
  ...KPI_KINDS.map((k) => `  ${k.key}（${k.label}）… ${k.hint}`),
  "・日報から数えられないもの（上長レビュー点など）は from_daily を false にする",
  "・MONTH 1 には必ず「日報提出率」を入れる（記録が無いと何も判断できないため）",
  "",
  "【書いてはいけないこと】",
  "・賃金・手当・雇用形態・労働時間そのものを目標にしない",
  "・人格や性格についての記述（「積極性を持つ」など）",
  "・研修の受講そのものをKGIにしない。受講して何ができるようになるかを書く",
].join("\n");

const kpiItem = {
  type: "object",
  additionalProperties: false,
  required: ["name", "kind", "target_value", "unit", "from_daily", "why"],
  properties: {
    name: { type: "string", description: "KPIの名前。20文字以内" },
    kind: { type: "string", enum: KIND_KEYS },
    target_value: { type: ["number", "null"], description: "月の目標値" },
    unit: { type: "string", description: "件・回・本・% など" },
    from_daily: { type: "boolean", description: "日報から数えられるか" },
    why: { type: "string", description: "なぜこの数字にしたか。1文" },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["three_month_kgi", "months", "note"],
  properties: {
    three_month_kgi: { type: "string", description: "「○○ができるようになる」の形で1文" },
    months: {
      type: "array", minItems: 3, maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["month_no", "kgi", "target_level", "kpis"],
        properties: {
          month_no: { type: "integer" },
          kgi: { type: "string" },
          target_level: { type: "integer", description: "想定する自走レベル 1〜4" },
          kpis: { type: "array", minItems: 3, maxItems: 6, items: kpiItem },
        },
      },
    },
    note: { type: "string", description: "確認してほしい点。書類から読み取れなかったことがあれば書く" },
  },
};

/**
 * @param {object} p
 * @param {object} p.employee  { display_name, department, position, joined_on }
 * @param {object} p.contract  gw_contracts の行（賃金は渡さない）
 * @param {number} p.level     いまの自走レベル
 */
export async function draftPlan({ employee, contract, level = 1, startDate, endDate }) {
  const scope = Array.isArray(contract?.work_scope) ? contract.work_scope : [];
  const programs = Array.isArray(contract?.training_programs) ? contract.training_programs : [];

  const prompt = [
    "【対象者】",
    `氏名：${employee.display_name}`,
    employee.department ? `所属：${employee.department}` : "",
    employee.joined_on ? `入社日：${employee.joined_on}` : "",
    `いまの自走レベル：L${level}（${LEVELS.find((l) => l.level === level)?.label || ""}）`,
    "",
    "【労働条件通知書から読み取った内容】",
    contract?.job_content ? `職務：${contract.job_content}` : "職務：（記載なし）",
    scope.length ? `業務範囲：${scope.join("・")}` : "業務範囲：（記載なし）",
    contract?.scope_change ? `業務変更の範囲：${contract.scope_change}` : "",
    contract?.training_months ? `育成期間：${contract.training_months}か月` : "",
    contract?.weekly_hours ? `週の所定労働時間：${contract.weekly_hours}時間` : "",
    contract?.work_days ? `勤務日：${contract.work_days}` : "",
    programs.length ? `指定研修：${programs.join("・")}` : "",
    contract?.training_review_note ? `育成終了時に見ること：${contract.training_review_note}` : "",
    "",
    `【計画の期間】${startDate} 〜 ${endDate}`,
    "",
    "この内容で、3か月の育成計画のドラフトを作ってください。",
    scope.length
      ? ""
      : "※ 業務範囲が読み取れていません。一般的な内容で作り、note にその旨を書いてください。",
  ].filter(Boolean).join("\n");

  try {
    const r = await call(PLAN_SYSTEM, prompt, PLAN_SCHEMA, "draft_growth_plan");
    return { ok: true, ...r, result: normalizePlan(r.result) };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/** 3か月ぶんに揃える。AIが月を飛ばしたり重複させたときに直す */
function normalizePlan(v) {
  const byNo = new Map((v.months || []).map((m) => [Number(m.month_no), m]));
  const months = STAGES.map((s) => {
    const m = byNo.get(s.monthNo) || {};
    return {
      month_no: s.monthNo,
      kgi: String(m.kgi || s.kgi).slice(0, 500),
      target_level: [1, 2, 3, 4].includes(Number(m.target_level))
        ? Number(m.target_level) : s.level,
      kpis: (m.kpis || []).slice(0, 6).map((k, i) => ({
        sort_order: i,
        name: String(k.name || "").trim().slice(0, 60),
        kind: KIND_KEYS.includes(k.kind) ? k.kind : "number",
        target_value: Number.isFinite(Number(k.target_value)) ? Number(k.target_value) : null,
        unit: String(k.unit || "").trim().slice(0, 10) || null,
        from_daily: k.from_daily !== false,
        note: String(k.why || "").trim().slice(0, 300) || null,
      })).filter((k) => k.name),
    };
  });

  return {
    three_month_kgi: String(v.three_month_kgi || "").trim().slice(0, 1000),
    months,
    note: String(v.note || "").trim().slice(0, 2000) || null,
  };
}

// -----------------------------------------------------------------------------
// 翌月のKGI/KPIドラフト（§32）
// -----------------------------------------------------------------------------
const NEXT_SYSTEM = [
  "あなたは株式会社エイトの育成計画づくりを手伝うAIです。",
  "前の月の実績を見て、翌月のKGIとKPIのドラフトを作ります。",
  "",
  "【これはドラフトです】確定するのは管理者と本人です。",
  "",
  "【数字の決め方】",
  "・前の月に大きく未達だったKPIは、数字を下げるか、達成できなかった原因に",
  "  当たるKPIへ置き換える。同じ数字をそのまま置き直さない",
  "・前の月に大きく超過したKPIは上げてよいが、倍にはしない",
  "・3か月KGIから外れる目標は作らない",
  "・4〜6個まで",
  "",
  "【書いてはいけないこと】",
  "・賃金・手当・雇用形態・労働時間そのものを目標にしない",
  "・人格や性格についての記述",
].join("\n");

const NEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kgi", "kpis", "note"],
  properties: {
    kgi: { type: "string" },
    kpis: { type: "array", minItems: 3, maxItems: 6, items: kpiItem },
    note: { type: "string", description: "前月から変えた点と、その理由" },
  },
};

export async function draftNextMonth({ plan, month, prevMonth, prevKpis, level }) {
  const prompt = [
    `【3か月KGI（固定）】${plan.three_month_kgi || "（未設定）"}`,
    `【対象月】${month.month}（MONTH ${month.month_no}）`,
    `【いまの自走レベル】L${level}`,
    month.kgi ? `【この月の想定】${month.kgi}` : "",
    "",
    prevMonth ? `【前の月（${prevMonth.month}）のKGI】${prevMonth.kgi || "（未設定）"}` : "",
    prevKpis?.length
      ? "【前の月のKPIと実績】\n" + prevKpis.map((k) =>
          `・${k.name}：目標 ${k.target ?? "—"}${k.unit || ""} / 実績 ${k.actual ?? "—"}` +
          (k.rate != null ? `（${k.rate}%）` : "（実績の記録なし）")).join("\n")
      : "【前の月の記録】なし（この月が最初です）",
    "",
    "この内容で、この月のKGIとKPIのドラフトを作ってください。",
  ].filter(Boolean).join("\n");

  try {
    const r = await call(NEXT_SYSTEM, prompt, NEXT_SCHEMA, "draft_next_month");
    return {
      ok: true, ...r,
      result: {
        kgi: String(r.result.kgi || "").trim().slice(0, 500),
        note: String(r.result.note || "").trim().slice(0, 2000) || null,
        kpis: (r.result.kpis || []).slice(0, 6).map((k, i) => ({
          sort_order: i,
          name: String(k.name || "").trim().slice(0, 60),
          kind: KIND_KEYS.includes(k.kind) ? k.kind : "number",
          target_value: Number.isFinite(Number(k.target_value)) ? Number(k.target_value) : null,
          unit: String(k.unit || "").trim().slice(0, 10) || null,
          from_daily: k.from_daily !== false,
          note: String(k.why || "").trim().slice(0, 300) || null,
        })).filter((k) => k.name),
      },
    };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

// -----------------------------------------------------------------------------
// モデル呼び出し。日報の評価と同じ考え方で、OpenAI が無ければ Claude に切り替える
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
    return { model: OPENAI_MODEL, result: JSON.parse(text) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY も ANTHROPIC_API_KEY も設定されていません");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE.MAX_TOKENS.long,
    system,
    tools: [{ name: toolName, description: "ドラフトを返す", input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: prompt }],
  });
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === toolName);
  if (!tu) throw new Error("claude_no_tool_use");
  return { model: CLAUDE_MODEL, result: tu.input };
}
