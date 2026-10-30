// Real dashboard HTML/report renderer with synthetic APIs; no business writes.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {launch} from "../_browser.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const browser=await launch();
try {
for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:900}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 const metric={matchingCount:2,unsubmittedMatchedCount:0,proposalSentCount:2,meetingEventCount:1,meetingCohortCount:1,conversionRate:50,closedCount:1,byOwner:[],blastCompanies:[],lossReasons:[{label:"理由未取得",count:1}],byCompany:[{companyName:"架空企業",sentCount:2,meetingCount:1,rate:50}],roleRows:{proposal:[],cs:[],closing:[]},sentRecords:[]};
 const report={period:{from:"2026-10-30",to:"2026-10-30"},previousPeriod:{from:"2026-10-29",to:"2026-10-29"},metrics:metric,previousMetrics:metric,insights:{issues:[],improvements:[],actions:[]}};
 const queue={total:6,rows:Array.from({length:6},(_,i)=>({id:"c"+i,name:"架空企業"+i,next:"確認",statusLabel:"未対応"}))};
 await page.route("**/*",async route=>{
  const u=new URL(route.request().url()),path=u.pathname;
  if(u.host!=="dashboard.test") return route.abort();
  if(path==="/js/api-client.js")return route.fulfill({contentType:"application/javascript",body:`window.API={api:async()=>${JSON.stringify(report)},salesDashboard:async()=>({sections:${JSON.stringify({click:queue,replied:queue,follow:queue,attack:queue})}}),listSalesApproaches:async()=>({approaches:[]}),warm(){},swr:async(k,f,cb)=>cb(await f()),morph:(el,html)=>el.innerHTML=html};`});
  if(path==="/js/layout-marketing.js")return route.fulfill({contentType:"application/javascript",body:""});
  if(path==="/js/sales-layout.js")return route.fulfill({contentType:"application/javascript",body:'window.SalesLayout={esc:v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"),fmt:v=>v||"",fmtDay:v=>v||"",ago:()=>"",allows:()=>true,init:async()=>({})};'});
  if(!["/sales/index.html","/js/sales-dashboard-report.js","/css/app.css","/img/logo.svg"].includes(path))return route.abort();
  return route.fulfill({body:readFileSync(resolve(root,"."+path)),contentType:path.endsWith(".js")?"application/javascript":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":"text/html"});
 });
 await page.goto("https://dashboard.test/sales/index.html");
 await page.locator(".db-bar-fill").first().waitFor();
 assert.equal(await page.locator("#list-click .sl-row").count(),3);
 assert.equal(await page.locator("#sec-history").getAttribute("open"),null);
 await page.getByText("提案先企業別（分母・面談率）",{exact:true}).click();
 assert.equal(await page.getByRole("cell",{name:"架空企業",exact:true}).count(),1);
 await page.getByRole("button",{name:"直近7日",exact:true}).click();
 assert.equal(await page.getByRole("button",{name:"直近7日",exact:true}).getAttribute("aria-pressed"),"true");
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.deepEqual(errors,[]);
 await page.close();
}
console.log("PASS Sales dashboard PC/mobile graphs, company table, compact queues, period control, overflow");
} finally {await browser.close();}
