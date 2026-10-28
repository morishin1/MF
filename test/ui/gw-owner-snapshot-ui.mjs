// Dedicated synthetic UI test. Does not use live GW, stored sessions, or real mail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launch } from "../_browser.mjs";
const html=readFileSync(new URL("../../admin-nippo.html",import.meta.url),"utf8");
const browser=await launch();let pass=0,fail=0;
async function test(name,fn){try{await fn();console.log("ok",name);pass++;}catch(e){console.error("NG",name,e.message);fail++;}}
async function open({owner=true,email="s_morita@gw.8grp.co.jp",width=1200}={}){
 const page=await browser.newPage({viewport:{width,height:850}});
 const bootstrap=`window.__calls=[];window.__mode='accepted';window.API={
  api:async(path,options)=>{window.__calls.push({path,options});if(window.__mode==='pending')await new Promise(r=>window.__resolve=r);
   if(window.__mode==='unknown')throw {code:'dispatch_result_unknown'};
   if(window.__mode==='unconfigured')throw {hint:'初期設定がまだ完了していません。SQL・固定設定の確認後に使えます。'};
   return {status:window.__mode==='duplicate'?'duplicate_suppressed':'accepted'};},
  nippoWeek:async()=>{throw new Error('not under test');},nippoAdmin:async()=>{throw new Error('not under test');}
 };window.KPLayout={init:async()=>({me:{email:${JSON.stringify(email)},gw:{roles:${JSON.stringify(owner?["owner"]:["staff"])}}}})};`;
 await page.route("**/*",async route=>{const path=new URL(route.request().url()).pathname;
  if(path==="/admin-nippo.html")return route.fulfill({contentType:"text/html",body:html});
  if(path==="/js/api-client.js")return route.fulfill({contentType:"application/javascript",body:bootstrap});
  if(path.endsWith(".css"))return route.fulfill({contentType:"text/css",body:'.hidden{display:none!important}.wrap{max-width:1100px;margin:20px auto;padding:0 12px}button{padding:10px;font-size:16px}'});
  return route.fulfill({contentType:"application/javascript",body:""});});
 await page.goto("http://127.0.0.1:8713/admin-nippo.html");await page.waitForFunction(()=>window.KPLayout&&typeof createOwnerFeedback==='function');return page;
}
try{
 await test("configured representative sees one button; action uses fixed empty POST and no browser secret",async()=>{
  const p=await open();assert.equal(await p.locator('#owner-feedback-create').isVisible(),true);await p.locator('#owner-feedback-create').click();
  await p.waitForFunction(()=>document.getElementById('owner-feedback-status').textContent.includes('受け付けました'));
  assert.deepEqual(await p.evaluate(()=>window.__calls),[{path:'/api/nippo/owner-snapshot',options:{method:'POST',body:{}}}]);
  assert.match(await p.locator('#owner-feedback-status').textContent(),/まだ確認していません.*未送信/);await p.close();
 });
 await test("rapid repeated calls are suppressed while pending",async()=>{
  const p=await open();await p.evaluate(()=>{window.__mode='pending';const b=document.getElementById('owner-feedback-create');createOwnerFeedback(b);createOwnerFeedback(b);});
  assert.equal(await p.evaluate(()=>window.__calls.length),1);assert.equal(await p.locator('#owner-feedback-create').isDisabled(),true);
  await p.evaluate(()=>{window.__mode='accepted';window.__resolve();});await p.waitForFunction(()=>!document.getElementById('owner-feedback-create').disabled);await p.close();
 });
 await test("unknown and duplicate states never claim delivered or auto-retry",async()=>{
  const p=await open();await p.evaluate(()=>window.__mode='unknown');await p.locator('#owner-feedback-create').click();await p.waitForFunction(()=>document.getElementById('owner-feedback-status').textContent.includes('結果が不明'));
  assert.equal(await p.evaluate(()=>window.__calls.length),1);assert.match(await p.locator('#owner-feedback-status').textContent(),/自動再送しません/);
  await p.evaluate(()=>window.__mode='duplicate');await p.locator('#owner-feedback-create').click();await p.waitForFunction(()=>document.getElementById('owner-feedback-status').textContent.includes('重複送信しません'));await p.close();
 });
 await test("unconfigured explanation appears without false completion",async()=>{
  const p=await open();await p.evaluate(()=>window.__mode='unconfigured');await p.locator('#owner-feedback-create').click();await p.waitForFunction(()=>document.getElementById('owner-feedback-status').textContent.includes('初期設定'));assert.equal(await p.evaluate(()=>window.__calls.length),1);await p.close();
 });
 await test("non-owner and different owner are hidden",async()=>{
  for(const opts of [{owner:false},{owner:true,email:'other@example.com'}]){const p=await open(opts);assert.equal(await p.locator('#owner-feedback-create').isVisible(),false);assert.equal(await p.evaluate(()=>window.__calls.length),0);await p.close();}
 });
 await test("mobile button and explanatory text fit viewport",async()=>{
  const p=await open({width:390});const box=await p.locator('#owner-feedback-create').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=390);assert.equal(await p.locator('#owner-feedback-status').getAttribute('aria-live'),'polite');await p.close();
 });
}finally{await browser.close();}
console.log(`${pass} passed, ${fail} failed`);if(fail)process.exit(1);
