// HR採用メール新着受付：手動候補→レビュー→既存応募者紐づけの実ブラウザ確認。
// 実際のGmail・Xserver・本番DBには一切接続せず、画面のHTTPをモック。
import { launch,BASE } from "../_browser.mjs";
import {accessOf} from "../../lib/gw.js";
const br=await launch();
const page=await br.newPage({viewport:{width:390,height:844},timezoneId:"Asia/Tokyo"});
const rows=[],seen=new Map();
const aid="12345678-1234-4234-8234-111111111111";
const emailId="12345678-1234-4234-8234-222222222222";
const errors=[];page.on("pageerror",e=>errors.push(String(e)));
await page.addInitScript(()=>localStorage.setItem("kp_session",JSON.stringify({access_token:"test",email:"recruit@example.com"})));
await page.route("**/api/**",route=>{
 const req=route.request(),url=req.url();
 const send=x=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(x)});
 if(/\/api\/me\b/.test(url))return send({email:"recruit@example.com",appRole:"member",
  gw:{employee:{id:"e1",display_name:"採用担当"},roles:["recruiter"],tenantId:"t1"},
  access:accessOf({roles:["recruiter"]})});
 if(/\/api\/hr\/applicants\b/.test(url))return send({applicants:[{id:aid,name:"架空候補者",jobTitle:"営業担当"}]});
 if(/\/api\/hr\/inbox\b/.test(url)){
  if(req.method()==="GET")return send({mails:rows,newCount:rows.filter(x=>x.status==="new").length,capped:false});
  const p=JSON.parse(req.postData()||"{}");
  if(p.action==="import"){
   if(seen.has(p.providerMessageId))return send({ok:true,duplicate:true,mail:seen.get(p.providerMessageId)});
   const row={id:emailId,status:"new",applicant_id:null,
    received_at:p.receivedAt,subject:p.subject,sender_address:p.senderAddress,
    body_text:p.bodyText,candidate_name_guess:p.candidateName,job_title_guess:p.jobTitle,
    source_guess:p.source,review_note:""};
   rows.push(row);seen.set(p.providerMessageId,row);return send({ok:true,duplicate:false,mail:row});
  }
  if(p.action==="review"){rows[0].status=p.status;rows[0].review_note=p.note;return send({ok:true,mail:rows[0]});}
  if(p.action==="link"){rows[0].status="linked";rows[0].applicant_id=p.applicantId;return send({ok:true,mail:rows[0]});}
 }
 return send({});
});
await page.goto(BASE+"/hr/inbox.html");
await page.waitForSelector(".hr-bar");
await page.waitForTimeout(250);
const expect=async(cond,label)=>{if(!cond)throw Error(label);};
await expect((await page.locator("#inStatus").innerText()).length===0,"読み込みエラーなし");
await expect((await page.locator("#newCount").innerText()).includes("新着 0件"),"新着初期0件");
await page.locator("#pasteButton").click();
await page.locator('[name="receivedAt"]').fill("2026-10-22T09:00");
await page.locator('[name="subject"]').fill("応募：架空候補者");
await page.locator('[name="senderAddress"]').fill("no-reply@example.com");
await page.locator('[name="candidateName"]').fill("架空候補者");
await page.locator('[name="bodyText"]').fill("応募に興味があります。");
await page.locator('#pasteForm button[type="submit"]').click();
await page.waitForFunction(()=>document.querySelector("#newCount")?.textContent.includes("1件"));
await expect(rows.length===1,"1件のみ受付");
await page.locator('[data-mail-id]').first().click();
await page.locator("#applicantSelect").selectOption(aid);
await page.locator('[data-in-act="link"]').click();
await page.waitForFunction(()=>document.querySelector("#newCount")?.textContent.includes("0件"));
await expect(rows[0].applicant_id===aid&&rows[0].status==="linked","既存応募者に明示紐づけ");
await page.locator("#inFilter").selectOption("linked");
await expect(await page.locator("[data-mail-id]").count()===1,"紐づけ済みの受信履歴を保持");
const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:innerWidth}));
await expect(width.scroll<=width.inner,"390pxで横はみ出しなし");
await expect(errors.length===0,"JavaScriptエラーなし："+errors.join(","));
await br.close();console.log("HR新着受付 UI：手動受付・紐づけ・新着件数・390px PASS");
