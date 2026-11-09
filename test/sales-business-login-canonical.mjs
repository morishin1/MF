import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {portalBaseUrl,loginUrl} from "../lib/sales-company-portal.js";
const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const workflow=read("../api/sales/company-workflow-status.js");
const creds=read("../js/sales-company-meeting-credentials.js");
const staff=read("../sales/company-meeting.html");
const modal=read("../js/sales-company-compact-proposal.js");
test("business login URLs use consistent canonical ENGER origin",()=>{
 const preview="https://enger-lp-git-fix-business-login-and-all-07bed3-eight-s-projects.vercel.app";
 assert.equal(loginUrl({ENGER_PORTAL_BASE_URL:preview}),preview+"/business/login");
 assert.equal(portalBaseUrl({ENGER_PORTAL_BASE_URL:preview}),preview);
 assert.match(workflow,/configuredPortal=portalBaseUrl\(\)/);
 assert.match(workflow,/process\.env\.VERCEL_ENV==="preview"/);
 assert.match(staff,/\/business\/login/);
 assert.doesNotMatch(staff,/\/company-portal\/login\.html/);
});
test("business login is generated once and never reset by regular meeting",()=>{
 assert.match(modal,/go\.onclick=\(\)=>/);
 assert.match(modal,/credentialPanel\?\.setVisible\(true\)/);
 assert.doesNotMatch(modal,/action:"generate_password"/);
 assert.doesNotMatch(modal,/action:"issue_account"/);
 assert.match(creds,/action:"ensure_meeting_account"/);
 assert.match(creds,/if\(active\(\)\.length\|\|pending\(\)\.length\)return/);
 assert.match(creds,/action:"generate_password"/,"explicit Sales reset is allowed");
 assert.match(creds,/confirm\("この企業の現在のパスワードを無効にし/,"reset requires confirmation");
 assert.match(creds,/function setVisible\(next\)/);
});
test("password is never put in URL, localStorage or company DB",()=>{
 assert.doesNotMatch(staff,/searchParams\.set\("password"/);
 assert.doesNotMatch(modal,/searchParams\.set\("password"/);
 assert.doesNotMatch(creds,/localStorage|sessionStorage/);
 assert.match(creds,/if\(!visible\)\{[\s\S]*?forgetSecret\(\)/);
});
