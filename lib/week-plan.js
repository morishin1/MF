// 週のゴールを、その日の行動まで落とす。
//
// ■ 考える場所を移す
//   これまでは、朝に本人が「今日の最優先」と「やること3つ」を考えていた。
//   何を書くか迷っている時間は、仕事が進んでいない時間でもある。
//
//   会社が「今週これが終わっていればよい」を決め、
//   そこから今日の行動までをAIが割る。
//   本人は 実行する ことと 結果を返す ことに集中する。
//
// ■ AIに決めさせないこと
//   週のゴールそのもの（KGI・KPI・期限・優先業務）は管理者が決める。
//   AIが出すのは下書きまで。何を目指すかを機械に決めさせない。
//   AIがやるのは「決まったゴールを、今日の行動に割る」ところだけ。
//
// ■ 行動には数値と終わり方を付ける
//   「新規企業に連絡する」ではなく
//   「新規15社へ連絡（完了条件：15社に一次連絡を入れ終わっている）」。
//   数値と完了条件が無いと、夜に できた／できなかった を判定できない。
//
// ■ 人格は見ない
//   意識する行動は、エイトの10か条（lib/scoring.js）から2つ選ぶ。
//   選ぶのは「今日の場面でどう動くか」であって、性格の話にはしない。

import { ACTIONS } from "./scoring.js";
import { askJson, aiConfigured } from "./ai-json.js";

export { aiConfigured };

const ACTION_KEYS = ACTIONS.map((a) => a.key);

const RULES = [
  "エイトの評価基準（10か条）:",
  ...ACTIONS.map((a) => `  ${a.no} ${a.label}（${a.short}）… ${a.desc}`),
  "",
  "守ること:",
  "・人格や性格には触れない。行動と数字だけを書く。",
  "・「頑張る」「意識する」で終わらせない。数と、何をもって終わりかを書く。",
  "・1日にやることは3つまで。多いほど、どれも終わらない。",
  "・その人が今日1日で終えられる量にする。週ぶんを1日に詰めない。",
  "・日本語。1文は短く。敬語は使わず、やることの言い切りで書く。",
].join("\n");

// ---- 1) 週のゴールの下書き ----------------------------------------------------

const GOAL_SCHEMA = {
  type: "object",
  required: ["kgi", "kpis", "priority_work"],
  properties: {
    kgi: { type: "string", description: "今週の終わりに何が終わっていればよいか。1〜2文" },
    kpis: {
      type: "array", minItems: 1, maxItems: 4,
      items: {
        type: "object",
        required: ["name", "target"],
        properties: {
          name: { type: "string", description: "数えるもの。例: 新規連絡社数" },
          target: { type: "number", description: "今週の目標値" },
          unit: { type: "string", description: "単位。例: 社 / 件 / 本" },
        },
      },
    },
    deadline: { type: "string", description: "いつまでに。例: 金曜17時" },
    priority_work: { type: "string", description: "今週いちばん時間を使う業務。1文" },
    note: { type: "string", description: "管理者に確認してほしい点があれば" },
  },
};

/**
 * 週のゴールの下書き。管理者が直してから確定させる。
 * @param {object} p { employee, growthPlan, lastWeek, monthKgi }
 */
export async function draftWeekGoal({ employee, growthPlan, lastWeek, monthKgi, weekStart }) {
  const prompt = [
    "【対象者】",
    `氏名：${employee.display_name}`,
    employee.department ? `所属：${employee.department}` : "",
    employee.initial_role ? `担当：${employee.initial_role}` : "",
    "",
    monthKgi ? `【今月のKGI】\n${monthKgi}` : "",
    growthPlan ? `【育成計画】\n${growthPlan}` : "",
    lastWeek ? `【先週のゴールと結果】\n${lastWeek}` : "【先週の記録】ありません（今週が最初）",
    "",
    `【対象の週】${weekStart} の週（月〜金）`,
    "",
    "この人の今週のゴールの下書きを作ってください。",
    "管理者がこれを見て直します。迷ったところは note に書いてください。",
  ].filter(Boolean).join("\n");

  const r = await askJson(
    `あなたは日本の小さな会社のマネージャーです。${RULES}`,
    prompt, GOAL_SCHEMA, "draft_week_goal", "normal");

  return { model: r.model, goal: normalizeGoal(r.result) };
}

export function normalizeGoal(v) {
  return {
    kgi: text(v?.kgi, 500),
    kpis: (Array.isArray(v?.kpis) ? v.kpis : []).slice(0, 4).map((k) => ({
      name: text(k?.name, 60),
      target: Number.isFinite(Number(k?.target)) ? Number(k.target) : null,
      unit: text(k?.unit, 10),
    })).filter((k) => k.name),
    deadline: text(v?.deadline, 100),
    priority_work: text(v?.priority_work, 300),
    note: text(v?.note, 300),
  };
}

// ---- 2) 週のゴール → 日ごとの行動 ---------------------------------------------

const dayItem = {
  type: "object",
  required: ["date", "success_line", "top_priority", "actions", "focus"],
  properties: {
    date: { type: "string", description: "YYYY-MM-DD" },
    success_line: {
      type: "string",
      description: "その日の終わりに最高だったと言える状態。1文。数字を入れる。"
        + "例: 新規15社への連絡が完了し、2社が登録へ進んでいる",
    },
    top_priority: { type: "string", description: "その日いちばん先に終わらせること。1つだけ" },
    actions: {
      type: "array", minItems: 1, maxItems: 3,
      items: {
        type: "object",
        required: ["task", "done_when"],
        properties: {
          task: { type: "string", description: "やること。言い切りで。例: 新規企業15社へ連絡" },
          target: { type: "number", description: "数。数えられないものは省く" },
          unit: { type: "string", description: "単位。例: 社 / 件" },
          done_when: { type: "string", description: "何をもって終わりか。1文" },
        },
      },
    },
    focus: {
      type: "array", minItems: 2, maxItems: 2,
      items: {
        type: "object",
        required: ["key", "how"],
        properties: {
          key: { type: "string", enum: ACTION_KEYS, description: "10か条のどれか" },
          how: {
            type: "string",
            description: "今日の場面で、具体的にどう動くか。1文。"
              + "例: 完璧に準備して止まらず、まず15社へ連絡する",
          },
        },
      },
    },
  },
};

const SPLIT_SCHEMA = {
  type: "object",
  required: ["days"],
  properties: {
    days: { type: "array", minItems: 1, maxItems: 7, items: dayItem },
    note: { type: "string" },
  },
};

/**
 * 週のゴールを、その週の勤務日ぶんに割る。
 * @param {object} p { employee, goal, dates:string[] }
 */
export async function splitToDays({ employee, goal, dates }) {
  const prompt = [
    "【対象者】",
    `氏名：${employee.display_name}`,
    employee.initial_role ? `担当：${employee.initial_role}` : "",
    "",
    "【今週のゴール】",
    `KGI：${goal.kgi || "（未記入）"}`,
    goal.kpis?.length
      ? `KPI：${goal.kpis.map((k) => `${k.name} ${k.target ?? ""}${k.unit || ""}`).join(" / ")}`
      : "KPI：（未記入）",
    goal.deadline ? `期限：${goal.deadline}` : "",
    goal.priority_work ? `優先業務：${goal.priority_work}` : "",
    goal.note ? `管理者から：${goal.note}` : "",
    "",
    `【割る日】${dates.join(" / ")}（${dates.length}日）`,
    "",
    "この週のゴールを、上の日付ぶんの行動に割ってください。",
    "週の合計が KPI の目標に届くように配ります。",
    "後半の日には、前半で積み残しが出たときに拾えるだけの余地を残してください。",
  ].filter(Boolean).join("\n");

  const r = await askJson(
    `あなたは日本の小さな会社のマネージャーです。${RULES}`,
    prompt, SPLIT_SCHEMA, "split_week_to_days", "long");

  return { model: r.model, days: normalizeDays(r.result?.days, dates) };
}

// ---- 3) 翌日の行動を作り直す ---------------------------------------------------

/**
 * 今日の結果を見て、翌日の行動を作り直す。
 * 未達・詰まったところ・週の残りを見て配り直す。
 */
export async function nextDayPlan({ employee, goal, date, todayResult, weekSoFar }) {
  const prompt = [
    "【対象者】",
    `氏名：${employee.display_name}`,
    "",
    "【今週のゴール】",
    `KGI：${goal.kgi || "（未記入）"}`,
    goal.kpis?.length
      ? `KPI：${goal.kpis.map((k) => `${k.name} ${k.target ?? ""}${k.unit || ""}`).join(" / ")}`
      : "",
    goal.priority_work ? `優先業務：${goal.priority_work}` : "",
    "",
    "【今日の結果】",
    todayResult || "（記録なし）",
    "",
    "【今週ここまでの積み上げ】",
    weekSoFar || "（記録なし）",
    "",
    `【作る日】${date}`,
    "",
    "今日の結果をふまえて、この日の行動を作ってください。",
    "未達のぶんは、残りの日数で無理なく取り返せる量に割り直します。",
    "同じやり方で届かなかったものは、やり方を変えた行動にしてください。",
  ].filter(Boolean).join("\n");

  const r = await askJson(
    `あなたは日本の小さな会社のマネージャーです。${RULES}`,
    prompt, SPLIT_SCHEMA, "next_day_plan", "normal");

  const days = normalizeDays(r.result?.days, [date]);
  return { model: r.model, day: days[0] || null };
}

// ---- 形をそろえる -------------------------------------------------------------

const text = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

const LABEL = new Map(ACTIONS.map((a) => [a.key, a.label]));

export function normalizeDays(days, dates) {
  const byDate = new Map((Array.isArray(days) ? days : []).map((d) => [String(d?.date), d]));
  return dates.map((date) => {
    const d = byDate.get(date) || {};
    return {
      work_date: date,
      success_line: text(d.success_line, 300),
      top_priority: text(d.top_priority, 200),
      actions: (Array.isArray(d.actions) ? d.actions : []).slice(0, 3).map((a) => ({
        task: text(a?.task, 200),
        target: Number.isFinite(Number(a?.target)) ? Number(a.target) : null,
        unit: text(a?.unit, 10),
        done_when: text(a?.done_when, 200),
      })).filter((a) => a.task),
      // 10か条から2つ。知らない鍵が来たら落とす
      focus: (Array.isArray(d.focus) ? d.focus : [])
        .filter((f) => LABEL.has(f?.key))
        .slice(0, 2)
        .map((f) => ({ key: f.key, label: LABEL.get(f.key), how: text(f.how, 200) })),
    };
  });
}

/**
 * 行動案を、朝の日報の形に落とす。
 * 表を新しくせず、これまでの tc_nippo にそのまま入れる
 */
export const toMorning = (plan) => ({
  topPriority: plan?.top_priority || "",
  goalImage: plan?.success_line || "",
  actions: (plan?.actions || []).map((a) => ({
    task: a.task,
    target: a.target ?? null,
    unit: a.unit || null,
    done_when: a.done_when || null,
  })),
});
