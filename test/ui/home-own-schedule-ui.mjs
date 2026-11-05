// ホームの作業タスク（未完了→対応済み履歴）をブラウザで確認。APIはモック、実データ変更なし。
import {launch,BASE,jstToday} from "../_browser.mjs";

const br=await launch();
const page=await br.newPage({viewport:{width:1440,height:950},timezoneId:"Asia/Tokyo"});
const bad=[],writes=[],errors=[];
const check=(ok,name)=>{console.log((ok?"ok ":"NG ")+name);if(!ok)bad.push(name);};
const today=jstToday();
const records=[
 {id:"11111111-1111-4111-8111-111111111111",title:"見積書を送付",status:"todo",priority:"high",due_on:today,assignee_id:"emp1",requestedByOther:false,needsAccept:false,completed_at:null},
 {id:"22222222-2222-4222-8222-222222222222",title:"資料を提出",status:"doing",priority:"normal",due_on:today,assignee_id:"emp1",requestedByOther:false,needsAccept:false,completed_at:null},
 {id:"33333333-3333-4333-8333-333333333333",title:"先週の報告を完了",status:"done",priority:"low",due_on:today,assignee_id:"emp1",requestedByOther:false,needsAccept:false,completed_at:"2026-11-03T08:30:00Z"},
];
await page.addInitScript(()=>{
 localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"employee@example.com"}));
 localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"テスト社員",shows:{},stage:null}));
});
page.on("pageerror",e=>errors.push(String(e)));
page.on("dialog",d=>d.accept());
await page.route("**/api/**",route=>{
 const req=route.request(),url=new URL(req.url()),method=req.method();
 const send=data=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(data)});
 if(url.pathname==="/api/me")return send({email:"employee@example.com",appRole:"member",isAdmin:false,access:{},shows:{},gw:{
   tenantId:"tenant1",roles:[],stage:null,employee:{id:"emp1",display_name:"テスト社員",status:"active"}}});
 if(url.pathname==="/api/tasks"){
   if(method==="GET")return send({tasks:records.map(x=>({...x})),requested:[],extras:{actions:[],onboarding:[],proposed:[]},canManage:false,me:{id:"emp1"}});
   if(method==="PATCH"){
     const body=JSON.parse(req.postData()||"{}");writes.push(body);
     const task=records.find(t=>t.id===body.id);
     if(task){task.status=body.status;task.completed_at=body.status==="done"?"2026-11-04T05:05:00Z":null;}
     return send({task:task||{}});
   }
   return send({task:{}});
 }
 if(url.pathname==="/api/schedule")return send({events:[{id:"meeting",title:"朝MTG",source:"self",category:"meeting",all_day:false,employee_id:"emp1",
   starts_at:new Date(today+"T09:00:00+09:00").toISOString(),ends_at:new Date(today+"T10:00:00+09:00").toISOString()}],
   tasks:[],bookings:[],external:{events:[]},googleLink:{},quantityAvailable:true});
 if(url.pathname==="/api/notifications")return send({notifications:[],unread:0});
 if(url.pathname==="/api/badges")return send({badges:{}});
 return send({});
});
try{
 await page.goto(BASE+"/home.html");
 await page.locator("#home-task-rows tr[data-task-id]").first().waitFor({state:"visible",timeout:15000});
 check((await page.locator("#home-tasks .home-task-title").innerText()).includes("タスク一覧"),"見出しはタスク一覧");
 check(await page.locator('[data-home-filter="open"]').getAttribute("aria-pressed")==="true","デフォルトは未完了");
 check(await page.locator("#home-task-rows tr[data-task-id]").count()===2,"未完了の2件だけ表示");
 check(!(await page.locator("#home-task-rows").innerText()).includes("朝MTG"),"カレンダーの朝MTGはタスクに混ざらない");
 check(!(await page.locator("#home-task-rows").innerText()).includes("先週の報告を完了"),"対応済みは未完了一覧に出ない");
 check(await page.locator("#home-task-completed-heading").isHidden(),"完了日時列は既定では隠す");
 await page.locator('.home-task-picker').first().check();
 check(await page.locator("#home-task-bulk").isVisible(),"選択するとまとめて更新を表示");
 check(writes.length===0,"チェックだけではDBを書き換えない");
 await page.locator("#home-task-bulk-done").click();
 await page.waitForFunction(()=>document.querySelectorAll("#home-task-rows tr[data-task-id]").length===1);
 check(writes.length===1&&writes[0].status==="done","対応済み操作は既存タスクAPIのPATCH");
 check(!(await page.locator("#home-task-rows").innerText()).includes("見積書を送付"),"完了時に未完了一覧から外す");
 await page.locator('[data-home-filter="done"]').click();
 await page.waitForFunction(()=>document.querySelectorAll("#home-task-rows tr[data-task-id]").length===2);
 check(await page.locator("#home-task-completed-heading").isVisible(),"対応済み一覧で完了日時列を表示");
 const content=await page.locator("#home-task-rows").innerText();
 check(content.includes("見積書を送付")&&content.includes("先週の報告を完了"),"完了したタスクは履歴一覧へ移動");
 check(content.includes("14:05"),"サーバの完了時刻をJSTで表示");
 check(!content.includes("朝MTG"),"履歴も会議を含めない");
 check(!errors.some(e=>e.includes("homeTasksInit")||e.includes("homeRenderTasks")),"ホームのタスク処理でブラウザ例外がない");
}finally{await br.close();}
if(bad.length)throw new Error(bad.length+"件失敗: "+bad.join("、"));
console.log("PASS タスク未完了初期表示・完了操作・履歴移動・完了時刻JST・予定との分離");
