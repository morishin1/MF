import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=(path)=>readFileSync(new URL(path,import.meta.url),"utf8");
const brief=get("../api/sales/company-meeting-brief.js");
const ui=get("../js/sales-company-compact-proposal.js");
const calendar=get("../js/sales-company-meeting-calendar.js");
const sales=get("../sales/company-segments.html");
const tabs=get("../js/sales-company-portal-tabs.js");
test("meeting brief imports the public-talent visibility check and does not use it undefined",()=>{
 assert.match(brief,/import\s*\{[^}]*isPublicTalent[^}]*\}\s*from\s*["\x27]\.\.\/\.\.\/lib\/enger-talent-public\.js/);
 assert.match(brief,/filter\(t=>isPublicTalent\(t\)/);
});
test("AI default is visible and falls back to recent ENGER candidates with honest labels",()=>{
 assert.match(ui,/mode="recommended"/);
 assert.match(ui,/const starter=\{job:\[\],talent:\[\]\}/);
 assert.match(ui,/登録候補（未照合）/);
 assert.match(ui,/mode:"search",type:"job"/);
 assert.match(ui,/company-talents\?/);
 assert.match(ui,/rec\[which\]\.length\?rec\[which\]:starter\[which\]/);
});
test("calendar and credentials appear inside meeting preflight modal, not first candidate view",()=>{
 assert.match(ui,/const preflight=mk\("dialog"/);
 assert.match(ui,/preflight\.append\(preHead,preInfo,calendarHost,loginDetails,preMessage,preActions\)/);
 assert.doesNotMatch(ui,/wrap\.append\(calendarHost\)/);
 assert.doesNotMatch(ui,/go\.hidden=true/);
 assert.match(ui,/mk\("button","商談","lp-compact-go"\)/);
 assert.match(ui,/preflight\.showModal\(\)/);
 assert.match(ui,/await calendar\?\.saveIfFilled\(\)/);
 assert.match(ui,/staffUrl\.searchParams\.set\("sessionId",sessionId\)/);
 assert.match(calendar,/async function saveIfFilled/);
 assert.match(calendar,/if\(!datetime\.value && !url\.value\.trim\(\)\)return null/);
});
test("existing 3-step matching and privacy checks stay present",()=>{
 assert.match(tabs,/const STAGES = \["info","analysis","proposal"\]/);
 assert.match(ui,/API\.api\("\/api\/sales\/company-shortlist"/);
 assert.match(ui,/action:"publish",confirmed:true/);
 assert.match(sales,/sales-company-stepper\.css\?v=20261108preflight1/);
});