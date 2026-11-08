import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const brief=get("../api/sales/company-meeting-brief.js");
const ui=get("../js/sales-company-compact-proposal.js");
const calendar=get("../js/sales-company-meeting-calendar.js");
const sales=get("../sales/company-segments.html");
const tabs=get("../js/sales-company-portal-tabs.js");
test("meeting brief loads the public talent visibility guard",()=>{
 assert.match(brief,/import\s*\{[^}]*isPublicTalent[^}]*\}\s*from\s*["\x27]\.\.\/\.\.\/lib\/enger-talent-public\.js/);
 assert.match(brief,/filter\(t=>isPublicTalent\(t\)/);
});
test("AI default falls back to ENGER candidates and displays all eligible items",()=>{
 assert.match(ui,/mode="recommended"/);
 assert.match(ui,/const starter=\{job:\[\],talent:\[\]\}/);
 assert.match(ui,/登録候補（未照合）/);
 assert.match(ui,/mode:"search",type:"job"/);
 assert.match(ui,/company-talents\?/);
 assert.match(ui,/function visibleCandidates\(\)/);
 assert.doesNotMatch(ui,/checkbox\.type="checkbox"/);
});
test("calendar and company login remain inside modal, candidate view first",()=>{
 assert.match(ui,/const preflight=mk\("dialog"/);
 assert.match(ui,/preflight\.append\(preHead,preInfo,loginPanel,calendarHost,preMessage,preActions\)/);
 assert.doesNotMatch(ui,/wrap\.append\(calendarHost\)/);
 assert.match(ui,/mk\("button","商談","lp-compact-go"\)/);
 assert.match(ui,/preflight\.showModal\(\)/);
 assert.match(ui,/await calendar\?\.saveIfFilled\(\)/);
 assert.match(ui,/staffUrl\.searchParams\.set\("sessionId",sessionId\)/);
 assert.match(calendar,/async function saveIfFilled/);
});
test("matching and public validation stay intact",()=>{
 assert.match(tabs,/const STAGES = \["info","analysis","proposal"\]/);
 assert.match(ui,/\/api\/sales\/meeting-visible-publish/);
 assert.match(ui,/confirmed:true/);
 assert.match(sales,/sales-company-stepper\.css\?v=20261108visible1/);
});