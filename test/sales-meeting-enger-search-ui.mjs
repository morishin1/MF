import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
const page=readFileSync(new URL("../sales/company-meeting.html",import.meta.url),"utf8");
const flow=readFileSync(new URL("../js/sales-meeting-five-stage.js",import.meta.url),"utf8");
const handoff=readFileSync(new URL("../js/sales-meeting-company-handoff.js",import.meta.url),"utf8");
const api=readFileSync(new URL("../api/sales/company-meeting-screen.js",import.meta.url),"utf8");
const pwdApi=readFileSync(new URL("../api/sales/company-portal.js",import.meta.url),"utf8");

test("step4 shows a large ENGER enterprise search card before the company login panel",()=>{
 assert.ok(page.indexOf('id="meeting-proposals"')<page.indexOf('id="meeting-company-handoff"'));
 for(const text of ["人材・案件を今すぐ探す","例：Java、AWS、PMO、リモート",
   "data-meeting-kind=\"all\"","data-meeting-kind=\"talent\"",
   "data-meeting-kind=\"job\"","id=\"meeting-candidate-query\"",
   "id=\"meeting-search-submit\"","meeting-search-popular",
   "id=\"jobs\"","id=\"talents\""]) {
  assert.ok(page.includes(text),"missing "+text);
 }
 assert.match(page,/\.meeting-business-search #meeting-candidate-query\{[^}]*min-height:60px/);
 assert.match(page,/\.meeting-search-kind button\[aria-pressed=true\]/);
 assert.match(page,/\.meeting-search-submit\{[^}]*#C0521F/);
 assert.match(page,/document\.querySelectorAll\("\[data-meeting-kind\]"\)/);
 assert.match(page,/document\.querySelectorAll\("\[data-meeting-quick\]"\)/);
});

test("step4 search is visible only for approved candidate data, not staffPreview reference data",()=>{
 assert.match(flow,/proposals\.hidden=viewed!==3\|\|qs\.get\("staffPreview"\)==="1"/);
 assert.match(flow,/never|Never|公開済み/);
 assert.match(api,/readPublicCandidates/);
 assert.match(page,/id="meeting-filter-count"/);
 assert.match(page,/params\.get\("staffPreview"\)==="1"/);
 assert.match(page,/reference:true/);
 assert.match(flow,/公開済みの候補を検索中です/);
});

test("existing company login remains actionable in step4, without credential disclosure",()=>{
 assert.match(page,/id="meeting-company-reset" hidden disabled/);
 assert.match(handoff,/action:"generate_password",memberId:active\[0\]\.id,confirmed:true/);
 assert.match(handoff,/activeStage===0\|\|activeStage===3/);
 assert.match(pwdApi,/if \(body\.action === "generate_password"\)/);
 assert.match(pwdApi,/newTemporaryPassword\(\)/);
 assert.match(pwdApi,/gte\("created_at",since\)/);
 assert.match(handoff,/secretTimer=setTimeout\(clearSecret,120000\)/);
 assert.doesNotMatch(handoff,/localStorage|sessionStorage/);
});

test("search interactions and staff navigation scripts parse",()=>{
 const inline=page.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/);
 assert.ok(inline,"missing inline search script");
 assert.doesNotThrow(()=>new Script(inline[0].slice(8,-9)));
 assert.doesNotThrow(()=>new Script(flow));
 assert.doesNotThrow(()=>new Script(handoff));
});
