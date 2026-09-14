import {
  normalizeNippo, evaluateDaily, hasContent, SUCCESS_MET, IMPROVE_TAGS, MAX_WINS,
} from "../lib/nippo.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let bad = 0;
const ok = (c, m) => { if (!c) { console.log("NG:", m); bad++; } };

// ---- 朝のゴールは達成できたか ----
for (const k of ["o", "d", "x"]) {
  ok(normalizeNippo({ successMet: k }).success_met === k, `successMet ${k}`);
  ok(SUCCESS_MET.some((s) => s.key === k), `SUCCESS_MET に ${k} が無い`);
}
ok(normalizeNippo({ successMet: "z" }).success_met === null, "知らない値を通した");
ok(normalizeNippo({}).success_met === null, "未指定は null");

// ---- 今日のデキタ3つ ----
const w1 = normalizeNippo({ wins: ["A", "B", "C", "D"] }).wins;
ok(w1.length === MAX_WINS && w1[0] === "A" && w1[2] === "C", `3件に切る: ${JSON.stringify(w1)}`);
ok(MAX_WINS === 3, "MAX_WINS が3でない");

const w2 = normalizeNippo({ wins: ["  ", "実装できた", "", null, "  空白落ち  "] }).wins;
ok(w2.length === 2 && w2[0] === "実装できた" && w2[1] === "空白落ち",
  `空欄を落として詰める: ${JSON.stringify(w2)}`);

ok(normalizeNippo({ wins: "文字列" }).wins.length === 0, "配列でない wins を通した");
ok(normalizeNippo({}).wins.length === 0, "未指定で空配列にならない");
ok(normalizeNippo({ wins: ["あ".repeat(200)] }).wins[0].length === 120, "長さで切っていない");

// ---- 改善したこと ----
const t1 = normalizeNippo({ improveTags: ["self_research", "new_method"] }).improve_tags;
ok(t1.length === 2, `分類: ${t1}`);
ok(normalizeNippo({ improveTags: ["self_research", "self_research"] }).improve_tags.length === 1,
  "同じ分類が2つ入った");
ok(normalizeNippo({ improveTags: ["でたらめ"] }).improve_tags.length === 0, "知らない分類を通した");
ok(normalizeNippo({ improveTags: "文字列" }).improve_tags.length === 0, "配列でない分類を通した");
ok(normalizeNippo({ improvedNote: "  やり方を変えた  " }).improved_note === "やり方を変えた", "一言");
ok(normalizeNippo({ improvedNote: "" }).improved_note === null, "空の一言は null");
ok(IMPROVE_TAGS.length === 6, `分類の数 ${IMPROVE_TAGS.length}`);

// ---- 既存の項目が壊れていないか ----
const full = normalizeNippo({
  topPriority: "A社の提案", kpiName: "架電", kpiTarget: 20, kpiActual: 22,
  workItems: [{ task: "架電", result: "22件" }],
  successMet: "o", wins: ["断られた理由を聞けた"],
  consultNote: "", improveTags: ["new_method"], improvedNote: "台本を変えた",
  tomorrowPlan: "B社に見積",
});
ok(full.kgi_achieved === true, "KPIの達成判定");
ok(full.top_priority === "A社の提案", "最優先");
ok(full.tomorrow_plan === "B社に見積", "明日");
ok(full.consult_note === null, "困ったこと（空）");
ok(hasContent(full), "中身ありと見なされない");

// ---- 行動の判定（⑦改善） ----
const base = { work_items: [{ task: "a", undone_reason: "途中" }], tomorrow_plan: null,
               kgi_actual: null, consult_note: null };
ok(evaluateDaily({ ...base, improved_note: "台本を変えた" }).feedback_improvement === "o",
  "改善を書いたのに ○ にならない");
ok(evaluateDaily({ ...base, improve_tags: ["new_method"] }).feedback_improvement === "o",
  "改善の分類だけでも ○ にする");
ok(evaluateDaily({ ...base }).feedback_improvement === "d",
  "改善も明日も無いのに ○/△ の判定が違う");
ok(evaluateDaily({ ...base, tomorrow_plan: "やる" }).feedback_improvement === "o",
  "未完了＋明日 は今までどおり ○");
ok(evaluateDaily({ work_items: [{ task: "a", result: "できた" }] }).feedback_improvement === "-",
  "材料が無いのに判定した");

// ---- AI に渡す文面 ----
const { buildUserPrompt } = await import(atRoot("lib/nippo-eval.js")).then(async (m) => {
  // buildUserPrompt は非公開。PROMPT_VERSION が上がっていることだけ確かめる
  return { buildUserPrompt: null, ...m };
});
const evalMod = await import(atRoot("lib/nippo-eval.js"));
ok(evalMod.PROMPT_VERSION === "daily_eval_v5", `プロンプト版 ${evalMod.PROMPT_VERSION}`);

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
