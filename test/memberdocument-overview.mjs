// Member document matrix: contract status vs PDF/consent, preview permissions.
import assert from "node:assert/strict";
import { documentOverview } from "../api/member-documents.js";

const file=(source,id,kind,{salary=false,signed=false,verified=false,createdAt="2026-11-08T00:00:00Z",group="contract",status="登録済"}={})=>({
  source,id,kind,title:kind,filename:kind+".pdf",
  storagePath:"tenant/members/"+id+".pdf",salary,signed,verified,group,status,createdAt,
});
function check(cond,msg){assert.ok(cond,msg);console.log("ok:",msg);}

const empty=documentOverview({documents:[]},true);
check(empty.contract.status==="台帳未登録" && !empty.contract.preview,"No contract is never marked as signed");
const terms=documentOverview({documents:[],contracts:[
  {contract_type:"業務委託",status:"draft",period_from:"2026-11-01",created_at:"2026-11-01T00:00:00Z"},
  {contract_type:"契約社員",status:"active",period_from:"2026-09-01",period_to:"2027-08-31",created_at:"2026-09-01T00:00:00Z"},
]},true);
check(terms.terms.contractType==="契約社員" && terms.terms.periodFrom==="2026-09-01" &&
  terms.terms.periodTo==="2027-08-31","Current confirmed contract type and dates override newer drafts");

const documents=[
  file("contract","c1","employment_contract",{salary:true}),
  file("offer-letter","o1","offer_letter"),
  file("offer-accepted","a1","accepted_offer",{salary:true,status:"条件承諾済"}),
  file("offer-notice","n1","labor_notice",{salary:true}),
  file("procedure","p1","other",{group:"submitted",verified:true}),
  file("procedure","p2","dependents",{group:"submitted",status:"提出済"}),
  file("hr","resume1","resume",{group:"submitted"}),
];
const full=documentOverview({documents},true);
check(Boolean(full.contract.preview)&&full.contract.status==="登録済","Contract PDF is not silently treated as electronically signed");
check(full.offer.preview.id==="o1","Offer notice preview is linked");
check(full.acceptance.preview.id==="a1","Acceptance PDF preview is linked");
check(full.notice.preview.id==="n1","Conditions notice preview is linked");
check(full.submitted.count===2&&full.submitted.status.includes("確認待ち 1件"),"Onboarding submitted files counted without resumes");
const limited=documentOverview({documents},false);
check(!limited.contract.preview&&!limited.acceptance.preview&&!limited.notice.preview,"Salary document preview permission is checked server-side");
check(Boolean(limited.offer.preview)&&Boolean(limited.submitted.preview),"Non-salary original files remain accessible");

const signed=documentOverview({documents:[file("sign","s1","employment_contract",{signed:true,status:"電子署名済"})]},true);
check(signed.contract.status==="電子署名済","Signed evidence is distinguished from upload");
console.log("document overview matrix: all cases passed");
