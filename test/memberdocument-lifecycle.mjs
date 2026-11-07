// Lifecycle order, required/optional/future states, and salary preview boundaries.
import assert from "node:assert/strict";
import { memberLifecycle, LIFECYCLE_PHASES } from "../lib/member-document-lifecycle.js";
import { publicLifecycle } from "../api/member-documents.js";

const employee=(status="active",employment_type="契約社員")=>({
  id:"11111111-1111-4111-8111-111111111111",display_name:"テスト",status,employment_type,employee_kind:"proper",
});
const doc=(kind,props={})=>({
  id:"22222222-2222-4222-8222-222222222222",kind,source:"manual",title:kind,filename:kind+".pdf",
  storagePath:"tenant/members/file.pdf",createdAt:"2026-11-08T00:00:00Z",...props,
});
const keys=entry=>entry.buttons.map(b=>b.key);
let passes=0;
function check(name,fn){fn();passes++;console.log("ok: "+name);}
check("five phases in chronological order",()=>{
  assert.deepEqual(LIFECYCLE_PHASES.map(p=>p.key),["recruit","offer","join","active","leave"]);
});
check("employee gets all applicable buttons, no service contract",()=>{
  const b=memberLifecycle(employee());
  assert.ok(b.buttons.length>=18);
  assert.ok(keys(b).includes("employment_contract"));
  assert.ok(!keys(b).includes("service_contract"));
  assert.deepEqual([...new Set(b.buttons.map(x=>x.phase))],LIFECYCLE_PHASES.map(p=>p.key));
});
check("contractor gets service contract, not wage/insurance paperwork",()=>{
  const b=memberLifecycle(employee("active","業務委託"));
  assert.ok(keys(b).includes("service_contract"));
  assert.ok(!keys(b).includes("dependents"));
  assert.ok(!keys(b).includes("employment_contract"));
});
check("retire docs are future for active members",()=>{
  const b=memberLifecycle(employee());
  for(const k of ["retire_certificate","retire_withholding","retire_separation","retire_insurance_loss"])
    assert.equal(b.buttons.find(x=>x.key===k).state,"future");
});
check("retirement checklist includes notice, handover, asset-return and generated certificates",()=>{
  const b=memberLifecycle(employee("leaving"));
  for(const k of ["resignation_notice","handover_form","asset_return_form","retirement_pledge",
    "retire_certificate","retire_withholding","retire_separation","retire_insurance_loss"])
    assert.ok(b.buttons.some(x=>x.key===k),k);
});
check("manual retirement form is received, not falsely issued",()=>{
  const b=memberLifecycle(employee("leaving"),[doc("resignation_notice")]);
  assert.equal(b.buttons.find(x=>x.key==="resignation_notice").state,"received");
});
check("retire progress and expected date are distinct from submission",()=>{
  const b=memberLifecycle(employee("leaving"),[],[],[],[
    {kind:"retire_certificate",state:"processing",version:1,expected_on:"2026-11-23"},
  ]);
  const cert=b.buttons.find(x=>x.key==="retire_certificate");
  assert.equal(cert.state,"processing");assert.equal(cert.dueOn,"2026-11-23");
});
check("uploaded employment PDF is not signed",()=>{
  const b=memberLifecycle(employee(),[doc("employment_contract",{verified:true})]);
  assert.equal(b.buttons.find(x=>x.key==="employment_contract").state,"contract_unconfirmed");
});
check("signed PDF is signed; acceptance PDF is not a contract signature",()=>{
  const b=memberLifecycle(employee(),[
    doc("employment_contract",{source:"sign",signed:true}),
    doc("accepted_offer",{source:"offer-accepted"}),
  ]);
  assert.equal(b.buttons.find(x=>x.key==="employment_contract").state,"signed");
  assert.equal(b.buttons.find(x=>x.key==="accepted_offer").state,"accepted");
});
check("completed procedure without file is record-only",()=>{
  const b=memberLifecycle(employee(),[],[
    {item_key:"form_bank",title:"振込口座",category:"document",status:"done",required:true},
  ]);
  assert.equal(b.buttons.find(x=>x.key==="bank").state,"record_only");
});
check("not-applicable document is not a button",()=>{
  const b=memberLifecycle(employee(),[],[
    {item_key:"doc_pension",category:"document",status:"na",required:true},
  ]);
  assert.ok(!keys(b).includes("pension"));
});
check("custom checklist key becomes an entry button",()=>{
  const b=memberLifecycle(employee(),[],[
    {item_key:"doc_specific",title:"現場入場時書類",category:"document",status:"todo",required:true},
  ]);
  assert.equal(b.buttons.find(x=>x.key==="custom_doc_specific").state,"missing");
});
check("salary document preview pointers are suppressed on both list and details",()=>{
  const b=memberLifecycle(employee(),[doc("labor_notice")]);
  const hidden=publicLifecycle(b,false).buttons.find(x=>x.key==="labor_notice");
  assert.equal(hidden.latestFile,null);
  assert.equal(hidden.uploadKind,null);
  assert.equal(hidden.restricted,true);
  const visible=publicLifecycle(b,true).buttons.find(x=>x.key==="labor_notice");
  assert.ok(visible.latestFile);
});
check("period context comes from current contract not latest unapproved draft",()=>{
  const b=memberLifecycle(employee(),[],[],[
    {status:"active",contract_type:"契約社員",period_from:"2026-09-01",period_to:"2027-08-31",created_at:"2026-09-01"},
    {status:"draft",contract_type:"契約社員",period_from:"2026-11-01",created_at:"2026-11-01"},
  ]);
  assert.equal(b.buttons.find(x=>x.key==="employment_contract").period.to,"2027-08-31");
});
console.log("member lifecycle: "+passes+" tests passed");
