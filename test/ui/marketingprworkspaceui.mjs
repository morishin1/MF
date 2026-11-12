// Regression for replacing the old multi-panel workspace with three clear primary tabs.
// Synthetic API data only; no production writes.
import assert from "node:assert/strict";
import {launch,BASE} from "../_browser.mjs";
const browser=await launch();let count=0;
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:850}});
  await context.route("**/js/api-client.js*",route=>route.fulfill({contentType:"application/javascript",body:`
   window.__calls=[];window.API={isLoggedIn:()=>true,api:async(path,options={})=>{
    window.__calls.push({path,method:options.method||"GET"});
    if(path==="/api/marketing?view=production")return {sources:[{key:"plan",state:"ok",count:0},{key:"site_news",state:"ok",count:0}],items:[],employees:[],videoSites:[]};
    if(path==="/api/marketing?view=work")return {sources:[],items:[],openCount:0,readsReady:true,unreadCount:0};
    if(path==="/api/marketing/pr-drafts")return {ready:true,items:[{
      id:"a0000000-0000-4000-8000-000000000001",version:1,status:"draft",
      createdAt:"2026-11-02T10:00:00+09:00",payload:{draft:{title:"仮のPR原稿"},tracking:[]}
    }]};
    if(path==="/api/marketing/pr-files")return {ready:true,files:[]};
    return {};
   }};
  `}));
  await context.route("**/js/marketing-layout.js*",route=>route.fulfill({contentType:"application/javascript",body:`
   window.MarketingLayout={init:async()=>{document.body.classList.add("marketing-app","of-app");return {};},
    esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
    fmt:s=>s||"",fmtDay:s=>s||"",pill:s=>"<span>"+String(s)+"</span>"};
  `}));
  await context.route(/^https:\/\/fonts\./,route=>route.fulfill({contentType:"text/css",body:""}));
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(BASE+"/marketing/?step=pr&tab=production&period=30&prSite=&contentType=all");
  await page.locator("#mps-create .mps-tr").first().waitFor();
  assert.equal(await page.locator("#marketing-primary-tabs [role=tab]").count(),3);
  assert.equal(await page.locator("#mps-create .mps-tr").count(),1);
  assert.equal(await page.locator("#savedPrList").isVisible(),false);
  assert.equal(await page.locator("#mps-editor").evaluate(e=>e.open),false);
  assert.ok((await page.locator("#mps-create").innerText()).includes("仮のPR原稿"));
  await page.getByRole("tab",{name:"拡散する"}).click();
  assert.ok(await page.locator("#mps-distribution .mps-head").isVisible());
  await page.getByRole("tab",{name:"効果を分析"}).click();
  assert.ok(await page.locator("#marketing-dashboard-kpis").isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  assert.deepEqual(await page.evaluate(()=>window.__calls.filter(x=>x.method!=="GET")) ,[]);
  assert.equal(errors.length,0,errors.join("|"));count+=10;
  await context.close();
 }
}finally{await browser.close();}
console.log(count+" simplified PR workspace checks passed");
