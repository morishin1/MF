// HR新着メール：一括選択・状態更新・スポット人材の同一モーダル登録（PC/390px）。
// 実メール・DB・Gmail・本番APIへのアクセスはすべてモック。
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";
const br=await launch(),fail=[];
const UUID=x=>"11111111-1111-4111-8111-"+String(x).padStart(12,"0");
const today="2026-10-25T00:00:00.000Z";
async function pageOf(width){
 const context=await br.newContext({viewport:{width,height:850},timezoneId:"Asia/Tokyo"});
 const page=await context.newPage();
 const rows=[
  {id:UUID(1),subject:"広告営業",received_at:today,updated_at:today,status:"new",sender_address:"sales@example.test",read:true},
  {id:UUID(2),subject:"配信エラー",received_at:today,updated_at:today,status:"new",sender_address:"mailer@example.test",read:true},
  {id:UUID(3),subject:"スポット募集（架空）",received_at:today,updated_at:today,status:"new",sender_address:"notify@example.test",
   read:false,body_text:"氏名：架空スポット\n職種：接客\nタイミーから応募"}
 ];
 const reqs=[];
 page.on("pageerror",e=>fail.push(String(e)));
 await page.addInitScript(()=>localStorage.setItem("kp_session",JSON.stringify({access_token:"fake",email:"hr@example.test"})));
 await page.route("**/api/**",r=>{
  const req=r.request(),url=new URL(req.url());
  const send=(x,code=200)=>r.fulfill({status:code,contentType:"application/json",body:JSON.stringify(x)});
  if(url.pathname==="/api/me")return send({email:"hr@example.test",appRole:"member",
   gw:{employee:{id:UUID(4),display_name:"採用担当"},roles:["recruiter"],tenantId:UUID(7)},
   access:accessOf({roles:["recruiter"]})});
  if(url.pathname==="/api/hr/applicants")return send({applicants:[]});
  if(url.pathname==="/api/hr/inbox"){
   if(req.method()==="GET"){
    const id=url.searchParams.get("id");
    if(id){const item=rows.find(x=>x.id===id);return send({mail:item,applicant:null,spot:null,readsReady:true});}
    return send({mails:rows,readsReady:true,capped:false,syncConfigured:false});
   }
   const b=JSON.parse(req.postData()||"{}");reqs.push(b);
   if(b.action==="read")return send({ok:true,readsReady:true});
   if(b.action==="bulk"){
    for(const {id} of b.items){
      const m=rows.find(x=>x.id===id);
      m.status=b.bulkAction==="archive"?"ignored":b.bulkAction;
      if(b.bulkAction==="archive")m.deleted_at="2026-10-25T12:00:00Z";
      else if(b.bulkAction==="restore")m.deleted_at=null;
      m.updated_at="2026-10-25T12:00:00Z";
      m.review_note=b.reason;
    }
    return send({ok:true,changed:b.items.length});
   }
   if(b.action==="registerSpot"){
     const m=rows.find(x=>x.id===b.id);m.status="linked";m.spot_talent_id=UUID(9);
     return send({ok:true,created:true,spotId:UUID(9)});
   }
   return send({ok:true});
  }
  return send({});
 });
 await page.goto(BASE+"/hr/inbox.html");
 await page.locator("#inList .in-item").first().waitFor();
 return {context,page,rows,reqs};
}
for(const width of [1280,390]){
 const {context,page,rows,reqs}=await pageOf(width);
 const check=(ok,msg)=>{if(!ok)throw Error(width+": "+msg);};
 const horizontal=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
 check(horizontal,"横はみ出しなし");
 await page.locator('[data-select-mail]').nth(0).check();
 await page.locator('[data-select-mail]').nth(1).check();
 check(await page.locator("#bulkBar").isVisible(),"2件のフロートバー");
 check((await page.locator("#bulkCount").innerText()).includes("2件"),"選択件数表示");
 await page.locator('[data-bulk="ignored"]').click();
 check(await page.locator("#bulkModal").isVisible(),"一括理由モーダル");
 await page.locator("#bulkConfirm").click();
 check((await page.locator("#bulkError").innerText()).includes("理由"),"理由が必要");
 await page.locator("#bulkReason").selectOption("営業・広告");
 await page.locator("#bulkConfirm").click();
 await page.waitForFunction(()=>document.querySelector("#openCount")?.textContent==="1件");
 check(rows[0].status==="ignored"&&rows[1].status==="ignored","2件を同時に対象外");
 check(reqs.some(x=>x.action==="bulk"&&x.items.length===2&&x.reason==="営業・広告"),"一括APIへの送信");
 await page.locator("#inList [data-mail-id]").first().click();
 await page.waitForSelector("#dDest");
 await page.locator("#dDest").selectOption("spot");
 check(await page.locator("#spotFields").isVisible(),"同じ詳細モーダルにスポット登録欄");
 check((await page.locator('[data-in-act="register"]').innerText()).includes("スポット"),"スポット登録ボタン");
 await page.locator("#dName").fill("架空スポット");
 await page.locator("#spotWorkedOn").fill("2026-10-28");
 await page.locator("#spotSource").selectOption("タイミー");
 await page.locator('[data-in-act="register"]').click();
 await page.waitForFunction(()=>document.querySelector("#openCount")?.textContent==="0件");
 check(reqs.some(x=>x.action==="registerSpot"&&x.spot.workedOn==="2026-10-28"),"スポット登録APIを利用");
 check(rows[2].spot_talent_id===UUID(9),"メールとスポット人材の紐づけ");
 await context.close();
}
await br.close();
if(fail.length)throw Error(fail.join("\n"));
console.log("HRメール一括・スポット登録 1280px/390px ブラウザテスト PASS");
