import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const get=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const ui=get("../js/sales-company-compact-proposal.js");
const batch=get("../api/sales/meeting-visible-publish.js");
const session=get("../api/sales/meeting-session.js");
const staff=get("../api/sales/company-meeting-screen.js");
const html=get("../sales/company-meeting.html");

test("candidates are all displayed without selection controls",()=>{
 assert.doesNotMatch(ui,/checkbox\.type="checkbox"/);
 assert.doesNotMatch(ui,/selected\.size/);
 assert.match(ui,/const list=sourceList\.filter/);
 assert.match(ui,/function visibleCandidates\(\)/);
 assert.match(ui,/go\.disabled=busy/);
 assert.match(ui,/候補がなくても、会社紹介から商談を開始できます/);
 assert.match(ui,/const go=mk\("button","商談"/);
});
test("starting sales meeting publishes precisely current visible eligible candidates",()=>{
 assert.match(ui,/\/api\/sales\/meeting-visible-publish/);
 assert.match(ui,/visibleCandidates\(\)/);
 assert.match(ui,/items:chosen\.map/);
 assert.match(ui,/selectedKeys:shared\.keys/);
 assert.doesNotMatch(ui,/staffUrl\.searchParams\.set\("selection"/);
 assert.match(batch,/requireUser\(req,res\)/);
 assert.match(batch,/canSell\(ctx\)/);
 assert.match(batch,/companyInScope\(db,ctx\.tenantId,companyId\)/);
 assert.match(batch,/filter\(isPublicTalent\)/);
 assert.match(batch,/filter\(jobAvailable\)/);
 assert.match(batch,/MAX_ITEMS=30/);
 assert.match(batch,/body\.confirmed!==true/);
});
test("meeting session handles zero to 30 candidates, always scoped by tenant/company",()=>{
 assert.match(session,/raw\.length>30/);
 assert.doesNotMatch(session,/raw\.length<1/);
 assert.match(session,/\.eq\("tenant_id",ctx\.tenantId\)/);
 assert.match(session,/\.eq\("company_id",companyId\)/);
 assert.match(staff,/sessionId/);
 assert.match(staff,/selected_keys/);
 assert.match(staff,/new Set\(keys\.map/);
 assert.match(html,/input\.set\("sessionId",params\.get\("sessionId"\)\)/);
});
test("calendar appears before the final meeting button; automatic issue stays in credential panel",()=>{
 assert.match(ui,/preflight\.append\(preHead,loginPanel,calendarHost,preMessage,preActions\)/);
 assert.match(ui,/const begin=mk\("button","商談画面を開く（ログイン不要）"/);
 assert.match(ui,/await calendar\?\.saveIfFilled\(\)/);
 assert.doesNotMatch(ui,/action:"generate_password"/);
 assert.doesNotMatch(ui,/action:"issue_account"/);
});
