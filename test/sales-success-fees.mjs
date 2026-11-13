import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseFeeDraft,feeTransition,feeSummary,validYmd} from "../lib/sales-success-fees.js";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const api=read("../api/sales/success-fees.js");
const ui=read("../js/sales-company-success-fees.js");
const tabs=read("../js/sales-company-portal-tabs.js");
const page=read("../sales/company-segments.html");
const ddl=read("../db/179_sales_enger_success_fees.sql");

test("fee models and monthly periods are validated",()=>{
 assert.deepEqual(parseFeeDraft({feeModel:"once",feeYen:50000,payerName:"株式会社ABC",feeMonth:""}).value,{
  fee_model:"once",fee_month:null,fee_yen:50000,payer_name:"株式会社ABC",note:null
 });
 assert.equal(parseFeeDraft({feeModel:"monthly",feeYen:40000,payerName:"株式会社ABC",feeMonth:"2026-11"}).value.fee_month,"2026-11-01");
 for(const amount of ["0",-500,Infinity,"xxx",1.5,100000001]){
   assert.equal(parseFeeDraft({feeModel:"once",feeYen:amount,payerName:"AB"}).error,"invalid_fee_amount");
 }
 assert.equal(parseFeeDraft({feeModel:"monthly",feeYen:40000,payerName:"AB",feeMonth:"2026-13"}).error,"invalid_fee_month");
 assert.equal(parseFeeDraft({feeModel:"once",feeYen:40000,payerName:"AB",feeMonth:"2026-11"}).error,"once_fee_month_forbidden");
 assert.equal(parseFeeDraft({feeModel:"once",feeYen:50000,payerName:"A"}).error,"payer_required");
});

test("manager must confirm real contract before any billable/paid state",()=>{
 const row={status:"draft"};
 assert.equal(feeTransition(row,{status:"confirmed",agreementReference:"Signed contract #17"},{
  manager:false,offerStatus:"won",now:"2026-11-10"}).error,"manager_required");
 assert.equal(feeTransition(row,{status:"confirmed",agreementReference:"Signed contract #17"},{
  manager:true,offerStatus:"meeting",now:"2026-11-10"}).error,"contract_not_yet_agreed");
 assert.equal(feeTransition(row,{status:"confirmed",agreementReference:"short"},{
  manager:true,offerStatus:"won",now:"2026-11-10"}).error,"agreement_reference_required");
 assert.deepEqual(feeTransition(row,{status:"confirmed",agreementReference:"Signed contract #17"},{
  manager:true,offerStatus:"won",now:"2026-11-10"}).value,{
   status:"confirmed",agreement_reference:"Signed contract #17",confirmed_on:"2026-11-10"
 });
 assert.equal(feeTransition({status:"confirmed"},{status:"paid"},{
  manager:true,offerStatus:"won",now:"2026-11-10"}).error,"invalid_transition");
 assert.equal(feeTransition({status:"confirmed"},{status:"invoiced",invoiceNumber:""},{
  manager:true,offerStatus:"won",now:"2026-11-10"}).error,"invoice_reference_required");
 assert.deepEqual(feeTransition({status:"invoiced"},{status:"paid"},{
  manager:true,offerStatus:"won",now:"2026-11-10"}).value,{status:"paid",paid_on:"2026-11-10"});
 assert.equal(feeTransition({status:"paid"},{status:"void"},{
  manager:true,offerStatus:"won",now:"2026-11-10"}).error,"invalid_transition");
 assert.equal(validYmd("2026-02-31"),false);
});

test("financial KPIs keep draft, contracted, invoiced and cash separate",()=>{
 const s=feeSummary([
  {status:"draft",fee_yen:50000},{status:"confirmed",fee_yen:40000},
  {status:"invoiced",fee_yen:40000},{status:"paid",fee_yen:40000},
  {status:"void",fee_yen:10000}
 ]);
 assert.equal(s.forecastYen,50000);
 assert.equal(s.confirmedYen,40000);
 assert.equal(s.invoicedYen,40000);
 assert.equal(s.receivedYen,40000);
 assert.equal(s.totals.void,10000);
});

test("offer and fee are scoped to the same tenant/company; only managers can confirm",()=>{
 assert.match(api,/companyInScope\(db,ctx\.tenantId,companyId\)/);
 assert.match(api,/\.eq\("tenant_id",ctx\.tenantId\)\s*\.eq\("company_id",companyId\)\.eq\("id",body\.offerId\)/);
 assert.match(api,/feeTransition\(existing\.data,body,\{manager,offerStatus:offer\.data\.status\}\)/);
 assert.match(api,/\.eq\("status",body\.expectedStatus\)/);
 assert.match(api,/canManageProposals\(ctx\)/);
 assert.match(ddl,/foreign key \(tenant_id,company_id,offer_id\)/);
 assert.match(ddl,/enable row level security/);
 assert.match(ddl,/revoke all on public\.gw_sales_success_fees from public,anon,authenticated/);
 assert.match(ddl,/gw_sales_success_fee_month_unique/);
});

test("Sales displays the ledger after corporate offers; account billing is not automated",()=>{
 assert.match(tabs,/renderSuccessFeeLedger\(feeHost,\{companyId:row\.companyId,offers:offerRows\}\)/);
 assert.match(ui,/\/api\/sales\/success-fees/);
 assert.match(ui,/成果報酬・入金管理/);
 assert.match(ui,/見込として登録/);
 assert.match(ui,/契約確認/);
 assert.match(ui,/請求記録/);
 assert.match(ui,/入金確認/);
 assert.match(ui,/会計上の売上計上とは別/);
 const entry=JSON.parse(read("../test/asset-hashes.json")).independent["js/sales-company-segments.js"];
 assert.ok(entry?.version, "company entry is versioned and content-checked by assethash");
 assert.ok(page.includes("sales-company-segments.js?v="+entry.version));
 assert.match(read("../js/sales-company-segments.js"),/sales-company-portal-tabs\.js\?v=/);
 assert.doesNotMatch(ui,/\.post\("invoice/);
});
