import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMemDb} from './_memdb.mjs';
import * as http from '../lib/http.js';
import * as mailPolicy from '../lib/sales-meeting-closeout.js';
import {meetingStepDetails} from '../lib/sales-meeting-step-details.js';
import {confirmedCompanyOffers} from '../lib/sales-company-offer-bridge.js';
const CO='11111111-2222-4333-8444-555555555555',ID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TENANT='tenant-a',USER='staff-a';
function harness(file){
 const mem=createMemDb({schema:{gw_sales_meeting_closeouts:{unique:[['tenant_id','company_id','session_id']]}}});
 const db=mem.admin();db.schema=()=>db;
 const state={authenticated:true,sell:true,scope:true,sent:[],mailStatus:'sent',from:'its@gw.8grp.co.jp',configured:true,authWrites:0};
 db.auth={admin:{getUserById:async()=>({data:{user:{id:'auth-a',email:'customer@example.test',app_metadata:{apps:['business']}}}}),
  createUser:async()=>{state.authWrites++;throw Error('Unexpected account creation');},deleteUser:async()=>{state.authWrites++;}}};
 const dependencies={
  '../../lib/http.js':http,
  '../../lib/auth.js':{requireUser:async(_req,res)=>state.authenticated?{id:USER}:http.json(res,401,{error:'unauthorized'})},
  '../../lib/gw.js':{gwContext:async()=>({tenantId:TENANT}),canSell:()=>state.sell},
  '../../lib/sales-enger-scope.js':{canAccessEightEngerDirectory:()=>true},
  '../../lib/supabase.js':{admin:()=>db},
  '../../lib/sales.js':{isUuid:value=>[CO,ID].includes(value)},
  '../../lib/sales-company-portal-db.js':{companyInScope:async()=>state.scope?{ok:true}:{ok:false,error:'forbidden',status:403},
   isInternalEmail:async()=>false,logPortalEvent:async()=>{}},
  '../../lib/sales-company-number.js':{formatCompanyNumber:()=> '00311'},
  '../../lib/sales-company-portal.js':{portalBaseUrl:()=> 'https://enger.jp',isCompanyIdOnlyEmail:()=>false,isReservedCompanyLoginEmail:()=>false},
  '../../lib/mail/index.js':{mailConfig:()=>({configured:state.configured,fromAddress:state.from,reason:'test'}),
   sendMail:async message=>{state.sent.push(message);return {status:state.mailStatus,provider:'mock',providerMessageId:'mail-a'};}},
  '../../lib/gw-audit.js':{gwLog:async()=>{}},
  '../../lib/sales-meeting-closeout.js':mailPolicy,
  '../../lib/sales-company-offer-bridge.js':{confirmedCompanyOffers},
  '../../lib/sales-meeting-step-details.js':{meetingStepDetails},
 };
 // Run the actual handler with explicit, in-memory dependencies. No service clients load.
 let source=readFileSync(new URL('../api/sales/'+file,import.meta.url),'utf8');
 source=source.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g,(_all,names,path)=>'const {'+names+'}=deps['+JSON.stringify(path)+'];');
 source=source.replace(/export default async function handler/,'async function handler').replace(/export (const|function) /g,'$1 ');
 const handler=new Function('deps',source+'\nreturn handler;')(dependencies);
 mem.rows.gw_sales_live_meeting_sessions=[{id:ID,tenant_id:TENANT,company_id:CO,stage:0,status:'active',version:1,
  selected_keys:[],started_at:'2026-11-17T00:00:00Z',step_details:{layout:'compact_v1'},staff_notes:{'2':'以前の商談記録'},step_checks:{}}];
 mem.rows.companies=[{id:CO,name:'テスト企業',company_no:311,deleted_at:null}];
 mem.rows.dx2_sales_company_directory_for_tenant=[{id:CO,tenant_id:TENANT,needs_contact_review:false,directory_hidden_at:null}];
 mem.rows.dx2_company_portal_members=[{id:'member-a',tenant_id:TENANT,company_id:CO,email:'customer@example.test',display_name:'田中',auth_user_id:'auth-a',disabled_at:null}];
 const run=async(method,body={},params={})=>{
  const query=new URLSearchParams({companyId:CO,sessionId:ID,...params});
  const res={setHeader(){},end(value){this.body=JSON.parse(value);}};
  await handler({method,url:'/?'+query,body:{companyId:CO,sessionId:ID,...body}},res);return res;
 };
 return {mem,state,run,row:mem.rows.gw_sales_live_meeting_sessions[0]};
}
test('v1 preserves old notes and validates structured intake with optimistic concurrency',async()=>{
 const h=harness('meeting-session.js');
 const body={action:'save_step',stage:0,version:1,checks:{values:{intro:true,agenda:true}},note:'本日のメモ',
  details:{materialUrl:'https://example.test/intro',contactMethods:['email'],problem:'Java人材2名',budget:'80万円',start:'12月'}};
 let r=await h.run('PATCH',body);assert.equal(r.statusCode,200);assert.equal(r.body.session.stepDetails['0'].problem,'Java人材2名');
 assert.equal(h.row.staff_notes['2'],'以前の商談記録');assert.equal(h.row.step_details.layout,'compact_v1');
 r=await h.run('PATCH',body);assert.equal(r.statusCode,409);assert.equal(h.row.version,2);
 r=await h.run('PATCH',{...body,version:2,details:{...body.details,materialUrl:'javascript:alert(1)'}});assert.equal(r.statusCode,400);
 assert.equal(h.row.version,2);
});
test('compact transitions require checks, keep adjacent audit entries, and retain legacy records',async()=>{
 const h=harness('meeting-session.js');h.row.stage=1;
 assert.equal((await h.run('PATCH',{action:'compact_stage',stage:5,version:1})).statusCode,409);
 h.row.step_checks['1']={values:{purpose:true,decision:true}};
 let r=await h.run('PATCH',{action:'compact_stage',stage:5,version:1});assert.equal(r.statusCode,200);assert.equal(h.row.stage,5);
 assert.deepEqual(h.mem.rows.gw_sales_live_meeting_stage_events.map(x=>[x.from_stage,x.to_stage]),[[1,2],[2,3],[3,4],[4,5]]);
 assert.equal(h.row.staff_notes['2'],'以前の商談記録');
 assert.equal((await h.run('PATCH',{action:'compact_stage',stage:0,version:2})).statusCode,400);
 h.row.step_details={};assert.equal((await h.run('PATCH',{action:'compact_stage',stage:1,version:2})).statusCode,409);
});
test('authentication, Sales entitlement and company scope reject writes',async()=>{
 for(const setting of ['authenticated','sell','scope']){
  const h=harness('meeting-session.js');h.state[setting]=false;
  assert.equal((await h.run('PATCH',{action:'compact_stage',stage:1,version:1,tenantId:'other'})).statusCode,setting==='authenticated'?401:403);
  assert.equal(h.mem.state.log.length,0);
 }
});
test('company job offers count at the introduction and other-company offers do not',async()=>{
 const h=harness('meeting-session.js');h.mem.rows.dx2_company_job_offers=[{id:'offer-a',tenant_id:TENANT,company_id:CO,created_at:'2026-11-17T01:00:00Z'},
  {id:'offer-b',tenant_id:'other',company_id:CO,created_at:'2026-11-17T01:00:00Z'}];
 const r=await h.run('GET');assert.equal(r.statusCode,200);assert.equal(r.body.companyOfferCount,1);
});
function payload(){return {confirmed:true,email:'customer@example.test',outcome:'considering',nextAction:'来週確認',offeredKeys:[],
 mailSubject:'本日はありがとうございました',mailText:'編集したお礼文\n企業専用ページ：https://enger.jp/business/login?next='+encodeURIComponent('/business/offers?companyId='+CO)+'\nログインID：00311'};}
test('mail preview is read-only and reports sender/account setup truthfully',async()=>{
 const h=harness('meeting-closeout.js');h.row.stage=5;
 let r=await h.run('GET');assert.equal(r.statusCode,200);assert.match(r.body.draft.text,/ログインID：00311/);
 assert.equal(h.mem.state.log.length,0);assert.equal(h.state.authWrites,0);assert.equal(h.state.sent.length,0);
 h.state.from='wrong@example.test';r=await h.run('GET');assert.equal(r.body.mailConfigured,false);
});
test('exact edited mail is sent once, result and next action persist without account changes',async()=>{
 const previous=process.env.VERCEL_ENV;process.env.VERCEL_ENV='production';
 try{
  const h=harness('meeting-closeout.js');h.row.stage=5;
  let r=await h.run('POST',payload());assert.equal(r.statusCode,200);assert.equal(r.body.mailSent,true);
  assert.equal(h.state.sent[0].text,payload().mailText);assert.equal(h.state.sent[0].subject,payload().mailSubject);
  assert.equal(h.row.status,'closed');assert.equal(h.row.closeout_next_action,'来週確認');assert.equal(h.state.authWrites,0);
  r=await h.run('POST',payload());assert.equal(r.body.alreadySent,true);assert.equal(h.state.sent.length,1);
 }finally{if(previous===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous;}
});
test('new company-job offer ledger satisfies the closeout, independent of the old shortlist',async()=>{
 const previous=process.env.VERCEL_ENV;process.env.VERCEL_ENV='production';
 try{
  const h=harness('meeting-closeout.js');h.row.stage=5;
  assert.equal((await h.run('POST',{...payload(),outcome:'offer'})).statusCode,400);
  h.mem.rows.dx2_company_job_offers=[{id:'offer-a',tenant_id:TENANT,company_id:CO,created_at:'2026-11-17T01:00:00Z'}];
  assert.equal((await h.run('POST',{...payload(),outcome:'offer'})).statusCode,200);
 }finally{if(previous===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous;}
});
test('preview, changed sender, invalid body, missing confirmation and missing account never send',async()=>{
 const previous=process.env.VERCEL_ENV;
 try{
  for(const scenario of ['preview','sender','body','confirmation','account']){
   process.env.VERCEL_ENV=scenario==='preview'?'preview':'production';
   const h=harness('meeting-closeout.js');h.row.stage=5;const body=payload();
   if(scenario==='sender')h.state.from='wrong@example.test';
   if(scenario==='body')body.mailText='URLとIDがありません';
   if(scenario==='confirmation')body.confirmed=false;
   if(scenario==='account')h.mem.rows.dx2_company_portal_members=[];
   const r=await h.run('POST',body);assert.ok(r.statusCode>=400,scenario);assert.equal(h.state.sent.length,0,scenario);
   assert.equal(h.state.authWrites,0,scenario);assert.equal(h.row.status,'active',scenario);
  }
 }finally{if(previous===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous;}
});
test('mail failure records failure without closing or permitting an automatic resend',async()=>{
 const previous=process.env.VERCEL_ENV;process.env.VERCEL_ENV='production';
 try{
  const h=harness('meeting-closeout.js');h.row.stage=5;h.state.mailStatus='failed';
  assert.equal((await h.run('POST',payload())).statusCode,503);assert.equal(h.row.status,'active');
  assert.equal(h.mem.rows.gw_sales_meeting_closeouts[0].mail_status,'failed');
  assert.equal((await h.run('POST',payload())).statusCode,409);assert.equal(h.state.sent.length,1);
 }finally{if(previous===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=previous;}
});

test('GW Sales cannot replace or edit an in-progress agent six-step meeting',async()=>{
 const h=harness('meeting-session.js');h.row.step_details={preparation:{customerType:'ses_partner'}};
 assert.equal((await h.run('POST',{selectedKeys:[]})).body.error,'agent_meeting_in_progress');
 assert.equal((await h.run('PATCH',{action:'save_step',stage:0,version:1,checks:{values:{intro:true,agenda:true}},note:'must not replace'})).body.error,'agent_meeting_workflow');
 assert.equal(h.mem.state.log.length,0);
 const mail=harness('meeting-closeout.js');mail.row.stage=5;mail.row.step_details={preparation:{customerType:'ses_partner'}};
 assert.equal((await mail.run('POST',payload())).body.error,'agent_meeting_workflow');
 assert.equal(mail.state.sent.length,0);assert.equal(mail.state.authWrites,0);
});
