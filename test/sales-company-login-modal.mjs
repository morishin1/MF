import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const credentialJs=readFileSync(new URL("../js/sales-company-meeting-credentials.js",import.meta.url),"utf8");
const compactJs=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../css/sales-company-stepper.css",import.meta.url),"utf8");

class FakeNode {
  constructor(tag){
    this.tag=tag;this.children=[];this.hidden=false;this.textContent="";
    this.dataset={};this.handlers={};this.attrs={};this.value="";this.style={};
  }
  append(...nodes){this.children.push(...nodes)}
  replaceChildren(...nodes){this.children=nodes}
  get lastElementChild(){return this.children.at(-1)||null}
  setAttribute(name,value){this.attrs[name]=value}
  addEventListener(name,callback){this.handlers[name]=callback}
}
const descendants=root=>[root,...root.children.flatMap(descendants)];
const content=root=>descendants(root).map(node=>node.textContent||"").join("|");
const factory=()=>new Function("document","API","setTimeout","clearTimeout","navigator","confirm",
 credentialJs.replace(/^export function/m,"function")+";return createMeetingCredentialPanel;");
function fixture(canIssue=true){
 const root=new FakeNode("root");
 const document={createElement:t=>new FakeNode(t)};
 let members=[];
 const api={api:async(path,opts)=>{
   if(path.startsWith("/api/sales/company-portal?"))
     return {members,canEnable:canIssue,portal:{displayId:"07264",loginUrl:"https://enger.jp/business/login"}};
   if(opts?.body?.action==="issue_account"){
     members=[{id:"m1",status:"active",displayName:"Test Contact",email:opts.body.email}];
     return {temporaryPassword:"Test-temp-password-A8!"};
   }
   throw Error("unexpected mock endpoint: "+path);
 }};
 const make=factory()(document,api,()=>1,()=>{},
   {clipboard:{writeText:async()=>{}}},()=>true);
 return {root,panel:make(root,{companyId:"11111111-2222-4333-8444-555555555555"})};
}
test("credentials appear in meeting modal without expanding a details drawer",()=>{
 assert.match(compactJs,/const loginPanel=mk\("section",null,"lp-meeting-login-panel"\)/);
 assert.match(compactJs,/preflight\.append\(preHead,preInfo,loginPanel,calendarHost,preMessage,preActions\)/);
 assert.doesNotMatch(compactJs,/const loginDetails=mk\("details"/);
 assert.match(css,/#lc-dialog \.lp-meeting-preflight \.lp-compact-credential-host\{[\s\S]*?max-height:none!important/);
});
test("new company account shows ID, login link, email and one-time password, then clears secret",async()=>{
 const {root,panel}=fixture();
 panel.setVisible(true);
 await panel.reload();
 assert.equal(panel.state().loaded,true);
 assert.match(content(root),/07264/);
 assert.match(content(root),/企業ログイン画面を開く/);
 assert.match(content(root),/未発行/);
 const all=descendants(root);
 const form=all.find(x=>x.tag==="form");
 assert.ok(form,"account issue form should appear if no active member");
 const name=all.find(x=>x.placeholder==="企業担当者名");
 const email=all.find(x=>x.placeholder==="担当者のメールアドレス");
 name.value="Test Contact";email.value="contact@external.example";
 await form.handlers.submit({preventDefault(){}});
 assert.equal(panel.state().active.length,1);
 assert.match(content(root),/contact@external\.example/);
 assert.match(content(root),/Test-temp-password-A8!/);
 panel.setVisible(false);panel.setVisible(true);
 assert.doesNotMatch(content(root),/Test-temp-password-A8!/);
 assert.match(content(root),/設定済み/);
});
test("non-manager cannot issue enterprise credentials",async()=>{
 const {root,panel}=fixture(false);
 panel.setVisible(true);await panel.reload();
 assert.doesNotMatch(content(root),/企業ログインID・一時パスワードを発行/);
 assert.match(content(root),/営業責任者・管理者のみ/);
});
test("login is always ENGER Business, not internal MF test portal",()=>{
 assert.match(credentialJs,/\/business\/login/);
 assert.doesNotMatch(credentialJs,/company-portal\/login\.html/);
 assert.match(credentialJs,/一時パスワードを再発行/);
});
