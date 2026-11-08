import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const ui=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
const api=readFileSync(new URL("../api/sales/company-meeting-brief.js",import.meta.url),"utf8");
test("AI candidates are default; all visible items are shown without checkboxes",()=>{
 assert.match(ui,/mode="recommended"/);
 assert.match(ui,/候補一覧・AIおすすめ/);
 assert.match(ui,/const list=sourceList\.filter/);
 assert.match(ui,/visibleCandidates\(\)/);
 assert.doesNotMatch(ui,/checkbox\.type="checkbox"/);
});
test("optional legacy analysis does not hide saved cloud research",()=>{
 assert.match(api,/analysis\.error\?null/);
 assert.match(api,/cloudDemandHintSkills\(cloud,skillTerms\)/);
});