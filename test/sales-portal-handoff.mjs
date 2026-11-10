import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const nav=read("../js/sales-meeting-five-stage.js");
const page=read("../sales/company-meeting.html");
const preflight=read("../js/sales-company-compact-proposal.js");
const closeout=read("../api/sales/meeting-closeout.js");

test("30-minute arrow workflow starts with icebreak and changes to external company page from stage four",()=>{
 const times=[...nav.matchAll(/min:(\d+)/g)].map(x=>Number(x[1]));
 assert.deepEqual(times,[2,4,7,10,4,3]);
 assert.equal(times.reduce((a,b)=>a+b,0),30);
 for(const stage of ["アイスブレーク","会社概要","課題・目的確認","企業ページで候補検索","オファー確認","クロージング"])
  assert.ok(nav.includes(stage));
 assert.match(nav,/meeting-stage-arrow/);
 assert.match(nav,/label\("span","→"\)/);
 assert.match(nav,/proposals\.hidden=true/);
 assert.match(nav,/handoff\.hidden=viewed!==3&&viewed!==4/);
 assert.match(nav,/intro\.hidden=viewed!==1/);
 assert.match(page,/id="meeting-business-handoff"/);
 assert.match(page,/id="meeting-proposals" hidden/);
});
test("company credentials are explicit, one-time and scoped to logged-in Sales not guessed",()=>{
 assert.match(nav,/\/api\/sales\/company-portal\?/);
 assert.match(nav,/action:"ensure_meeting_account"/);
 assert.match(nav,/action:"generate_password"/);
 assert.match(nav,/if\(reset&&!confirm\(/);
 assert.match(nav,/password\.length===8/);
 assert.match(nav,/120000/);
 assert.match(nav,/active\.length>0/);
 assert.match(nav,/row\?\.contactReady===false/);
 assert.match(page,/id="meeting-company-login-id"/);
 assert.match(page,/id="meeting-company-password"/);
 assert.match(page,/id="meeting-open-business-page"/);
 assert.match(nav,/new URL\("https:\/\/enger\.jp\/business\/login"\)/);
 assert.match(nav,/new URL\("\/business\/meeting"/);
 assert.doesNotMatch(nav,/localStorage|sessionStorage/);
});
test("meeting preflight has one visible action and only company ID+summary",()=>{
 assert.match(preflight,/preflight\.append\(preHead,identityPanel,preMessage,preActions\)/);
 assert.match(preflight,/preActions\.append\(begin\)/);
 assert.match(preflight,/mk\("button","商談画面を開く","lp-meeting-preflight-next"\)/);
 assert.match(preflight,/const identitySummary=mk\(/);
 assert.match(preflight,/const identityId=mk\(/);
 assert.doesNotMatch(preflight,/preHead\.append\(preTitle,beginTop,preClose\)/);
 assert.doesNotMatch(preflight,/preflight\.append\(preHead,loginPanel,calendarHost/);
});
test("Sales closeout records actual same-company offers created after start",()=>{
 assert.match(closeout,/dx2_company_portal_offers/);
 assert.match(closeout,/\.eq\("tenant_id",ctx\.tenantId\)/);
 assert.match(closeout,/\.eq\("company_id",companyId\)\.gte\("created_at",session\.data\.started_at\)/);
 assert.match(closeout,/const received=\(portalOffers\.data\|\|\[\]\)/);
 assert.match(closeout,/const offered=\[\.\.\.new Set\(\[\.\.\.requested,\.\.\.received\]\)\]/);
 assert.match(closeout,/if\(input\.outcome==="offer"&&!offered\.length\)/);
 assert.match(closeout,/status:"closed"/);
 assert.doesNotMatch(closeout,/select\("\*"\)/);
});
