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
    if(method==="POST"&&data.action==="batch_create"){
      const saved=data.events.map((e,i)=>({id:"batch-"+operations.length+"-"+i,title:e.title,location:e.location,
        category:e.category,all_day:false,source:"self",visibility:e.visibility,employee_id:"emp1",
        starts_at:new Date(e.startsAt).toISOString(),ends_at:new Date(e.endsAt).toISOString()}));
      own.push(...saved);
      return send({ok:true,count:saved.length,events:saved});
    }
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
const gridMetrics=await page.locator(".oc-grid").evaluate(n=>{
  const style=getComputedStyle(n);
  const cells=[...n.querySelectorAll(".oc-dow")].map(x=>x.getBoundingClientRect());
  return {display:style.display,columns:style.gridTemplateColumns.split(" ").filter(Boolean).length,
    firstRow:cells.map(x=>Math.round(x.top)), widths:cells.map(x=>Math.round(x.width))};
});
assert(gridMetrics.display==="grid"&&gridMetrics.columns===7,"月間カレンダーが実際に7列表示（CSSとレイアウト）");
assert(new Set(gridMetrics.firstRow).size===1,"曜日ヘッダーが同じ横列に並ぶ");
assert(gridMetrics.widths.every(n=>n>=35),"7列の表示幅が正常");
assert(await page.locator(".oc-dow").count()===7,"Officeと同じ月曜始まり");
assert((await page.locator(".oc-dow").first().innerText())==="月","週の始まりは月曜");
assert(await page.locator(".oc-strip").count()===1,"Officeと同じスマホ日付ストリップ");
assert((await page.locator("#cal-list-heading").innerText()).includes("自分の予定一覧"),"自分の月間予定一覧を表示");
const layoutMetrics=await page.locator(".cal-wrap").evaluate(n=>{
 const r=n.getBoundingClientRect();
 const side=document.querySelector(".kp-sidebar")?.getBoundingClientRect();
 return {left:r.left,right:r.right,sideRight:side?.right||0,viewport:innerWidth};
});
assert(layoutMetrics.left>=layoutMetrics.sideRight-1,"本文がサイドメニューに重ならない");
assert(layoutMetrics.right<=layoutMetrics.viewport+1,"本文が画面幅からはみ出さない");
const iconMetrics=await page.locator(".kp-sidebar .material-symbols-outlined").first().evaluate(n=>{
 const s=getComputedStyle(n);
 return {family:s.fontFamily,width:n.getBoundingClientRect().width};
});
assert(iconMetrics.family.includes("Material Symbols")&&iconMetrics.width<=35,"アイコン表示を共通メニューでも有効化");
assert((await page.locator("#cal-list").innerText()).includes("営業アタック"),"自分の予定が一覧に出る");
await page.locator('.oc-grid .cal-date[data-date="'+today+'"]').click();
assert(await page.locator("#cal-batch-panel").isVisible(),"日付を押すと予定登録モーダルが開く");
assert((await page.locator("#cal-batch-title").innerText()).includes("の予定"),"選んだ日の予定を追加");
assert((await page.locator("#cal-batch-existing").innerText()).includes("営業アタック"),"既存予定を確認できる");
await page.locator('#cal-batch-panel button[aria-label="閉じる"]').click();
assert(await page.locator("#cal-batch-panel").isHidden(),"モーダルを閉じられる");
assert((await page.locator("#cal-grid").innerText()).includes("営業アタック"),"自分の予定が月間に出る");

await page.locator("#cal-new").click();
assert(await page.locator("#cal-batch-rows .cal-batch-row").count()===1,"追加画面は最初1件だけ表示");
await page.locator(".cal-batch-row .cal-batch-title input").first().fill("午前の面談");
await page.locator(".cal-batch-row .cal-batch-start input").first().fill("11:00");
await page.locator(".cal-batch-row .cal-batch-end input").first().fill("12:00");
await page.locator("#cal-batch-add").click();
assert(await page.locator("#cal-batch-rows .cal-batch-row").count()===2,"追加すると下に新しい予定が増える");
await page.locator(".cal-batch-row .cal-batch-title input").nth(1).fill("午後の企画");
await page.locator(".cal-batch-row .cal-batch-start input").nth(1).fill("13:00");
await page.locator(".cal-batch-row .cal-batch-end input").nth(1).fill("14:00");
await page.locator("#cal-batch-save").click();
await page.waitForTimeout(400);
const batch=operations.filter(x=>x.method==="POST"&&x.data.action==="batch_create");
assert(batch.length===1,"最後に1回だけまとめて登録");
assert(batch[0]?.data.events.length===2,"登録内容2件を一括送信");
assert(batch[0]?.data.events.every(e=>e.startsAt.slice(0,10)===today),"選択した日だけに予定を登録");
assert((await page.locator("#cal-grid").innerText()).includes("午前の面談"),"保存した予定がカレンダーに反映");
assert((await page.locator("#cal-batch-result").innerText()).includes("AIアドバイス"),"登録後にAIがアドバイスを表示");
assert(await page.locator("#cal-batch-save").isHidden(),"登録済みの保存ボタンは消える");
assert(await page.locator("#cal-batch-again").isVisible(),"さらに予定を登録できる");
await page.locator("#cal-batch-again").click();
assert(await page.locator("#cal-batch-rows .cal-batch-row").count()===1,"追加登録は入力欄をリセットする");
await page.locator('#cal-batch-panel button[aria-label="閉じる"]').click();
assert(await page.locator("#cal-batch-panel").isHidden(),"登録後も閉じられる");
await page.locator("#scope-team").click();
await page.waitForTimeout(350);
assert((await page.locator("#cal-grid").innerText()).includes("他メンバー"),"全員表示で担当者が出る");
assert((await page.locator("#cal-grid").innerText()).includes("会社MTG"),"全員の業務予定が見える");
await page.locator('.oc-grid .cal-date[data-date="'+today+'"]').click();
assert(!(await page.locator(".cal-drawer").innerText()).includes("編集する"),"全員の詳細は閲覧だけ");
await page.locator(".cal-drawer-close").first().click();
assert((await page.locator("#cal-list-heading").innerText()).includes("全員"),"一覧も全員モードに切り替わる");
assert(await page.locator("#cal-new").isHidden(),"全員表示では他人の予定を編集させない");
assert(await page.locator("#cal-new").isHidden(),"全員表示では追加モーダルも使えない");
await page.locator("#view-week").click();
await page.locator(".cal-week").waitFor();
assert(await page.locator(".cal-week").count()===1,"週表示に切り替わる");
await page.locator("#view-day").click();
await page.locator(".cal-dayview").waitFor();
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
