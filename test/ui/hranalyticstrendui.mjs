// Synthetic only: real HR HTML/assets, no request ever reaches a server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { accessOf } from "../../lib/gw.js";
const ROOT=fileURLToPath(new URL("../../",import.meta.url));
const ORIGIN="http://hr-analytics.test";
const browser=await launch();
const sample=[
 {id:"synthetic-1",name:"TEST ONLY A",createdAt:"2026-10-01T09:00:00+09:00",source:"Synthetic",jobTitle:"Test",stage:"applied",status:"todo"},
 {id:"synthetic-2",name:"TEST ONLY B",createdAt:"2026-10-23T09:00:00+09:00",source:"Synthetic",jobTitle:"Test",stage:"casual_interview",status:"todo"}
];
async function open(width,response={applicants:sample},status=200){
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:"Asia/Tokyo",serviceWorkers:"block"});
 const requests=[];
 await context.addInitScript(()=>{
  const RealDate=Date,fixed=Date.parse("2026-10-23T12:00:00+09:00");
  window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed]));}static now(){return fixed;}};
  localStorage.setItem("kp_session",JSON.stringify({access_token:"synthetic-test-not-a-token",email:"test@example.invalid"}));
 });
 await context.route("**/*",async route=>{
  const req=route.request(),url=new URL(req.url());
  requests.push({path:url.pathname,method:req.method()});
  if(url.origin!==ORIGIN)return route.abort();
  if(req.method()!=="GET")return route.abort();
  const send=(body,code=200)=>route.fulfill({status:code,contentType:"application/json",body:JSON.stringify(body)});
  if(url.pathname==="/api/me")return send({email:"test@example.invalid",appRole:"member",gw:{employee:{id:"synthetic-recruiter",display_name:"Synthetic recruiter"},roles:["recruiter"],tenantId:"synthetic"},access:accessOf({roles:["recruiter"]})});
  if(url.pathname==="/api/hr/applicants")return send(response,status);
  if(url.pathname.startsWith("/api/"))return send({});
  const path=resolve(ROOT,"."+decodeURIComponent(url.pathname==="/hr/"?"/hr/index.html":url.pathname));
  if(!path.startsWith(ROOT.endsWith(sep)?ROOT:ROOT+sep))return route.abort();
  const mime={".html":"text/html",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
  try{return route.fulfill({status:200,contentType:mime[extname(path)]||"application/octet-stream",body:readFileSync(path)});}catch{return route.fulfill({status:404,body:"not found"});}
 });
 const page=await context.newPage();
 await page.goto(ORIGIN+"/hr/");
 return {page,context,requests};
}
try{
 for(const width of [1280,390]){
  const {page,context,requests}=await open(width);
  await page.waitForSelector("#haResults:not([hidden])");
  await page.selectOption("#haPeriod","30");
  assert.equal(await page.locator("#haTrend svg").count(),1);
  assert.equal(await page.locator("#haTrend tbody tr").count(),2);
  assert.match(await page.locator("#haTrend").innerText(),/2026-09-24 ～ 2026-10-23/);
  assert.match(await page.locator("#haTrend tbody").innerText(),/部分月/);
  assert.deepEqual(await page.locator("#haTrend tbody td:last-child").allTextContents(),["0名","2名"]);
  assert.equal(await page.locator("#haKpi strong").first().innerText(),"2");
  await page.selectOption("#haPeriod","180");
  assert.equal(await page.locator("#haTrend tbody tr").count(),7);
  assert.equal(await page.locator("#haTrend circle").count(),7);
  const dims=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,chart:document.querySelector("#haTrend svg").getBoundingClientRect().width}));
  if(dims.scroll>dims.width){
    const overflowing=await page.evaluate(()=>[...document.querySelectorAll("body *")].map(e=>({tag:e.tagName,id:e.id,cls:String(e.className?.baseVal||e.className||"").slice(0,70),right:Math.round(e.getBoundingClientRect().right),width:Math.round(e.getBoundingClientRect().width)})).filter(x=>x.right>innerWidth+2).slice(0,16));
    console.log("HR analytics overflow diagnostics",JSON.stringify({dims,overflowing}));
  }
  assert.ok(dims.scroll<=dims.width,`${width}: no horizontal page overflow`);
  assert.ok(dims.chart>0&&dims.chart<=dims.width,`${width}: chart fits viewport`);
  assert.doesNotMatch(await page.locator("main").innerText(),/TEST ONLY/);
  assert.ok(requests.every(r=>r.method==="GET"));
  await page.screenshot({path:shotPath(`hr-analytics-trend-${width}.png`),fullPage:true});
  await context.close();
  console.log(`PASS HR trend real HTML ${width}px: monthly table, partial months, 180 days, layout`);
 }
 for(const scenario of [
  {name:"verified empty",response:{applicants:[]},valid:true},
  {name:"server failure",response:{error:"synthetic_failure"},status:500},
  {name:"missing applicants",response:{}},
  {name:"invalid applicants",response:{applicants:null}},
 ]){
  const {page,context}=await open(390,scenario.response,scenario.status||200);
  if(scenario.valid){
   await page.waitForSelector("#haResults:not([hidden])");
   assert.match(await page.locator("#haTrend").innerText(),/この期間の応募記録は0名/);
   assert.equal(await page.locator("#haKpi strong").first().innerText(),"0");
  }else{
   await page.waitForFunction(()=>document.getElementById("haStatus").textContent.includes("読み込めませんでした"));
   assert.equal(await page.locator("#haResults").isVisible(),false);
   await page.selectOption("#haPeriod","180");
   assert.equal(await page.locator("#haResults").isVisible(),false);
   assert.equal(await page.locator("#haTrend").innerText(),"");
   assert.equal(await page.locator("#haKpi strong").count(),0);
  }
  await context.close();
  console.log(`PASS HR trend ${scenario.name}: no fabricated zero counts`);
 }
}finally{await browser.close();}
