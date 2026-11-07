// AI goal coach: no fabricated KPI/score, and only member-confirmed success line is stored.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGoalCoach } from "../lib/nippo-goal-coach.js";
import { normalizeMorning } from "../lib/nippo.js";

function check(name, fn) {
  fn();
  console.log("ok:", name);
}

const suggestion = {
  goal: "提案相手が次の対応を判断できる", purpose: "面談に進めるため",
  done_when: "提案と次回の確認日を記録した", first_step: "対象案件を確認する",
  coaching_question: "相手が判断する材料は？", needs_manager: false,
  manager_question: "", kpi_link: "面談件数"
};
check("no manager goal always needs confirmation", () => {
  const r = normalizeGoalCoach(suggestion);
  assert.equal(r.needsManager, true);
  assert.equal(r.kpiLink, "");
  assert.equal(r.doneWhen, suggestion.done_when);
});
check("only exact configured KPI can be linked", () => {
  const r = normalizeGoalCoach(suggestion, {
    kgi: "面談を増やす",
    kpis: [{ name: "提案件数", target: 30 }]
  });
  assert.equal(r.needsManager, false);
  assert.equal(r.kpiLink, "");
  assert.equal(normalizeGoalCoach(suggestion, {
    kgi: "面談を増やす",
    kpis: [{ name: "面談件数", target: 2 }]
  }).kpiLink, "面談件数");
});
check("AI-created goal text is capped", () => {
  assert.equal(normalizeGoalCoach({ ...suggestion, goal: "x".repeat(500) }, { kgi: "test" }).goal.length, 200);
});
check("daily morning persists accepted goal rather than an AI draft", () => {
  const without = normalizeMorning({ topPriority: "企業への提案" });
  const withGoal = normalizeMorning({ topPriority: "企業への提案", goalImage: "提案と次回確認日を記録した" });
  assert.equal(without.goal_image, null);
  assert.equal(withGoal.goal_image, "提案と次回確認日を記録した");
});
check("both personal and plan-based daily work expose coaching", () => {
  const page = readFileSync(new URL("../nippo.html", import.meta.url), "utf8");
  assert.match(page, /AIにゴールと進め方を聞く/);
  assert.match(page, /AIに進め方を聞く/);
  assert.match(page, /async function coachTomorrowGoal/);
  assert.match(page, /await KPLayout.busy\(btn, "反映中…"/);
});

check("weekly save result is a row and is retained after redraw", () => {
  const page = readFileSync(new URL("../nippo.html", import.meta.url), "utf8");
  const api = readFileSync(new URL("../js/api-client.js", import.meta.url), "utf8");
  assert.match(api, /saveWeeklyReview = \(w\)[\s\S]*?\.then\(\(d\) => d\.weekly\)/);
  assert.match(page, /saved && saved\.week_start === data\.weekStart\) data\.weekly = saved/);
});
check("weekly view shows submitted outcomes and the previous improvement", () => {
  const page = readFileSync(new URL("../nippo.html", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api/nippo/index.js", import.meta.url), "utf8");
  assert.match(page, /id="wk-facts"/);
  assert.match(page, /先週決めた改善を確認する/);
  assert.match(api, /previousWeekly/);
});
check("weekly KGI can be published manually, never silently", () => {
  const api = readFileSync(new URL("../api/week-goals.js", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../admin-goals.html", import.meta.url), "utf8");
  assert.match(api, /if \(body\.activate === true\)/);
  assert.match(api, /no_saved_goal/);
  assert.match(ui, /週のゴールだけ本人に公開/);
  assert.match(ui, /await API\.saveWeekGoal\(readCard\(id\)\)/);
});
check("weekly goal is visible even when no daily plan was generated", () => {
  const page = readFileSync(new URL("../nippo.html", import.meta.url), "utf8");
  assert.match(page, /責任者が決めた今週のゴール/);
  assert.match(page, /今週のゴールはまだ責任者から設定されていません/);
});
check("AI quota is measured before the paid model call", () => {
  const api = readFileSync(new URL("../api/nippo/goal-coach.js", import.meta.url), "utf8");
  assert.match(api, /nippo\.goal_coach_attempt/);
  assert.ok(api.indexOf("nippo.goal_coach_attempt") < api.indexOf("draftGoalCoach({"));
  assert.match(api, /\(calls \?\? 0\) >= 5/);
});
