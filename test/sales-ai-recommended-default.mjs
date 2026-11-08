import test from "node:test"; import assert from "node:assert/strict"; import {readFileSync} from "node:fs";
const ui=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
const api=readFileSync(new URL("../api/sales/company-meeting-brief.js",import.meta.url),"utf8");
test("AI candidates are default, top 3 then expand",()=>{assert.match(ui,/mode="recommended"/);assert.match(ui,/AIおすすめ候補（自動表示）/);assert.match(ui,/rec\[which\]\.slice\(0,3\)/);assert.match(ui,/もっと見る/)});
test("optional legacy analysis does not hide completed cloud research",()=>{assert.match(api,/analysis\.error\?null/);assert.match(api,/cloudDemandHintSkills\(cloud,skillTerms\)/)});