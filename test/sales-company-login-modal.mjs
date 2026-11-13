import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const credentials=readFileSync(new URL("../js/sales-company-meeting-credentials.js",import.meta.url),"utf8");
const modal=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
const api=readFileSync(new URL("../api/sales/company-portal.js",import.meta.url),"utf8");

class FakeNode{
 constructor(tag){this.tag=tag;this.children=[];this.hidden=false;this.textContent="";this.dataset={};this.attrs={};this.handlers={};this.value="";}
 append(...v){this.children.push(...v)}
 replaceChildren(...v){this.children=v}
 get lastElementChild(){return this.children.at(-1)||null}
 setAttribute(k,v){this.attrs[k]=v}
 addEventListener(k,v){this.handlers[k]=v}
 closest(){return {close(){}}}
}
const descendants=x=>[x,...x.children.flatMap(descendants)];
const visibleText=x=>descendants(x).map(n=>n.textContent||"").join("|");
function fixture({active=false,withContact=true,canIssue=true}={}){
 const document={createElement:tag=>new FakeNode(tag),querySelector:()=>null};
 const host=new FakeNode("host");
 let members=active?[{id:"1",email:"contact@example.org",displayName:"Contact",status:"active"}]:[];
 const calls=[];
 const API={api:async(path,options)=>{
  if(!options)return {members,canEnable:false,canIssue,contactReady:withContact,previewDemoAllowed:false,portal:{displayId:"08854",loginUrl:"https://enger.jp/business/login"}};
  calls.push(options.body.action);
  if(options.body.action!=="ensure_meeting_account")throw Error("unexpected mutation");
  if(!withContact){const e=new Error("連絡先未登録");e.hint="企業基本情報に担当者名とメールを保存してください。";throw e;}
  members=[{id:"1",email:"contact@example.org",displayName:"Contact",status:"active"}];
  return {ok:true,temporaryPassword:"Qm7!Xr2@"};
 }};
 const setup=new Function("document","API","setTimeout","clearTimeout","navigator",
  credentials.replace(/^export function/m,"function")+";return createMeetingCredentialPanel;");
 const panel=setup(document,API,()=>11,()=>{},{clipboard:{writeText:async()=>{}}})(
  host,{companyId:"11111111-2222-4333-8444-555555555555"});
 const tick=async()=>{for(let i=0;i<32;i++)await Promise.resolve()};
 return {panel,host,calls,tick};
}
test("the meeting modal contains only ID/password, calendar and meeting CTA",()=>{
 assert.match(modal,/preflight\.append\(preHead,summaryPanel,loginPanel,calendarHost,preMessage,preActions\)/);
 assert.match(modal,/const begin=mk\("button","商談画面を開く"/);
 assert.doesNotMatch(credentials,/企業担当者名";name\.autocomplete/);
 assert.doesNotMatch(credentials,/企業ログインID・一時パスワードを発行/);
 assert.match(credentials,/rows\.append\(line\("企業ID"/);
 assert.match(credentials,/rows\.append\(line\(pwLabel/);
});
test("first opening automatically issues password once using pre-registered company contact",async()=>{
 const f=fixture();f.panel.setVisible(true);await f.tick();
 assert.deepEqual(f.calls,["ensure_meeting_account"]);
 assert.match(visibleText(f.host),/08854/);
 assert.match(visibleText(f.host),/Qm7!Xr2@/);
 assert.doesNotMatch(visibleText(f.host),/contact@example\.org/);
 f.panel.setVisible(false);f.panel.setVisible(true);await f.tick();
 assert.deepEqual(f.calls,["ensure_meeting_account"]);
 assert.doesNotMatch(visibleText(f.host),/Qm7!Xr2@/);
 assert.match(visibleText(f.host),/設定済み/);
});
test("existing companies never regenerate credentials",async()=>{
 const f=fixture({active:true});f.panel.setVisible(true);await f.tick();
 assert.deepEqual(f.calls,[]);
 assert.match(visibleText(f.host),/設定済み（再表示不可）/);
});
test("contactless meeting does not create external Auth or show blocking login warning",async()=>{
 const f=fixture({withContact:false});f.panel.setVisible(true);await f.tick();
 assert.deepEqual(f.calls,[]);
 assert.match(visibleText(f.host),/担当者名・メールが未登録でも社内商談を開始できます/);
 assert.doesNotMatch(visibleText(f.host),/正式な企業ログインの発行には/);
 assert.doesNotMatch(visibleText(f.host),/Qm7!Xr2@/);
});
test("server reports contact readiness and does not modify an existing password",()=>{
 assert.match(api,/contactReady: !inviteInput/);
 assert.match(api,/previewDemoAllowed: meetingPreviewDemoAllowed/);
 assert.match(api,/body\.action==="ensure_meeting_account"/);
 assert.match(api,/canManageProposals\(ctx\)/);
 assert.match(api,/select\("id,contact_name,contact_email,deleted_at,caution"\)/);
 assert.match(api,/rows\.data\?\.length/);
 assert.match(api,/return act\(res,db,ctx,user,company,\{/);
 assert.match(api,/action:"issue_account",confirmed:true/);
 assert.match(credentials,/action:"generate_password"/);
 assert.doesNotMatch(credentials,/初回発行は営業責任者・管理者/);
});
