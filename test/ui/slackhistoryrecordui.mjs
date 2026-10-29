// Owner-session receipt form in a real browser; synthetic APIs only.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {accessOf} from '../../lib/gw.js';
const browser=await launch();let count=0;
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),posts=[];let result='unknown';
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'fixture@example.test'})));
  await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(BASE).origin?route.continue():route.abort());
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(url.pathname==='/api/me')return send({email:'fixture@example.test',appRole:'member',gw:{employee:{id:'fixture',display_name:'確認用'},roles:['owner'],tenantId:'fixture'},access:accessOf({roles:['owner']})});
   if(url.pathname==='/api/slack-history'){
    if(req.method()==='POST'){posts.push(JSON.parse(req.postData()));return result==='unknown'?route.abort():send({ok:true});}
    return send({ready:true,history:[]});
   }
   if(req.method()!=='GET')throw Error('Unexpected write '+url.pathname);
   return send({});
  });
  try{
   await page.goto(BASE+'/slack-history-record.html?department=hr');await page.locator('#receipt-form').waitFor({state:'visible'});
   for(const [id,value]of Object.entries({'receipt-link':'https://8grp.slack.com/archives/C0CCSBTDB1S/p1793242800000000','receipt-summary':'架空の送信済み非機密要約','receipt-date':'2026-10-29','receipt-start':'2026-10-29T08:00:00+09:00','receipt-end':'2026-10-29T11:00:00+09:00'}))await page.locator('#'+id).fill(value);
   assert.equal(await page.locator('#receipt-ts').inputValue(),'1793242800.000000');count++;
   assert.equal(await page.locator('#receipt-sent').inputValue(),'2026-10-29T03:00:00.000Z');count++;
   await page.locator('#receipt-confirm-sent').check();await page.locator('#receipt-confirm-safe').check();
   await page.getByRole('button',{name:'送信済み投稿を記録する',exact:true}).click();await page.getByText(/保存結果が不明です/).waitFor();
   assert.equal(posts.length,1);count++;assert.equal(posts[0].department,'hr');count++;assert.equal(posts[0].source,'hr-mailbox');count++;
   assert.equal(await page.locator('#receipt-submit').isDisabled(),true);count++;
   await page.getByRole('button',{name:'保存結果を履歴で確認する'}).click();await page.getByText(/この表示範囲では同じ記録を確認できません/).waitFor();
   assert.equal(posts.length,1);count++;assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));count++;
  }finally{await context.close();}
 }
 console.log(`Owner receipt browser ${count}/${count} PASS (synthetic only)`);
}finally{await browser.close();}
