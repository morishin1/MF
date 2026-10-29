// HR応募分析：実ブラウザでKPI・期間変更・ナビ・390pxの見切れを確認。
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";

const browser=await launch();
let failed=0;
const check=(ok,text)=>{console.log(ok?"  ok":"  NG",text);if(!ok)failed++;};
const now=new Date(),recent=new Date(now.getTime()-15*86400000).toISOString();
const older=new Date(now.getTime()-70*86400000).toISOString();
const data=[
 {id:"fake1",name:"テストA",source:"Wantedly",jobTitle:"AIまち運営",createdAt:recent,stage:"applied",status:"todo",interviewCount:0},
 {id:"fake2",name:"テストB",source:"Indeed",jobTitle:"エンジニア",createdAt:older,stage:"casual_interview",status:"passed",interviewCount:1}
];
async function open(width){
 const page=await browser.newPage({viewport:{width,height:850},timezoneId:"Asia/Tokyo"});
 await page.addInitScript(()=>localStorage.setItem("kp_session",JSON.stringify({access_token:"test",email:"hr@example.com"})));
 await page.route("**/api/**",route=>{
  const url=route.request().url();
  const send=x=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(x)});
  if(/\/api\/me\b/.test(url))return send({email:"hr@example.com",appRole:"member",
    gw:{employee:{id:"e1",display_name:"採用担当"},roles:["recruiter"],tenantId:"t1"},
    access:accessOf({roles:["recruiter"]})});
  if(/\/api\/hr\/applicants\b/.test(url))return send({applicants:data});
  if(/\/api\/hr\/interviews\/today\b/.test(url))return send({interviews:[]});
  return send({});
 });
 await page.goto(BASE+"/hr/");
 await page.waitForSelector("#haResults:not([hidden])");
 return page;
}
for(const width of [1280,390,360]){
 const page=await open(width);
 const kpis=await page.locator("#haKpi").innerText();
 check(kpis.includes("対象期間の応募"),width+": 応募KPIを表示");
 check(kpis.includes("面談記録あり"),width+": 面談記録ありの表示");
 check((await page.locator("#haSource").innerText()).includes("Wantedly"),width+": 流入元を表示");
 check((await page.locator(".hr-nav a[href='/hr/']").innerText()).includes("応募分析"),width+": 旧HRホームは応募分析");
 check((await page.locator(".hr-nav a[href='/hr/applicants.html']").innerText()).includes("ダッシュボード"),width+": 応募者対応はダッシュボード");
 const dims=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:window.innerWidth}));
 check(dims.scroll<=dims.inner,width+": 分析画面が左右にはみ出さない（"+dims.scroll+"/"+dims.inner+"）");
 if(width===1280){
  await page.selectOption("#haPeriod","30");
  check((await page.locator("#haKpi").innerText()).includes("1"),"期間を30日に切り替えると応募1名");
  await page.selectOption("#haPeriod","90");
  check((await page.locator("#haKpi").innerText()).includes("2"),"期間を90日に切り替えると応募2名");
 }
 check(!(await page.locator("main").innerText()).includes("テストA"),width+": 候補者名を分析画面に出さない");
 await page.close();
}
await browser.close();
console.log(failed?failed+" cases NG":"HR応募分析UI：全ケース通過");
process.exit(failed?1:0);
