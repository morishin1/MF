// 翌営業日の予定を登録するまで日報入力禁止（画面 + 再確認）のブラウザテスト。
import { launch, BASE } from "../_browser.mjs";
const br=await launch();
const page=await br.newPage({viewport:{width:1280,height:960},timezoneId:"Asia/Tokyo"});
const assert=(ok,label)=>{if(!ok)throw new Error("NG "+label);console.log("OK "+label)};
const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
let allow=false,gateError=false,postCount=0;
const errors=[];
page.on("pageerror",e=>errors.push(String(e)));
page.on("dialog",d=>d.accept());
await page.addInitScript(()=>{
 localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"member@test.co.jp"}));
 localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"担当者",shows:{},stage:null}));
});
await page.route("**/api/**",route=>{
 const req=route.request(),url=new URL(req.url());
 const send=(o,s=200)=>route.fulfill({status:s,contentType:"application/json",body:JSON.stringify(o)});
 if(url.pathname==="/api/me")return send({email:"member@test.co.jp",appRole:"member",isAdmin:false,shows:{},
   gw:{tenantId:"tenant-1",roles:[],stage:null,employee:{id:"employee-1",display_name:"担当者",status:"active"}}});
 if(url.pathname==="/api/schedule/day-gate"){
   if(gateError)return send({error:"schedule_check_unavailable",hint:"DB確認エラー"},503);
   return send({ready:allow,targetDate:"2026-10-21",count:allow?1:0});
 }
 if(url.pathname==="/api/schedule")return send({events:[],bookings:[],tasks:[],external:{events:[]},googleLink:{}});
 if(url.pathname==="/api/tasks/focus")return send({today:today,tomorrowDate:"2026-10-21",todayTasks:[],tomorrowTasks:[],
    tomorrowState:null,openTasks:[],carryOver:[],people:[],qualityLevels:[],max:3});
 if(url.pathname==="/api/nippo/plan")return send({plan:null});
 if(url.pathname==="/api/nippo"){
   if(req.method()==="POST"){postCount++;return send({ok:true,ai:{configured:false}});}
   return send({date:today,weekStart:today,me:{userId:"member",name:"担当者"},today:null,recent:[],replies:[],
     evals:[],aiConfigured:false,thanks:[],weekly:null,weekClosing:{isToday:false,filled:true},
     openActions:[],todayActions:[],criteria:[],kpisToday:[],team:[],notSubmitted:[]});
 }
 if(url.pathname==="/api/notifications")return send({notifications:[],unread:0});
 return send({});
});
await page.goto(BASE+"/nippo.html");
await page.waitForTimeout(1000);
assert(await page.locator("#np-schedule-gate").isVisible(),"予定が0件ならロック案内を表示");
assert(await page.locator("#write-card").isHidden(),"予定が0件なら日報入力欄が開かない");
assert((await page.locator("#np-gate-msg").innerText()).includes("最低1件"),"何をすればよいか明確");
assert((await page.locator("#np-gate-calendar").getAttribute("href"))==="/calendar.html?date=2026-10-21",
  "対象日へ直接登録に進める");
assert(postCount===0,"予定なしの送信は発生しない");
allow=true;
await page.locator("#np-gate-check-btn").click();
await page.waitForTimeout(450);
assert(await page.locator("#write-card").isVisible(),"登録後の再確認で日報欄が開く");
assert(await page.locator("#np-schedule-gate").isHidden(),"登録済みならロック案内は閉じる");
allow=false;
// 開いた状態でも、送信の直前に再確認してロックする。
await page.locator("#submit-btn").click();
await page.waitForTimeout(300);
assert(await page.locator("#write-card").isHidden(),"予定を削除した場合は送信直前に再ロック");
assert(postCount===0,"予定がない状態の直接日報送信を止めた");
gateError=true;
await page.locator("#np-gate-check-btn").click();
await page.waitForTimeout(300);
assert(await page.locator("#write-card").isHidden(),"DBエラー中にロックを解除しない");
assert((await page.locator("#np-gate-msg").innerText()).includes("再確認"),"DBエラーには再確認を案内");
assert(errors.length===0,"JSエラーなし: "+errors.join(" / "));
await br.close();
console.log("日報ゲートのロック・登録後解除・再ロック・DB障害 すべて通過");
