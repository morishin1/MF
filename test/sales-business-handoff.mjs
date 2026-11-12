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

test("the staff navigator begins with icebreak, stays six steps and has arrow navigation",()=>{
 assert.match(nav,/name:"アイスブレーク・会社概要",min:4/);
 assert.match(nav,/name:"企業ページで検索",min:10/);
 assert.match(nav,/name:"ご案内・終了",min:3/);
 assert.match(nav,/i<STEPS\.length-1\?" →":""/);
 assert.match(page,/\.meeting-stage\{[^}]*clip-path:polygon/);
 assert.match(nav,/meeting-talk-flow/);
 assert.match(page,/meeting-talk-flow/);
 assert.match(nav,/アイスブレーク/);
});

test("customer candidates never render inside staff's coaching navigator after step 4",()=>{
 assert.match(nav,/proposals\.hidden=true/);
 assert.match(nav,/handoff\.hidden=viewed!==3/);
 assert.match(nav,/offerPanel\.hidden=viewed<4\|\|viewed>5/);
 assert.match(nav,/panel\.hidden=viewed>=3/);
 assert.match(page,/id="meeting-company-handoff"/);
 assert.match(page,/id="meeting-company-open"/);
 assert.match(page,/id="meeting-company-password"/);
 assert.match(page,/id="meeting-offer-result"/);
 assert.match(page,/id="meeting-step5-outcome"/);
 assert.ok(page.indexOf('id="meeting-step5-outcome"')>page.indexOf('id="meeting-closeout"'),'STEP 5 outcome sits inside the shared STEP 5–6 panel');
 assert.match(nav,/closing\.hidden=viewed<4\|\|viewed>5/);
 assert.match(nav,/s\.stage!==5/,'email send stays locked until the internal sixth step');
 assert.match(page,/sales-meeting-company-handoff\.js\?v=20261111handoff1/);
});

test("company login is issued only via a validated explicit action; never stored in a URL",()=>{
 assert.match(auth,/company-portal\?/);
 assert.match(auth,/action:"ensure_meeting_account"/);
 assert.match(auth,/action:"generate_password"/);
 assert.match(auth,/contactReady/);
 assert.match(auth,/canIssue/);
 assert.match(auth,/confirm\(/);
 assert.match(auth,/if\(result\?\.temporaryPassword\)showSecret\(result\.temporaryPassword\)/);
 assert.doesNotMatch(auth,/localStorage|sessionStorage/);
 assert.doesNotMatch(auth,/password=\+|searchParams\.set\("password"/);
 assert.match(auth,/oneTimeTimer=setTimeout\(eraseSecret,120000\)/);
 assert.match(auth,/\/business\/meeting\?companyId=/);
});

test("preflight is simplified to one actionable meeting button with company ID and summary",()=>{
 assert.match(popup,/preflight\.append\(preHead,summaryPanel,loginPanel,calendarHost,preMessage,preActions\)/);
 assert.match(popup,/preActions\.append\(begin\)/);
 assert.match(popup,/const summaryPanel=mk/);
 assert.match(popup,/企業ID：確認中/);
 assert.match(css,/lp-meeting-preflight-summary/);
 assert.match(css,/lp-meeting-preflight-topstart\[hidden\]/);
});

test("company offers are the source of truth when closing after customer-side selection",()=>{
 assert.match(closeout,/\.from\("dx2_company_portal_offers"\)/);
 assert.match(closeout,/\.eq\("tenant_id",ctx\.tenantId\)\.eq\("company_id",companyId\)/);
 assert.match(closeout,/\.gte\("created_at",session\.data\.started_at\)/);
 assert.match(closeout,/companyOfferCount/);
 assert.match(closeout,/mailConfig\("portal"\)/);
});
