// HR採用メール新着受付：実ブラウザで、受信→開く（既読）→候補の確認→重複→登録＋紐づけ／対応終了／未対応に戻す を確認。
// 実際のGmail・Xserver・本番DBには一切接続せず、画面のHTTPをモック（架空データのみ）。
import { launch,BASE } from "../_browser.mjs";
import {accessOf} from "../../lib/gw.js";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
import {shotPath} from "../_shot.mjs";
// 画面写真は確認用（判定には使わない）。SHOTS_DIR があればそこへ、無ければ共通の置き場所へ
const SHOTS=process.env.SHOTS_DIR||"";
if(SHOTS)mkdirSync(SHOTS,{recursive:true});
const shotFile=(name)=>SHOTS?join(SHOTS,name+".png"):shotPath("hrinbox-"+name+".png");
const br=await launch();
const expect=(cond,label)=>{if(!cond)throw Error(label);};
const aid="12345678-1234-4234-8234-111111111111";
const mid=(n)=>"12345678-1234-4234-8234-22222222222"+n;
let pass=0;const ok=(c,m)=>{expect(c,m);pass++;};

function fixture(){
 return {
  rows:[
   {id:mid(1),provider:"gmail",status:"new",applicant_id:null,received_at:"2026-10-24T00:10:00Z",updated_at:"2026-10-24T00:10:01.000Z",
    subject:"【Wantedly】架空 太郎さんから応募がありました",sender_address:"no-reply@wantedly.com",reply_to:null,read:false,
    body_text:"【架空データ】\n氏名：架空 太郎\nメールアドレス：taro@example.com\n電話番号：090-0000-0000\n応募職種：営業\nプロフィール https://www.wantedly.com/id/fake?x=1&y=2 \n危険 javascript:alert(1) <img src=x onerror=alert(1)>"},
   {id:mid(2),provider:"gmail",status:"new",applicant_id:null,received_at:"2026-10-24T00:05:00Z",updated_at:"2026-10-24T00:05:01.000Z",
    subject:"【Wantedly】架空 既存さんから応募がありました",sender_address:"no-reply@wantedly.com",reply_to:"kizon@example.com",read:true,
    body_text:"【架空データ】ログインして確認してください"},
   {id:mid(3),provider:"manual",status:"review",applicant_id:null,received_at:"2026-10-23T23:00:00Z",updated_at:"2026-10-23T23:00:01.000Z",
    subject:"営業のご案内",sender_address:"sales@vendor.example",reply_to:null,read:true,body_text:"【架空データ】サービスのご案内"},
  ],
  applicants:[{id:aid,name:"架空 既存",jobTitle:"営業担当",email:"kizon@example.com",listTab:"active"}],
  posts:[],readsReady:true,
 };
}
async function openPage(viewport,fx,{failList=false}={}){
 const ctx=await br.newContext({viewport,timezoneId:"Asia/Tokyo"});
 const page=await ctx.newPage();
 const errors=[];page.on("pageerror",e=>errors.push(String(e)));
 page.on("dialog",d=>{errors.push("dialog:"+d.message());d.dismiss();});
 await page.addInitScript(()=>localStorage.setItem("kp_session",JSON.stringify({access_token:"test",email:"recruit@example.com"})));
 await page.route("**/api/**",route=>{
  const req=route.request(),url=new URL(req.url());
  const send=(x,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(x)});
  if(url.pathname==="/api/me")return send({email:"recruit@example.com",appRole:"member",
   gw:{employee:{id:"e1",display_name:"採用担当"},roles:["recruiter"],tenantId:"t1"},access:accessOf({roles:["recruiter"]})});
  if(url.pathname==="/api/hr/applicants")return send({applicants:fx.applicants});
  if(url.pathname==="/api/hr/inbox"){
   if(req.method()==="GET"){
    if(failList)return send({error:"db_failed",message:"新着受付の保存・読込に失敗しました"},500);
    const id=url.searchParams.get("id");
    if(id){const m=fx.rows.find(r=>r.id===id);return m?send({mail:m,applicant:m.applicant_id?fx.applicants.find(a=>a.id===m.applicant_id)||{id:m.applicant_id,name:"架空 新規"}:null,readsReady:fx.readsReady}):send({error:"not_found"},404);}
    const list=fx.rows.map(({body_text,...r})=>({...r,read:fx.readsReady?r.read:null}));
    return send({mails:list,newCount:list.filter(x=>x.status==="new").length,readsReady:fx.readsReady,capped:false});
   }
   const p=JSON.parse(req.postData()||"{}");fx.posts.push(p);
   const m=fx.rows.find(r=>r.id===p.id);
   if(p.action==="read"){m.read=true;return send({ok:true,readsReady:true});}
   if(p.action==="review"){m.status=p.status;m.review_note=p.note;return send({ok:true,mail:m});}
   if(p.action==="link"){m.status="linked";m.applicant_id=p.applicantId;return send({ok:true,created:false,mail:m});}
   if(p.action==="register"){
    const email=String(p.applicant.email||"").toLowerCase();
    const dup=fx.applicants.filter(a=>a.email===email&&!(p.seenDuplicateIds||[]).includes(a.id));
    if(dup.length)return send({error:"duplicate_candidates",message:"同じ人の可能性がある応募者がいます",candidates:dup},409);
    const id="12345678-1234-4234-8234-3333333333"+String(fx.applicants.length).padStart(2,"0");
    fx.applicants.push({id,name:p.applicant.name,email,jobTitle:p.applicant.jobTitle});
    m.status="linked";m.applicant_id=id;return send({ok:true,created:true,applicantId:id,mail:m});
   }
  }
  return send({});
 });
 await page.goto(BASE+"/hr/inbox.html");
 await page.waitForSelector(".hr-bar");
 await page.waitForFunction(()=>!document.querySelector("#inList")?.textContent.includes("読み込み中"));
 return {ctx,page,errors};
}
const shot=async(page,name)=>{await page.screenshot({path:shotFile(name),fullPage:false});};
const noOverflow=async(page,label)=>{const w=await page.evaluate(()=>({s:document.documentElement.scrollWidth,i:innerWidth}));ok(w.s<=w.i,label+"：横はみ出しなし "+JSON.stringify(w));};

for(const [vp,tag] of [[{width:390,height:844},"phone"],[{width:1280,height:900},"pc"]]){
 const fx=fixture();
 const {ctx,page,errors}=await openPage(vp,fx);
 const tabs=await page.locator(".hr-nav a").allInnerTexts();
 ok(tabs.some(t=>t.includes("ダッシュボード"))&&tabs.some(t=>t.includes("応募分析"))&&tabs.some(t=>t.includes("資料")),"最新の共通ナビ: "+tabs.join(" / "));
 // アイコンが文字（"dashboard" など）のまま幅を取らない：字形のフォントが指定されている
 const fam=await page.evaluate(()=>getComputedStyle(document.querySelector(".hr-nav .material-symbols-outlined")).fontFamily);
 ok(/Material Symbols Rounded/.test(fam),"ナビのアイコンにアイコンフォントを指定 "+fam);
 const navWrap=await page.evaluate(()=>[...document.querySelectorAll(".hr-nav a")].every(a=>getComputedStyle(a).whiteSpace==="nowrap"));
 ok(navWrap,"メニューの文字を折り返さない");
 ok((await page.locator("#openCount").innerText())==="3件","未対応3（新着2＋確認中1）");
 ok((await page.locator("#newCount").innerText())==="2件","新着2");
 ok((await page.locator("#unreadCount").innerText())==="1件","自分の未読1");
 ok(await page.locator(".in-item.unread").count()===1,"未読の行に印");
 await noOverflow(page,tag+" 一覧");
 await shot(page,tag+"-1-list");
 // 状態とボタンの説明
 await page.locator("#helpBox summary").click();
 ok((await page.locator("#stateHelp").innerText()).includes("確認中")&&(await page.locator("#actionHelp").innerText()).includes("未対応に戻す"),"状態とボタンの意味を表示");
 await page.locator("#helpBox summary").click();
 // 1通目を開く
 await page.locator(`[data-mail-id="${mid(1)}"]`).click();
 await page.waitForFunction(()=>document.querySelector("#inBody a.in-link"));
 const links=await page.$$eval("#inBody a",as=>as.map(a=>({href:a.getAttribute("href"),t:a.target,rel:a.rel})));
 ok(links.length===1&&links[0].href==="https://www.wantedly.com/id/fake?x=1&y=2"&&links[0].t==="_blank"&&/noopener/.test(links[0].rel),"本文の https だけリンク "+JSON.stringify(links));
 ok(await page.locator("#inBody img").count()===0,"本文のタグは実行しない");
 ok((await page.locator("#inAddr").innerText()).includes("応募者本人のアドレスではありません"),"通知元を本人と区別");
 ok(await page.locator("#dName").inputValue()==="架空 太郎"&&await page.locator("#dEmail").inputValue()==="taro@example.com","氏名・メールの候補");
 ok((await page.locator("#fromEmail").innerText()).includes("未確認"),"候補は未確認と表示");
 ok(!(await page.locator('[data-in-act="new"]').isVisible())&&!(await page.locator("#spotLink").isVisible()),"新着では「未対応に戻す」「スポット人材」を出さない");
 ok(await page.locator('[data-in-act="register"]').isVisible(),"登録ボタンは見える位置にある");
 ok(await page.locator("#dSource").inputValue()==="Wantedly","媒体の候補");
 await page.waitForFunction(()=>document.querySelector("#unreadCount")?.textContent==="0件");
 ok(fx.posts.some(p=>p.action==="read"&&p.id===mid(1)),"本文を表示できたあとに既読を記録");
 ok(fx.rows[0].status==="new","開いただけでは未対応のまま");
 await noOverflow(page,tag+" 詳細");
 await shot(page,tag+"-2-detail");
 // 未取得は人が直せる：電話を消して入れ直す
 await page.locator("#dPhone").fill("");await page.locator("#dPhone").fill("090-1111-2222");
 // 登録（重複なし）
 await page.locator('[data-in-act="register"]').click();
 await page.waitForFunction(()=>document.querySelector("#inModal").hidden);
 ok(fx.rows[0].status==="linked"&&fx.applicants.length===2,"登録＋紐づけ");
 const reg=fx.posts.find(p=>p.action==="register");
 ok(reg.expectUpdatedAt==="2026-10-24T00:10:01.000Z"&&reg.applicant.phone==="090-1111-2222","画面の版と修正した値を送る");
 await page.waitForFunction(()=>document.querySelector("#inStatus").textContent.includes("登録し"));
 ok(true,"結果を表示");
 ok((await page.locator("#openCount").innerText())==="2件","登録したら未対応から外れる");
 // 2通目：既存と同じメール → 重複候補を表示、確認するまで登録できない
 await page.locator(`[data-mail-id="${mid(2)}"]`).click();
 await page.waitForFunction(()=>!document.querySelector("#dupBox").hidden);
 ok((await page.locator("#dupBox").innerText()).includes("架空 既存"),"重複候補を表示");
 ok(await page.locator('[data-in-act="register"]').isDisabled(),"候補を確認するまで登録できない");
 ok(await page.locator("#dEmail").inputValue()==="kizon@example.com","返信先をメール候補に");
 await shot(page,tag+"-3-duplicate");
 const ackBox=await page.locator("#dupAck").boundingBox();ok(ackBox&&ackBox.width<40,"確認のチェックボックスが崩れていない");
 await page.locator(`[data-dup-link="${aid}"]`).click();
 await page.waitForFunction(()=>document.querySelector("#inModal").hidden);
 ok(fx.rows[1].status==="linked"&&fx.rows[1].applicant_id===aid&&fx.applicants.length===2,"本人を選んで既存に紐づけ（二重登録しない）");
 // 3通目：対応終了は理由必須 → 理由を書いて終了 → 未対応に戻す
 await page.locator("#inFilter").selectOption("");
 await page.locator(`[data-mail-id="${mid(3)}"]`).click();
 await page.waitForFunction(()=>document.querySelector("#inBody").textContent.includes("サービス"));
 await page.locator("#inNote").fill("");
 await page.locator('[data-in-act="ignored"]').click();
 ok((await page.locator("#inModalStatus").innerText()).includes("理由"),"理由なしでは対応終了にしない");
 ok(fx.rows[2].status==="review","状態は変えない");
 await page.locator("#dDest").selectOption("spot");
 ok(await page.locator("#spotLink").isVisible()&&await page.locator('[data-in-act="register"]').isDisabled(),"スポット人材は別画面へ案内（ここで登録しない）");
 await page.locator("#inNote").fill("営業メールのため");
 await page.locator('[data-in-act="ignored"]').click();
 await page.waitForFunction(()=>document.querySelector("#inModal").hidden);
 ok(fx.rows[2].status==="ignored"&&fx.rows[2].review_note==="営業メールのため","理由つきで対応終了");
 await page.locator(`[data-mail-id="${mid(3)}"]`).click();
 await page.waitForFunction(()=>!document.querySelector('[data-in-act="new"]').hidden);
 ok(await page.locator('[data-in-act="register"]').isDisabled(),"対応終了のまま登録はできない");
 await page.locator('[data-in-act="new"]').click();
 await page.waitForFunction(()=>document.querySelector("#inModal").hidden);
 ok(fx.rows[2].status==="new","未対応に戻せる");
 ok(errors.length===0,"JavaScriptエラーなし："+errors.join(","));
 await ctx.close();
}

// 取得失敗は0件と出さない／既読の表が未設定なら「確認できません」
{
 const fx=fixture();
 const {ctx,page}=await openPage({width:390,height:844},fx,{failList:true});
 ok((await page.locator("#inList").innerText()).includes("0件ではありません"),"取得失敗を0件にしない");
 ok((await page.locator("#openCount").innerText())==="—","件数は—");
 await shot(page,"phone-4-error");
 await ctx.close();
 const fx2=fixture();fx2.readsReady=false;
 const r2=await openPage({width:390,height:844},fx2);
 ok((await r2.page.locator("#unreadCount").innerText())==="確認できません","既読表なしは未読を確認できない");
 await r2.ctx.close();
}

// 採用ダッシュボードの新着マーク・件数
{
 const ctx=await br.newContext({viewport:{width:390,height:844},timezoneId:"Asia/Tokyo"});
 const page=await ctx.newPage();
 await page.addInitScript(()=>localStorage.setItem("kp_session",JSON.stringify({access_token:"test",email:"recruit@example.com"})));
 let mode="ok";
 await page.route("**/api/**",route=>{
  const url=new URL(route.request().url());
  const send=(x,s=200)=>route.fulfill({status:s,contentType:"application/json",body:JSON.stringify(x)});
  if(url.pathname==="/api/me")return send({email:"recruit@example.com",appRole:"member",
   gw:{employee:{id:"e1",display_name:"採用担当"},roles:["recruiter"],tenantId:"t1"},access:accessOf({roles:["recruiter"]})});
  if(url.pathname==="/api/hr/inbox")return mode==="ok"?send({openCount:2,newCount:1,unreadCount:1,readsReady:true}):send({error:"db_failed"},500);
  if(url.pathname==="/api/hr/applicants")return send({applicants:[],employees:[],sources:{options:[],counts:[]}});
  return send({});
 });
 await page.goto(BASE+"/hr/applicants.html");
 await page.waitForFunction(()=>document.querySelector("#hr-inbox-link .hic-wrap")?.textContent.includes("未読"));
 const t=await page.locator("#hr-inbox-link").innerText();
 ok(t.includes("新着あり")&&t.includes("未対応 2件")&&t.includes("未読 1件"),"ダッシュボードに新着マーク・未対応・未読: "+t);
 await noOverflow(page,"ダッシュボード");
 await shot(page,"phone-5-dashboard-badge");
 mode="fail";await page.reload();
 await page.waitForFunction(()=>document.querySelector("#hr-inbox-link .hic-wrap")?.textContent.includes("取得できません"));
 ok(!(await page.locator("#hr-inbox-link").innerText()).includes("0件"),"件数の取得失敗を0件と出さない");
 await ctx.close();
}
await br.close();console.log(`HR新着受付 UI：一覧・既読・候補・安全リンク・重複・登録・対応終了・戻す・バッジ・390px/1280px ${pass}ケース PASS`);
