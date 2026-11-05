// 月間カレンダーではセルの表示上限3件を超えても、日付の全予定を開けることを確認。
import {launch,BASE,jstToday} from "../_browser.mjs";
const br=await launch();
const page=await br.newPage({viewport:{width:1400,height:940},timezoneId:"Asia/Tokyo"});
const errors=[];
page.on("pageerror",e=>errors.push(String(e)));
page.on("dialog",d=>d.accept());
const date=jstToday();
const events=Array.from({length:5},(_,i)=>({
  id:"e"+i,employee_id:"emp1",source:"self",category:"work",visibility:"shared",
  title:"その日の予定"+(i+1),all_day:false,
  starts_at:new Date(date+"T"+String(9+i).padStart(2,"0")+":00:00+09:00").toISOString(),
  ends_at:new Date(date+"T"+String(10+i).padStart(2,"0")+":00:00+09:00").toISOString()
}));
await page.addInitScript(()=>{
  localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"test@example.com"}));
  localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"社員",shows:{},stage:null}));
});
await page.route("**/api/**",route=>{
  const u=new URL(route.request().url());
  const send=data=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(data)});
  if(u.pathname==="/api/me")return send({email:"test@example.com",appRole:"member",isAdmin:false,shows:{},gw:{
    tenantId:"tenant1",roles:[],stage:null,employee:{id:"emp1",display_name:"社員",status:"active"}}});
  if(u.pathname==="/api/schedule")return send({events,eventsStatus:"available",quantityAvailable:true,
    tasks:[],bookings:[],external:{events:[]},googleLink:{}});
  if(u.pathname==="/api/schedule/team")return send({events:[],people:[]});
  if(u.pathname==="/api/notifications")return send({notifications:[],unread:0});
  return send({});
});
try{
  await page.goto(BASE+"/calendar.html");
  await page.locator(".oc-grid .cal-date").first().waitFor({timeout:15000});
  const cell=page.locator('.oc-grid .cal-date[data-date="'+date+'"]');
  if(!await cell.isVisible())throw Error("本日の日付セルがありません");
  const visible=await cell.locator(".cal-event").count();
  if(visible!==3)throw Error("月セルの予定は3件までの想定: "+visible);
  await cell.locator(".cal-num").click();
  if(await page.locator(".cal-drawer .oc-card").count()!==5)throw Error("日付クリックで5件すべてが表示されない");
  if(!(await page.locator(".cal-drawer").innerText()).includes("その日の予定5"))throw Error("省略された5件目が見えない");
  await page.locator(".cal-drawer-close").first().click();
  await cell.locator(".cal-event").first().click();
  if(await page.locator(".cal-drawer .oc-card").count()!==5)throw Error("予定名クリックが詳細1件に戻っている");
  await page.locator(".cal-drawer .cal-event-title").first().click();
  if(await page.locator(".cal-drawer .cal-detail-list").count()!==1)throw Error("一覧から個別詳細を開けない");
  if(errors.length)throw Error("ブラウザエラー: "+errors.join("; "));
}finally{await br.close();}
console.log("PASS 月カレンダー：日付／予定名→省略なし5件表示→個別詳細");
