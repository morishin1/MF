// 経営日報PREP: 根拠のある出力・本人のみ閲覧・セキュリティの回帰テスト。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWeeklyPrepMarkdown, PREP_SECTIONS } from "../lib/weekly-prep-report.js";

const base = {
  from: "2026-11-02", to: "2026-11-08",
  employees: [{ id: "empA", user_id: "uA", display_name: "社員A", department: "営業" }],
  nippos: [
    { id: "x", user_id: "uA", work_date: "2026-11-03", submitted_at: "2026-11-03T10:00:00Z",
      goal_today: "企業提案3社", kgi_target: 3, kgi_actual: 4, kgi_achieved: true,
      work_items: [{ task: "A社へ提案", result: "送信した", done: true }],
      consult_note: "送信後の交渉を相談", improved_note: "文章を見直した" },
    { id: "morning", user_id: "uA", work_date: "2026-11-04", submitted_at: null, kgi_achieved: false,
      work_items: [{ task: "未提出の朝の予定", done: false }] },
    { id: "other", user_id: "uZ", work_date: "2026-11-04", submitted_at: "2026-11-04T10:00:00Z",
      consult_note: "他社社員の機密情報" },
  ],
  reviews: [{ user_id: "uA", week_start: "2026-11-02", q1: "提案数が増えた", q2: "確認を徹底した",
    q3: "改善する", q4: "来週面談2件" }],
  previousReviews: [{ user_id: "uA", week_start: "2026-10-26", q3: "毎朝確認", q4: "提案3社" }],
};
test("選択社員の提出済み日報とKPI・前週の振り返りだけを出力する", () => {
  const md = buildWeeklyPrepMarkdown(base);
  assert.match(md, /PREP分析プロンプト/);
  assert.match(md, /2026-11-02 〜 2026-11-08/);
  assert.match(md, /社員A/);
  assert.match(md, /企業提案3社/);
  assert.match(md, /1\/1記録日/);
  assert.match(md, /毎朝確認/);
  assert.doesNotMatch(md, /未提出の朝の予定/);
  assert.doesNotMatch(md, /他社社員の機密情報/);
  for (const section of PREP_SECTIONS) assert.ok(md.includes("## " + section));
});
test("日報に記録されないKGIは0%と扱わない", () => {
  const md = buildWeeklyPrepMarkdown({ ...base, nippos: [{ ...base.nippos[0], kgi_achieved: null, kgi_target: null, kgi_actual: null }] });
  assert.match(md, /KGI達成：判定の記録なし/);
});
test("経営出力と本人APIの境界が異なり、下書きが見えない", () => {
  const owner = readFileSync(new URL("../api/keiei/weekly-prep.js", import.meta.url), "utf8");
  const mine = readFileSync(new URL("../api/nippo/feedback.js", import.meta.url), "utf8");
  const sql = readFileSync(new URL("../db/162_gw_weekly_prep_feedback.sql", import.meta.url), "utf8");
  assert.match(owner, /requireKeiei\(req, res\)/);
  assert.match(owner, /rosterOf\(sb, ctx\.tenantId\)/);
  assert.match(mine, /employee_id", ctx\.employee\.id/);
  assert.match(mine, /eq\("status", "published"\)/);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all .* from public, anon, authenticated/i);
});
