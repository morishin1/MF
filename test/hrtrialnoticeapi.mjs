// Synthetic-only API contract checks; no external DB, no real applicant, no real mail.
import assert from "node:assert/strict";
import {createHandler} from "../api/hr/trial-notice.js";
import {FIELDS} from "../lib/hr-trial-word.js";
const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",U="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A="cccccccc-cccc-4ccc-8ccc-cccccccccccc",F="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const P="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const values=Object.fromEntries(FIELDS.map(([k,label])=>[k,label+"：確認済みの合成データ"]));
const rows={
 gw_hr_applicants:[{id:A,tenant_id:T,name:"合成テスト応募者",email:"candidate@example.invalid",
    stage:"offer",decision:"hired",status:"offer_ready",lead_category:"recruitment",
    offer_type:"part_time",employment_type:"アルバイト",employee_id:null}],
 gw_hr_pdf_flows:[{id:F,tenant_id:T,applicant_id:A,offer_doc_id:P,phase:"offer_preparing"}],
 gw_hr_pdf_docs:[{id:P,tenant_id:T,flow_id:F,kind:"offer",revoked_at:null,superseded_at:null}],
 tenants:[{id:T,name:"株式会社エイト"}],
 gw_hr_trial_notices:[],gw_hr_trial_notice_deliveries:[]
};
let counter=0,actorContext={tenantId:T,isAdmin:true,roles:["owner"],apps:["hr"]};
const mails=[],audits=[];
const makeId=()=>("00000000-0000-4000-8000-"+String(++counter).padStart(12,"0"));
class Q{
 constructor(table){this.table=table;this.mode="select";this.filters=[];this.max=99999;this.sort=null;this.data=null;this.columns=null;}
 select(cols){this.columns=cols;return this;}
 insert(v){this.mode="insert";this.data=v;return this;}
 update(v){this.mode="update";this.data=v;return this;}
 eq(k,v){this.filters.push([k,v]);return this;}
 order(k,{ascending}={}){this.sort={k,ascending};return this;}
 limit(n){this.max=n;return this;}
 maybeSingle(){const r=this.perform();return Promise.resolve({data:r.data?.[0]||null,error:r.error});}
 then(resolve,reject){return Promise.resolve(this.perform()).then(resolve,reject);}
 perform(){
  let src=rows[this.table];if(!Array.isArray(src))return{data:null,error:{message:"unknown table "+this.table}};
  let filtered=src.filter(x=>this.filters.every(([k,v])=>x[k]===v));
  if(this.sort)filtered=[...filtered].sort((a,b)=>this.sort.ascending?Number(a[this.sort.k]>b[this.sort.k])-Number(a[this.sort.k]<b[this.sort.k]):Number(a[this.sort.k]<b[this.sort.k])-Number(a[this.sort.k]>b[this.sort.k]));
  filtered=filtered.slice(0,this.max);
  if(this.mode==="insert"){
   const row={id:makeId(),...this.data};
   if(this.table==="gw_hr_trial_notices"&&src.some(x=>x.tenant_id===row.tenant_id&&x.applicant_id===row.applicant_id&&x.version===row.version))
    return{data:null,error:{code:"23505"}};
   if(this.table==="gw_hr_trial_notice_deliveries"&&src.some(x=>x.tenant_id===row.tenant_id&&(x.notice_id===row.notice_id||x.request_key===row.request_key)))
    return{data:null,error:{code:"23505"}};
   src.push(row);return{data:[row],error:null};
  }
  if(this.mode==="update"){for(const item of filtered)Object.assign(item,this.data);return{data:filtered,error:null};}
  return{data:filtered,error:null};
 }
}
const fakeAdmin=()=>({from:table=>new Q(table)});
const h=createHandler({requireUser:async()=>({id:U}),gwContext:async()=>actorContext,admin:fakeAdmin,
 gwLog:async x=>audits.push(x),mailConfig:()=>({configured:true,from:"HR <hr@example.invalid>",provider:"mock"}),
 sendMail:async m=>{mails.push(m);return{status:"sent",providerMessageId:"mock-1"};}
});
async function call(method,body={}){
 let status=200,payload=null;const res={setHeader(){},set statusCode(v){status=v;},get statusCode(){return status;},end(s){payload=JSON.parse(s);}};
 await h({method,body,headers:{},url:"/?applicantId="+A},res);
 return{status,data:payload};
}
const oldEnabled=process.env.HR_TRIAL_NOTICE_ENABLED,oldSend=process.env.HR_TRIAL_NOTICE_SEND_ENABLED;
try{
 process.env.HR_TRIAL_NOTICE_ENABLED="1";process.env.HR_TRIAL_NOTICE_SEND_ENABLED="0";
 let r=await call("GET");assert.equal(r.status,200);assert.equal(r.data.eligible,true);assert.equal(r.data.current,null);
 r=await call("POST",{action:"save",applicantId:A,values,expectedVersion:0});
 assert.equal(r.status,200);assert.equal(r.data.version,1);assert.equal(mails.length,0);
 r=await call("GET");assert.equal(r.data.current.version,1);
 r=await call("POST",{action:"export",applicantId:A});
 assert.equal(r.status,200);assert.equal(Buffer.from(r.data.contentBase64,"base64").subarray(0,2).toString(),"PK");assert.equal(mails.length,0);
 r=await call("POST",{action:"save",applicantId:A,values,expectedVersion:0});assert.equal(r.status,409);
 r=await call("POST",{action:"previewSend",applicantId:A});assert.equal(r.status,403);assert.equal(mails.length,0);
 process.env.HR_TRIAL_NOTICE_SEND_ENABLED="1";
 r=await call("POST",{action:"previewSend",applicantId:A});assert.equal(r.status,409);
 r=await call("POST",{action:"approve",applicantId:A,confirmed:true,professionalReviewed:true,reviewEvidence:"確認履歴が短い"});assert.equal(r.status,400);
 r=await call("POST",{action:"approve",applicantId:A,confirmed:true,professionalReviewed:true,
   reviewEvidence:"2026-11-13・社労士による期間・保険・賃金・同意条項の実査済み（合成確認）"});
 assert.equal(r.status,200);assert.equal(mails.length,0);
 r=await call("POST",{action:"previewSend",applicantId:A});assert.equal(r.status,200);
 const digest=r.data.confirmation.digest;
 assert.equal(r.data.confirmation.to,"candidate@example.invalid");
 assert.equal(mails.length,0);
 r=await call("POST",{action:"send",applicantId:A,confirmed:true,confirmDigest:"bad",
   requestKey:"12345678-1234-4234-8234-123456789012"});assert.equal(r.status,409);assert.equal(mails.length,0);
 const key="12345678-1234-4234-8234-123456789012";
 r=await call("POST",{action:"send",applicantId:A,confirmed:true,confirmDigest:digest,requestKey:key});
 assert.equal(r.status,200);assert.equal(r.data.mailSent,true);assert.equal(mails.length,1);
 assert.equal(mails[0].attachments[0].filename.endsWith(".docx"),true);
 assert.equal(rows.gw_hr_trial_notices[0].state,"sent");
 r=await call("POST",{action:"send",applicantId:A,confirmed:true,confirmDigest:digest,requestKey:key});assert.equal(r.status,409);
 assert.equal(mails.length,1,"never silently resend a sent version");
 actorContext={...actorContext,tenantId:"11111111-1111-4111-8111-111111111111"};
 r=await call("GET");assert.equal(r.status,404);
 actorContext={tenantId:T,isAdmin:false,roles:["recruiter"],apps:["hr"]};
 r=await call("GET");assert.equal(r.status,403);
 assert.ok(audits.some(x=>x.action==="hr.trial_notice_draft")&&audits.some(x=>x.action==="hr.trial_notice_approved"));
 assert.ok(audits.some(x=>x.action==="hr.trial_notice_mail_sent"));
 console.log("HR trial notice API mock: tenant/salary isolation, no implicit mail, review, digest and single send PASS");
}finally{
 if(oldEnabled===undefined)delete process.env.HR_TRIAL_NOTICE_ENABLED;else process.env.HR_TRIAL_NOTICE_ENABLED=oldEnabled;
 if(oldSend===undefined)delete process.env.HR_TRIAL_NOTICE_SEND_ENABLED;else process.env.HR_TRIAL_NOTICE_SEND_ENABLED=oldSend;
}
