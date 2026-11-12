// Synthetic-only browser regression; no real applicants or external writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launch} from '../_browser.mjs';
const browser=await launch();
try {
 const page=await browser.newPage();
 const people=Array.from({length:52},(_,i)=>({id:`spot-${i}`,name:`人材${i}`,source:'テスト',worked_on:'2026-11-12',status:'closed',applicant_id:null}));
 people.push({id:'moved',name:'移動済み',source:'テスト',status:'converted',applicant_id:'applicant-1'});
 const requests=[];
 await page.route('**/*',async route=>{
  if(route.request().url()==='https://spot.test/hr/spot.html')return route.fulfill({contentType:'text/html',body:readFileSync(new URL('../../hr/spot.html',import.meta.url),'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g,'')});
  return route.abort();
 });
 await page.exposeFunction('testRequest',body=>{requests.push(body);return {changed:body.ids.length};});
 await page.addInitScript(({people})=>{
  window.HRLayout={init:async()=>({})};
  window.API={api:async(url,opts)=>opts?window.testRequest(opts.body):url==='/api/hr/spot'?{people}:{applicants:[]}};
 },{people});
 await page.goto('https://spot.test/hr/spot.html');
 const a=page.locator('[data-check="spot-0"]'),b=page.locator('[data-check="spot-1"]');
 await a.check();await b.check();assert.equal(await page.locator('#selectedCount').innerText(),'2件選択');
 assert.equal(await a.isChecked(),true);assert.equal(await b.isChecked(),true);
 await a.uncheck();assert.equal(await b.isChecked(),true);
 assert.equal(await page.locator('[data-check="moved"]').isDisabled(),true);
 assert.match(await page.locator('.bulkbar').innerText(),/選考へ移動済み.*対象外/);
 await page.locator('#query').fill('人材2');assert.equal(await page.locator('#selectedCount').innerText(),'0件選択');
 await page.locator('#query').fill('');await a.check();await b.check();
 page.once('dialog',d=>d.dismiss());await page.locator('#bulkClosed').click();assert.equal(requests.length,0);
 assert.equal(await a.isChecked(),true);assert.equal(await b.isChecked(),true);
 page.once('dialog',d=>d.accept());await page.locator('#bulkClosed').click();
 await page.waitForFunction(()=>document.querySelector('#selectedCount').textContent==='0件選択');
 assert.deepEqual(requests[0],{action:'bulk',bulkAction:'closed',ids:['spot-0','spot-1']});
 await page.locator('#selectAll').check();assert.equal(await page.locator('#selectedCount').innerText(),'50件選択');
 assert.equal(await page.locator('[data-check="moved"]').isChecked(),false);
 await page.locator('[data-check="spot-51"]').click();assert.equal(await page.locator('[data-check="spot-51"]').isChecked(),false);
 await a.uncheck();await page.locator('[data-check="spot-51"]').check();assert.equal(await page.locator('#selectedCount').innerText(),'50件選択');
 await page.locator('#clearSelection').click();assert.equal(await page.locator('#selectedCount').innerText(),'0件選択');
 assert.equal(requests.length,1,'selection alone never writes');
 console.log('HR spot multi-selection, filters, 50-row limit, protection and exact bulk target OK');
} finally {await browser.close();}
