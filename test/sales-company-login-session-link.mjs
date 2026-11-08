import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const ui=get("../js/sales-company-compact-proposal.js");
const credential=get("../js/sales-company-meeting-credentials.js");
const publish=get("../api/sales/meeting-visible-publish.js");
const calendar=get("../api/sales/company-meeting-calendar.js");

test("enterprise login button prepares published candidates and a meeting session before visiting the login URL",()=>{
 assert.match(credential,/onLogin:openCompanyLogin|typeof onLogin==="function"/);
 assert.match(credential,/候補を準備して企業ログイン/);
 assert.match(ui,/onLogin:openCompanyLogin/);
 assert.match(ui,/async function prepareSession\(\)/);
 assert.match(ui,/async function openCompanyLogin\(rawUrl,mode\)/);
 assert.match(ui,/const prepared=await prepareSession\(\)/);
 assert.match(ui,/url\.searchParams\.set\("next",next\)/);
 assert.match(ui,/&session=/);
 assert.match(ui,/window\.open\("about:blank","_blank"\)/);
 assert.doesNotMatch(ui,/searchParams\.set\("password"/);
});
test("all currently eligible talents/jobs are published without leaking stale or private rows",()=>{
 assert.match(publish,/const shareable=items\.filter/);
 assert.match(publish,/approvedTalents\.has/);
 assert.match(publish,/approvedJobs\.has/);
 assert.match(publish,/skippedCount/);
 assert.match(publish,/requireUser\(req,res\)/);
 assert.match(publish,/canSell\(ctx\)/);
 assert.match(publish,/body\.confirmed!==true/);
 assert.match(publish,/filter\(isPublicTalent\)/);
 assert.match(publish,/filter\(jobAvailable\)/);
});
test("preview calendar goes to the same ENGER portal as credentials",()=>{
 assert.match(calendar,/portalBaseUrl\(\)\+"\/business\/meeting/);
});
