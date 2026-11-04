import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canSupplyTransition,hasRegisteredSupply} from "../lib/sales-supply-policy.js";

assert.equal(canSupplyTransition("planned","contacted"),true);
assert.equal(canSupplyTransition("planned","appointment"),true);
assert.equal(canSupplyTransition("contacted","received"),true);
assert.equal(canSupplyTransition("received","registered"),true);
assert.equal(canSupplyTransition("planned","registered"),false);
assert.equal(canSupplyTransition("registered","closed"),false);
assert.equal(canSupplyTransition("closed","contacted"),false);
assert.equal(hasRegisteredSupply("job","00000000-0000-4000-8000-000000000001",null),true);
assert.equal(hasRegisteredSupply("job",null,"00000000-0000-4000-8000-000000000001"),false);
assert.equal(hasRegisteredSupply("talent",null,"00000000-0000-4000-8000-000000000001"),true);
assert.equal(hasRegisteredSupply("both",null,"00000000-0000-4000-8000-000000000001"),true);
assert.equal(hasRegisteredSupply("both",null,null),false);
const server=readFileSync("api/sales/enger-company-supply.js","utf8");
const directory=readFileSync("api/sales/enger-company-directory.js","utf8");
const app=readFileSync("js/sales-enger-directory.js","utf8");
const client=readFileSync("js/sales-enger-supply.js","utf8");
const html=readFileSync("sales/companies.html","utf8");
const schema=readFileSync("db/158_enger_sales_company_supply_pipeline.sql","utf8");
for (const condition of [
 server.includes("requireUser(req,res)"),server.includes("canSell(ctx)"),
 server.includes('.eq("tenant_id",tenant)'),
 server.includes("company_classification_unavailable"),
 server.includes("contact_review_required"),
 server.includes("legacy_company_sources"),server.includes("canSupplyTransition"),
 server.includes("hasRegisteredSupply"),
 schema.includes("ENABLE ROW LEVEL SECURITY"),
 schema.includes("REVOKE ALL ON enger.dx2_sales_company_supply_pipeline FROM PUBLIC,anon,authenticated"),
 html.includes('id="enger-company-directory"'),html.includes("js/sales-enger-supply.js"),
 app.includes("[data-engr-bucket]"),app.includes("enger:company-open"),
 client.includes('data-supply-stage'),client.includes("enger-company-supply"),
 directory.includes('const BUCKETS=["existing","revive","new"]')
]) assert.equal(condition,true,"sales supply workflow contract is missing");
console.log("PASS ENGER company supply pipeline and three-tab Sales contract");
