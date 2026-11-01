// Salesの企業・リードはENGER提案先だけをread-only表示。会社IDとXSSとスマホ幅を検証。
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {launch} from "../_browser.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const browser=await launch();
try{
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  const proposals=[
    {id:"p1",companyName:"安全な企業",companyId:"co1",title:"AI案件",status:"call_wait",statusLabel:"電話待ち",closed:false,archived:false,sentAt:"2026-11-01T01:00:00Z",salesOwnerName:"営業A"},
    {id:"p2",companyName:"安全な企業",companyId:"co1",title:"Cloud案件",status:"meeting_adjust",statusLabel:"面談調整",closed:false,archived:false,sentAt:"2026-10-31T01:00:00Z",salesOwnerName:"営業A"},
    {id:"p3",companyName:"未登録<script>alert(1)</script>",companyId:null,sourceCompanyId:null,title:"未登録案件",status:"reply_wait",statusLabel:"返信待ち",closed:false,archived:false,sentAt:"2026-10-30T01:00:00Z",salesOwnerName:"営業B"}
  ];
  await page.route("**/*",async route=>{
    const u=new URL(route.request().url()),p=u.pathname;
    if(["fonts.googleapis.com","fonts.gstatic.com"].includes(u.host))return route.abort();
    if(u.host!=="accounts.test")return route.abort();
    if(p==="/js/api-client.js")return route.fulfill({contentType:"application/javascript",body:"window.API={api:async()=>"+JSON.stringify({proposals,truncated:false})+"};"});
    if(p==="/js/layout-marketing.js")return route.fulfill({contentType:"application/javascript",body:""});
    if(p==="/js/sales-layout.js")return route.fulfill({contentType:"application/javascript",body:'window.SalesLayout={init:async()=>({})};'});
    if(!["/sales/accounts.html","/css/app.css","/img/logo.svg"].includes(p))return route.abort();
    return route.fulfill({body:readFileSync(resolve(root,"."+p)),contentType:p.endsWith(".css")?"text/css":p.endsWith(".svg")?"image/svg+xml":"text/html"});
  });
  await page.goto("https://accounts.test/sales/accounts.html");
  await page.waitForFunction(()=>document.getElementById("accounts-total").textContent.includes("2社"));
  assert.equal(await page.locator("#accounts-rows tr").count(),2);
  assert.equal(await page.locator("#accounts-overview b").first().innerText(),"2");
  assert.equal(await page.locator("#accounts-rows script").count(),0);
  await page.locator("#accounts-search").fill("AI案件");
  assert.equal(await page.locator("#accounts-rows tr").count(),1);
  assert.equal(await page.locator('#accounts-rows a[href="/sales/proposals.html?id=p1"]').count(),2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log("Sales company-lead lookup grouping, escaped names and mobile width PASS");
}finally{await browser.close();}
