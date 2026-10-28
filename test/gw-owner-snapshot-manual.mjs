// Synthetic manual owner POST only: no real authentication, DB, SMTP or secrets.
import assert from "node:assert/strict";
import { createMemDb } from "./_memdb.mjs";
import { handleManualSnapshot } from "../api/nippo/owner-snapshot.js";
import { deliverSnapshot, RECIPIENT } from "../lib/gw-owner-snapshot.js";
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const T=id(1),O=id(2),U=id(3),N=id(4);const now=new Date("2026-10-28T12:00:00Z");
const env={VERCEL_ENV:"production",GW_OWNER_SNAPSHOT_ENABLED:"1",GW_OWNER_SNAPSHOT_TENANT_ID:T,GW_OWNER_SNAPSHOT_OWNER_EMPLOYEE_ID:O,
 GW_OWNER_SNAPSHOT_CONSENT_AT:"2026-10-28T11:40:00Z",GW_OWNER_SNAPSHOT_ROSTER_CONFIRMED:"1",MAIL_PROVIDER:"smtp",MAIL_SEND_ENABLED:"1",
 HR_RECRUITING_FROM:"saiyou@8grp.co.jp",SMTP_HOST:"smtp.invalid",SMTP_USER:"synthetic",SMTP_PASS:"synthetic-not-a-real-credential"};
function db(){const d=createMemDb({schema:{gw_owner_snapshot_sends:{unique:[["tenant_id","dispatch_key"]]}}});
 d.rows.gw_employees=[{id:O,tenant_id:T,user_id:U,email:RECIPIENT,display_name:"PRIVATE_NAME_SENTINEL",status:"active",joined_on:"2020-01-01"}];
 d.rows.gw_role_grants=[{tenant_id:T,employee_id:O,role:"owner"}];d.rows.memberships=[{tenant_id:T,user_id:U,role:"staff"}];
 d.rows.gw_nippo_shares=[{tenant_id:T,nippo_id:N,user_id:U,work_date:"2026-10-28",visible:true}];
 d.rows.tc_nippo=[{id:N,user_id:U,work_date:"2026-10-28",updated_at:"2026-10-28T11:00:00Z",work_items:[{task:"PRIVATE_TASK_SENTINEL",done:false}]}];return d;}
const request=()=>({method:"POST",url:"/api/nippo/owner-snapshot",body:{},headers:{origin:"https://gw.8grp.co.jp","sec-fetch-site":"same-origin","content-type":"application/json",authorization:"Bearer synthetic-owner-jwt"}});
function harness(d=db()){let sent=0,authCalls=0;const opts={now,env,authenticate:async()=>{authCalls++;return{id:U};},sbFactory:()=>d.admin(),deliver:args=>deliverSnapshot({...args,mailer:async()=>{sent++;return{status:"sent"};}})};
 return{d,opts,get sent(){return sent;},get authCalls(){return authCalls;},async call(req=request(),extra={}){const r={headers:{},setHeader(k,v){this.headers[k]=v;},end(x){this.body=JSON.parse(x);}};await handleManualSnapshot(req,r,{...opts,...extra});return r;}};}
let pass=0,fail=0;async function test(name,fn){try{await fn();console.log("ok",name);pass++;}catch(e){console.error("NG",name,e);fail++;}}
await test("POST-only, explicit JWT, exact Origin and JSON; cross-site/form requests rejected before auth",async()=>{
 for(const change of [r=>r.method="GET",r=>r.headers.origin="https://attacker.invalid",r=>delete r.headers.origin,r=>r.headers["content-type"]="text/plain",r=>r.headers["sec-fetch-site"]="cross-site",r=>delete r.headers.authorization]){
  const h=harness(),r=request();change(r);assert.ok([403,405].includes((await h.call(r)).statusCode));assert.equal(h.authCalls,0);assert.equal(h.sent,0);
 }
});
await test("recipient/tenant/date/body/query overrides rejected before auth",async()=>{
 for(const change of [r=>r.body={to:"someone@example.com"},r=>r.url+="?tenant=other",r=>r.body={date:"2026-10-01"},r=>r.body=[]]){const h=harness(),r=request();change(r);assert.equal((await h.call(r)).statusCode,400);assert.equal(h.authCalls,0);}
});
await test("existing authentication remains mandatory",async()=>{
 const h=harness(),r=await h.call(request(),{authenticate:async(req,res)=>{res.statusCode=401;res.end(JSON.stringify({error:"unauthorized"}));return null;}});assert.equal(r.statusCode,401);assert.equal(h.sent,0);
});
await test("only exact configured owner actor; other owner/user/tenant rejected",async()=>{
 const h=harness();assert.equal((await h.call(request(),{authenticate:async()=>({id:id(9)})})).statusCode,403);assert.equal(h.sent,0);
 assert.equal((await h.call(request(),{env:{...env,GW_OWNER_SNAPSHOT_TENANT_ID:id(10)}})).statusCode,403);assert.equal(h.sent,0);
});
await test("unconfigured gives actionable explanation and sends nothing",async()=>{
 const h=harness(),r=await h.call(request(),{env:{...env,GW_OWNER_SNAPSHOT_ENABLED:"0"}});assert.equal(r.statusCode,503);assert.match(r.body.hint,/初期設定/);assert.equal(r.body.sendAttempted,false);assert.equal(h.sent,0);
});
await test("revoked owner/status/membership fails before mail even with valid old session",async()=>{
 for(const change of [d=>d.rows.gw_role_grants=[],d=>d.rows.gw_employees[0].status="left",d=>d.rows.memberships[0].role="client"]){const h=harness();change(h.d);assert.equal((await h.call()).statusCode,403);assert.equal(h.sent,0);}
});
await test("one-click accepts fixed mail without browser CRON_SECRET; response has no private payload",async()=>{
 const h=harness(),r=await h.call();assert.equal(r.statusCode,200);assert.equal(r.body.status,"accepted");assert.equal(r.body.deliveryConfirmed,false);assert.equal(h.sent,1);
 assert.equal(h.d.rows.gw_owner_snapshot_sends[0].slot,"manual");assert.match(h.d.rows.gw_owner_snapshot_sends[0].dispatch_key,/^manual:sha256:/);
 assert.equal(JSON.stringify(r.body).includes("SENTINEL"),false);assert.equal(r.headers["Cache-Control"],"no-store");
});
await test("same fingerprint and concurrent POSTs send once, changed original creates new version",async()=>{
 const h=harness();const r=await Promise.all([h.call(),h.call()]);assert.equal(h.sent,1);assert.deepEqual(r.map(x=>x.body.status).sort(),["accepted","duplicate_suppressed"]);
 assert.equal((await h.call(request(),{now:new Date(now.getTime()+60000)})).body.status,"duplicate_suppressed");
 h.d.rows.tc_nippo[0].updated_at="2026-10-28T11:59:00Z";assert.equal((await h.call()).body.status,"accepted");assert.equal(h.sent,2);
});
await test("unknown outcome and reload/reclick cannot automatically resend",async()=>{
 const h=harness();let attempts=0;h.opts.deliver=args=>deliverSnapshot({...args,mailer:async()=>{attempts++;return{status:"failed",error:"ECONNRESET"};}});
 const a=await h.call();assert.equal(a.statusCode,502);assert.equal(a.body.error,"dispatch_result_unknown");assert.match(a.body.hint,/再送しません/);
 assert.equal((await h.call()).body.status,"duplicate_suppressed");assert.equal(attempts,1);
});
await test("actor binding is rechecked during source read, not only initial endpoint lookup",async()=>{
 const h=harness();h.opts.deliver=args=>{h.d.rows.gw_employees[0].user_id=id(20);return deliverSnapshot({...args,mailer:async()=>{throw new Error("must not send");}});};
 assert.equal((await h.call()).statusCode,403);
});
console.log(`${pass} passed, ${fail} failed`);if(fail)process.exit(1);
