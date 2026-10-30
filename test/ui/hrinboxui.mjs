// The former inbox URL now displays Slack notification history. Legacy mail/API
// regression coverage remains in hrinboxapi, hrinboxtext and hr-inbox-* suites.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {historyFixture,openHistory} from '../fixtures/slack-history-browser.js';
const browser=await launch();let count=0;
const check=(v,label)=>{assert.ok(v,label);count++;};
try{
 for(const width of [1280,390]){
  const fx=historyFixture(),{context,page}=await openHistory(browser,BASE,fx,width);
  try{
   await page.getByText('送信済み 1件',{exact:true}).waitFor();
   check(await page.getByRole('heading',{name:'Slack通知履歴',exact:true}).isVisible(),'replacement heading');
   check(await page.getByRole('button',{name:'履歴を更新'}).isVisible(),'history refresh');
   check(await page.locator('#syncNow,#importBtn,#inList,#openCount').count()===0,'retired intake controls absent');
   check(await page.getByRole('button',{name:/Gmail|取り込|応募者.*登録/}).count()===0,'no import/registration actions');
   check(await page.locator('.slack-history-card').count()===1,'one sent row');
   check((await page.locator('.slack-history-meta').allTextContents()).join(' ').includes('JST'),'timezone explicit');
   check(await page.locator('.slack-history-card a').getAttribute('target')==='_blank','Slack separate tab');
   check((await page.locator('.slack-history-card a').getAttribute('rel')).includes('noreferrer'),'no referrer');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
   fx.history[0].coverage_status='unavailable';fx.history[0].coverage_note='取得できない情報があります';fx.history[0].summary='<img src=x onerror=alert(1)> 本文';
   await page.getByRole('button',{name:'履歴を更新'}).click();await page.getByText('送信済み 1件',{exact:true}).waitFor();
   check((await page.locator('.slack-history-warning').textContent()).includes('未確認'),'unavailable not complete');
   check((await page.locator('.slack-history-warning').textContent()).includes(fx.history[0].coverage_note),'coverage note');
   check(await page.locator('.slack-history-summary img').count()===0,'summary HTML never executes');
   check((await page.locator('.slack-history-summary').textContent()).includes('<img'),'plain text retained');
   for(const bad of ['https://evil.example/','javascript:alert(1)','https://8grp.slack.com/archives/C0CCLMUQZ7G/p1793242800000000']){
    fx.history[0].slack_permalink=bad;await page.getByRole('button',{name:'履歴を更新'}).click();await page.getByText('投稿リンクを確認できません。',{exact:true}).waitFor();
    check(await page.locator('.slack-history-card a').count()===0,'unsafe/other-department link rejected');
   }
   for(const change of [{department:'office'},{status:'failed'},{sent_at:null}]){
    fx.history=[{...historyFixture().history[0],...change}];await page.getByRole('button',{name:'履歴を更新'}).click();await page.getByText(/通知履歴を取得できませんでした/).waitFor();
    check(await page.locator('.slack-history-card').count()===0,'other department/unsent response rejected');
   }
   fx.history=[];await page.getByRole('button',{name:'履歴を更新'}).click();await page.getByText(/送信済みのSlack通知履歴はまだありません/).waitFor();
   check((await page.locator('#slack-history-state').textContent()).includes('確認が完了したことを意味'),'no rows does not mean mailbox clear');
   check(!fx.calls.some(c=>c.path.startsWith('/api/hr/inbox')||c.method!=='GET'),'no retired intake API or write');
   assert.deepEqual(fx.errors,[]);count++;
  }finally{await context.close();}
 }
 console.log(`HR Slack history replacement UI ${count}/${count} PASS (synthetic 1280/390px)`);
}finally{await browser.close();}
