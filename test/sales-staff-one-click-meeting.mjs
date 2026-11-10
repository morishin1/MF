import test from "node:test";import assert from "node:assert/strict";import{readFileSync}from"node:fs";
const ui=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
const page=readFileSync(new URL("../sales/company-meeting.html",import.meta.url),"utf8");
test("sales meeting opens staff page, never company login",()=>{assert.match(ui,/new URL\("\/sales\/company-meeting\.html"/);assert.doesNotMatch(ui.slice(ui.indexOf("begin.onclick=async()=>{")),/tab\.location\.replace\(url\.href\)/);assert.match(ui,/go\.disabled=busy/)});
test("staff meeting includes customer login link without passwords",()=>{assert.match(page,/client-link/);assert.match(page,/business\/login/);assert.match(page,/new URL\("\/business\/meeting"/);});