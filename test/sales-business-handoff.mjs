import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const page=read("../sales/company-meeting.html");
const nav=read("../js/sales-meeting-five-stage.js");
const auth=read("../js/sales-meeting-company-handoff.js");
const popup=read("../js/sales-company-compact-proposal.js");
const css=read("../css/sales-company-stepper.css");
const closeout=read("../api/sales/meeting-closeout.js");

test("company offers are the source of truth when closing after customer-side selection",()=>{
 assert.match(closeout,/\.from\("dx2_company_portal_offers"\)/);
 assert.match(closeout,/\.eq\("tenant_id",ctx\.tenantId\)\.eq\("company_id",companyId\)/);
 assert.match(closeout,/\.gte\("created_at",session\.data\.started_at\)/);
 assert.match(closeout,/companyOfferCount/);
 assert.match(closeout,/mailConfig\("portal"\)/);
});
