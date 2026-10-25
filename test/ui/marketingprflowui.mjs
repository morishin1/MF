// Real browser UI acceptance with synthetic APIs: never reads/writes real user data.
import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";
const browser=await launch();
let checks=0;
const check=(v,n)=>{assert.ok(v,n);checks++;console.log("ok",n);};
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:850},timezoneId:"Asia/Tokyo",permissions:["clipboard-read","clipboard-write"]});
  await context.addInitScript(()=>{
   window.__prCalls=[];
   window.__pr={items:[],sequence:1,tableReady:true};
  });
  await context.route("**/js/api-client.js*",r=>r.fulfill({status:200,contentType:"application/javascript",body:`
    window.API={isLoggedIn:()=>true,api:async(path,options)=>{
      const op=options||{};
      window.__prCalls.push({path,method:op.method||"GET",action:op.body&&op.body.action});
      if(path==="/api/marketing?view=work")return {sources:[],items:[],readsReady:true,unreadCount:0,newCount:0,openCount:0};
      if(path==="/api/marketing?view=production")return {today:"2026-10-25",sources:[{key:"site_news",state:"ok",count:0},{key:"plan",state:"ok",count:0}],items:[],videoSites:[],employees:[],canManageSite:true,canLinkInquiries:true};
      if(path==="/api/marketing/pr-drafts"){
        if(!op.method)return {ready:true,items:window.__pr.items};
        const input=op.body;
        if(input.action==="save"){
          const obj={id:input.id||"a0000000-0000-4000-8000-000000000001",
            version:input.version?input.version+1:1,status:"draft",registeredAt:null,payload:input.payload,
            createdAt:"2026-10-25T00:00:00Z",updatedAt:"2026-10-25T00:00:00Z"};
          window.__pr.items=[obj];return {ready:true,item:obj};
        }
        if(input.action==="register"){
          const old=window.__pr.items[0];
          if(old.version!==input.version)throw Error("競合");
          const next={...old,status:"registered",version:old.version+1,registeredAt:"2026-10-25T00:00:00Z"};
          window.__pr.items=[next];return {ready:true,item:next};
        }
      }
      throw Error("unexpected api: "+path);
    }};
  `}));
  await context.route("**/js/marketing-layout.js*",r=>r.fulfill({status:200,contentType:"application/javascript",body:`
    window.MarketingLayout={
      init:async()=>({me:{access:{marketing:true}}}),
      esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
      fmt:s=>s||"",fmtDay:s=>s||""
    };
  `}));
  const page=await context.newPage();
  const errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.goto(BASE+"/marketing/?step=pr");
  await page.locator("#marketing-handoff-pr-composer .mpr-tabs").waitFor();
  check(await page.locator("#marketing-handoff-pr-composer [role=tab]").count()===5,"five PR subtabs "+width);
  check(await page.locator("#mkt-panel-pr").isVisible(),"PR primary tab visible "+width);
  check(!(await page.getByText("発信・制作の確認画面",{exact:true}).count())&&!(await page.getByText("既存8spでPR草案を作る",{exact:true}).count()),"removed duplicate links "+width);
  check(await page.locator("#marketing-handoff-pr-composer .mpr-draft-bar").innerText().then(t=>t.includes("接続済み")),"mock server marked ready "+width);
  const title=page.locator("#marketing-handoff-pr-composer .mpr-field").filter({hasText:"タイトル"}).locator("input").first();
  await title.fill("株式会社エイト、地域向けAI研修を提供開始");
  await page.getByRole("tab",{name:"2. 発表内容"}).click();
  await page.locator("#marketing-handoff-pr-composer .mpr-field").filter({hasText:"概要・リード文"}).locator("textarea").fill("地域の企業・住民向けに、AIを実践的に学ぶ講座を開催します。");
  await page.locator('[aria-label="特徴1の見出し"]').fill("実践型のカリキュラム");
  await page.getByRole("tab",{name:"4. 会社・問い合わせ"}).click();
  await page.locator("#marketing-handoff-pr-composer .mpr-field").filter({hasText:"メールアドレス"}).locator("input").fill("press@example.com");
  await page.getByRole("tab",{name:"5. 画像・仕上げ"}).click();
  check(await page.getByRole("button",{name:"下書き保存"}).isVisible(),"save in final tab "+width);
  check(await page.getByRole("button",{name:"プレビューを見る"}).isVisible(),"preview in final tab "+width);
  await page.getByRole("button",{name:"プレビューを見る"}).click();
  check(await page.locator("#marketing-handoff-pr-composer .mpr-preview").innerText().then(t=>t.includes("■ 会社概要")),"formatted PR preview "+width);
  check(!(await page.getByRole("button",{name:"内容を確認して本登録"}).isEnabled()),"register blocked before save "+width);
  await page.getByRole("button",{name:"下書き保存"}).click();
  await page.getByRole("button",{name:"内容を確認して本登録"}).waitFor();
  check(await page.getByRole("button",{name:"内容を確認して本登録"}).isEnabled(),"register only after saved "+width);
  await page.getByRole("button",{name:"内容を確認して本登録"}).click();
  await page.getByText("社内のPR原稿として本登録しました。").waitFor();
  const calls=await page.evaluate(()=>window.__prCalls.filter(x=>x.method==="POST"));
  check(calls.length===2&&calls[0].action==="save"&&calls[1].action==="register","ordered save then register "+width);
  check(!calls.some(x=>/publish|send|sns|blastmail/.test(x.path)),"no external publication "+width);
  await page.getByRole("tab",{name:"拡散する"}).click();
  check(await page.getByRole("button",{name:"Xでシェア"}).isVisible(),"manual X share available "+width);
  check(await page.getByRole("button",{name:"Instagram用リンクをコピー"}).isVisible(),"manual Instagram link available "+width);
  check(!errors.length,"browser JS errors absent "+width+": "+errors.join(" | "));
  await context.close();
 }
}finally{await browser.close();}
console.log("Marketing PR browser e2e: "+checks+" UI checks passed (mock only)");
