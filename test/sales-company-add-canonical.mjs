import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {Script} from "node:vm";
const source=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const layout=source("js/sales-layout.js");
const dashboard=source("sales/index.html");
const launcher=source("js/sales-meeting-launcher.js");
const segments=source("sales/company-segments.html");
const segmentsJs=source("js/sales-company-segments.js");
const tools=source("sales/company-tools.html");
const legacy=source("sales/companies.html");
const attack=source("sales/attack.html");
const api=source("api/sales/meeting-company.js");

test("all visible company-add entry points use one official company search",()=>{
 for(const [name,page] of [
   ["header",layout],["modern company list",segments],
   ["old company list",legacy],["CSV import",tools],["attack",attack]
 ]){
  assert.match(page,/\/sales\/\?companyAdd=1/,name);
  assert.doesNotMatch(page,/\/sales\/company-tools\.html\?new=1/,name);
 }
 assert.doesNotMatch(legacy,/id="q-url"/);
 assert.doesNotMatch(tools,/id="q-url"/);
 assert.doesNotMatch(legacy,/onclick="openAdd\(\)"/);
 assert.doesNotMatch(tools,/onclick="openAdd\(\)"/);
});
test("legacy bookmarks redirect to canonical addition, while CSV and sales detail remain",()=>{
 for(const html of [legacy,tools]){
  assert.match(html,/get\("new"\)/);
  assert.match(html,/location\.replace\("\/sales\/\?companyAdd=1"\)/);
  assert.match(html,/openBulkUrls/);
  assert.match(html,/openCsvImport/);
 }
 assert.match(segments,/href="\/sales\/company-tools\.html"/);
 assert.match(segments,/href="\/sales\/\?companyAdd=1"/);
 assert.match(segmentsJs,/initial\.get\('segment'\)/);
});
test("after Sales auth, registration-only opens the existing official search and never auto starts a meeting",()=>{
 assert.match(dashboard,/SalesLayout\.init/);
 assert.match(dashboard,/get\("companyAdd"\)==="1"/);
 assert.match(dashboard,/SalesMeetingLauncher\?\.openCompanyAdd\(\)/);
 assert.match(launcher,/window\.SalesMeetingLauncher=\{openCompanyAdd:\(\)=>open\(\{registration:true\}\)\}/);
 assert.match(launcher,/if\(registration\)chooseMode\("new"\)/);
 assert.match(launcher,/registration\?"この企業を登録する"/);
 assert.match(launcher,/if\(!registrationOnly\)dest\.set\("meeting","info"\)/);
 assert.match(launcher,/window\.location\.assign\("\/sales\/company-segments\.html\?"/);
 assert.match(launcher,/dialog\.addEventListener\("close"/);
});
test("registered companies are selected through official NTA/gBiz lookup and duplicate-check RPC",()=>{
 assert.match(launcher,/mode:"number"/);
 assert.match(launcher,/mode:"name"/);
 assert.match(launcher,/\/api\/sales\/meeting-company/);
 assert.match(api,/canSell\(ctx\)/);
 assert.match(api,/canAccessEightEngerDirectory\(ctx\)/);
 assert.match(api,/lookupMeetingCompanyNumber\(body\.corporateNumber\)/);
 assert.match(api,/precheck\.reviewExisting/);
 assert.match(api,/precheck\.existingCompanyId/);
 assert.match(api,/gw_sales_register_meeting_company/);
});
test("canonical links resolve to existing Sales files, and scripts parse",()=>{
 for(const p of ["sales/index.html","sales/company-segments.html","sales/company-tools.html","sales/companies.html","sales/analytics.html"]){
  assert.ok(existsSync(new URL("../"+p,import.meta.url)),p);
 }
 for(const js of [layout,launcher,segmentsJs])assert.doesNotThrow(()=>new Script(js.replace(/^import[^\n]+\n/g,"")),js.slice(0,40));
 for(const html of [dashboard,tools,legacy,segments]){
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for(const [,script] of scripts)assert.doesNotThrow(()=>new Script(script));
 }
});
