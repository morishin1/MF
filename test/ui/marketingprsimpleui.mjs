// Three-tab PR dashboard acceptance using synthetic API and fake file endpoint only.
import assert from "node:assert/strict";
import {launch,BASE} from "../_browser.mjs";
const browser=await launch();let count=0;
const check=(v,msg)=>{assert.ok(v,msg);count++;console.log("ok",msg);};
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:850},timezoneId:"Asia/Tokyo"});
  await context.addInitScript(()=>{
   window.__calls=[];window.__upload={
    items:[{id:"a0000000-0000-4000-8000-000000000001",version:1,status:"draft",
     createdAt:"2026-11-03T08:00:00+09:00",updatedAt:"2026-11-03T08:00:00+09:00",
     payload:{draft:{title:"既存のPR",kind:"other",company:"株式会社エイト",features:[],images:[]},body_override:"",media:{},tracking:[]}}],
    files:[],pending:null
   };
  });
  await context.route("https://upload.test/**",r=>r.fulfill({status:200,body:"uploaded"}));
  await context.route("**/js/api-client.js*",r=>r.fulfill({contentType:"application/javascript",body:`
   window.API={isLoggedIn:()=>true,api:async(path,options={})=>{
    const b=options.body||{},m=options.method||"GET";
    window.__calls.push({path,method:m,action:b.action});
    if(path==="/api/marketing?view=production")return {sources:[{key:"plan",state:"ok",count:0},{key:"site_news",biz:"site",state:"ok",count:0}],items:[],employees:[],videoSites:[]};
    if(path==="/api/marketing?view=work")return {sources:[],items:[],openCount:0,readsReady:true,unreadCount:0};
    if(path==="/api/marketing/pr-drafts"){
     if(m==="GET")return {ready:true,items:window.__upload.items};
     const prev=window.__upload.items.find(x=>x.id===b.id);
     if(b.action==="tracking"){
      if(!prev||prev.version!==b.version)throw Error("conflict");
      const next={...prev,version:prev.version+1,payload:{...prev.payload,tracking:b.tracking}};
      window.__upload.items=window.__upload.items.map(x=>x.id===next.id?next:x);
      return {ready:true,item:next};
     }
     if(b.action==="delete"){
      if(!prev||prev.status!=="draft"||b.confirmed!==true)throw Error("not authorized");
      window.__upload.items=window.__upload.items.filter(x=>x.id!==b.id);
      window.__upload.files=window.__upload.files.filter(x=>x.prId!==b.id);
      return {ready:true,deletedId:b.id};
     }
    }
    if(path==="/api/marketing/pr-files"){
     if(m==="GET")return {ready:true,files:window.__upload.files};
     if(b.action==="start"){
      const id="a0000000-0000-4000-8000-000000000002";
      window.__upload.pending={id,filename:b.filename,mimeType:b.mimeType,sizeBytes:b.sizeBytes};
      window.__upload.items.push({id,version:1,status:"draft",
       createdAt:"2026-11-03T08:25:00+09:00",updatedAt:"2026-11-03T08:25:00+09:00",
       payload:{source:"upload",draft:{kind:"other",title:b.filename.replace(/\\.[^.]+$/,""),company:"株式会社エイト",features:[],images:[]},tracking:[]}});
      return {ready:true,prId:id,uploadUrl:"https://upload.test/signed"};
     }
     if(b.action==="complete"){
      const f=window.__upload.pending;
      const file={id:"f",prId:f.id,filename:f.filename,mimeType:f.mimeType,sizeBytes:f.sizeBytes,uploadedAt:"2026-11-03T08:26:00+09:00"};
      window.__upload.files.push(file);window.__upload.pending=null;return {ready:true,file};
     }
     if(b.action==="rename"){
      const item=window.__upload.items.find(x=>x.id===b.prId);
      if(!item||item.version!==b.version)throw Error("conflict");
      item.version++;item.payload.draft.title=b.title;return {ready:true,item};
     }
    }
    if(path.startsWith("/api/marketing/pr-files?id="))return {ready:true,url:"https://example.com/document.pdf"};
    return {};
   }};
  `}));
  await context.route("**/js/marketing-layout.js*",r=>r.fulfill({contentType:"application/javascript",body:`
    window.MarketingLayout={init:async()=>{document.body.classList.add("marketing-app","of-app");return {};},
     esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
     fmt:s=>s||"",fmtDay:s=>s||"",pill:s=>"<span>"+String(s)+"</span>"};
  `}));
  await context.route(/^https:\/\/fonts\./,r=>r.fulfill({contentType:"text/css",body:""}));
  const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(BASE+"/marketing/?step=pr&tab=production&period=30&prSite=&contentType=all");
  const nav=page.locator("#marketing-primary-tabs [role=tab]");
  check((await nav.allTextContents()).join("|")==="PRをつくる|拡散する|効果を分析","exact three tabs "+width);
  check(await page.locator("#mkt-panel-pr").isVisible(),"default PR dashboard "+width);
  await page.locator("#mps-create .mps-tr").first().waitFor();
  check(await page.locator("#mps-create .mps-tr").count()===1,"existing originals listed "+width);
  check((await page.locator("#mps-create .mps-date").first().innerText()).includes("2026"),"date shown "+width);
  const picker=page.locator('#mps-create input[type="file"]');
  check(await picker.isVisible(),"Word/PDF picker visible "+width);
  await picker.setInputFiles({name:"リリース.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.4\n")});
  await page.locator("#mps-create .mps-tr").nth(1).waitFor();
  check(await page.locator("#mps-create .mps-tr").count()===2,"PDF added to list after upload "+width);
  check((await page.locator("#mps-create .mps-tr").nth(1).innerText()).includes("リリース.pdf"),"original filename visible "+width);
  const uploadCalls=await page.evaluate(()=>window.__calls.filter(x=>x.path==="/api/marketing/pr-files"&&x.method==="POST").map(x=>x.action));
  check(uploadCalls.includes("start")&&uploadCalls.includes("complete"),"upload recorded after completion "+width);
  await page.locator("#mps-create .mps-tr").nth(1).locator('input[type=checkbox]').check();
  check(await page.getByRole("button",{name:"拡散する"}).isEnabled(),"select one PR enables distribution button "+width);
  await page.getByRole("button",{name:"拡散する"}).click();
  const dist=page.locator("#mps-distribution");
  check(await dist.isVisible(),"distribution visible "+width);
  check(await dist.locator("select").inputValue()==="a0000000-0000-4000-8000-000000000002","selected PR transferred to distribution "+width);
  await dist.getByText("PR TIMES",{exact:true}).click();
  await dist.getByText("X",{exact:true}).click();
  check(await dist.getByLabel("PR TIMESの掲載URL").isVisible(),"checking media reveals URL field "+width);
  await dist.getByLabel("PR TIMESの掲載URL").fill("https://prtimes.jp/main/html/rd/p/000001.htm");
  await dist.getByLabel("Xの掲載URL").fill("https://x.com/example/status/123");
  await dist.getByLabel("Xの閲覧数").fill("125");
  await dist.getByLabel("Xのリンククリック").fill("13");
  await dist.getByLabel("Xの問い合わせ・応募").fill("2");
  await dist.locator('input[placeholder="https://example.jp/news/..."]').fill("https://8grp.co.jp/news");
  await page.evaluate(()=>{window.open=url=>{window.__officialCompose=url;};});
  await dist.getByRole("button",{name:"投稿画面を開く"}).click();
  check((await page.evaluate(()=>window.__officialCompose)).includes("utm_content=a0000000-0000-4000-8000-000000000002"),"official X composer receives tracked PR link "+width);
  await dist.getByRole("button",{name:"拡散先を保存"}).click();
  await page.waitForFunction(()=>window.__upload.items.some(x=>x.id.endsWith("0002")&&x.payload.tracking?.length===2));
  check((await page.evaluate(()=>window.__upload.items.find(x=>x.id.endsWith("0002")).payload.tracking)).every(x=>x.status==="published"&&x.url),"published channels need recorded HTTPS URLs "+width);
  check((await page.evaluate(()=>window.__upload.items.find(x=>x.id.endsWith("0002")).payload.tracking.find(x=>x.channel==="x").views))===125,"manual source metrics saved "+width);
  check((await page.evaluate(()=>window.__calls)).every(x=>x.action!=="publish"),"no automatic external publishing "+width);
  await page.getByRole("tab",{name:"効果を分析"}).click();
  check(await page.locator("#marketing-dashboard-kpis").isVisible(),"existing KPI charts reused "+width);
  check(await page.locator("#mps-analysis .mps-analytics-row").count()===2,"channel outcomes displayed "+width);
  check((await page.locator("#mps-analysis").innerText()).includes("—"),"unmeasured remains dash "+width);
  await page.getByRole("tab",{name:"PRをつくる"}).click();
  const uploaded=page.locator("#mps-create .mps-tr").nth(1);
  await uploaded.locator('input[type=checkbox]').check();
  page.once("dialog",d=>d.accept("編集したPR"));
  await page.locator("#mps-create .mps-list-actions").getByRole("button",{name:"編集"}).click();
  await page.waitForFunction(()=>window.__upload.items.find(x=>x.id.endsWith("0002")).payload.draft.title==="編集したPR");
  check((await page.locator("#mps-create").innerText()).includes("編集したPR"),"single select edit "+width);
  const updated=page.locator("#mps-create .mps-tr").nth(1);
  await updated.locator('input[type=checkbox]').check();
  page.once("dialog",d=>d.accept());
  await page.locator("#mps-create .mps-list-actions").getByRole("button",{name:"削除"}).click();
  await page.waitForFunction(()=>document.querySelectorAll("#mps-create .mps-tr").length===1);
  check(await page.locator("#mps-create .mps-tr").count()===1,"delete draft "+width);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"no horizontal overflow "+width);
  check(!errors.length,"no JavaScript exceptions "+width+": "+errors.join("|"));
  await context.close();
 }
}finally{await browser.close();}
console.log(count+" three-tab PR UI checks passed");
