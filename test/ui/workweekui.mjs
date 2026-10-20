// 週間業務カレンダー: 日付選択・保存・週別の登録状態・日報との連携。
import { launch, BASE } from "./_browser.mjs";

const br=await launch();
const page=await br.newPage({viewport:{width:1280,height:950},timezoneId:"Asia/Tokyo"});
const check=(ok,label)=>{if(!ok)throw Error("NG: "+label);console.log("ok: "+label)};
const errors=[];
page.on("pageerror",e=>errors.push(String(e)));
const now = new Date();
const testMonday = "2026-10-19";
const testTuesday = "2026-10-20";
const events=[
  {id:"event-1",employee_id:"emp-1",title:"営業アタック",source:"self",category:"work",all_day:false,visibility:"shared",
   starts_at:"2026-10-19T00:00:00.000Z",ends_at:"2026-10-19T01:00:00.000Z"}
];
const posted=[];
page.on("dialog",d=>d.accept());
await page.addInitScript(()=>{
  localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"member@eight.co.jp"}));
  localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"社員",shows:{},stage:null}));
});
await page.route("**/api/**",route=>{
  const req=route.request(),url=new URL(req.url());
  const send=(v,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(v)});
  if(url.pathname==="/api/me")return send({
    email:"member@eight.co.jp",appRole:"member",isAdmin:false,shows:{},
    gw:{employee:{id:"emp-1",display_name:"社員",status:"active"},roles:[],tenantId:"tenant1",stage:null}
  });
  if(url.pathname==="/api/schedule" && req.method()==="GET")return send({events:events.slice(),bookings:[],tasks:[],external:{events:[]},googleLink:{}});
  if(url.pathname==="/api/schedule" && req.method()==="POST"){
    const body=JSON.parse(req.postData()||"{}");posted.push(body);
    const event={id:"event-2",source:"self",all_day:false,
      title:body.title,category:body.category,visibility:body.visibility,
      starts_at:new Date(body.startsAt).toISOString(),ends_at:new Date(body.endsAt).toISOString()};
    events.push(event);return send({event});
  }
  if(url.pathname==="/api/schedule/review")return send({ai:true,verdict:"good",summary:"予定を確認しました",suggestions:["準備の時間を確保してください"]});
  if(url.pathname==="/api/notifications")return send({notifications:[],unread:0});
  return send({});
});
await page.goto(BASE+"/work-week.html?date="+testTuesday);
await page.waitForTimeout(1100);
check((await page.locator("#wk-edit-title").innerText()).includes(testTuesday),"日報から選択した日付で編集画面を開く");
check((await page.locator("#wk-calendar .wk-day").count())===7,"7日表示");
check((await page.locator("#wk-status").innerText()).includes("1/5"),"予定登録済みの日数を表示");
await page.locator(".wk-title").first().fill("資料整理");
await page.locator(".wk-start").first().fill("13:00");
await page.locator(".wk-end").first().fill("14:00");
await page.locator("#wk-save").click();
await page.waitForTimeout(600);
check(posted.some(x=>x.title==="資料整理"&&x.visibility==="shared"),"保存と同時に全社員向けに共有");
check((await page.locator("#wk-calendar").innerText()).includes("資料整理"),"保存した予定がカレンダーへ即時反映");
await page.locator("#wk-review").click();
await page.waitForTimeout(400);
check((await page.locator("#wk-message").innerText()).includes("予定を確認しました"),"事前にAIコメントを表示");
check(errors.length===0,"ブラウザエラーなし: "+errors.join("; "));
await page.close();
await br.close();
console.log("週間業務カレンダーUI すべて通過");
