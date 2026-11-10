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

test("Sales meeting can begin before any company contact/password is issued",()=>{
 assert.match(ui,/const beginTop=mk\("button","商談画面を開く（企業ログイン不要）"/);
 assert.match(ui,/beginTop\.onclick=\(\)=>begin\.click\(\)/);
 assert.match(ui,/go\.disabled=busy/);
 assert.match(ui,/const companyLoginReady=Boolean\(credentialPanel\?\.state\(\)\?\.active\?\.length\)/);
 assert.doesNotMatch(ui,/if\(!companyLoginReady\)return/);
 assert.match(ui,/new URL\("\/sales\/company-meeting\.html"/);
 assert.match(ui,/window\.open\("about:blank","_blank"\)/);
 assert.match(css,/lp-meeting-preflight-topstart/);
 assert.match(css,/position:sticky;bottom:-16px/);
});

test("If a published shortlist fails, staff-only meeting remains available without publishing private candidate data",()=>{
 assert.match(ui,/catch\(error\)\{[\s\S]*?sharingIssue=/);
 assert.match(ui,/selectedKeys:\[\]/);
 assert.match(ui,/staffUrl\.searchParams\.set\("staffPreview","1"\)/);
 assert.match(session,/raw\.length>30/);
 assert.match(session,/\.eq\("tenant_id",ctx\.tenantId\)/);
 assert.match(company,/requireUser\(req,res\)/);
 assert.match(company,/canAccessEightEngerDirectory\(ctx\)/);
 assert.match(page,/params\.get\("staffPreview"\)==="1"/);
 assert.match(page,/\/api\/sales\/company-talents\?/);
 assert.match(page,/\/api\/sales\/company-shortlist\?/);
 assert.match(page,/key:null,reference:true/);
 assert.doesNotMatch(page,/source_company|original_resume|skill_sheet_url/);
 assert.match(page,/社内参考候補/);
 assert.match(page,/displayItems\.filter/);
});

test("company password generation still requires a verified company contact and never creates anonymous business accounts",()=>{
 assert.match(portal,/error:"contact_missing"/);
 assert.match(portal,/正式な企業ログインの発行には企業基本情報の担当者名とメールが必要です/);
 assert.match(ui,/企業ログインのパスワードが未発行でも社内商談を開始できます/);
 assert.doesNotMatch(ui,/company-demo\+/);
 assert.match(credentials,/初回発行/);
});

test("Show up to 30 internal rows per side, never silently imply more than 30 were shared",()=>{
 assert.equal((ui.match(/\.rows\.slice\(0,30\)/g)||[]).length,4);
 assert.match(ui,/return gathered\.slice\(0,30\)/);
 assert.match(ui,/商談へ共有するのは先頭30件まで/);
 assert.match(page,/talentRows\.slice\(0,30\)/);
 assert.match(page,/jobRows\.slice\(0,30\)/);
});
