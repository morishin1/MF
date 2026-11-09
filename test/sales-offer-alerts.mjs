import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const api=read("../api/sales/offer-alerts.js");
const layout=read("../js/sales-layout.js");
const detail=read("../js/sales-company-portal-tabs.js");
const list=read("../js/sales-company-segments.js");
const proposals=read("../sales/proposals.html");
const dashboard=read("../sales/index.html");
const company=read("../sales/company-segments.html");

test("new offer red badges require login, tenant and ENGER-Sales scope",()=>{
 assert.match(api,/requireUser\(req,res\)/);
 assert.match(api,/canSell\(ctx\)/);
 assert.match(api,/canAccessEightEngerDirectory\(ctx\)/);
 assert.match(api,/\.eq\("tenant_id",ctx\.tenantId\)/);
 assert.match(api,/\.eq\("status","new"\)/);
 assert.match(api,/\.from\("dx2_sales_company_directory_for_tenant"\)/);
 assert.match(api,/\.eq\("tenant_id",ctx\.tenantId\)\.in\("id",companyIds\)/);
 assert.match(api,/visible\.slice\(0,5\)/);
 assert.doesNotMatch(api,/\.from\("candidates"\)/);
});

test("dashboard and proposal tabs show red badge only for unhandled company offers",()=>{
 assert.match(layout,/data-sales-offer-count/);
 assert.match(layout,/\["dashboard","proposals"\]\.includes\(n\.key\)/);
 assert.match(layout,/badge\.hidden=count===0/);
 assert.match(layout,/refreshOfferAlerts\(\)/);
 assert.match(layout,/visibilitychange/);
 assert.doesNotMatch(layout,/localStorage/);
 assert.match(dashboard,/id="db-offer-alert"/);
 assert.match(dashboard,/data-offer-alert-recent/);
 assert.match(proposals,/id="pp-company-offers-alert"/);
 assert.match(proposals,/id="pp-company-offers"/);
});

test("offer notification opens the company and offers/revenue details without a hidden tab",()=>{
 assert.match(company,/id="lc-open-offers"/);
 assert.match(company,/data-modal-tab="offers"/);
 assert.match(company,/id="lc-offers-count"/);
 assert.match(detail,/offers:"lc-panel-offers"/);
 assert.match(detail,/tab==="offers"\)void loadOffers\(\)/);
 assert.match(detail,/offersNav\.disabled=!usable/);
 assert.match(detail,/renderSuccessFeeLedger/);
 assert.match(list,/initial\.get\("view"\)==="offers"/);
 assert.match(list,/tabs\.select\("offers"\)/);
});

test("status change updates alert immediately; view-only doesn't dismiss notifications",()=>{
 assert.match(detail,/refreshOfferAlerts\?\.\(\)/);
 const widget=read("../js/sales-proposal-company-offers.js");
 assert.match(widget,/refreshOfferAlerts\?\.\(\)/);
 assert.match(api,/meaning:"未対応の企業オファー/);
 assert.doesNotMatch(api,/\.update\(/);
});
