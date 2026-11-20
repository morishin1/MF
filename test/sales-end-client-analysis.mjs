import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  periodStartJst, SUPPLY_ROLE_TITLES,
  summarizeEngagements, summarizeEngerProposals, summarizeEndClientCoverage,
} from "../lib/sales-end-client-analysis.js";

test("日付範囲はJSTの当日を含む30/90/365日だけを許可する", () => {
  const now = new Date("2026-11-19T15:05:00Z"); // 2026-11-20 00:05 JST
  assert.equal(periodStartJst(30, now), "2026-10-22T00:00:00+09:00");
  assert.throws(() => periodStartJst(7, now), /invalid_period/);
  assert.ok(SUPPLY_ROLE_TITLES.includes("クラウドエンジニア"));
});

test("稼働の入力状態を人数や売上の確定値に変換しない", () => {
  const rows = [
    { company: " A株式会社 ", status: "稼働中", end_date: null, proposal_id: null },
    { company: "A株式会社", status: "稼働中", end_date: "2025-11-30", proposal_id: "p" },
    { company: "B株式会社", status: "予定", end_date: null, proposal_id: null },
  ];
  assert.deepEqual(summarizeEngagements(rows), {
    totalRecords: 3, statusWorking: 2, statusPlanned: 1,
    companyNames: 2, endDateMissing: 2, withProposalId: 1,
  });
  assert.deepEqual(summarizeEngagements([]), {
    totalRecords: 0, statusWorking: 0, statusPlanned: 0,
    companyNames: 0, endDateMissing: 0, withProposalId: 0,
  });
});

test("見送り・失注はステージ別に数え、理由は個人情報を返さず分類する", () => {
  const rows = [
    { stage: "見送り", lost_reason_category: "A1: スキル不足/アンマッチ" },
    { stage: "失注", lost_reason: "E1: 担当者と連絡つかず" },
    { stage: "失注", lost_reason: "A4: 人材側辞退" },
    { stage: "見送り", lost_reason: "単価が高い" },
    { stage: "提案中" },
    { stage: "合格" },
  ];
  const result = summarizeEngerProposals(rows);
  assert.equal(result.totalRecords, 6);
  assert.equal(result.lostRecords, 2);
  assert.equal(result.rejectedRecords, 2);
  assert.equal(result.proposingRecords, 1);
  assert.equal(result.goodStageRecords, 1);
  assert.equal(result.lossReasons.reduce((n, row) => n + row.count, 0), 4);
  assert.ok(result.lossReasons.some((x) => x.label === "連絡・フォロー不成立" && x.count === 1));
  assert.ok(result.lossReasons.some((x) => x.label === "人材側の辞退" && x.count === 1));
  assert.ok(result.lossReasons.every((x) => !x.label.includes("担当者と連絡つかず")));
});

test("エンド企業フラグの数と業種・規模のカバレッジを分ける", () => {
  const result = summarizeEndClientCoverage([
    { industry: "製造業", employee_band: null },
    { industry: "製造業", employee_band: "100-299" },
    { industry: null, employee_band: null },
  ]);
  assert.equal(result.flaggedCount, 3);
  assert.equal(result.industryKnown, 2);
  assert.equal(result.sizeKnown, 1);
  assert.deepEqual(result.industries, [{ label: "製造業", count: 2 }]);
});

test("Sales分析の既存2タブを残し、閲覧制限つきのエンド営業を追加する", () => {
  const html = readFileSync(new URL("../sales/analytics.html", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api/sales/end-client-analysis.js", import.meta.url), "utf8");
  for (const id of ["an-tab-proposal", "an-tab-attack", "an-tab-end", "an-end-body"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /SalesEndClientAnalysis\.load\(days\)/);
  assert.match(api, /canAccessEightEngerDirectory\(ctx\)/);
  assert.match(api, /canSell\(ctx\)/);
  assert.match(api, /canManageProposals\(ctx\)/);
  assert.match(api, /Cache-Control/);
});
