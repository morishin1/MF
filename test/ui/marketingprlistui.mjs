// New PR listing and legacy URL regression; legacy production list is hidden, not destroyed.
// Synthetic browser: no writes to real data.
import assert from "node:assert/strict";
import {launch,BASE} from "../_browser.mjs";
const browser=await launch();let passed=0;
const fixture={sources:[{key:"site_news",biz:"site",state:"ok",count:1},{key:"plan",state:"ok",count:0}],
 items:[{key:"site_news:1",origin:"site_news",biz:"site",sourceKind:"エイトコラム",medium:"column",mediumLabel:"コラム",
 title:"別のコラム",summary:"テスト用",state:{key:"drafting",label:"作成中"}}],employees:[],videoSites:[]};
try{
 for(const width of [1440,390]){
  const ctx=await browser.newContext({viewport:{width,height:850}});
  await ctx.route("**/js/api-client.js*",r=>r.fulfill({contentType:"application/javascript",body:`
   window.__calls=[];window.API={isLoggedIn:()=>true,api:async(path,opt={})=>{
    window.__calls.push({path,method:opt.method||"GET"});
    if(path==="/api/marketing?view=production")return ${JSON.stringify(fixture)};
    if(path==="/api/marketing?view=work")return {sources:[],items:[],openCount:0,readsReady:true,unreadCount:0};
    if(path==="/api/marketing/pr-drafts")return {ready:true,items:[{
     id:"a0000000-0000-4000-8000-000000000001",status:"draft",version:1,
     createdAt:"2026-11-03T08:00:00Z",payload:{draft:{title:"PRの下書き"},tracking:[]}
    }]};
    if(path==="/api/marketing/pr-files")return {ready:true,files:[]};
    return {};
   }};
  `}));
  await ctx.route("**/js/marketing-layout.js*",r=>r.fulfill({contentType:"application/javascript",body:`
   window.MarketingLayout={init:async()=>{document.body.classList.add("marketing-app","of-app");return {};},
    esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
    fmt:s=>s||"",fmtDay:s=>s||"",pill:s=>"<span>"+String(s)+"</span>"};
  `}));
  await ctx.route(/^https:\/\/fonts\./,r=>r.fulfill({contentType:"text/css",body:""}));
  const page=await ctx.newPage(),errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(BASE+"/marketing/?step=pr&tab=production&period=30&prSite=&contentType=all");
  await page.locator("#mps-create .mps-tr").first().waitFor();
  assert.equal(await page.locator("#marketing-primary-tabs button").count(),3);
  assert.ok((await page.locator("#mps-create").innerText()).includes("PRの下書き"));
  assert.ok(!(await page.locator("#savedPrList").isVisible()));
  await page.getByRole("tab",{name:"拡散する"}).click();
  assert.equal(await page.locator("#mkt-tab-distribution").getAttribute("aria-selected"),"true");
  await page.goBack();
  assert.equal(await page.locator("#mkt-tab-pr").getAttribute("aria-selected"),"true");
  await page.getByRole("tab",{name:"効果を分析"}).click();
  assert.equal(await page.locator("#mkt-tab-analytics").getAttribute("aria-selected"),"true");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.equal(errors.length,0,errors.join("|"));
  assert.ok((await page.evaluate(()=>window.__calls)).every(x=>x.method==="GET"));
  passed+=10;await ctx.close();
 }
}finally{await browser.close();}
console.log(passed+" three-tab PR navigation checks passed");
