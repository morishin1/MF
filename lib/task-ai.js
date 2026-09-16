// 明日の重要タスクを、AIに見てもらう。
//
// ■ AIがやること
//
//   1. 内容の確認 … 本当に明日やるべきか。目標・KPIにつながっているか。
//                    ただの作業になっていないか。完了条件が明確か。
//   2. 担当の提案 … 役割・担当サービス・いまの仕事量・期限・未完了から、誰が適任か。
//
// ■ AIがやらないこと
//
//   確定。AIは案と理由を出すだけで、決めるのは人。
//   「AIがそう言ったから」で仕事が割り振られる形にはしない。
//
// ■ OK/NG だけ返させない
//
//   「NG」とだけ言われても直しようがない。
//   必ず 理由 と 直し方（書き換え案）を返させる。
//
// ■ 人格の話にしない
//
//   見るのは書かれた内容と数だけ。「◯◯さんは遅い」のような評価は返させない。

import { askJson, aiConfigured } from "./ai-json.js";

export { aiConfigured };

const RULES = [
  "あなたは、会社の目標から逆算して1日の仕事を組み立てる役です。",
  "",
  "守ること:",
  "・人物評価をしない。書かれた内容と数だけを見る。",
  "・OK/NG だけで終わらせない。必ず 理由 と 直した文 を出す。",
  "・「頑張る」「意識する」で終わっているものは直す。数と、何をもって終わりかを書く。",
  "・1日にやるのは3件まで。多いほど、どれも終わらない。",
  "・日本語。1文は短く。指示の言い切りで書く。",
].join("\n");

const REVIEW_SCHEMA = {
  type: "object",
  required: ["overall", "tasks"],
  properties: {
    overall: {
      type: "object",
      required: ["ok", "summary"],
      properties: {
        ok: { type: "boolean", description: "このまま明日のタスクとして確定してよいか" },
        summary: { type: "string", description: "全体の講評。1〜2文" },
        warnings: {
          type: "array", maxItems: 4, items: { type: "string" },
          description: "気づいたこと。多すぎる・偏っている・もっと優先すべきものがある、など",
        },
        better: {
          type: "array", maxItems: 3, items: { type: "string" },
          description: "いまの3件より先にやるべき未完了タスクがあれば、その題名",
        },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "verdict", "reason"],
        properties: {
          index: { type: "integer", description: "何番目のタスクか（0から）" },
          verdict: { type: "string", enum: ["ok", "fix", "drop"],
                     description: "ok=このまま / fix=直せば良い / drop=明日やるべきでない" },
          reason: { type: "string", description: "そう判断した理由。1〜2文" },
          fix: { type: "string", description: "直した文。verdict が ok なら空でよい" },
          done_condition: { type: "string", description: "直した完了条件。数と終わり方を入れる" },
          kpi: { type: "string", description: "つながるKPI・事業。分からなければ空" },
          assignee_name: { type: "string", description: "担当の案（氏名）。いまの担当で良ければ同じ名前" },
          assignee_why: { type: "string", description: "その人を薦める理由。仕事量にも触れる" },
        },
      },
    },
  },
};

/**
 * 明日の重要タスクを見る。
 *
 * @param {object} p
 *   employee   { name, department, position, role }
 *   date       YYYY-MM-DD（いつのぶんか）
 *   tasks      [{ title, purpose, done_condition, due_on, priority, kpi_link, assigneeName }]
 *   goals      { kgi, kpis:[{name,target,unit}], priority_work }  週のゴール（あれば）
 *   kpis       [{ label, target, unit }]  その人の定番KPI（あれば）
 *   members    [{ name, department, position, roles, openCount, focusCount }]  他のメンバー
 *   openTasks  [{ title, due_on, priority }]  その人の未完了タスク
 * @returns {Promise<{model:string, result:object}>}
 */
export async function reviewFocus(p) {
  const lines = [
    `対象: ${p.employee?.name || "（不明）"}`
      + [p.employee?.department, p.employee?.position].filter(Boolean).map((v) => `／${v}`).join(""),
    `いつのぶん: ${p.date}`,
    "",
    "■ 明日やると決めた仕事",
    ...(p.tasks || []).map((t, i) => [
      `${i}. ${t.title}`,
      `   目的: ${t.purpose || "（未記入）"}`,
      `   完了条件: ${t.done_condition || "（未記入）"}`,
      `   期限: ${t.due_on || "（未記入）"}／優先度: ${t.priority || "normal"}`,
      `   関連KPI・事業: ${t.kpi_link || "（未記入）"}`,
      `   担当: ${t.assigneeName || "（未定）"}`,
    ].join("\n")),
  ];

  if (p.goals?.kgi) {
    lines.push("", "■ 今週のゴール（会社が決めたもの）", `KGI: ${p.goals.kgi}`);
    for (const k of p.goals.kpis || []) {
      lines.push(`KPI: ${k.name} ${k.target ?? ""}${k.unit || ""}`);
    }
    if (p.goals.priority_work) lines.push(`優先業務: ${p.goals.priority_work}`);
  }
  if ((p.kpis || []).length) {
    lines.push("", "■ この人のKPI",
      ...p.kpis.map((k) => `${k.label} 目標 ${k.target ?? "—"}${k.unit || ""}`));
  }
  if ((p.openTasks || []).length) {
    lines.push("", "■ この人の未完了タスク（明日の3件に入っていないもの）",
      ...p.openTasks.slice(0, 20).map((t) =>
        `・${t.title}（期限 ${t.due_on || "なし"}／優先度 ${t.priority || "normal"}）`));
  }
  if ((p.members || []).length) {
    lines.push("", "■ ほかのメンバーと、いまの仕事量",
      ...p.members.map((m) =>
        `・${m.name}${m.department ? `（${m.department}）` : ""}`
        + `${m.roles?.length ? ` 役割: ${m.roles.join("・")}` : ""}`
        + ` 未完了 ${m.openCount}件／明日の重要タスク ${m.focusCount}件`));
  }
  lines.push("", "上の内容を見て、明日このまま進めてよいかを判断してください。",
    "担当が未定のタスクには、メンバーの中から担当の案を出してください。",
    "1人に偏っているときは、その理由を書いて別の人を薦めてください。");

  return askJson(RULES, lines.join("\n"), REVIEW_SCHEMA, "focus_review", "long");
}

const CARRY_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "decision", "reason"],
        properties: {
          index: { type: "integer" },
          decision: { type: "string", enum: ["carry", "lower", "hand", "drop"],
                      description: "carry=明日へ持ち越す / lower=優先度を下げる / hand=別の人へ渡す / drop=やらない" },
          reason: { type: "string", description: "そう薦める理由。1文" },
          assignee_name: { type: "string", description: "hand のときだけ、渡す相手" },
        },
      },
    },
  },
};

/**
 * 終わらなかったタスクを、どうするか。
 *
 * 自動で翌日へ動かさない。案を出すだけで、決めるのは人。
 * 何度も持ち越されているものは、やらない判断を薦めてよい
 */
export async function reviewCarry(p) {
  const lines = [
    `対象: ${p.employee?.name || "（不明）"}`,
    `日付: ${p.date}`,
    "",
    "■ 今日終わらなかった重要タスク",
    ...(p.tasks || []).map((t, i) => [
      `${i}. ${t.title}`,
      `   完了条件: ${t.done_condition || "（未記入）"}`,
      `   できなかった理由: ${t.not_done_reason || "（未記入）"}`,
      `   これまでの持ち越し: ${t.carry_count || 0}回`,
    ].join("\n")),
  ];
  if ((p.members || []).length) {
    lines.push("", "■ ほかのメンバー",
      ...p.members.map((m) => `・${m.name} 未完了 ${m.openCount}件`));
  }
  lines.push("", "1件ずつ、どうするかを薦めてください。",
    "2回以上持ち越しているものは、そのまま持ち越すのではなく、",
    "優先度を下げる・別の人へ渡す・やらないことにする、のどれかを検討してください。");

  return askJson(RULES, lines.join("\n"), CARRY_SCHEMA, "carry_review", "normal");
}

const MEMO_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "decision", "reason"],
        properties: {
          index: { type: "integer" },
          decision: { type: "string", enum: ["task", "self", "hand", "drop"],
                      description: "task=正式タスク化 / self=もう自分で片付けた / hand=他の人へ依頼 / drop=不要だった" },
          reason: { type: "string", description: "そう薦める理由。1文" },
          assignee_name: { type: "string", description: "hand のときだけ、渡す相手の案" },
        },
      },
    },
  },
};

/**
 * 日中に吐き出した「とりあえずメモ」を、退勤時にどうするか。
 *
 * ここでも決めるのは人。AIは案と理由を返すだけ。
 * 内容が薄い一言（例:「確認」だけ）でも、勝手に補って重く判定しない。
 * 分からなければ self（対応済みとして片付ける）ではなく task（タスク化して確認）を薦める。
 */
export async function reviewMemos(p) {
  const lines = [
    `対象: ${p.employee?.name || "（不明）"}`,
    `日付: ${p.date}`,
    "",
    "■ 今日のとりあえずメモ",
    ...(p.memos || []).map((m, i) => `${i}. ${m.body}`),
  ];
  if ((p.members || []).length) {
    lines.push("", "■ ほかのメンバー",
      ...p.members.map((m) => `・${m.name} 未完了 ${m.openCount}件`));
  }
  lines.push("", "1件ずつ、どうするかを薦めてください。",
    "内容だけでは判断がつかないものは、self（対応済み）ではなく task（タスク化して確認）を薦めてください。");

  return askJson(RULES, lines.join("\n"), MEMO_SCHEMA, "memo_review", "normal");
}
