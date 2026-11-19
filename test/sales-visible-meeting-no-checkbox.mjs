import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const get=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const ui=get("../js/sales-company-compact-proposal.js");
const batch=get("../api/sales/meeting-visible-publish.js");
const session=get("../api/sales/meeting-session.js");
const staff=get("../api/sales/company-meeting-screen.js");
const html=get("../sales/company-meeting.html");

test("meeting session handles zero to 30 candidates, always scoped by tenant/company",()=>{
 assert.match(session,/raw\.length>30/);
 assert.doesNotMatch(session,/raw\.length<1/);
 assert.match(session,/\.eq\("tenant_id",ctx\.tenantId\)/);
 assert.match(session,/\.eq\("company_id",companyId\)/);
 assert.match(staff,/sessionId/);
 assert.match(staff,/selected_keys/);
 assert.match(staff,/new Set\(keys\.map/);
 assert.match(html,/target\.set\(\x27sessionId\x27/);
});
