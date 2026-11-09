import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  normalizeClassification,classifyWithHaiku,canClassifyTenant,EIGHT_TENANT,
  CLASSIFIER_MODEL,classifyWithoutOfficialEvidence
} from "../lib/sales-company-classification-ai.js";
import {selectLifecycle} from "../lib/sales-company-lifecycle.js";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const worker=read("../api/cron/sales-company-classify.js");
const register=read("../api/sales/meeting-company.js");
const lifecycle=read("../api/sales/company-lifecycle.js");
const ui=read("../js/sales-company-segments.js");
const page=read("../sales/company-segments.html");
const config=JSON.parse(read("../vercel.json"));
const record={org_type:"private",business_types:["ses","sier"],confidence:0.95,
 reason:"事業ページに技術者派遣とシステム構築が明記",needs_review:false,
 suggested_service:"enger",evidence:[{index:1,quote:"技術者派遣とシステムインテグレーション"}]};
const pages=[{url:"https://example.co.jp/service",text:"技術者派遣とシステムインテグレーション"}];
test("Haiku 5.5 is explicitly selected for classification",()=>{
 assert.equal(CLASSIFIER_MODEL,"claude-haiku-5-5");
 assert.ok(canClassifyTenant(EIGHT_TENANT));
 assert.ok(!canClassifyTenant("00000000-0000-4000-8000-000000000000"));
});
test("SES and SIer can both be selected while evidence stays URL-scoped",()=>{
 const classified=normalizeClassification(record,pages);
 assert.equal(classified.status,"completed");
 assert.deepEqual(classified.business_types,["ses","sier"]);
 assert.equal(classified.evidence[0].url,"https://example.co.jp/service");
 const noProof=normalizeClassification(record,[]);
 assert.equal(noProof.status,"needs_review");
 assert.deepEqual(noProof.evidence,[]);
 const low=normalizeClassification({...record,confidence:0.54},pages);
 assert.equal(low.status,"needs_review");
});
test("missing website does not incur API spending and never fabricates SES",async()=>{
 const source={name:"未知の事業者",industry:"IT",si_ses_candidate:true};
 let called=false;
 const client={messages:{create:async()=>{called=true;throw Error("should_not_call");}}};
 const result=await classifyWithHaiku({company:source,website:"",pages:[],client});
 assert.equal(called,false);
 assert.equal(result.status,"needs_review");
 assert.deepEqual(result.business_types,[]);
 assert.equal(classifyWithoutOfficialEvidence(source).model,null);
});
test("Anthropic returned structured classification is normalized and bounded",async()=>{
 const mock={messages:{create:async params=>{
  assert.equal(params.model,"claude-haiku-5-5");
  assert.equal(params.tool_choice.name,"classify_company");
  return {content:[{type:"tool_use",name:"classify_company",input:record}],
   usage:{input_tokens:300,output_tokens:80}};
 }}};
 const r=await classifyWithHaiku({company:{name:"企業A",corporate_number:"1234567890123"},
  website:"https://example.co.jp",pages,client:mock});
 assert.equal(r.status,"completed");assert.equal(r.model,CLASSIFIER_MODEL);
 assert.equal(r.input_tokens,300);assert.equal(r.output_tokens,80);
});
test("cron is secret protected, tenant scoped, idempotent and does not scan 7,322 companies",()=>{
 assert.match(worker,/process\.env\.CRON_SECRET/);
 assert.match(worker,/canClassifyTenant\(item\.tenant_id\)/);
 assert.match(worker,/EIGHT_TENANT/);
 assert.match(worker,/\.eq\("status","queued"\)/);
 assert.match(worker,/\.eq\("human_override",false\)/);
 assert.match(worker,/\.limit\(4\)/);
 assert.match(worker,/attempts<2/);
 assert.ok(config.crons.some(c=>c.path==="/api/cron/sales-company-classify"));
 assert.equal(config.functions["api/cron/sales-company-classify.js"].maxDuration,60);
});
test("new company creates exactly one queued classification without blocking registration",()=>{
 assert.match(register,/gw_sales_company_classifications/);
 assert.match(register,/ignoreDuplicates:true/);
 assert.match(register,/origin:'new_registration'/);
 assert.match(register,/if\(result\.created\)/);
});
test("Sales company classification is server side filtered before pagination",()=>{
 assert.match(lifecycle,/gw_sales_company_classifications/);
 assert.match(lifecycle,/selectLifecycle\(model,params\)/);
 assert.match(ui,/category:\$\('lc-category'\)\.value/);
 assert.match(page,/id="lc-category"/);
 const mk=(cat)=>({get:k=>k==="category"?cat:k==="segment"?"all":null});
 const model={rows:[
  {id:"1",name:"A",companyId:"1",orgType:"private",businessTypes:["ses"],classificationStatus:"completed",people:[]},
  {id:"2",name:"B",companyId:"2",orgType:"private",businessTypes:["sier"],classificationStatus:"completed",people:[]},
  {id:"3",name:"C",companyId:"3",orgType:"municipality",businessTypes:[],classificationStatus:"completed",people:[]},
 ],activities:[],counts:{}};
 assert.deepEqual(selectLifecycle(model,mk("ses")).rows.map(x=>x.id),["1"]);
 assert.deepEqual(selectLifecycle(model,mk("sier")).rows.map(x=>x.id),["2"]);
 assert.deepEqual(selectLifecycle(model,mk("municipality")).rows.map(x=>x.id),["3"]);
});
