import test from "node:test";
import assert from "node:assert/strict";
import { summarizeKeieiWeekly } from "../lib/keiei-weekly.js";

const base = () => ({
  roster: [
    { id: "emp-1", user_id: "u1", display_name: "社員A", department: "営業" },
    { id: "emp-2", user_id: "u2", display_name: "社員B", department: "Office" },
  ],
  weekStart: "2026-11-02", today: "2026-11-06",
  nippos: [
    { id: "n1", user_id: "u1", work_date: "2026-11-02", submitted_at: "2026-11-02T10:00:00Z",
      kgi_achieved: true, goal_today: "提案", kgi_target: 3, kgi_actual: 4,
      work_items: [{ task: "A社に提案", result: "提案書送付", done: true }],
      consult_note: "商談の進め方を相談", improved_note: "送付文を改善" },
    { id: "morning-only", user_id: "u1", work_date: "2026-11-03", submitted_at: null,
      kgi_achieved: false, work_items: [{ task: "未提出の朝の計画", done: false }],
      consult_note: "未提出の文章" },
    { id: "n2", user_id: "u2", work_date: "2026-11-03", submitted_at: "2026-11-03T10:00:00Z",
      kgi_achieved: false, work_items: [{ task: "B社と交渉", undone_reason: "先方から返信なし" }] },
    { id: "old", user_id: "u1", work_date: "2026-10-30", submitted_at: "2026-10-30T10:00:00Z",
      kgi_achieved: false, work_items: [] },
  ],
  reviews: [
    { id: "r1", user_id: "u1", week_start: "2026-11-02",
      q1: "新規提案を完了", q2: "ヒアリングが増えた", q3: "提案方法を改善", q4: "面談2件",
      eval_total: 85, submitted_at: "2026-11-06T08:00:00Z", eval_comment: "先週より前進" },
    { id: "r2", user_id: "u2", week_start: "2026-11-02",
      q1: "連絡の継続", q2: "", q3: "", q4: "",
      eval_total: 20, submitted_at: null, eval_comment: "未公開のメモ" },
    { id: "prev", user_id: "u1", week_start: "2026-10-26",
      q3: "毎日1社へ提案", q4: "来週は提案3社" },
  ],
});

test("週次の元データを社員ごとにまとめ、朝だけの記録は提出として数えない", () => {
  const d = summarizeKeieiWeekly(base());
  assert.equal(d.summary.total, 2);
  assert.equal(d.summary.written, 2);
  assert.equal(d.summary.complete, 1);
  assert.equal(d.summary.submittedDays, 2);
  assert.equal(d.summary.kgiAchieved, 1);
  assert.equal(d.summary.kgiRecorded, 2);
  assert.equal(d.summary.kgiRate, 50);
  const sales = d.members.find((m) => m.employeeId === "emp-1");
  assert.equal(sales.submittedDays, 1);
  assert.equal(sales.resultsCount, 1);
  assert.equal(sales.results[0].result, "提案書送付");
  assert.equal(sales.kgiDays[0].target, 3);
  assert.equal(sales.kgiDays[0].actual, 4);
  assert.equal(sales.consultations.length, 1);
  assert.equal(sales.previousReview.q3, "毎日1社へ提案");
  assert.ok(sales.topics.some((t) => t.includes("先週決めた")));
  assert.equal(sales.review.publishedScore, 85);
  assert.equal(d.members.find((m) => m.employeeId === "emp-2").review.publishedScore, null);
});

test("振り返りが未記入・KGIの記録なしは未達成0%にしない", () => {
  const d = summarizeKeieiWeekly({
    roster: [{ id: "e", user_id: "u", display_name: "社員C", department: "営業" }],
    weekStart: "2026-11-02", today: "2026-11-06",
    nippos: [{ id: "n", user_id: "u", work_date: "2026-11-02",
      submitted_at: "2026-11-02T08:00:00Z", kgi_achieved: null, work_items: null }],
    reviews: [],
  });
  assert.equal(d.summary.notWritten, 1);
  assert.equal(d.members[0].reviewStatus, "missing");
  assert.equal(d.summary.kgiRate, null);
  assert.equal(d.members[0].resultsCount, 0);
  assert.equal(d.summary.submittedDays, 1);
});

test("未来の日報・他週の記録を集計せず、対象社員が0でも安全に表示できる", () => {
  const d = summarizeKeieiWeekly({
    ...base(), today: "2026-11-02",
  });
  assert.equal(d.summary.submittedDays, 1);
  assert.equal(d.weekEnd, "2026-11-08");
  const empty = summarizeKeieiWeekly({
    roster: [], nippos: [], reviews: [], weekStart: "2026-11-02", today: "2026-11-06",
  });
  assert.equal(empty.summary.total, 0);
  assert.equal(empty.summary.kgiRate, null);
});
