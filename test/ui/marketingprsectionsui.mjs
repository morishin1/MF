// Marketing PR 作成：自由セクション（本文の追加）と本文への写真の割り当てを、実際のブラウザで通す。
// 架空の API だけを使う（実データ・画像アップロード・外部送信なし）。
//   ・「2. 発表内容」でセクションを追加 → 見出し・本文を入れる → 「5. 画像・仕上げ」で選んだ写真を割り当てる
//   ・プレビューに見出し（HTML として実行しない）・本文・写真が出る
//   ・下書きに入るのは、文字と写真への参照（UUID）・画像原本の ID だけ。画像の URL（blob:）やファイル本体は入れない
//   ・画像の本体は、下書き保存のときに非公開の画像保存（/api/marketing/pr-images）へ1回だけ送る（架空の API）
import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=", "base64");
const browser = await launch();
let checks = 0;
const check = (v, n) => { assert.ok(v, n); checks++; console.log("ok", n); };
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, timezoneId: "Asia/Tokyo" });
    await context.addInitScript(() => { window.__prCalls = []; window.__pr = { items: [] }; });
    await context.route("**/js/api-client.js*", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: `
      window.API={isLoggedIn:()=>true,api:async(path,options)=>{
        const op=options||{};
        window.__prCalls.push({path,method:op.method||"GET",body:op.body?JSON.parse(JSON.stringify(op.body)):null});
        if(path==="/api/marketing?view=work")return {sources:[],items:[],readsReady:true,unreadCount:0,newCount:0,openCount:0};
        if(path==="/api/marketing?view=production")return {today:"2026-10-29",sources:[{key:"site_news",state:"ok",count:0},{key:"plan",state:"ok",count:0}],items:[],videoSites:[],employees:[],canManageSite:true,canLinkInquiries:true};
        if(path==="/api/marketing/pr-drafts"){
          if(!op.method)return {ready:true,items:window.__pr.items};
          const input=op.body;
          if(input.action==="save"){
            const obj={id:"a0000000-0000-4000-8000-000000000001",version:input.version?input.version+1:1,status:"draft",registeredAt:null,
              payload:input.payload,createdAt:"2026-10-29T00:00:00Z",updatedAt:"2026-10-29T00:00:00Z"};
            window.__pr.items=[obj];return {ready:true,item:obj};
          }
        }
        if(path==="/api/marketing/pr-images"&&op.method==="POST")return {imageId:op.body.imageId,size:42,mime:"image/png"};
        throw Error("unexpected api: "+path);
      }};
    ` }));
    await context.route("**/js/marketing-layout.js*", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: `
      window.MarketingLayout={init:async()=>({me:{access:{marketing:true}}}),
        esc:s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),
        fmt:s=>s||"",fmtDay:s=>s||"",pill:(label)=>"<span>"+String(label)+"</span>"};
    ` }));
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    let alerted = false; page.on("dialog", (d) => { alerted = true; d.dismiss(); });
    await page.goto(BASE + "/marketing/?step=pr");
    const C = page.locator("#marketing-handoff-pr-composer");
    await C.locator(".mpr-tabs").waitFor();
    await C.locator(".mpr-field").filter({ hasText: "タイトル" }).locator("input").first().fill("架空：地域向けAI研修の開始");

    // 2. 発表内容：セクションを追加
    await page.getByRole("tab", { name: "2. 発表内容" }).click();
    await C.locator(".mpr-field").filter({ hasText: "概要・リード文" }).locator("textarea").fill("架空の講座の告知文です。");
    await page.locator('[aria-label="特徴1の見出し"]').fill("実践型のカリキュラム");
    await page.getByRole("button", { name: "＋ 本文セクションを追加" }).click();
    await page.locator('[aria-label="追加セクション1の見出し"]').fill('<img src=x onerror=alert(1)>見出し');
    await page.locator('[aria-label="追加セクション1の本文"]').fill("自由に書いた本文です。");
    check(await page.locator('[aria-label="追加セクション1の写真"] option').count() === 1, "写真を選ぶ前は「写真なし」だけ " + width);

    await page.getByRole("tab", { name: "4. 会社・問い合わせ" }).click();
    await C.locator(".mpr-field").filter({ hasText: "メールアドレス" }).locator("input").fill("press@example.com");

    // 5. 画像・仕上げ：写真を選ぶ（この画面内のプレビューだけ）
    await page.getByRole("tab", { name: "5. 画像・仕上げ" }).click();
    await page.locator('[aria-label="掲載画像を選択"]').setInputFiles({ name: "kakuu.png", mimeType: "image/png", buffer: PNG });
    await page.locator('[aria-label="画像1の説明"]').fill("架空の写真の説明");

    // 2. に戻って、写真をセクションへ割り当てる
    await page.getByRole("tab", { name: "2. 発表内容" }).click();
    await page.locator('[aria-label="追加セクション1の写真"]').selectOption({ label: "kakuu.png" });
    await page.getByRole("button", { name: "＋ 本文セクションを追加" }).click();
    await page.locator('[aria-label="追加セクション2の見出し"]').fill("二つ目");
    await page.getByRole("button", { name: "上へ" }).click();
    check((await page.locator('[aria-label="追加セクション1の見出し"]').inputValue()) === "二つ目", "上へで並べ替え " + width);
    await page.getByRole("button", { name: "下へ" }).first().click();
    check((await page.locator('[aria-label="追加セクション1の本文"]').inputValue()) === "自由に書いた本文です。", "下へで元の順 " + width);

    // プレビュー
    await page.getByRole("tab", { name: "5. 画像・仕上げ" }).click();
    await page.getByRole("button", { name: "プレビューを見る" }).click();
    const sec = C.locator(".mpr-body-section").first();
    await sec.waitFor();
    check((await sec.locator("h4").innerText()) === "<img src=x onerror=alert(1)>見出し", "見出しは文字として出る（HTML にしない） " + width);
    check((await sec.innerText()).includes("自由に書いた本文です。"), "本文が出る " + width);
    check(await sec.locator("img").count() === 1 && (await sec.locator("img").getAttribute("src")).startsWith("blob:"), "割り当てた写真が本文に出る（この画面内の表示） " + width);
    check(await C.locator(".mpr-body-section").count() === 2, "セクションは2つ " + width);
    check(!alerted, "見出しの HTML は実行されない " + width);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "横にはみ出さない " + width);

    // 保存：文字と参照だけ
    await page.getByRole("button", { name: "下書き保存" }).click();
    await page.getByText("下書きを保存しました。").waitFor();
    const calls = await page.evaluate(() => window.__prCalls);
    const saves = calls.filter((x) => x.method === "POST");
    const order = saves.map((x) => (x.path === "/api/marketing/pr-images" ? "image" : x.body.action)).join(",");
    check(order === "save,image,save", "新しい原稿は 保存→画像の保存→保存 の順（いま " + order + "） " + width);
    const up = saves.find((x) => x.path === "/api/marketing/pr-images");
    check(up.body.action === "upload" && up.body.draftId === "a0000000-0000-4000-8000-000000000001" && up.body.base64.length > 0, "画像の本体は画像保存へ送る " + width);
    const last = saves.filter((x) => x.path === "/api/marketing/pr-drafts").at(-1);
    const d = last.body.payload.draft;
    check(d.sections.length === 2 && d.sections[0].body === "自由に書いた本文です。" && d.sections[1].title === "二つ目", "セクションが保存内容に入る " + width);
    check(/^[0-9a-f-]{36}$/.test(d.sections[0].imageKey) && d.images[0].key === d.sections[0].imageKey, "写真は参照（UUID）で結ぶ " + width);
    check(/^[0-9a-f-]{36}$/.test(d.images[0].imageId) && !("url" in d.images[0]) && !("base64" in d.images[0]), "下書きの画像は原本の ID だけ（URL・本体なし） " + width);
    check(!saves.filter((x) => x.path === "/api/marketing/pr-drafts").some((x) => JSON.stringify(x.body).includes("blob:") || JSON.stringify(x.body).includes(up.body.base64)), "下書きに blob: や画像の本体を入れない " + width);
    check(calls.filter((x) => x.path === "/api/marketing/pr-images").length === 1, "画像の保存は1回だけ " + width);
    check(!calls.some((x) => /publish|send|sns|blastmail/.test(x.path)), "外部への送信は呼ばない " + width);

    // 写真を原稿から外すと、セクションの参照も外れる
    await page.getByRole("button", { name: "入力画面へ戻る" }).click();
    await page.getByRole("tab", { name: "5. 画像・仕上げ" }).click();
    await page.getByRole("button", { name: "原稿から外す" }).click();
    await page.getByRole("tab", { name: "2. 発表内容" }).click();
    check((await page.locator('[aria-label="追加セクション1の写真"]').inputValue()) === "", "写真を外すとセクションの写真も「なし」 " + width);
    check(!errors.length, "ブラウザの JS エラーなし " + width + ": " + errors.join(" | "));
    await context.close();
  }
  console.log(`Marketing PR 自由セクション・本文の写真：${checks} checks passed（架空の API のみ）`);
} finally {
  await browser.close();
}
