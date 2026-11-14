import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const page=source("../sales/company-meeting.html");
const handoff=source("../js/sales-meeting-company-handoff.js");
const api=source("../api/sales/company-portal.js");

test("existing account no longer leaves a disabled first-issuance button without an alternative",()=>{
 assert.match(page,/id="meeting-company-issue"/);
 assert.match(page,/id="meeting-company-reset" hidden disabled/);
 assert.match(handoff,/reset\.hidden=!\(members\.length===1&&active\.length===1\)/);
 assert.match(handoff,/reset\.disabled=!canIssue\|\|reset\.hidden/);
 assert.match(handoff,/パスワードを表示できません/);
});

test("rotation only follows explicit confirmation and server-side member scope",()=>{
 assert.match(handoff,/reset\.addEventListener\("click"/);
 assert.match(handoff,/if\(members\.length!==1\|\|active\.length!==1\|\|portalState\?\.canIssue!==true\)/);
 assert.match(handoff,/if\(!confirm\("この企業の現在のパスワードを無効にし/);
 assert.match(handoff,/action:"generate_password",memberId:active\[0\]\.id,confirmed:true/);
 assert.match(api,/body\.action === "generate_password"/);
 assert.match(api,/body\.confirmed!==true/);
 assert.match(api,/authUser\.email\|\|""/);
 assert.match(api,/rate_limited/);
});

test("rotation does not disclose old passwords and only shows the new value for two minutes",()=>{
 assert.match(handoff,/secretTimer=setTimeout\(clearSecret,120000\)/);
 assert.match(handoff,/再発行した仮パスワード/);
 assert.match(handoff,/const password=secretValue\.textContent\.replace\(/);
 assert.match(handoff,/window\.addEventListener\("pagehide",clearSecret/);
 assert.doesNotMatch(handoff,/localStorage|sessionStorage|document\.cookie|searchParams\.set\("password"/);
});

test("company portal is not rotated automatically on opening a meeting",()=>{
 assert.match(handoff,/issue\.addEventListener\("click"/);
 assert.match(handoff,/reset\.addEventListener\("click"/);
 assert.match(handoff,/action:"ensure_meeting_account",confirmed:true/);
 assert.doesNotMatch(handoff,/window\.addEventListener\("load",[\s\S]*?generate_password/);
});
