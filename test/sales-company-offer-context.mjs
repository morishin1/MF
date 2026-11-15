import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const api=read("../api/sales/company-offers.js");
const ui=read("../js/sales-company-portal-tabs.js");

test("Sales receives tenant-and-company-scoped focus context with the matched offer",()=>{
 assert.match(api,/context_submission_id,context_note/);
 assert.match(api,/\.eq\("tenant_id",tenantId\)\.in\("id",contextIds\)/);
 assert.match(api,/ref\.company_id===x\.company_id/);
 // 追加時（#321）から実装は「ref&&ref.company_id===x.company_id?{…}:null」で、
 // `context?{` という書き方は一度も存在しない（このassertは最初から通っていなかった）。
 // 守りたいのは「同じ企業の資料だけを context に載せ、他社の資料なら null にする」こと。
 assert.match(api,/const context=ref&&ref\.company_id===x\.company_id\?\{[\s\S]*?\}:null;/);
 assert.match(api,/budget:safe\(ref\.budget,100\)/);
 assert.match(api,/description:safe\(ref\.description,3000\)/);
 assert.match(ui,/lp-offer-context/);
 assert.match(ui,/企業が入力した/);
 assert.match(ui,/esc\(o\.context\.description/);
 assert.match(ui,/esc\(o\.contextNote/);
});
