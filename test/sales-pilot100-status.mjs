import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildLifecycle,selectLifecycle} from "../lib/sales-company-lifecycle.js";

const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const api=read("api/sales/company-lifecycle.js");
const html=read("sales/company-segments.html");
const ui=read("js/sales-company-segments.js");
const pilotStatuses=[
  ...Array(50).fill("queued"),
  ...Array(10).fill("processing"),
  ...Array(25).fill("completed"),
  ...Array(12).fill("needs_review"),
  ...Array(3).fill("failed")
];
const directory=pilotStatuses.map((status,i)=>({
 id:"company-"+String(i).padStart(3,"0"),name:"企業"+i,bucket:"new",
 classification_basis:"取引・営業履歴未確認",relationship_status:"unknown",
 si_ses_candidate:i<30
}));
const contacts=directory.map(x=>({id:x.id,company_no:null,contact_email:null}));
const classifications=directory.map((x,i)=>({
 company_id:x.id,origin:"pilot100",status:pilotStatuses[i],
 org_type:"private",business_types:i<30?["ses"]:["general"],
 confidence:pilotStatuses[i]==="completed"?.91:null
}));
const model=buildLifecycle({
 directory,contacts,proposals:[],links:[],sales:[],employees:[],
 jobs:[],broadcasts:[],classifications,people:[]
});

test("every company has a pilot100 marker and correct status",()=>{
 assert.equal(model.rows.length,100);
 assert.ok(model.rows.every(x=>x.isPilot100===true));
 assert.deepEqual(model.rows.slice(0,2).map(x=>x.classificationStatus),["queued","queued"]);
 assert.equal(model.rows[60].classificationStatus,"completed");
});
test("summary represents exactly 100 target rows without conflating completed and review",()=>{
 assert.deepEqual(model.counts.pilot100,{
  total:100,queued:50,processing:10,completed:25,needsReview:12,failed:3
 });
});
const query=(pilot,category="")=>new URLSearchParams({segment:"all",pilot,category});
test("pilot filters work before 50-row pagination",()=>{
 assert.equal(selectLifecycle(model,query("all")).selectedCount,100);
 assert.equal(selectLifecycle(model,query("queued")).selectedCount,50);
 assert.equal(selectLifecycle(model,query("processing")).selectedCount,10);
 assert.equal(selectLifecycle(model,query("completed")).selectedCount,25);
 assert.equal(selectLifecycle(model,query("needs_review")).selectedCount,12);
 assert.equal(selectLifecycle(model,query("failed")).selectedCount,3);
 const second=selectLifecycle(model,new URLSearchParams({segment:"all",pilot:"all",page:"2"}));
 assert.equal(second.rows.length,50);
 assert.equal(selectLifecycle(model,query("completed","ses")).selectedCount,0);
});
test("non-pilot companies cannot appear under pilot filters",()=>{
 const other={...model,rows:[...model.rows,{
  id:"another",companyId:"another",name:"非試験企業",segment:"pending",
  isPilot100:false,classificationStatus:"completed",businessTypes:["ses"],
  orgType:"private",people:[]
 }]};
 assert.equal(selectLifecycle(other,query("all")).selectedCount,100);
 assert.equal(selectLifecycle(other,query("completed")).selectedCount,25);
});
test("invalid pilot status fails validation",()=>{
 assert.throws(()=>selectLifecycle(model,query("unknown")),/invalid_filter/);
});
test("the server reads pilot origin and the UI shows a badge and clickable progress",()=>{
 assert.match(api,/select\('company_id,status,origin,org_type/);
 assert.match(api,/eq\('tenant_id',tenant\)/);
 for(const id of ["lc-pilot100","lc-pilot-summary","lc-pilot-fill",
   "lc-pilot-open","lc-pilot","lc-pilot-queued","lc-pilot-processing",
   "lc-pilot-completed","lc-pilot-review","lc-pilot-failed"])
   assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(ui,/function pilotTag\(r\)/);
 assert.match(ui,/試験100社/);
 assert.match(ui,/renderPilot\(c\.pilot100\|\|\{\}\)/);
 assert.match(ui,/pilot:\$\('lc-pilot'\)\.value/);
 assert.match(ui,/b\.onclick=\(\)=>showPilot\(b\.dataset\.pilotJump\)/);
});
