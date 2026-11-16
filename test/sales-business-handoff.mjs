import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const page=read("../sales/company-meeting.html");
const nav=read("../js/sales-meeting-five-stage.js");
const auth=read("../js/sales-meeting-company-handoff.js");
const popup=read("../js/sales-company-compact-proposal.js");
const css=read("../css/sales-company-stepper.css");
const closeout=read("../api/sales/meeting-closeout.js");

test("the staff navigator begins with icebreak, stays six steps and has arrow navigation",()=>{
 assert.match(nav,/name:"アイスブレーク・会社概要",min:4/);
 assert.match(nav,/name:"企業ページで検索",min:10/);
 assert.match(nav,/name:"ご案内・終了",min:3/);
 assert.match(nav,/i<STEPS\.length-1\?" →":""/);
 assert.match(page,/\.meeting-stage\{[^}]*clip-path:polygon/);
 assert.match(nav,/meeting-talk-flow/);
 assert.match(page,/meeting-talk-flow/);
 assert.match(nav,/アイスブレーク/);
});

test("customer page handoff is visible in STEP1 and STEP4 while staff candidates stay out of the navigator",()=>{
 assert.match(nav,/proposals\.hidden=true/);
 assert.match(nav,/handoff\.hidden=viewed!==0&&viewed!==3/);
 assert.match(nav,/offerPanel\.hidden=viewed!==4/);
 assert.match(nav,/panel\.hidden=viewed>=3/);
 assert.match(page,/id="meeting-company-handoff"/);
 assert.match(page,/id="meeting-company-open"/);
 assert.match(page,/id="meeting-company-login-id"/);
 assert.match(page,/id="meeting-company-issue"/);
 assert.match(page,/id="meeting-company-password-reset"/);
 assert.match(page,/id="meeting-company-one-time-password"/);
 assert.match(page,/id="meeting-offer-result"/);
 assert.match(page,/id="meeting-step5-outcome"/);
 assert.match(page,/sales-meeting-company-handoff\.js\?v=20261117passwordreset/);
});

test("meeting page issues credentials and lets Sales explicitly replace an existing password",()=>{
 assert.match(auth,/company-portal\?/);
 assert.match(auth,/action:"ensure_meeting_account",confirmed:true/);
 assert.match(auth,/members\.length>0/);
 assert.match(auth,/portalState\?\.canResetBusinessPassword===true/);
 assert.match(auth,/isPreviewDemo\?"rotate_meeting_demo_password":"generate_password"/);
 assert.match(auth,/現在のパスワードはすぐに使えなくなります/);
 assert.match(auth,/reset\.hidden=!handoffVisible\|\|active\.length!==1/);
 assert.match(auth,/if\(!confirm\(/);
 assert.match(auth,/secretTimer=setTimeout\(clearSecret,120000\)/);
 assert.match(auth,/sales:meeting-step/);
 assert.match(auth,/action==="generate_password"\)body\.memberId=member\.id/);
 assert.doesNotMatch(auth,/localStorage|sessionStorage/);
 assert.doesNotMatch(auth,/password=\+|searchParams\.set\("password"/);
 assert.match(page,/自動メール送信しません/);
 assert.match(auth,/\/business\/offers\?companyId=/);
});

test("preflight is simplified to one actionable meeting button with company ID and summary",()=>{
 assert.match(popup,/preflight\.append\(preHead,summaryPanel,loginPanel,calendarHost,preMessage,preActions\)/);
 assert.match(popup,/preActions\.append\(begin\)/);
 assert.doesNotMatch(popup,/credentialPanel\?\.setVisible\(true\)/);
 assert.match(popup,/const summaryPanel=mk/);
 assert.match(popup,/企業ID：確認中/);
 assert.match(css,/lp-meeting-preflight-summary/);
 assert.match(css,/lp-meeting-preflight-topstart\[hidden\]/);
});

test("company offers are the source of truth when closing after customer-side selection",()=>{
 assert.match(closeout,/\.from\("dx2_company_portal_offers"\)/);
 assert.match(closeout,/\.eq\("tenant_id",ctx\.tenantId\)\.eq\("company_id",companyId\)/);
 assert.match(closeout,/\.gte\("created_at",session\.data\.started_at\)/);
 assert.match(closeout,/companyOfferCount/);
 assert.match(closeout,/mailConfig\("portal"\)/);
});

test("reissued password appears at the handoff, can be copied, and clears after leaving the step",async()=>{
 const ids=["meeting-company-login-hint","meeting-company-login-id","meeting-company-open",
  "meeting-company-copy","meeting-company-issue","meeting-company-password-reset",
  "meeting-company-one-time-password","meeting-company-one-time-value","meeting-company-password-copy"];
 const nodes=Object.fromEntries(ids.map(id=>[id,{
  textContent:"",hidden:false,disabled:false,value:"",handlers:{},
  addEventListener(type,handler){this.handlers[type]=handler;},
 }]));
 const state={canIssue:true,previewDemoAllowed:false,canResetBusinessPassword:true,
  members:[{id:"member-1",email:"user@company.example",displayName:"担当者",status:"active"}],
  portal:{displayId:"00311",loginUrl:"https://enger.jp/business/login"}};
 const calls=[],copied=[],documentEvents={};
 const context={URL,URLSearchParams,location:{search:"?companyId=11111111-2222-4333-8444-555555555555&sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
  document:{getElementById:id=>nodes[id]||null,addEventListener:(name,handler)=>documentEvents[name]=handler},
  window:{open:()=>null,addEventListener(){}},confirm:()=>true,
  navigator:{clipboard:{writeText:async value=>copied.push(value)}},
  API:{api:async(_path,options)=>{
   if(!options)return state;
   calls.push(options.body);
   return {temporaryPassword:"N3w!Pass"};
  }},setTimeout:()=>1,clearTimeout(){}};
 vm.runInNewContext(auth,context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes["meeting-company-password-reset"].hidden,false);
 await nodes["meeting-company-password-reset"].handlers.click();
 assert.equal(calls[0].action,"generate_password");
 assert.equal(calls[0].memberId,"member-1");
 assert.equal(nodes["meeting-company-one-time-password"].hidden,false);
 assert.match(nodes["meeting-company-one-time-value"].textContent,/N3w!Pass/);
 await nodes["meeting-company-password-copy"].handlers.click();
 assert.deepEqual(copied,["N3w!Pass"]);
 documentEvents["sales:meeting-step"]({detail:{stage:3}});
 assert.equal(nodes["meeting-company-password-reset"].hidden,false);
 assert.equal(nodes["meeting-company-one-time-password"].hidden,false);
 documentEvents["sales:meeting-step"]({detail:{stage:4}});
 assert.equal(nodes["meeting-company-one-time-password"].hidden,true);
});
