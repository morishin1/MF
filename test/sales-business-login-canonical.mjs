import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {portalBaseUrl,loginUrl} from "../lib/sales-company-portal.js";
const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const workflow=read("../api/sales/company-workflow-status.js");
const creds=read("../js/sales-company-meeting-credentials.js");
const staff=read("../sales/company-meeting.html");
const modal=read("../js/sales-company-compact-proposal.js");

test("all Sales enterprise login URLs share the same configured ENGER origin",()=>{
  const preview="https://enger-lp-git-feat-business-five-step-me-2feb9c-eight-s-projects.vercel.app";
  assert.equal(loginUrl({ENGER_PORTAL_BASE_URL:preview}),preview+"/business/login");
  assert.equal(portalBaseUrl({ENGER_PORTAL_BASE_URL:preview}),preview);
  assert.match(workflow,/import\s*\{\s*portalBaseUrl\s*\}.*sales-company-portal\.js/);
  assert.match(workflow,/configuredPortal=portalBaseUrl\(\)/);
  assert.match(workflow,/process\.env\.VERCEL_ENV==="preview"/);
  assert.match(workflow,/portalOrigin.*"https:\/\/enger\.jp"/s);
  assert.doesNotMatch(workflow,/ENGER_BUSINESS_PORTAL_ORIGIN/);
  assert.match(staff,/\/business\/login/);
  assert.doesNotMatch(staff,/\/company-portal\/login\.html/);
});

test("opening meeting or showing existing credentials never resets password",()=>{
  assert.match(modal,/go\.onclick=\(\)=>/);
  assert.match(modal,/credentialPanel\?\.setVisible\(true\)/);
  assert.doesNotMatch(modal,/action:"generate_password"/);
  assert.doesNotMatch(modal,/action:"issue_account"/);
  assert.match(creds,/if\(users\.length&&st\.canIssue&&!busy\)/);
  assert.match(creds,/const recovery=el\("details"/);
  assert.match(creds,/パスワードを忘れたときだけ再発行/);
  assert.match(creds,/if\(!confirm\(member\.email/);
  assert.match(creds,/action:"generate_password"/);
  assert.match(creds,/if\(!users\.length&&!queued\.length&&st\.canIssue&&!busy\)/);
  assert.match(creds,/action:"issue_account"/);
  assert.match(creds,/setVisible\(next\)/);
});

test("no customer passwords in login or meeting URLs",()=>{
  assert.doesNotMatch(staff,/searchParams\.set\("password"/);
  assert.doesNotMatch(modal,/searchParams\.set\("password"/);
  assert.match(creds,/if\(!visible\)forgetSecret\(\)/);
});
