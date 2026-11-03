// Real dashboard HTML/report renderer with synthetic APIs; no business writes.
import assert from "node:assert/strict";
import {Script} from "node:vm";
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
 const metric={matchingCount:2,unsubmittedMatchedCount:0,proposalSentCount:2,meetingEventCount:1,meetingCohortCount:1,conversionRate:50,closedCount:1,byOwner:[],blastCompanies:[],lossReasons:[{label:"理由未取得",count:1}],byCompany:[{companyName:"架空企業",sentCount:2,meetingCount:1,rate:50}],roleRows:{proposal:[],cs:[],closing:[]},sentRecords:[],wonCohortCount:0,dailyTrend:[{date:"2026-10-30",sent:2,meetings:1}],sentByHour:[{hour:10,label:"10時",count:2}]};
 const report={period:{from:"2026-10-30",to:"2026-10-30"},previousPeriod:{from:"2026-10-29",to:"2026-10-29"},metrics:metric,previousMetrics:metric,insights:{issues:[],improvements:[],actions:[]}};
 const queue={total:6,rows:Array.from({length:6},(_,i)=>({id:"c"+i,name:"架空企業"+i,next:"確認",statusLabel:"未対応"}))};
 const decision={metrics:{openCases:5,proposalToVerify:2,contactToInspect:2,interviewToInspect:1},partial:false,note:"Salesに同期済み",updatedAt:"2026-11-03T02:00:00Z",priority:[{title:"架空の確認案件",companyName:"架空企業",statusLabel:"提案前の条件確認",sourceProposalId:null,hasRegisteredOwner:true}]};
 const apiFixture=`window.API={api:async(url)=>url.startsWith("/api/sales/decision-brief")?(${JSON.stringify(decision)}):(${JSON.stringify(report)}),salesDashboard:async()=>({sections:${JSON.stringify({click:queue,replied:queue,follow:queue,attack:queue})}}),listSalesApproaches:async()=>({approaches:[]}),warm(){},swr:async(k,f,cb)=>cb(await f()),morph:(el,html)=>el.innerHTML=html};`;
 new Script(apiFixture); // Fail immediately if the generated mock is not valid JavaScript.
 await page.route("**/*",async route=>{
  const u=new URL(route.request().url()),path=u.pathname;
  if(["fonts.googleapis.com","fonts.gstatic.com"].includes(u.host)) return route.continue();
  if(u.host!=="dashboard.test") return route.abort();
  if(path==="/js/api-client.js")return route.fulfill({contentType:"application/javascript",body:apiFixture});
  if(path==="/js/layout-marketing.js")return route.fulfill({contentType:"application/javascript",body:""});
  if(path==="/js/sales-layout.js")return route.fulfill({contentType:"application/javascript",body:'window.SalesLayout={esc:v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"),fmt:v=>v||"",fmtDay:v=>v||"",ago:()=>"",allows:()=>true,init:async()=>({})};'});
  if(!["/sales/index.html","/js/sales-dashboard-report.js","/js/sales-dashboard-tabs.js","/js/sales-decision-board.js","/js/sales-company-reference.js","/js/sales-visuals.js","/css/app.css","/img/logo.svg"].includes(path))return route.abort();
  return route.fulfill({body:readFileSync(resolve(root,"."+path)),contentType:path.endsWith(".js")?"application/javascript":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":"text/html"});
 });
 await page.goto("https://dashboard.test/sales/index.html");
 await page.waitForFunction(()=>window.SalesDashboardReport&&window.SalesDashboardTabs&&window.SalesDecisionBoard, null, {timeout:5000});
 assert.deepEqual(errors,[], "page scripts must initialize without errors");
 assert.equal(await page.locator("#db-panel-today").isVisible(),true);
 assert.equal(await page.locator("#db-panel-analysis").isVisible(),false);
 await page.locator("#db-decision-board .db-decision-item").first().waitFor();
 assert.equal(await page.locator("#list-click .sl-row").count(),0,"Legacy attack queue must not fetch on initial paint");
 assert.equal(await page.locator("#db-legacy-queue").getAttribute("open"),null);
 assert.equal(await page.locator("#sec-history").getAttribute("open"),null);
 await page.getByRole("tab",{name:"優先ランキング"}).click();
 await page.locator("#db-rankings-content").getByText("案件の確認優先 TOP10",{exact:false}).waitFor();
 assert.equal(await page.locator("#db-panel-analysis").isVisible(),false);
 await page.getByRole("tab",{name:"分析レポート"}).click();
 await page.locator(".sv-line svg").first().waitFor();
 await page.locator(".sv-ring").first().waitFor();
 assert.ok(await page.locator(".sv-bar-fill").count()>0,"Visual histogram and funnel render");
 await page.locator(".db-deep-dive > summary").click();
 await page.getByText("提案先企業別（分母・面談率）",{exact:true}).click();
 assert.equal(await page.getByRole("cell",{name:"架空企業",exact:true}).count(),1);
 await page.getByRole("button",{name:"直近7日",exact:true}).click();
 assert.equal(await page.getByRole("button",{name:"直近7日",exact:true}).getAttribute("aria-pressed"),"true");
 await page.getByRole("tab",{name:"営業判断"}).click();
 assert.equal(await page.locator("#db-panel-today").isVisible(),true);
 assert.equal(await page.locator("#db-decision-board").isVisible(),true);
 assert.equal(await page.locator("#sec-click").isVisible(),false);
 await page.locator("#db-legacy-queue > summary").click();
 await page.locator("#list-click .sl-row").first().waitFor();
 assert.equal(await page.locator("#sec-click").isVisible(),true);
 assert.equal(await page.locator("#sec-attack").isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.deepEqual(errors,[]);
 await page.close();
}
console.log("PASS Sales dashboard PC/mobile graphs, company table, compact queues, period control, overflow");
} finally {await browser.close();}
