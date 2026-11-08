import test from "node:test"; import assert from "node:assert/strict"; import {readFileSync} from "node:fs";
const api=readFileSync(new URL("../api/sales/meeting-session.js",import.meta.url),"utf8");
const staff=readFileSync(new URL("../sales/company-meeting.html",import.meta.url),"utf8");
const controller=readFileSync(new URL("../js/sales-meeting-five-stage.js",import.meta.url),"utf8");
const stage2=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
test("company meeting session can only be read and updated after staff authentication",()=>{ assert.match(api,/requireUser\(req,res\)/); assert.match(api,/canSell\(ctx\)/); assert.match(api,/canAccessEightEngerDirectory\(ctx\)/); assert.match(api,/companyInScope\(db/); });
test("meeting session is scoped by tenant and company",()=>{assert.match(api,/\.eq\("tenant_id",ctx\.tenantId\)/);assert.match(api,/\.eq\("company_id",companyId\)/);assert.match(api,/selection_not_published/);assert.match(api,/eq\("version",current\.version\)/);});
test("shared stages are adjacent and audited",()=>{assert.match(api,/Math\.abs\(body\.stage-current\.stage\)!==1/);assert.match(api,/gw_sales_live_meeting_stage_events/);assert.match(controller,/setInterval/);assert.match(controller,/3000/);});
test("staff opens same selection and requires no customer password",()=>{assert.match(stage2,/api\/sales\/meeting-session/);assert.match(stage2,/staffUrl\.searchParams\.set\("sessionId",sessionId\)/);assert.match(staff,/meeting-stages/);assert.match(staff,/business\/login/);});