import test from "node:test";
import assert from "node:assert/strict";
import {jobAvailable,toPublicJob,toSalesJob} from "../lib/sales-company-share-public.js";

const row={id:"11111111-1111-4111-8111-111111111111",job_no:61129,
  title:"株式会社パートナーの秘密案件",role_label:"Javaエンジニア",
  skills:["Java","AWS","株式会社機密"],
  remote_type:"partial_remote",work_location:"東京都",is_published:true,
  is_closed:false,deleted_at:null,status:"募集中",review_status:null,is_focus:true};
test("only published and ongoing jobs are shareable",()=>{
 assert.equal(jobAvailable(row),true);
 assert.equal(jobAvailable({...row,is_published:false}),false);
 assert.equal(jobAvailable({...row,is_closed:true}),false);
 assert.equal(jobAvailable({...row,deleted_at:"2026-11-07"}),false);
 assert.equal(jobAvailable({...row,status:"募集終了"}),false);
});
test("external job payload cannot disclose client or procurement information",()=>{
 const item=toPublicJob({...row,contact_email:"hidden@company.jp",company:"株式会社秘密",salary_min:50,flow_note:"秘密"});
 assert.equal(item.title,"Javaエンジニア");
 assert.equal(item.skills.includes("株式会社機密"),false);
 assert.equal(JSON.stringify(item).includes("株式会社パートナー"),false);
 for(const secret of ["contact_email","company","salary_min","flow_note","partner"])assert.equal(secret in item,false);
});
test("Sales-only job title is not included in the public projection",()=>{
 const sales=toSalesJob(row),external=toPublicJob(row);
 assert.match(sales.displayTitle,/パートナー/);
 assert.equal(external.displayTitle,undefined);
});
