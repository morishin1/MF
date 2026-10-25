// P0 dashboard integration browser acceptance. Synthetic API only, no live data or sends.
import assert from "node:assert/strict";
import {launch,BASE} from "../_browser.mjs";
const browser=await launch();
const checks=[];
function check(condition,label){assert.ok(condition,label);checks.push(label);console.log("ok",label);}
const prod={
 sources:[{key:"plan",biz:null,state:"ok",count:1},{key:"site_news",biz:"site",state:"ok",count:1}],
 items:[
  {origin:"site_news",biz:"site",medium:"column",title:"お知らせの公開設定",state:{key:"published",label:"公開設定済"},publishedOn:"2026-10-24"},
  {origin:"plan",id:"a0000000-0000-4000-8000-000000000001",key:"plan:test",version:1,biz:"mugen",medium:"sns",title:"SNSの準備",state:{key:"review",label:"確認待ち"},ownerId:"a1",owner:"担当",due:"2026-11-10"}
 ],employees:[{id:"a1",name:"担当"}],videoSites:[],canManageSite:true,canLinkInquiries:false
};
try{
 for(const width of [1440,768,390]){
  const ctx=await browser.newContext({viewport:{width,height:900},timezoneId:"Asia/Tokyo"});
  await ctx.addInitScript(()=>{window.__mktApiCalls=[];});
  await ctx.route("**/js/api-client.js*",r=>r.fulfill({status:200,contentType:"application/javascript",body:`
     window.API={isLoggedIn:()=>true,api:async(path,opt={})=>{
       window.__mktApiCalls.push({path,method:opt.method||"GET"});
       if(path==="/api/marketing?view=work") return {items:[],sources:[],readsReady:true,unreadCount:0,newCount:0,openCount:0};
       if(path==="/api/marketing?view=production") return ${JSON.stringify(prod)};
       if(path==="/api/marketing/pr-drafts")return {ready:true,items:[]};
       return {};
     }};
   `}));
  await ctx.route("**/js/marketing-layout.js*",r=>r.fulfill({status:200,contentType:"application/javascript",body:`
    window.MarketingLayout={
     init:async()=>{document.body.classList.add("of-app","marketing-app");return {me:{access:{marketing:true}}};},
     esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
     fmt:s=>s||"",fmtDay:s=>s||"",pill:t=>"<span>"+String(t)+"</span>"
    };
  `}));
  await ctx.route(/^https:\/\/fonts\./,r=>r.fulfill({status:200,contentType:"text/css",body:""}));
  const page=await ctx.newPage();const errors=[];
  page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(BASE+"/marketing/");
  await page.locator("#marketing-dashboard-kpis .mkh-kpi").first().waitFor();
  await page.locator("#marketing-site-status .mkh-site-mini-row").first().waitFor();
  check(await page.locator("#marketing-dashboard-kpis .mkh-kpi").count()===6,"6 KPIs "+width);
  check(await page.locator("#marketing-site-status .mkh-site-mini-row").count()===5,"5 compact site rows "+width);
  const names=await page.locator("#marketing-dashboard-kpis .mkh-kpi-label").allTextContents();
  check(names.join("|")==="発信数|Web PV|SNS流入|メールクリック|有効問い合わせ|商談・成約","KPI order "+width);
  const values=await page.locator("#marketing-dashboard-kpis .mkh-kpi-main strong").allTextContents();
  check(values.every(v=>v==="—"),"no invented PV or attribution "+width);
  const rects=await page.evaluate(()=>{
    const ids=["marketing-dashboard-kpis","marketing-site-status","marketing-dashboard-tasks","marketing-home-charts"];
    return ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,top:r.top,left:r.left};});
  });
  check(rects[0].top<rects[1].top&&rects[1].top<rects[3].top,"P0 dashboard content order "+width);
  check(width<1040||Math.abs(rects[1].top-rects[2].top)<2,"site and tasks side by side on desktop "+width);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),"no horizontal overflow "+width);
  check(await page.locator("#mkt-tab-dashboard").getAttribute("aria-selected")==="true","default dashboard "+width);
  if(width===1440){
   const k=await page.locator("#marketing-dashboard-kpis .mkh-kpi").evaluateAll(ns=>ns.map(n=>Math.round(n.getBoundingClientRect().top)));
   check(k.every(t=>t===k[0]),"desktop KPI single row");
   check(rects[1].top<900,"site status above fold");
   await page.locator("#mkh-p0-period").selectOption("90");
   await page.locator("#mkh-p0-biz").selectOption("mugen");
   let u=new URL(page.url());
   check(u.searchParams.get("period")==="90"&&u.searchParams.get("biz")==="mugen","filters in URL");
   await page.reload();
   await page.locator("#marketing-dashboard-kpis .mkh-kpi").first().waitFor();
   check(await page.locator("#mkh-p0-period").inputValue()==="90"&&await page.locator("#mkh-p0-biz").inputValue()==="mugen","filters persist after reload");
   check(await page.locator("#mkh-p0-biz option[value=ec]").evaluate(o=>o.disabled),"EC disabled");
   await page.getByRole("tab",{name:"PRを作る"}).click();
   check(await page.locator("#marketing-handoff-pr-composer [role=tab]").count()===5,"PR's five input subtabs remain");
   await page.getByRole("tab",{name:"拡散する"}).click();
   check(await page.getByRole("button",{name:"Xでシェア"}).count()===1,"manual X sharing stays available");
  }
  const writes=await page.evaluate(()=>window.__mktApiCalls.filter(x=>x.method!=="GET"));
  check(writes.length===0,"dashboard and navigation do not write "+width);
  check(errors.length===0,"no browser JS error "+width+": "+errors.join(" | "));
  await ctx.close();
 }
}finally{await browser.close();}
console.log("P0 isolated responsive browser: "+checks.length+" checks passed.");
