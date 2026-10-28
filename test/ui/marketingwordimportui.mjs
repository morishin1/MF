// Playwright: Word import stays entirely in the browser and never overwrites silently.
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {deflateRawSync} from "node:zlib";
import {launch} from "../_browser.mjs";
const abs=p=>fileURLToPath(new URL("../../"+p,import.meta.url));
function docx(xmlText){
 const name=Buffer.from("word/document.xml"),raw=Buffer.from(xmlText,"utf8"),compressed=deflateRawSync(raw);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
 local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);
 central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);
 central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);
 const cd=Buffer.concat([central,name]);const offset=local.length+name.length+compressed.length;
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);
 end.writeUInt16LE(1,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([local,name,compressed,cd,end]);
}
const esc=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const rows=[
 "株式会社エイト、地域AI講座を開講",
 "概要：地域の企業がAIを学びます。",
 "背景・目的",
 "地域に学ぶ機会が必要でした。",
 "特徴",
 "実践型：自分でAIの作品を制作します。",
 "今後の展望：全国の活動へつなげます。",
 "会社名：株式会社エイト",
 "Email：press@example.com"
];
const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+
rows.map(t=>'<w:p><w:r><w:t>'+esc(t)+'</w:t></w:r></w:p>').join("")+'</w:body></w:document>';
const browser=await launch();let checks=0;
const ok=(x,why)=>{assert.ok(x,why);checks++;};
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}});
  const page=await context.newPage();
  const errors=[];page.on("pageerror",e=>errors.push(String(e)));
  await page.setContent("<html><body class='marketing-app'><div id='app'></div></body></html>");
  for(const path of ["js/marketing-space-release-draft.js","js/marketing-word-import.js","js/marketing-word-import-ui.js","js/marketing-handoff-composer.js"])
   await page.addScriptTag({path:abs(path)});
  await page.addStyleTag({path:abs("css/marketing-word-import.css")});
  await page.evaluate(()=>{
   window.__calls=[];
   window.API={api:async(url,options={})=>{window.__calls.push({url,method:options.method||"GET"});
      if(url==="/api/marketing/pr-drafts"&&!options.method)return {ready:true,items:[]};
      throw Error("Unexpected write or external call: "+url);}};
   window.MarketingHandoffComposer.mount(document.getElementById("app"));
  });
  await page.locator(".mpr-tabs").waitFor();
  ok(await page.locator(".mpr-tabs [role=tab]").count()===5,"five PR entry tabs "+width);
  await page.locator(".mpr-field").filter({hasText:"タイトル"}).first().locator("input").fill("既存のタイトル");
  const picker=page.getByLabel("PR原稿のWordファイルを選択");
  await picker.setInputFiles({name:"pr-draft.docx",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",buffer:docx(xml)});
  await page.locator(".mpr-import-review-head").waitFor();
  ok((await page.locator(".mpr-import-review-head").innerText()).includes("pr-draft.docx"),"Word docx parsed locally "+width);
  const title=page.locator(".mpr-import-field").filter({hasText:"タイトル"}).first();
  ok(!(await title.locator('input[type=checkbox]').isChecked()),"existing title is protected "+width);
  const summary=page.locator(".mpr-import-field").filter({hasText:"概要・リード文"}).first();
  ok(await summary.locator('input[type=checkbox]').isChecked(),"empty summary is proposed "+width);
  ok((await page.locator(".mpr-import-original pre").count())===1,"original content retained for review "+width);
  await page.getByRole("button",{name:"選択した項目を入力欄に反映する"}).click();
  ok(await page.locator(".mpr-field").filter({hasText:"タイトル"}).first().locator("input").inputValue()==="既存のタイトル","no overwritten title "+width);
  await page.getByRole("tab",{name:"2. 発表内容"}).click();
  ok((await page.locator(".mpr-field").filter({hasText:"概要・リード文"}).locator("textarea").inputValue()).includes("地域の企業"),"summary populated "+width);
  ok((await page.locator('input[aria-label="特徴1の見出し"]').inputValue())==="実践型","feature populated "+width);
  const writes=await page.evaluate(()=>window.__calls.filter(x=>x.method!=="GET"));
  ok(writes.length===0,"import triggers no API write "+width);
  ok(errors.length===0,"no browser errors "+width+": "+errors.join(";"));
  await context.close();
 }
}finally{await browser.close();}
console.log("Marketing Word local import browser: "+checks+" checks passed.");
