// 本人予定のチェック操作と一括更新をブラウザで検証する。実データ・実ログインは使わない。
import { launch, BASE, jstToday } from "../_browser.mjs";
const br=await launch();
const page=await br.newPage({viewport:{width:1440,height:900},timezoneId:"Asia/Tokyo"});
const bad=[],sent=[],errors=[];
const check=(ok,msg)=>{console.log((ok?"ok ":"NG ")+msg);if(!ok)bad.push(msg);};
const day=jstToday();
const starts=new Date(day+"T09:00:00+09:00").toISOString();
const ends=new Date(day+"T10:00:00+09:00").toISOString();
const records=[
  {id:"11111111-1111-4111-8111-111111111111",title:"本人予定A",source:"self",category:"work",starts_at:starts,ends_at:ends,all_day:false,work_status:"todo"},
  {id:"22222222-2222-4222-8222-222222222222",title:"本人予定B",source:"self",category:"meeting",starts_at:starts,ends_at:ends,all_day:false,work_status:"doing"},
];
await page.addInitScript(()=>{
  localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"test@example.com"}));
  localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"テスト社員",shows:{},stage:null}));
});
page.on("pageerror",e=>errors.push(String(e)));
page.on("dialog",d=>d.accept());
await page.route("**/api/**",route=>{
  const req=route.request(),u=new URL(req.url());
  const send=o=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(o)});
  if(u.pathname==="/api/me")return send({email:"test@example.com",appRole:"member",isAdmin:false,access:{},shows:{},gw:{
    tenantId:"tenant1",roles:[],stage:null,employee:{id:"emp1",display_name:"テスト社員",status:"active"}}});
  if(u.pathname==="/api/schedule"&&u.searchParams.get("view")==="home")
    return send({items:records.map(x=>({...x})),truncated:false});
  if(u.pathname==="/api/schedule"&&req.method()==="POST"){
    const body=JSON.parse(req.postData()||"{}");
    sent.push(body);
    if(body.action==="bulk_work_status"){
      for(const record of records)if(body.ids.includes(record.id))record.work_status=body.status;
      return send({ok:true,count:body.ids.length,items:records.filter(x=>body.ids.includes(x.id)).map(x=>({
        id:x.id,work_status:x.work_status,completed_at:x.work_status==="done"?new Date().toISOString():null}))});
    }
    return send({});
  }
  if(u.pathname==="/api/schedule")return send({events:records.map(x=>({...x,visibility:"shared",employee_id:"emp1"})),
    tasks:[],bookings:[],external:{events:[]},googleLink:{},quantityAvailable:true});
  if(u.pathname==="/api/notifications")return send({notifications:[],unread:0});
  if(u.pathname==="/api/badges")return send({badges:{}});
  return send({});
});
try{
  await page.goto(BASE+"/home.html");
  await page.locator(".home-event-picker").first().waitFor({state:"visible",timeout:12000});
  check((await page.locator("#home-tasks .home-task-title").innerText()).includes("自分の予定"),"本人予定のタイトル");
  check(await page.locator(".home-event-picker").count()===2,"本人の業務予定2件が並ぶ");
  check(await page.locator(".home-event-picker").first().isEnabled(),"チェックは無効化されていない");
  check(await page.locator("#home-event-bulk").isHidden(),"未選択なら一括操作欄を隠す");
  await page.locator(".home-event-picker").first().check();
  check(await page.locator("#home-event-bulk").isVisible(),"選択すると一覧下に操作欄が出る");
  check((await page.locator("#home-event-selected-count").innerText())==="1","選択件数を表示");
  check(sent.length===0,"チェックだけでは保存しない");
  await page.locator("#home-event-select-all").check();
  check((await page.locator("#home-event-selected-count").innerText())==="2","表示中を全選択できる");
  await page.locator("#home-event-bulk-done").click();
  await page.waitForFunction(()=>document.querySelectorAll("#home-event-rows .ht-pill.done").length===2);
  check(sent.length===1&&sent[0].action==="bulk_work_status"&&sent[0].status==="done"&&sent[0].ids.length===2,"2件を1リクエストで対応済みに保存");
  check(await page.locator(".home-event-picker").first().isEnabled(),"更新後もチェックできる");
  await page.locator("#home-event-reload").click();
  await page.waitForTimeout(150);
  check(await page.locator("#home-event-rows .ht-pill.done").count()===2,"再取得後も対応済みが残る");
  check(!errors.some(s=>s.includes("HomeSchedule")),"本人予定スクリプトの実行エラーがない");
}finally{await br.close();}
if(bad.length)throw new Error(bad.length+" 件失敗: "+bad.join(", "));
console.log("PASS 本人予定の表示・チェック選択・一括更新・再取得");
