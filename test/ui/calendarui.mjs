// 月／週／日・自分／全員をカレンダー上で切り替えるブラウザ回帰テスト。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
const page = await br.newPage({viewport:{width:1380,height:940},timezoneId:"Asia/Tokyo"});
const bad=[];const assert=(ok,name)=>{if(!ok)bad.push(name);console.log((ok?"ok ":"NG ")+name)};
const today = new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const start = new Date(today+"T09:00:00+09:00").toISOString();
const end = new Date(today+"T10:00:00+09:00").toISOString();
const own=[{id:"a",title:"営業アタック",location:"社内",category:"work",all_day:false,source:"self",visibility:"shared",
  starts_at:start,ends_at:end,employee_id:"emp1"}];
const team=[{id:"b",title:"会社MTG",location:"本社",category:"meeting",allDay:false,visibility:"shared",
  startsAt:start,endsAt:end,employeeId:"emp2",employeeName:"他メンバー"}];
const operations=[];const errors=[];
page.on("pageerror",e=>errors.push(String(e)));
page.on("dialog",d=>d.accept());
await page.addInitScript(()=>{
  localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"a@b.c"}));
  localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"社員",shows:{},stage:null}));
});
await page.route("**/api/**",route=>{
  const req=route.request(),url=new URL(req.url()),method=req.method();
  const send=obj=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(obj)});
  if(url.pathname==="/api/me")return send({email:"a@b.c",appRole:"member",isAdmin:false,shows:{},
    gw:{tenantId:"tenant1",roles:[],stage:null,employee:{id:"emp1",display_name:"社員",status:"active"}}});
  if(url.pathname==="/api/schedule"){
    if(method==="GET")return send({events:own.slice(),tasks:[],bookings:[],external:{events:[]},googleLink:{}});
    const data=JSON.parse(req.postData()||"{}");operations.push({method,data});
    if(method==="POST"){
      const event={id:"c",title:data.title,location:data.location,category:data.category,all_day:false,source:"self",
        starts_at:new Date(data.startsAt).toISOString(),ends_at:new Date(data.endsAt).toISOString(),
        visibility:data.visibility,employee_id:"emp1"};
      own.push(event);return send({event});
    }
    if(method==="PATCH"){const o=own.find(o=>o.id===data.id);if(o){o.title=data.title;o.starts_at=new Date(data.startsAt).toISOString();o.ends_at=new Date(data.endsAt).toISOString()}return send({event:o});}
    if(method==="DELETE"){own.splice(own.findIndex(o=>o.id===url.searchParams.get("id")),1);return send({ok:true});}
  }
  if(url.pathname==="/api/schedule/team")return send({events:team.slice(),people:[{id:"emp1",name:"自分"},{id:"emp2",name:"他メンバー"}]});
  if(url.pathname==="/api/schedule/review")return send({ai:true,verdict:"good",summary:"時間配分は妥当です",details:"予定の重複がなく、休憩の余地があります。",priorityAdvice:"先に営業アタックを行います。",metrics:{totalMinutes:180,overlaps:0},suggestions:["営業アタックを優先"]});
  if(url.pathname==="/api/notifications")return send({notifications:[],unread:0});
  return send({});
});
await page.goto(BASE+"/calendar.html");
await page.waitForTimeout(900);
assert((await page.locator("#cal-title").innerText()).includes("年"),"最初は月表示");
assert(await page.locator("#scope-mine").evaluate(x=>x.classList.contains("on")),"初期状態は自分");
assert(await page.locator("#view-month").evaluate(x=>x.classList.contains("on")),"初期状態は月");
assert(await page.locator(".cal-date").count()>=28,"1か月分のカレンダーが並ぶ");
assert(await page.locator(".oc-grid").count()===1,"Officeと同じ月間グリッド");
assert(await page.locator(".oc-dow").count()===7,"Officeと同じ月曜始まり");
assert((await page.locator(".oc-dow").first().innerText())==="月","週の始まりは月曜");
assert(await page.locator(".oc-strip").count()===1,"Officeと同じスマホ日付ストリップ");
assert((await page.locator("#cal-list-heading").innerText()).includes("自分の予定一覧"),"自分の月間予定一覧を表示");
assert((await page.locator("#cal-list").innerText()).includes("営業アタック"),"自分の予定が一覧に出る");
assert((await page.locator("#cal-grid").innerText()).includes("営業アタック"),"自分の予定が月間に出る");
await page.locator("#cal-new").click();
await page.locator("#f-title").fill("面談");
await page.locator("#f-start").fill("11:00");
await page.locator("#f-end").fill("12:00");
await page.locator("#cal-save").click();
await page.waitForTimeout(300);
assert(operations.some(x=>x.method==="POST"&&x.data.title==="面談"&&x.data.visibility==="shared"),"選択日の予定を社内共有で保存");
assert((await page.locator("#cal-grid").innerText()).includes("面談"),"保存後に予定が画面に反映");
assert((await page.locator("#cal-list").innerText()).includes("面談"),"保存した予定が月間一覧にも反映");
await page.locator("#scope-team").click();
await page.waitForTimeout(350);
assert((await page.locator("#cal-grid").innerText()).includes("他メンバー"),"全員表示で担当者が出る");
assert((await page.locator("#cal-grid").innerText()).includes("会社MTG"),"全員の業務予定が見える");
assert((await page.locator("#cal-list-heading").innerText()).includes("全員"),"一覧も全員モードに切り替わる");
assert(await page.locator("#cal-new").isHidden(),"全員表示では他人の予定を編集させない");
await page.locator("#view-week").click();
assert(await page.locator(".cal-week").count()===1,"週表示に切り替わる");
await page.locator("#view-day").click();
assert(await page.locator(".cal-dayview").count()===1,"日表示に切り替わる");
await page.locator("#scope-mine").click();
assert(await page.locator("#cal-new").isVisible(),"自分へ戻ると新規登録可能");
await page.locator("#cal-ai-btn").click();
await page.waitForTimeout(300);
assert(await page.locator("#cal-ai-result details.cal-ai-detail").count()===1,"AIの詳細を折りたたみで確認可能");
await page.locator("#cal-ai-result details.cal-ai-detail summary").click();
assert((await page.locator("#cal-ai-result").innerText()).includes("判断理由"),"AI判定の根拠を表示");
assert(errors.length===0,"画面JavaScriptエラーなし: "+errors.join(" / "));
await br.close();
console.log(bad.length?bad.length+" NG":"月週日・自分全員・予定登録 すべて通過");
process.exit(bad.length?1:0);
