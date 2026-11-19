import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const ui=get("../js/sales-company-compact-proposal.js");
const page=get("../sales/company-meeting.html");
const css=get("../css/sales-company-stepper.css");
const session=get("../api/sales/meeting-session.js");
const company=get("../api/sales/company-meeting-screen.js");
const portal=get("../api/sales/company-portal.js");
const credentials=get("../js/sales-company-meeting-credentials.js");
const handoff=get("../js/sales-meeting-company-handoff.js");

test("STEP1 can issue only the existing scoped company-ID login once, without email",()=>{
 assert.match(portal,/body\.action==="ensure_meeting_account"/);
 assert.match(portal,/body\.confirmed!==true/);
 assert.match(portal,/companyIdOnlyEmail\(company\.id\)/);
 assert.match(portal,/company_login_only:true/);
 assert.match(portal,/detail:\{method:"sales_company_number_issue",passwordStored:false,mailSent:false\}/);
 assert.match(handoff,/action:"ensure_meeting_account",confirmed:true/);
 assert.match(handoff,/members\.length>0/);
 assert.match(handoff,/if\(!confirm\(/);
 assert.match(ui,/ENGER商談を開始/);
 assert.doesNotMatch(ui,/company-demo\+/);
 assert.match(credentials,/初回発行/);
});
