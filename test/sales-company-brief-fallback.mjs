// Regressions: saved research must never be represented as "no analysis" when match brief API fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const tabs=readFileSync(new URL("../js/sales-company-portal-tabs.js",import.meta.url),"utf8");
const compact=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
const brief=readFileSync(new URL("../api/sales/company-meeting-brief.js",import.meta.url),"utf8");
test("missing match brief does not silently map to 0 matches",()=>{
  assert.match(tabs,/loadError/);
  assert.match(tabs,/照合結果を取得できていません/);
  assert.match(tabs,/lastPrepAnalysisAt!==analysisAt/);
  assert.match(tabs,/previousAnalysisAt!==updatedAnalysisAt/);
  assert.match(compact,/取得できていません/);
  assert.match(compact,/照合できなかったため件数は未確定/);
  assert.match(compact,/再取得/);
  assert.doesNotMatch(tabs,/basis:"企業の確認済みニーズ・分析条件が未登録"/);
});
test("API leaves an actionable error code in logs without leaking company records",()=>{
  assert.match(brief,/\[sales\/company-meeting-brief\] read_failed/);
  assert.match(brief,/\[sales\/company-meeting-brief\] unexpected/);
});
