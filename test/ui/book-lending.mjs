import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";

const browser = await launch();
try {
  const ctx = await browser.newContext();
  await ctx.route(/https:\/\/fonts\./, route => route.abort());
  const title = "栢木先生のITパスポート教室 平成30年度";
  const isbn = "9784774193243";
  let failLookup = false;
  const books = [{id:"11111111-1111-4111-8111-111111111111",copy_no:1,title,isbn,revision:1,confirmed:false,loan:null}];
  const loans = [];
  const xml = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcndl="http://ndl.go.jp/dcndl/terms/"><channel><item><title>${title}</title><dc:publisher>技術評論社</dc:publisher><dcterms:issued>2017</dcterms:issued><dc:identifier xsi:type="dcndl:ISBN">978-4-7741-9324-3</dc:identifier></item></channel></rss>`;
  await ctx.route(/\/js\/layout\.js(\?|$)/, route => route.fulfill({contentType:"application/javascript",body:`window.KPLayout={init:async()=>({}),infoTabs:()=>"",esc:s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))};`}));
  await ctx.route(/\/js\/device\.js(\?|$)/, route => route.fulfill({contentType:"application/javascript", body:""}));
  await ctx.route(/\/js\/api-client\.js(\?|$)/, route => route.fulfill({contentType:"application/javascript",body:`window.API={devices:async()=>{throw Error("devices")},devicePeople:async()=>{throw Error("people")},listLibrary:async()=>({documents:[]}),api:async(url,options={})=>{const r=await fetch(url,{method:options.method||"GET",headers:{"content-type":"application/json"},body:options.body?JSON.stringify(options.body):undefined});const data=await r.json();if(!r.ok){const e=new Error(data.message);e.status=r.status;throw e;}return data;}};`}));
  await ctx.route("**/api/book-lending*", async route=>{
    const url=new URL(route.request().url()), q=url.searchParams;
    const respond=(json,status=200)=>route.fulfill({json,status});
    if(route.request().method()==="GET"){
      if(q.has("lookup"))return failLookup?respond({message:"検索できませんでした。ISBNを手入力できます。"},503):respond({xml});
      if(q.has("history")) return respond({loans:loans.filter(l=>l.book_id===q.get("history"))});
      return respond({books:q.has("manage")?books:books.filter(b=>b.confirmed&&!b.loan).map(b=>({title:b.title,isbn:b.isbn,copies:1}))});
    }
    const b=route.request().postDataJSON();
    const book=books.find(x=>x.id===b.bookId);
    if(b.action==="register") books.push({id:b.bookId,copy_no:books.length+1,title:b.title,isbn:b.isbn,confirmed:true,revision:1,loan:null});
    if(b.action==="confirm"){book.confirmed=true;book.revision++;}
    if(b.action==="lend"){book.loan={id:b.loanId,book_id:b.bookId,borrower_name:b.borrower,loaned_on:b.date,returned_on:null};loans.push(book.loan);}
    if(b.action==="return"){book.loan.returned_on=b.date;book.loan=null;}
    return respond({ok:true});
  });
  const admin=await ctx.newPage();
  const errors=[]; admin.on("pageerror",e=>errors.push(e.message));
  const member=await ctx.newPage();
  await admin.goto(BASE + "/admin-devices.html#books",{waitUntil:"domcontentloaded"});
  await member.goto(BASE + "/library.html#books",{waitUntil:"domcontentloaded"});
  const row=admin.locator(".books-table tr").filter({hasText:title});
  const dialog=admin.getByRole("dialog");
  await member.getByText("現在、貸出可能な書籍はありません。").waitFor();
  await row.getByRole("button",{name:"現物を確認"}).click();
  await dialog.getByRole("button",{name:"書名からISBNを検索"}).click();
  await dialog.getByRole("button",{name:/技術評論社.*2017/}).click();
  assert.equal(await dialog.getByLabel("ISBN",{exact:true}).inputValue(),isbn);
  await dialog.getByRole("button",{name:"確認して貸出可にする"}).click();
  await row.getByText("貸出可",{exact:true}).waitFor();
  await admin.getByRole("searchbox",{name:"書名・ISBNで検索"}).fill("９７８－４－７７４１－９３２４－３");
  await row.getByRole("button",{name:"貸出",exact:true}).click();
  await dialog.getByLabel("借りる方の氏名").fill("テスト 太郎");
  await dialog.getByLabel("貸出日").fill("2025-12-01");
  await dialog.getByRole("button",{name:"貸出を記録",exact:true}).click();
  await row.getByText("貸出中",{exact:true}).waitFor();
  await row.getByRole("button",{name:"返却",exact:true}).click();
  await dialog.getByLabel("返却日").fill("2025-12-02");
  await dialog.getByRole("button",{name:"返却を記録",exact:true}).click();
  await row.getByText("貸出可",{exact:true}).waitFor();
  await row.getByRole("button",{name:"履歴",exact:true}).click();
  await dialog.getByText("2025-12-02").waitFor();
  await dialog.getByRole("button",{name:"閉じる"}).click();
  await member.reload({waitUntil:"domcontentloaded"});
  await member.getByText("1冊",{exact:true}).waitFor();
  assert(!(await member.locator("#book-list").innerText()).includes("テスト 太郎"));
  await member.setViewportSize({width:390,height:844});
  assert(await member.locator("body").evaluate(el=>el.scrollWidth<=400));
  failLookup=true;
  await admin.getByRole("button",{name:"書籍を登録",exact:true}).click();
  await dialog.getByLabel("書名（年度・版を含む）").fill("2冊目");
  await dialog.getByRole("button",{name:"書名からISBNを検索"}).click();
  await dialog.getByText(/手入力できます/).waitFor();
  await dialog.getByLabel("ISBN",{exact:true}).fill("978-4-7741-9324-9");
  await dialog.getByRole("button",{name:"確認して貸出可にする"}).click();
  await dialog.getByText("ISBNの桁数と数字を確認してください。").waitFor();
  await dialog.getByLabel("ISBN",{exact:true}).fill(isbn);
  await dialog.getByRole("button",{name:"確認して貸出可にする"}).click();
  await admin.getByText("登録しました。",{exact:true}).waitFor();
  assert.equal(books.length,2);
  await admin.getByRole("button",{name:"社員",exact:true}).click();
  assert(await admin.locator("#p-books").isHidden());
  assert.deepEqual(errors,[]);
  console.log("Desktop and mobile catalogue, filters, edition selection, manual fallback, check-out, return and loan history passed.");
} finally { await browser.close(); }

