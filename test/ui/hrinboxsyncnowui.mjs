// Retired Gmail-sync control: the replacement can refresh history only. The old
// HMAC/manual-sync backend regressions are retained unchanged in Node API tests.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {historyFixture,openHistory,deferred} from '../fixtures/slack-history-browser.js';
const browser=await launch();let count=0;const check=(v,label)=>{assert.ok(v,label);count++;};
const fx=historyFixture(),{context,page}=await openHistory(browser,BASE,fx);
try{
 await page.getByText('送信済み 1件',{exact:true}).waitFor();
 check(await page.locator('#syncNow').count()===0,'Gmail sync button removed');
 const button=page.getByRole('button',{name:'履歴を更新'});
 fx.gate=deferred();const gate=fx.gate,before=fx.gets;
 await button.click();await page.getByText('送信済みの履歴を確認しています…',{exact:true}).waitFor();
 check(await button.isDisabled(),'pending disabled');check(await page.locator('.slack-history-card').count()===0,'old rows removed while loading');
 await button.dispatchEvent('click');await button.dispatchEvent('click');
 await page.waitForTimeout(80);check(fx.gets===before+1,'double-click and synthetic click no duplicate GET');
 gate.release();fx.gate=null;await page.getByText('送信済み 1件',{exact:true}).waitFor();check(await button.isEnabled(),'released after success');
 for(const [status,pattern] of [[503,/Slack通知履歴は準備中/],[500,/通知履歴を取得できませんでした/],[403,/閲覧する権限がありません/]]){
  fx.status=status;const previous=fx.gets;await button.click();await page.getByText(pattern).waitFor();
  check(await page.locator('.slack-history-card').count()===0,'failure clears old success');
  check(!(await page.locator('#slack-history-state').textContent()).includes('0件'),'failure not zero');
  await page.waitForTimeout(80);check(fx.gets===previous+1,'failure never automatically retries');check(await button.isEnabled(),'manual refresh available');
 }
 fx.status=200;fx.ready=false;await button.click();await page.getByText(/Slack通知履歴は準備中/).waitFor();check(await page.locator('.slack-history-card').count()===0,'ready=false hides rows');
 fx.ready=true;fx.history[0].summary='復旧を確認した履歴';await button.click();await page.getByText('復旧を確認した履歴',{exact:true}).waitFor();check(await button.isEnabled(),'manual recovery succeeds');
 check(!fx.calls.some(c=>c.path.startsWith('/api/hr/inbox')||c.method!=='GET'),'no import sync or write through recovery');
 assert.deepEqual(fx.errors,[]);count++;
 console.log(`HR history read-only refresh ${count}/${count} PASS (synthetic browser)`);
}finally{await context.close();await browser.close();}
