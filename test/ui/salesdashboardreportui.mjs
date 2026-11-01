// 旧ダッシュボードの詳細分析はPDCAの「根拠」から開ける。PC/スマホの無書込みUI検査。
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
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  const metric={matchingCount:2,unsubmittedMatchedCount:0,proposalSentCount:2,
    meetingEventCount:1,meetingCohortCount:1,conversionRate:50,closedCount:1,
    byOwner:[],blastCompanies:[],lossReasons:[{label:"理由未取得",count:1}],
    byCompany:[{companyName:"架空企業",sentCount:2,meetingCount:1,rate:50}],
    roleRows:{proposal:[],cs:[],closing:[]},sentRecords:[]};
  const report={period:{from:"2026-10-30",to:"2026-10-30"},
    previousPeriod:{from:"2026-10-29",to:"2026-10-29"},
    metrics:metric,previousMetrics:metric,
    insights:{issues:[],improvements:[],actions:[]}};
  const apiFixture=`window.API={api:async()=> (${JSON.stringify(report)})};`;
  new Script(apiFixture);
  await page.route("**/*",async route=>{
    const u=new URL(route.request().url()),p=u.pathname;
    if(["fonts.googleapis.com","fonts.gstatic.com"].includes(u.host))return route.abort();
    if(u.host!=="dashboard.test")return route.abort();
    if(p==="/js/api-client.js")return route.fulfill({contentType:"application/javascript",body:apiFixture});
    if(p==="/js/layout-marketing.js")return route.fulfill({contentType:"application/javascript",body:""});
    if(p==="/js/sales-layout.js")return route.fulfill({contentType:"application/javascript",body:'window.SalesLayout={esc:v=>String(v??""),fmt:v=>v||"",fmtDay:v=>v||"",allows:()=>true,init:async()=>({})};'});
    if(p==="/js/sales-proposal-analysis.js")return route.fulfill({contentType:"application/javascript",body:'window.SalesProposalAnalysis={load(){},loadDaily(){}};'});
    if(!["/sales/analytics.html","/js/sales-dashboard-report.js","/js/sales-pdca.js","/css/app.css","/img/logo.svg"].includes(p))
      return route.abort();
    return route.fulfill({body:readFileSync(resolve(root,"."+p)),contentType:p.endsWith(".js")?"application/javascript":p.endsWith(".css")?"text/css":p.endsWith(".svg")?"image/svg+xml":"text/html"});
  });
  await page.goto("https://dashboard.test/sales/analytics.html?step=evidence");
  await page.waitForFunction(()=>Boolean(window.SalesDashboardReport&&window.SalesPDCA),null,{timeout:6000});
  assert.equal(await page.locator("#an-main-title").innerText(),"根拠");
  assert.equal(await page.locator("#an-full-report").isVisible(),true);
  await page.locator("#an-full-report > summary").click();
  await page.locator(".db-bar-fill").first().waitFor({timeout:8000});
  await page.getByText("提案先企業別（分母・面談率）",{exact:true}).click();
  assert.equal(await page.getByRole("cell",{name:"架空企業",exact:true}).count(),1);
  await page.getByRole("button",{name:"直近7日",exact:true}).last().click();
  assert.equal(await page.getByRole("button",{name:"直近7日",exact:true}).last().getAttribute("aria-pressed"),"true");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);
  await page.close();
}
console.log("PASS Sales PDCA PC/mobile detailed evidence, charts and historical comparison");
} finally {await browser.close();}
