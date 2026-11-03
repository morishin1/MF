// Synthetic PR workspace acceptance: no live API calls or external posts.
import assert from "node:assert/strict";
import {launch,BASE} from "../_browser.mjs";
const browser=await launch();let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;console.log("ok",label);};
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:850},timezoneId:"Asia/Tokyo"});
  await context.addInitScript(()=>{
   const now="2026-11-02T10:30:00+09:00";
   const draft={kind:"service",title:"甲佐町DXのお知らせ",summary:"地域のデジタル相談窓口を開始",company:"株式会社エイト",features:[{title:"相談",body:"デジタル相談"}],images:[]};
   window.__pr={
    items:[
     {id:"a0000000-0000-4000-8000-000000000001",version:1,status:"draft",createdAt:now,updatedAt:now,registeredAt:null,payload:{draft,body_override:"",media:{},tracking:[]}},
     {id:"a0000000-0000-4000-8000-000000000002",version:2,status:"registered",createdAt:now,updatedAt:now,registeredAt:now,payload:{draft:{...draft,title:"社内本登録済みPR"},body_override:"",media:{},tracking:[]}}
    ],
    calls:[]
   };
  });
  await context.route("**/js/api-client.js*",r=>r.fulfill({contentType:"application/javascript",body:`
   window.API={isLoggedIn:()=>true,api:async(path,options={})=>{
    const op=options.body||{};
    window.__pr.calls.push({path,action:op.action||"GET"});
    if(path==="/api/marketing?view=production")return {sources:[{key:"plan",state:"ok",count:0},{key:"site_news",biz:"site",state:"ok",count:0}],items:[],videoSites:[],employees:[]};
    if(path==="/api/marketing?view=work")return {sources:[],items:[],openCount:0,readsReady:true,unreadCount:0};
    if(path==="/api/marketing/pr-drafts"){
     if(!options.method)return {ready:true,items:window.__pr.items};
     const old=window.__pr.items.find(x=>x.id===op.id);
     if(op.action==="tracking"){
      if(!old||old.version!==op.version)throw Error("conflict");
      const updated={...old,version:old.version+1,payload:{...old.payload,tracking:op.tracking}};
      window.__pr.items=window.__pr.items.map(x=>x.id===updated.id?updated:x);
      return {ready:true,item:updated};
     }
     if(op.action==="delete"){
      if(!old||old.status!=="draft"||old.version!==op.version||op.confirmed!==true)throw Error("not allowed");
      window.__pr.items=window.__pr.items.filter(x=>x.id!==op.id);return {ready:true,deletedId:op.id};
     }
    }
    throw Error("unexpected route: "+path);
   }};
  `}));
  await context.route("**/js/marketing-layout.js*",r=>r.fulfill({contentType:"application/javascript",body:`
   window.MarketingLayout={
    init:async()=>{document.body.classList.add("marketing-app","of-app");return {};},
    esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
    fmt:s=>s||"",fmtDay:s=>s||"",pill:s=>"<span>"+String(s)+"</span>"
   };
  `}));
  await context.route(/^https:\/\/fonts\./,r=>r.fulfill({contentType:"text/css",body:""}));
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(BASE+"/marketing/?step=list&contentType=pr");
  await page.locator("#savedPrList .mpr-pr-row").first().waitFor();
  check(await page.locator("#savedPrList .mpr-pr-row").count()===2,"PR originals listed "+width);
  check((await page.locator("#savedPrList .mpr-workspace-tab").allTextContents()).join("|")==="一覧|アップロード|新規作成","three actions "+width);
  check((await page.locator("#savedPrList .mpr-pr-datetime").first().innerText()).includes("11/02"),"date displayed on left "+width);
  check((await page.locator("#savedPrList .mpr-pr-stats").first().innerText()).includes("—"),"missing metric is dash "+width);
  await page.locator("#savedPrList .mpr-pr-title").first().click();
  check(await page.getByRole("dialog",{name:"PR原稿プレビュー"}).isVisible(),"click opens preview "+width);
  await page.keyboard.press("Escape");
  check(await page.getByRole("dialog").count()===0,"Escape closes preview "+width);
  await page.locator("#savedPrList .mpr-pr-row").first().locator('button[title^="PR TIMES"]').click();
  check(await page.getByRole("dialog",{name:"配信先・反響の記録"}).isVisible(),"channel record dialog "+width);
  await page.getByRole("dialog").locator('select[aria-label="配信媒体"]').selectOption("prtimes");
  await page.getByRole("dialog").locator('select').nth(1).selectOption("published");
  await page.getByRole("dialog").locator('input[type=url]').fill("https://prtimes.jp/example");
  const numbers=page.getByRole("dialog").locator('input[type=number]');
  await numbers.nth(0).fill("250");await numbers.nth(1).fill("10");await numbers.nth(2).fill("2");
  await page.getByRole("button",{name:"記録を保存"}).click();
  await page.getByRole("dialog").waitFor({state:"detached"});
  const first=page.locator("#savedPrList .mpr-pr-row").first();
  check((await first.locator(".mpr-pr-stats").innerText()).includes("250"),"real manually recorded metrics "+width);
  check(await first.locator(".mpr-channel.published").count()===1,"published icon only for explicit manual status "+width);
  check((await page.locator("#savedPrList .mpr-metric-summary").innerText()).includes("250"),"aggregate uses source values "+width);
  await first.locator('input[type=checkbox]').check();
  await page.getByRole("button",{name:"選択した下書きを削除"}).click();
  page.once("dialog",async d=>d.accept());
  // Dialog is emitted synchronously by button action; retry after attaching listener if still present.
  if(await page.locator("#savedPrList .mpr-pr-row").count()===2){
   await page.getByRole("button",{name:"選択した下書きを削除"}).click();
  }
  await page.waitForFunction(()=>document.querySelectorAll("#savedPrList .mpr-pr-row").length===1);
  check(await page.locator("#savedPrList .mpr-pr-row").count()===1,"draft deleted, registered retained "+width);
  check((await page.evaluate(()=>window.__pr.calls)).filter(c=>c.action==="delete").length===1,"confirmed deletion only "+width);
  await page.locator("#savedPrList .mpr-workspace-tab").filter({hasText:"アップロード"}).click();
  check(await page.locator("#mkt-panel-pr").isVisible(),"upload directs to editor "+width);
  check(await page.locator(".mpr-import input[type=file]").isVisible(),"Word import is available "+width);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"no horizontal page overflow "+width);
  check(errors.length===0,"no JS errors "+width+": "+errors.join("|"));
  await context.close();
 }
}finally{await browser.close();}
console.log(checks+" synthetic PR workspace UI checks passed");
