// All identities/content/credentials below are synthetic. No real DB/mail/network calls.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createMemDb } from "./_memdb.mjs";
import * as S from "../lib/gw-owner-snapshot.js";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const T=id(1), O=id(2), E=id(3), X=id(4), U=id(5), V=id(6), Q=id(7), R=id(8);
const now = new Date("2026-10-28T08:20:00Z");
const env = { VERCEL_ENV:"production", GW_OWNER_SNAPSHOT_ENABLED:"1", GW_OWNER_SNAPSHOT_TENANT_ID:T,
  GW_OWNER_SNAPSHOT_OWNER_EMPLOYEE_ID:O, GW_OWNER_SNAPSHOT_CONSENT_AT:"2026-10-28T07:00:00Z",
  GW_OWNER_SNAPSHOT_ROSTER_CONFIRMED:"1", GW_OWNER_SNAPSHOT_INITIAL_DATE:"2026-10-28", MAIL_PROVIDER:"smtp",
  MAIL_SEND_ENABLED:"1", HR_RECRUITING_FROM:"合成送信元 <saiyou@8grp.co.jp>",
  SMTP_HOST:"smtp.invalid", SMTP_PORT:"465", SMTP_SECURE:"1", SMTP_USER:"synthetic", SMTP_PASS:"synthetic-not-a-credential" };
const cfg = S.snapshotConfig(env, now);
const stamp = "2026-10-28T16:50:00+09:00";
let pass=0, fail=0;
async function test(name, fn) { try { await fn(); console.log("ok",name); pass++; } catch(e) { console.error("NG",name,e); fail++; } }
function fixture() {
 const db = createMemDb({schema:{gw_owner_snapshot_sends:{unique:[["tenant_id","dispatch_key"]]}}});
 db.rows.gw_employees = [
  {id:O,tenant_id:T,user_id:U,display_name:"合成代表",email:S.RECIPIENT,status:"active",joined_on:"2020-01-01",department:"代表",position:"代表取締役"},
  {id:E,tenant_id:T,user_id:V,display_name:"合成メンバー",status:"active",joined_on:"2020-01-01",department:"営業",position:"担当"},
  {id:X,tenant_id:Q,user_id:R,display_name:"OTHER_TENANT_SENTINEL",status:"active"},
  {id:id(9),tenant_id:T,user_id:id(10),display_name:"LEFT_SENTINEL",status:"leaving",left_on:"2026-10-27"},
 ];
 db.rows.gw_role_grants=[{tenant_id:T,employee_id:O,role:"owner"}];
 db.rows.memberships=[{tenant_id:T,user_id:U,role:"staff"}];
 db.rows.gw_nippo_shares=[
  {tenant_id:T,nippo_id:id(20),user_id:V,work_date:"2026-10-28",visible:true},
  {tenant_id:T,nippo_id:id(21),user_id:V,work_date:"2026-10-27",visible:true},
  {tenant_id:Q,nippo_id:id(22),user_id:V,work_date:"2026-10-28",visible:true},
  {tenant_id:T,nippo_id:id(23),user_id:V,work_date:"2026-10-28",visible:false},
 ];
 db.rows.tc_nippo=[
  {id:id(20),user_id:V,work_date:"2026-10-28",submitted_at:stamp,updated_at:stamp,top_priority:"提案書を提出",salary:"SALARY_SENTINEL",consult_note:"CONSULT_SENTINEL",
   work_items:[{task:"提案書",target:3,actual:2,unit:"件",result:"2件提出",undone_reason:"HEALTH_REASON_SENTINEL",done:false,actual_minutes:45,planned_starts_at:"2026-10-28T09:00:00+09:00",planned_ends_at:"2026-10-28T10:00:00+09:00",unknown:"NESTED_SECRET_SENTINEL"}]},
  {id:id(21),user_id:V,work_date:"2026-10-27",submitted_at:"2026-10-27T08:00:00Z",updated_at:"2026-10-27T08:00:00Z",work_items:[{task:"提案書",target:2,actual:1,result:"1件提出"}]},
  {id:id(22),user_id:V,work_date:"2026-10-28",work_items:[{task:"OTHER_REPORT_SENTINEL"}]},
  {id:id(23),user_id:V,work_date:"2026-10-28",work_items:[{task:"HIDDEN_REPORT_SENTINEL"}]},
 ];
 db.rows.gw_calendar_events = [
  {id:id(30),tenant_id:T,employee_id:E,title:"共有商談",planned_quantity:3,planned_quantity_unit:"件",category:"meeting",source:"self",visibility:"shared",starts_at:"2026-10-29T10:00:00+09:00",ends_at:"2026-10-29T11:00:00+09:00",body:"PRIVATE_MEMO_SENTINEL",location:"LOCATION_SENTINEL",updated_at:stamp},
  ...["private","busy"].map((visibility,i)=>({id:id(31+i),tenant_id:T,employee_id:E,title:"HIDDEN_EVENT_SENTINEL",category:"work",source:"self",visibility,starts_at:"2026-10-29T10:00:00+09:00",ends_at:"2026-10-29T11:00:00+09:00"})),
  {id:id(33),tenant_id:T,employee_id:E,title:"PRIVATE_CATEGORY_SENTINEL",category:"private",source:"self",visibility:"shared",starts_at:"2026-10-29T10:00:00+09:00",ends_at:"2026-10-29T11:00:00+09:00"},
  {id:id(34),tenant_id:T,employee_id:E,title:"GOOGLE_SENTINEL",category:"work",source:"google",visibility:"shared",starts_at:"2026-10-29T10:00:00+09:00",ends_at:"2026-10-29T11:00:00+09:00"},
 ];
 db.rows.gw_tasks=[{id:id(40),tenant_id:T,assignee_id:E,focus_for:E,focus_date:"2026-10-29",title:"提案書を仕上げる",done_condition:"3件提出",due_on:"2026-10-30",status:"todo",body:"TASK_BODY_SENTINEL",updated_at:stamp}];
 db.rows.gw_focus_days=[{tenant_id:T,employee_id:E,focus_date:"2026-10-29",status:"confirmed",confirmed_at:stamp,updated_at:stamp}];
 db.rows.gw_reminder_prefs=[{tenant_id:T,employee_id:E,workdays:[1,3,5],evening_at:"17:45",updated_at:stamp}];
 db.rows.gw_requests=[{tenant_id:T,employee_id:E,kind:"leave",status:"approved",leave_type:"special",starts_on:"2026-10-30",ends_on:"2026-10-30",title:"HEALTH_TITLE_SENTINEL",body:"HEALTH_BODY_SENTINEL",updated_at:stamp}];
 return db;
}
await test("fail closed authentication: missing/blank/wrong rejected",()=>{
 for(const v of [undefined,""," "]) assert.equal(S.authorized("Bearer ",v),false);
 assert.equal(S.authorized("Bearer wrong","test-only"),false);
 assert.equal(S.authorized("Bearer test-only","test-only"),true);
});
await test("enabled requires production, bound owner/tenant, consent, reviewed roster, exact SMTP sender",()=>{
 assert.equal(cfg.ok,true);
 for(const [key,value] of Object.entries({GW_OWNER_SNAPSHOT_ENABLED:"",VERCEL_ENV:"preview",GW_OWNER_SNAPSHOT_TENANT_ID:"wrong",GW_OWNER_SNAPSHOT_OWNER_EMPLOYEE_ID:"",GW_OWNER_SNAPSHOT_CONSENT_AT:"2099-01-01",GW_OWNER_SNAPSHOT_ROSTER_CONFIRMED:"",HR_RECRUITING_FROM:"other@example.com",MAIL_PROVIDER:"resend",MAIL_SEND_ENABLED:"0",SMTP_PASS:""}))
  assert.equal(S.snapshotConfig({...env,[key]:value},now).ok,false,key);
 assert.equal(S.snapshotConfig({...env,GW_OWNER_SNAPSHOT_EXCLUDED_EMPLOYEE_IDS:O},now).ok,false);
});
await test("JST scheduled window and initial date are bounded",()=>{
 assert.equal(S.slotFor(now,"evening",cfg),"evening"); assert.equal(S.slotFor(now,"morning",cfg),null);
 assert.equal(S.slotFor(new Date("2026-10-27T22:50:00Z"),"morning",cfg),"morning");
 assert.equal(S.slotFor(new Date("2026-10-28T11:00:00Z"),null,cfg),null);
 assert.equal(S.slotFor(now,"initial",cfg),"initial");
 assert.equal(S.slotFor(new Date("2026-10-29T08:20:00Z"),"initial",cfg),null);
 assert.equal(S.slotFor(new Date("2026-10-29T08:20:00Z"),"initial",{...cfg,initialDate:"2026-10-29"}),null);
});
await test("original quantity comparison, source date/version, no private or other tenant data",async()=>{
 const db=fixture(), s=await S.readSnapshot(db.admin(),cfg,now), text=JSON.stringify(s);
 assert.equal(s.coverage.targetMembers,2); assert.equal(s.coverage.todayOriginalsObtained,1);
 assert.equal(s.coverage.previousOriginalsObtained,1); assert.equal(s.coverage.nextBusinessPlanObtained,1);
 assert.equal(s.members[1].reports[0].items[0].actual,2); assert.equal(s.members[1].reports[1].items[0].actual,1);
 assert.equal(s.members[1].reports[0].items[0].actualMinutes,45); assert.equal(s.members[1].reports[0].items[0].plannedStartsAt,"2026-10-28T09:00:00+09:00");
 assert.equal(s.members[1].reports[0].updatedAt,stamp); assert.equal(s.members[1].tasks[0].planConfirmed,true);
 assert.equal(s.members[1].schedule.length,1); assert.equal(s.members[1].schedule[0].plannedQuantity,3); assert.equal(s.members[1].schedule[0].plannedQuantityState,"recorded"); assert.equal(/SENTINEL/.test(text),false);
 assert.equal(db.state.log.length,0,"reader must not mutate business sources");
});
await test("missing original means unknown, never a non-submission or absence",async()=>{
 const s=await S.readSnapshot(fixture().admin(),cfg,now), owner=s.members[0];
 assert.equal(owner.reports.length,0); assert.ok(owner.missing.includes("today_original_not_obtained_not_a_missing_submission_judgment"));
 assert.equal(owner.workdayHint,null); assert.equal("unsubmitted" in owner,false);
});
await test("leave only availability full/AM/PM, no reasons or sensitive subtype",async()=>{
 const db=fixture(); db.rows.gw_requests.push({...db.rows.gw_requests[0],leave_type:"am",starts_on:"2026-10-29"},{...db.rows.gw_requests[0],leave_type:"pm",starts_on:"2026-10-31"});
 const s=await S.readSnapshot(db.admin(),cfg,now), x=s.members[1];
 assert.deepEqual(x.unavailable.map(l=>l.period),["morning","full_day","afternoon"]);
 assert.equal(JSON.stringify(x.unavailable).includes("special"),false); assert.equal(x.workdayHint.authoritativeShiftOrDeadline,false);
});
await test("excluded synthetic/shared accounts not counted as targets",async()=>{
 const db=fixture(); const s=await S.readSnapshot(db.admin(),{...cfg,excluded:[E]},now);
 assert.equal(s.coverage.rosterCandidates,2);assert.equal(s.coverage.approvedExclusions,1);assert.equal(s.coverage.targetMembers,1);
 assert.equal(JSON.stringify(s).includes("合成メンバー"),false);
});
await test("current owner role, membership, active status, address are required every time",async()=>{
 for (const action of [db=>db.rows.gw_role_grants=[],db=>db.rows.memberships=[],db=>db.rows.memberships[0].role="client",db=>db.rows.gw_employees[0].status="left",db=>db.rows.gw_employees[0].email="wrong@example.com"]) {
  const db=fixture();action(db);await assert.rejects(()=>S.readSnapshot(db.admin(),cfg,now));
 }
});
await test("roster failed or missing is blocked, not treated as empty success",async()=>{
 const db=fixture();db.state.missing="gw_employees";await assert.rejects(()=>S.readSnapshot(db.admin(),cfg,now),/roster_unavailable/);
});
await test("failed source is explicit incomplete and not zero-success",async()=>{
 const db=fixture();db.state.missing="gw_requests";const s=await S.readSnapshot(db.admin(),cfg,now);
 assert.equal(s.coverage.sourceReadsComplete,false);assert.ok(s.coverage.issues.includes("leave:read_failed"));
});
await test("provenance mismatch never releases original record",async()=>{
 const db=fixture();db.rows.gw_nippo_shares[0].work_date="2026-10-27";
 const s=await S.readSnapshot(db.admin(),cfg,now);assert.equal(s.coverage.todayOriginalsObtained,0);
 assert.ok(s.coverage.issues.includes("reports:provenance_original_mismatch"));
});
await test("joined-on prevents prior employee-history exposure",async()=>{
 const db=fixture();db.rows.gw_employees[1].joined_on="2026-10-28";
 const s=await S.readSnapshot(db.admin(),cfg,now);assert.equal(s.members[1].reports.length,1);
});
await test("overlap and zero-duration all-day shared events are included",async()=>{
 const db=fixture();const e=db.rows.gw_calendar_events[0];
 db.rows.gw_calendar_events.push({...e,id:id(90),title:"継続業務",starts_at:"2026-10-27T10:00:00+09:00",ends_at:"2026-10-29T10:00:00+09:00"},
  {...e,id:id(91),title:"終日",all_day:true,starts_at:"2026-10-28T00:00:00+09:00",ends_at:"2026-10-28T00:00:00+09:00"});
 const s=await S.readSnapshot(db.admin(),cfg,now);assert.equal(s.members[1].schedule.length,3);
});
await test("SMTP accepted is not mailbox delivery; metadata ledger only",async()=>{
 const db=fixture(), sent=[];const r=await S.deliverSnapshot({sb:db.admin(),cfg,now,slot:"evening",env,mailer:async m=>{sent.push(m);return{status:"sent"};}});
 assert.equal(r.status,"accepted");assert.equal(r.deliveryConfirmed,false);assert.equal(sent[0].to,S.RECIPIENT);
 assert.equal(sent[0].purpose,"gw_snapshot");assert.match(sent[0].text,/GW_SNAPSHOT_JSON_BEGIN/);
 assert.equal(db.rows.gw_owner_snapshot_sends[0].status,"accepted");
 for(const k of ["text","body_text","subject","to_email","provider_error"]) assert.equal(k in db.rows.gw_owner_snapshot_sends[0],false);
 assert.equal(JSON.stringify(r).includes("合成"),false);
});
await test("concurrent invocations cause only one SMTP attempt",async()=>{
 const db=fixture();let count=0;const p={sb:db.admin(),cfg,now,slot:"evening",env,mailer:async()=>{count++;await new Promise(r=>setTimeout(r,10));return{status:"sent"};}};
 const r=await Promise.all([S.deliverSnapshot(p),S.deliverSnapshot(p)]);assert.equal(count,1);
 assert.deepEqual(r.map(x=>x.status).sort(),["accepted","duplicate_suppressed"]);
});
await test("failed/timeout/throw are unknown; no retry or false success",async()=>{
 for(const mailer of [async()=>({status:"failed",error:"Rejected"}),async()=>({status:"failed",error:"ECONNRESET"}),async()=>{throw new Error("arbitrary sensitive provider error");}]) {
  const db=fixture();const p={sb:db.admin(),cfg,now,slot:"evening",env,mailer};
  assert.equal((await S.deliverSnapshot(p)).status,"unknown");
  assert.equal((await S.deliverSnapshot(p)).status,"duplicate_suppressed");
 }
});
await test("not configured/skipped is not sent",async()=>{
 const db=fixture();assert.equal((await S.deliverSnapshot({sb:db.admin(),cfg,now,slot:"evening",env,mailer:async()=>({status:"skipped"})})).status,"not_sent");
});
await test("missing ledger stops before SMTP",async()=>{
 const db=fixture();db.state.missing="gw_owner_snapshot_sends";let count=0;
 await assert.rejects(()=>S.deliverSnapshot({sb:db.admin(),cfg,now,slot:"evening",env,mailer:async()=>{count++;}}),/dispatch_claim_failed/);assert.equal(count,0);
});
await test("outcome persistence failure leaves sending and prevents duplicate",async()=>{
 const db=fixture();const p={sb:db.admin(),cfg,now,slot:"evening",env,mailer:async()=>{db.state.missing="gw_owner_snapshot_sends";return{status:"sent"};}};
 const r=await S.deliverSnapshot(p);assert.equal(r.status,"unknown");assert.equal(r.reason,"outcome_record_failed");
 db.state.missing=null;assert.equal(db.rows.gw_owner_snapshot_sends[0].status,"sending");assert.equal((await S.deliverSnapshot(p)).status,"duplicate_suppressed");
});
await test("initial only once per consent even on another date",async()=>{
 const db=fixture();let count=0;const p={sb:db.admin(),cfg,now,slot:"initial",env,mailer:async()=>{count++;return{status:"sent"};}};
 await S.deliverSnapshot(p);await S.deliverSnapshot({...p,now:new Date(now.getTime()+86400000)});assert.equal(count,1);
});
await test("API requires secret before DB and rejects method or caller-scope expansion",async()=>{
 let dbCalled=0;mock.module(new URL("../lib/supabase.js",import.meta.url).href,{namedExports:{admin:()=>{dbCalled++;return fixture().admin();}}});
 const {default:handler}=await import("../api/cron/gw-owner-snapshot.js");
 const savedEnvReference=process.env;process.env={...env,CRON_SECRET:"test-only"};
 const run=async(method,url,auth)=>{const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(x){this.body=JSON.parse(x);}};await handler({method,url,headers:{authorization:auth}},res);return res;};
 try {
  assert.equal((await run("GET","/api/cron/gw-owner-snapshot")).statusCode,401);
  assert.equal((await run("POST","/api/cron/gw-owner-snapshot","Bearer test-only")).statusCode,405);
  assert.equal((await run("GET","/api/cron/gw-owner-snapshot?to=attacker@example.com","Bearer test-only")).statusCode,400);
  assert.equal((await run("GET","/api/cron/gw-owner-snapshot?slot=initial&slot=evening","Bearer test-only")).statusCode,400);
  delete process.env.CRON_SECRET;assert.equal((await run("GET","/api/cron/gw-owner-snapshot")).statusCode,401);
  assert.equal(dbCalled,0);
 } finally {process.env=savedEnvReference;mock.reset();}
});
await test("approved bounded cron schedules; restrictive metadata-only SQL; no secret serialization",()=>{
 const cron=JSON.parse(readFileSync(new URL("../vercel.json",import.meta.url),"utf8"));
 assert.deepEqual((cron.crons||[]).filter(x=>x.path.includes("gw-owner-snapshot")), [{"path":"/api/cron/gw-owner-snapshot","schedule":"50 22 * * *"},{"path":"/api/cron/gw-owner-snapshot","schedule":"20 8 * * *"},{"path":"/api/cron/gw-owner-snapshot-initial","schedule":"*/5 13-14 28 10 *"}]);
 const sql=readFileSync(new URL("../db/148_gw_owner_snapshot_sends.sql",import.meta.url),"utf8");
 assert.match(sql,/unique \(tenant_id, dispatch_key\)/);assert.match(sql,/revoke all.*anon, authenticated/);assert.match(sql,/enable row level security/);
 assert.equal(/create policy/i.test(sql),false);
});
await test("stable fingerprint ignores checked-at, changes on original version",async()=>{
 const db=fixture();const a=await S.readSnapshot(db.admin(),cfg,now);
 const b=await S.readSnapshot(db.admin(),cfg,new Date(now.getTime()+60000));
 assert.equal(a.fingerprint,b.fingerprint);assert.match(a.fingerprint,/^sha256:[0-9a-f]{64}$/);
 db.rows.tc_nippo[0].updated_at="2026-10-28T16:51:00+09:00";
 assert.notEqual(a.fingerprint,(await S.readSnapshot(db.admin(),cfg,now)).fingerprint);
 assert.match(S.renderMail(a).subject,/^\[GW日報スナップショット\]/);
 assert.equal(S.renderMail(a).replyTo,S.SENDER);
});
await test("server row cap cannot masquerade as complete roster",async()=>{
 const db=fixture(), base=db.admin();
 const sb={from(table){const q=base.from(table);if(table==="gw_employees") {const then=q.then;q.then=(fn,rej)=>then(r=>fn({...r,count:r.data.length+100}),rej);}return q;}};
 await assert.rejects(()=>S.readSnapshot(sb,cfg,now),/roster_unavailable/);
});
await test("original done boolean is authoritative; result text never implies completion",async()=>{
 const db=fixture();db.rows.tc_nippo[0].work_items=[{task:"明示未完",result:"1件提出",target:3,actual:1,done:false},
  {task:"旧式不明",result:"1件提出"},{task:"明示完了",done:true}];
 const s=await S.readSnapshot(db.admin(),cfg,now);assert.deepEqual(s.members[1].reports[0].items.map(i=>i.done),[false,null,true]);
});
await test("unknown employment status remains visible as review count, not a missing person",async()=>{
 const db=fixture();db.rows.gw_employees.push({id:id(100),tenant_id:T,status:"legacy_unknown",display_name:"UNCERTAIN_SENTINEL"});
 const s=await S.readSnapshot(db.admin(),cfg,now);assert.equal(s.coverage.unknownStatusAwaitingReview,1);
 assert.equal(s.coverage.targetMembers,2);assert.equal(s.coverage.rosterRows,4);assert.equal(JSON.stringify(s).includes("UNCERTAIN_SENTINEL"),false);
});
await test("missing optional schedule quantity columns use explicit incomplete fallback",async()=>{
 const db=fixture(), base=db.admin();let attempts=0;
 const sb={from(table){const q=base.from(table), select=q.select;let quantity=false;
   q.select=(cols,opts)=>{quantity=table==="gw_calendar_events" && cols.includes("planned_quantity");return select(cols,opts);};
   const then=q.then;q.then=(fn,rej)=>quantity ? (attempts++,Promise.resolve(fn({data:null,error:{code:"42703"}}))) : then(fn,rej);return q;}};
 const s=await S.readSnapshot(sb,cfg,now);assert.equal(attempts,1);assert.equal(s.members[1].schedule.length,1);
 assert.equal(s.members[1].schedule[0].plannedQuantityState,"schema_unavailable");assert.equal(s.coverage.sourceReadsComplete,false);
 assert.ok(s.coverage.issues.includes("schedule:planned_quantity_columns_unavailable"));
});
console.log(`${pass} passed, ${fail} failed`);if(fail)process.exit(1);
