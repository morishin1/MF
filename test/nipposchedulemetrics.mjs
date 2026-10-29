// Synthetic, pure metric and prompt-boundary checks. No AI calls, database or browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { evaluationItems, isDone } from "../lib/nippo.js";
import { weeklyMetrics, monthlyMetrics } from "../lib/nippo-period.js";
import { computeMetrics as autonomyMetrics } from "../lib/autonomy.js";
import { computeMetrics as probationMetrics } from "../lib/probation.js";
import { findFollowUps, rankings } from "../lib/follow.js";
import { ACTIONS as CRITERIA } from "../lib/scoring.js";

const read = file => fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const marker = "SYNTHETIC_SCHEDULE_NOT_EXECUTION";
const planned = (over = {}) => ({ task: marker, schedule_event_id: "40000000-0000-4000-8000-000000000001",
  actual: 8, actual_minutes: 60, done: false, result: "", undone_reason: "", ...over });
const legacy = [{ task: "既存の完了作業", result: "結果を記録", done: true }, { task: "既存の未完了作業", undone_reason: "相談した" }];
const report = (over = {}) => ({ user_id: "synthetic-user", work_date: "2026-10-28", submitted_at: "2026-10-28T09:00:00Z",
  work_items: clone(legacy), consult_note: "本人の相談", tomorrow_plan: "次の行動", ...over });
const variations = [planned(), planned({ actual: 0, actual_minutes: 0 }), planned({ actual: null, actual_minutes: null }),
  planned({ done: true, result: "CLIENT_COMPLETION_NOT_PROOF", undone_reason: "CLIENT_UNDONE_NOT_PROOF" })];
const add = (n, item) => ({ ...n, work_items: [...n.work_items, item] });
const staff = [{ user_id: "synthetic-user", display_name: "合成メンバー" }];

test("shared evaluation boundary preserves legacy items and never claims schedule completion", () => {
  const n = report();
  for (const item of variations) {
    assert.deepEqual(evaluationItems(add(n, item)), n.work_items);
    assert.equal(isDone(item), false);
  }
  assert.equal(isDone(legacy[0]), true);
  assert.equal(isDone({ result: "旧形式の結果" }), true);
  assert.deepEqual(evaluationItems(null), []);
});

test("weekly and monthly metrics are invariant to schedule measurements or injected completion", () => {
  const n = report();
  const weekly = nippos => weeklyMetrics({ weekStart: "2026-10-26", nippos, evals: [] });
  const monthly = nippos => monthlyMetrics({ month: "2026-10", nippos, weeks: [], prevWeeks: [], workdays: 22 });
  for (const item of variations) {
    assert.deepEqual(weekly([add(n, item)]), weekly([n]));
    assert.deepEqual(monthly([add(n, item)]), monthly([n]));
  }
  assert.equal(weekly([n]).workCount, 2);
  assert.equal(weekly([n]).resultCount, 1);
});

test("autonomy denominator, consultation and carryover metrics ignore schedule rows", () => {
  const n = report({ work_items: [legacy[0]], consult_note: "", tomorrow_plan: "" });
  const metrics = nippos => autonomyMetrics({ workdays: ["2026-10-28"], nippos, kpis: [], items: [], blockers: [] });
  for (const item of variations) assert.deepEqual(metrics([add(n, item)]), metrics([n]));
  assert.equal(metrics([n]).resultRate, 100);
});

test("probation evidence counts and result rate ignore schedule self-report", () => {
  const n = report();
  const metrics = nippos => probationMetrics({ from: "2026-10-26", to: "2026-10-28", nippos, weeks: [], evals: [] });
  for (const item of variations) assert.deepEqual(metrics([add(n, item)]), metrics([n]));
  assert.equal(metrics([n]).workCount, 2);
  assert.equal(metrics([n]).resultRate, 50);
});

test("follow rankings and previous-period growth do not count calendar slots", () => {
  const n = report(), previous = report({ work_date: "2026-10-21" });
  const rank = (nippos, prevNippos) => rankings({ staff, nippos, prevNippos, kpis: [], evals: [] });
  for (const item of variations) {
    assert.deepEqual(rank([add(n, item)], [previous]), rank([n], [previous]));
    assert.deepEqual(rank([n], [add(previous, item)]), rank([n], [previous]));
  }
});

test("calendar imports cannot create or remove action-slowdown follow-up", () => {
  const before = report({ work_date: "2026-10-21", work_items: Array.from({ length: 5 }, () => ({ ...legacy[0] })) });
  const now = report({ work_items: [{ ...legacy[0] }] });
  const follow = nippos => findFollowUps({ date: "2026-10-28", staff, nippos, kpis: [] });
  const expected = follow([now, before]);
  assert.ok(expected[0].reasons.some(r => r.kind === "slowdown"));
  assert.deepEqual(follow([add(add(add(now, planned()), planned()), planned()), before]), expected);
  assert.deepEqual(follow([now, add(before, planned())]), expected);
});

test("schedule-only reports keep task-based rates unknown, not zero", () => {
  const n = report({ work_items: [planned()], consult_note: "", tomorrow_plan: "" });
  const weekly = weeklyMetrics({ weekStart: "2026-10-26", nippos: [n], evals: [] });
  assert.equal(weekly.workCount, 0); assert.equal(weekly.resultCount, 0);
  assert.equal(autonomyMetrics({ workdays: [n.work_date], nippos: [n], kpis: [], items: [], blockers: [] }).resultRate, null);
  assert.equal(probationMetrics({ from: n.work_date, to: n.work_date, nippos: [n], weeks: [], evals: [] }).resultRate, null);
});

test("weekly AI prompt excludes schedule-only facts and injected lifecycle text", () => {
  const src = read("lib/nippo-period.js");
  const code = src.slice(src.indexOf("function weeklyPrompt("), src.indexOf("/** @returns {Promise<{ok, model?"));
  assert.ok(code.includes("function weeklyPrompt("));
  const c = vm.createContext({ evaluationItems, isDone, CRITERIA }); vm.runInContext(code, c);
  const prompt = n => c.weeklyPrompt({ metrics: weeklyMetrics({ weekStart: "2026-10-26", nippos: [n], evals: [] }), nippos: [n], evals: [], review: null });
  for (const item of variations) assert.equal(prompt(add(report(), item)), prompt(report()));
  assert.doesNotMatch(prompt(add(report(), variations[3])), /SYNTHETIC_SCHEDULE|CLIENT_COMPLETION|CLIENT_UNDONE/);
});

test("legacy daily AI text excludes plan references without modifying the report", () => {
  const src = read("lib/ai.js"), start = src.indexOf("function nippoToText(");
  const code = src.slice(start, src.indexOf("\n/**", start));
  const c = vm.createContext({ evaluationItems }); vm.runInContext(code, c);
  const n = add(report(), variations[3]), before = clone(n);
  assert.equal(c.nippoToText(n), c.nippoToText(report())); assert.deepEqual(n, before);
});

test("next-day planning AI line does not label optional measurements as missing work", () => {
  const src = read("api/nippo/plan.js"), start = src.indexOf("  const line = (n) =>");
  const code = src.slice(start, src.indexOf("\n\n  const today", start));
  const c = vm.createContext({ evaluationItems, isDone }); vm.runInContext(code + "\nthis.makeLine = line;", c);
  for (const item of variations) assert.equal(c.makeLine(add(report(), item)), c.makeLine(report()));
  assert.equal(c.makeLine(report({ work_items: [planned()] })), "");
});

test("week goal AI material excludes schedule reference rows using read-only synthetic source", async () => {
  const src = read("api/week-goals.js"), start = src.indexOf("async function gatherMaterial(");
  const code = src.slice(start, src.indexOf("// その週の勤務日", start));
  const c = vm.createContext({ evaluationItems, shiftDays: () => "2026-10-19" }); vm.runInContext(code, c);
  const material = async n => {
    const sb = { from(table) { const q = { select() { return q; }, eq() { return q; }, gte() { return q; }, lt() { return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { return q; },
      then(resolve) { return Promise.resolve({ data: table === "tc_nippo" ? [n] : null }).then(resolve); } }; return q; } };
    return clone(await c.gatherMaterial(sb, { id: "synthetic-employee", user_id: "synthetic-user" }, "2026-10-26"));
  };
  for (const item of variations) assert.deepEqual(await material(add(report(), item)), await material(report()));
});

test("executive legacy work-item projection excludes unlabeled schedule evidence", () => {
  const src = read("lib/member-exec-read.js");
  const line = src.split("\n").find(s => s.includes("workItems: "));
  assert.ok(line);
  const expression = line.trim().replace(/^workItems: /, "").replace(/,$/, "");
  const project = n => clone(vm.runInNewContext(expression, { n, evaluationItems }));
  assert.deepEqual(project(add(report(), variations[3])), project(report()));
  assert.equal(project(report()).length, 2);
});
