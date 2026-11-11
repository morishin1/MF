import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const staff=read("../sales/company-meeting.html");
const stages=read("../js/sales-meeting-five-stage.js");
const handoff=read("../js/sales-meeting-company-handoff.js");
const progress=read("../api/sales/company-offer-progress.js");
const meeting=read("../api/sales/meeting-session.js");

test("STEP4 company search and STEP5 offer confirmation are distinct and concise",()=>{
 assert.match(stages,/name:"候補検索・提案",min:10/);
 assert.match(stages,/name:"提案結果確認",min:4/);
 assert.match(stages,/name:"次回案内・完了",min:3/);
 assert.match(stages,/handoff\.hidden=viewed!==3/);
 assert.match(staff,/id="meeting-offer-receipt"/);
 assert.match(staff,/id="meeting-check-offer"/);
 assert.match(staff,/meeting-condensed/);
 assert.match(staff,/STEP 6：次回のご案内・完了/);
});

test("company can signal saved offer only to a verified Sales-origin window",()=>{
 assert.match(handoff,/window\.open\(portalUrl,"enger-company-offer"/);
 assert.match(handoff,/event\.origin!=="https:\/\/enger\.jp"/);
 assert.match(handoff,/event\.source!==companyWindow/);
 assert.match(handoff,/msg\.companyId!==companyId\|\|msg\.sessionId!==sessionId/);
 assert.match(handoff,/CustomEvent\("enger:company-offer-received"/);
 assert.doesNotMatch(handoff,/postMessage\(.*password/);
});

test("Sales session advances only when trusted API confirms a same-tenant offer since meeting started",()=>{
 assert.match(progress,/requireUser\(req,res\)/);
 assert.match(progress,/canSell\(ctx\)/);
 assert.match(progress,/canAccessEightEngerDirectory\(ctx\)/);
 assert.match(progress,/companyInScope\(db,ctx\.tenantId,companyId\)/);
 assert.match(progress,/\.eq\("id",sessionId\)\.eq\("company_id",companyId\)/);
 assert.match(progress,/\.eq\("tenant_id",ctx\.tenantId\)/);
 assert.match(progress,/\.gte\("created_at",session\.data\.started_at\)/);
 assert.match(stages,/if\(!proof\?\.hasOffer\|\|proof\.companyId!==companyId\|\|proof\.sessionId!==sessionId\)return/);
 assert.match(stages,/action:"save_step",stage:3/);
 assert.match(stages,/stage:4,version:current\.version/);
 assert.match(meeting,/step_check_required/);
 assert.match(stages,/let offerCheckBusy=false/);
});
