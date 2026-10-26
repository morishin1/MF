// /sales ホーム：提案起点の指標。重複、役割別集計、期間外、失注理由、画面構文を守る。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { computeSalesDashboardMetrics } from "../lib/sales-dashboard-metrics.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const at = (d) => d + "T10:00:00+09:00";
const p = (id, extra = {}) => ({
  id, created_at: at("2026-10-12"), matched_at: at("2026-10-12"),
  sent_at: null, status: "proposal_wait", matching_owner_name: "起点担当" + id,
  sales_owner_id: "e1", cs_owner_id: null, closing_owner_id: null, handoff_stage: "proposal",
  close_reason: null, meeting_at: null, archived_at: null, ...extra,
});
const proposals = [
  p("won", { sent_at: at("2026-10-13"), status: "won", handoff_stage: "closing", cs_owner_id: "e2",
    closing_owner_id: "e3", meeting_at: at("2026-10-16") }),
  p("lost", { sent_at: at("2026-10-13"), status: "lost", close_reason: "filled" }),
  p("pending"),
  p("no_reply", { sent_at: at("2026-10-14"), status: "closed_no_reply", close_reason: "no_reply" }),
  p("past", { created_at: at("2026-08-01"), matched_at: at("2026-08-01"), status: "won" }),
  p("hidden", { archived_at: at("2026-10-15"), sent_at: at("2026-10-13") }),
];
const activities = [
  { proposal_id: "won", kind: "sent", employee_id: "e1", occurred_at: at("2026-10-13") },
  { proposal_id: "won", kind: "call", result: "connected", occurred_at: at("2026-10-13") },
  { proposal_id: "won", kind: "call", result: "connected", occurred_at: at("2026-10-13") },
  { proposal_id: "won", kind: "meeting", result: "done", occurred_at: at("2026-10-16") },
  { proposal_id: "lost", kind: "call", result: "no_answer", occurred_at: at("2026-10-13") },
];
const d = computeSalesDashboardMetrics(proposals, activities, {
  since: "2026-10-01", days: 30,
  nameOf: (id) => ({ e1: "提案実施者", e2: "CS担当", e3: "クロージング担当" })[id],
});
assert.equal(d.counts.matched, 4, "期間外・アーカイブは数えない");
assert.equal(d.counts.sent, 3);
assert.equal(d.counts.called, 2, "同じ提案への2回の電話は1件");
assert.equal(d.counts.meeting, 1);
assert.equal(d.counts.cs, 1);
assert.equal(d.counts.closing, 1);
assert.equal(d.counts.won, 1);
assert.equal(d.counts.lost, 2);
assert.equal(d.reasons.find((r) => r.key === "filled")?.count, 1);
assert.equal(d.reasons.find((r) => r.key === "no_reply")?.count, 1);
assert.equal(d.roles.proposal.find((r) => r.name === "提案実施者")?.won, 1);
assert.equal(d.roles.cs.find((r) => r.name === "CS担当")?.closing, 1);
assert.equal(d.roles.closing.find((r) => r.name === "クロージング担当")?.won, 1);
assert.equal(d.trend.reduce((n, x) => n + x.matched, 0), 4, "グラフの起票合計とKPIが一致する");
const empty = computeSalesDashboardMetrics([], [], { since: "2026-10-01", days: 30 });
assert.equal(empty.counts.sentRate, null, "分母0の転換率を0%として誤表示しない");
assert.equal(empty.roles.closing.length, 0);
assert.equal(computeSalesDashboardMetrics([p("x", { status: "considering" })], [], {
  since: "2026-10-01", days: 30,
}).counts.meeting, 0, "検討中を面談済みと扱わない");

// 1日＝JST当日、7日＝JST今日を含む直近7日間。
const dailyProposals = [
  p("yesterday", { matched_at: at("2026-10-21"), created_at: at("2026-10-21") }),
  p("today", { matched_at: at("2026-10-22"), created_at: at("2026-10-22"), sent_at: at("2026-10-22") }),
  p("seven-days-ago", { matched_at: at("2026-10-15"), created_at: at("2026-10-15") }),
  p("six-days-ago", { matched_at: at("2026-10-16"), created_at: at("2026-10-16") }),
];
const oneDay = computeSalesDashboardMetrics(dailyProposals, [], { since: "2026-10-22", days: 1 });
assert.equal(oneDay.counts.matched, 1, "1日は日本時間の当日だけ");
assert.equal(oneDay.trend.length, 1, "1日は日別1本");
assert.equal(oneDay.trend[0].matched, 1);
assert.equal(oneDay.trend[0].label, "10/22", "1日のグラフ表示は日付だけにする");
const sevenDays = computeSalesDashboardMetrics(dailyProposals, [], { since: "2026-10-16", days: 7 });
assert.equal(sevenDays.counts.matched, 3, "7日は当日を含む7日・8日前は除外");
assert.equal(sevenDays.trend.length, 7, "7日は日別の7本");
assert.equal(sevenDays.trend.reduce((sum, b) => sum + b.matched, 0), 3);
assert.equal(sevenDays.trend[0].matched, 1, "初日を含む");
assert.equal(sevenDays.trend[0].label, "10/16", "7日は日付を簡潔に表示する");

const jsInsights = read("js/sales-dashboard-insights.js");
assert.match(jsInsights, /\[1, 7, 30, 90, 365\]\.map/, "期間に1日と7日が表示される");
assert.match(jsInsights, /!\[1,7,30,90,365\]\.includes\(n\)/, "1日と7日が切替可能");
assert.match(read("api/sales/proposals/metrics.js"), /\[1, 7, 30, 90, 365\]\.includes\(requested\)/,
  "APIで1日と7日を許可");
new vm.Script(jsInsights);
const home = read("sales/index.html");
const inline = home.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inline);
new vm.Script(inline[1], { filename: "sales/index.html:inline" });
assert.ok(home.includes('SalesInsights.load()'), "ログイン後に提案分析を読み込む");
assert.ok(home.includes("rows.slice(0, 3)"), "企業一覧は上位3社");
assert.ok(home.includes('<details class="db-history"'), "履歴は折り畳む");
assert.ok(read("api/sales/proposals/metrics.js").includes('canManageProposals(ctx)'), "集計APIに役割確認がある");
console.log("sales-dashboard-metrics: PASS (cohort, 1/7/30/90/365 days, daily trend, roles, losses, syntax)");
