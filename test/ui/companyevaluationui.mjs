// Real company-evaluation panel + module, synthetic APIs only. No external requests or writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch,jstToday} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const html=readFileSync(resolve(root,'sales/index.html'),'utf8');
const start=html.indexOf('<details class="db-sec" id="company-evaluation-panel">');
const end=html.indexOf('<div class="db-sum"',start);
assert(start>=0&&end>start,'real dashboard panel must exist');
const fixture={note:'同期確認済み・参考',window:{since:new Date(Date.now()-86400000*89).toISOString(),until:new Date().toISOString()},complete:true,unmappedCount:0,companies:[{companyName:'検証用企業',sentCount:15,meetingCount:0,qualifiedCount:10,review:{status:'candidate',actions:['review_blast_only']}}]};
const browser=await launch();
try{
for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'});
 const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());requests.push({method:req.method(),url:req.url()});
  assert.equal(req.method(),'GET','No HTTP writes');
  if(url.host!=='evaluation.test')return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/app.css"><body>${html.slice(start,end)}<script>window.calls=[];window.pending=[];window.fixture=${JSON.stringify(fixture)};window.mode='ok';window.detailStatus=0;window.detailFixture={company:{id:'company-1',name:'保存検証企業'},current:null,canConfirm:true,history:[]};window.API={api:(...args)=>{calls.push(args);if(args[0].startsWith('/api/sales/company-evaluations/detail')){if(args[1]?.method==='POST'){if(detailStatus)return Promise.reject({status:detailStatus,hint:'入力または保存結果を確認'});const b=args[1].body;const revision=String(BigInt(detailFixture.current?.revision||'0')+1n);const evaluation={...b,score:0};detailFixture.current={revision,evaluation};detailFixture.history.unshift({revision,evaluation,created_at:new Date().toISOString()});return Promise.resolve({status:'saved'});}return Promise.resolve(structuredClone(detailFixture));}if(mode==='defer')return new Promise((resolve,reject)=>pending.push({resolve,reject}));if(mode==='error')return Promise.reject({data:{hint:'取得失敗の検証'}});return Promise.resolve(fixture)}};</script><script type="module" src="/js/company-evaluation.js"></script><script type="module" src="/js/company-evaluation-editor.js"></script></body></html>`});
  if(['/js/company-evaluation.js','/js/company-evaluation-editor.js','/lib/company-evaluation-policy.js','/css/app.css'].includes(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.js')?'application/javascript':'text/css',body:readFileSync(resolve(root,'.'+url.pathname))});
  return route.abort();
 });
 await page.goto('https://evaluation.test/');
 await page.waitForFunction(()=>document.querySelectorAll('#company-evaluation-axes input').length===15);
 assert.equal(await page.evaluate(()=>calls.length),0,'Collapsed panel must not fetch');
 await page.locator('#company-evaluation-panel > summary').click();
 await page.getByRole('cell',{name:'検証用企業',exact:true}).waitFor();
 assert.equal(await page.getByRole('cell',{name:'未評価',exact:true}).count(),1);
 await page.getByText('根拠を入力して配点を試算（保存しません）',{exact:true}).click();
 await page.getByRole('button',{name:'試算する',exact:true}).click();
 assert.match(await page.locator('#company-evaluation-preview-result').textContent(),/^未評価/);
 const before=await page.evaluate(()=>calls.length);
 const axes=[['outcomes',30],['response',20],['reasons',20],['profitability',20],['reliability',10]];
 for(const [key]of axes){await page.locator(`[name="${key}-points"]`).fill('0');await page.locator(`[name="${key}-date"]`).fill(jstToday());await page.locator(`[name="${key}-evidence"]`).fill('<img src=x onerror="window.xss=1">根拠');}
 await page.getByRole('button',{name:'試算する',exact:true}).click();
 assert.match(await page.locator('#company-evaluation-preview-result').textContent(),/0 \/ 100点 → D候補.*未保存・未確定.*改善協議.*管理者/);
 assert.equal(await page.evaluate(()=>calls.length),before,'Trial must not call API');
 assert.equal(await page.evaluate(()=>window.xss),undefined);
 for(const [key,max]of axes)await page.locator(`[name="${key}-points"]`).fill(String(max));
 await page.getByRole('button',{name:'試算する',exact:true}).click();assert.match(await page.locator('#company-evaluation-preview-result').textContent(),/100 \/ 100点 → A候補/);
 await page.locator('[name="response-points"]').fill('');await page.getByRole('button',{name:'試算する',exact:true}).click();assert.match(await page.locator('#company-evaluation-preview-result').textContent(),/^未評価.*返信速度/);
 await page.locator('[name="response-points"]').fill('20');await page.locator('[name="response-date"]').fill(jstToday(-100));await page.getByRole('button',{name:'試算する',exact:true}).click();assert.match(await page.locator('#company-evaluation-preview-result').textContent(),/^未評価/);
 // HTML in company names and API notes must remain text, not executable markup.
 await page.evaluate(()=>{fixture.note='<img src=x onerror="window.xss=2">';fixture.companies[0].companyName='<svg onload="window.xss=3">';});
 await page.locator('#company-evaluation-refresh').click();await page.waitForFunction(()=>document.querySelector('#company-evaluation-results').textContent.includes('<svg'));
 assert.equal(await page.locator('#company-evaluation-results img,#company-evaluation-results svg').count(),0);assert.equal(await page.evaluate(()=>window.xss),undefined);
 await page.evaluate(()=>{mode='error'});await page.locator('#company-evaluation-refresh').click();await page.getByText('取得失敗の検証',{exact:true}).waitFor();
 // Newer refresh wins regardless of success/failure order of the old request.
 await page.evaluate(()=>{mode='defer';pending=[]});await page.locator('#company-evaluation-refresh').click();await page.locator('#company-evaluation-refresh').click();
 await page.evaluate(()=>pending[1].resolve({...fixture,note:'新しい応答'}));await page.getByText('新しい応答',{exact:true}).waitFor();
 await page.evaluate(()=>pending[0].resolve({...fixture,note:'古い応答'}));assert.equal(await page.getByText('古い応答',{exact:true}).count(),0);
 await page.evaluate(()=>{pending=[]});await page.locator('#company-evaluation-refresh').click();await page.locator('#company-evaluation-refresh').click();
 await page.evaluate(()=>pending[1].resolve({...fixture,note:'最新の成功'}));await page.getByText('最新の成功',{exact:true}).waitFor();await page.evaluate(()=>pending[0].reject({data:{hint:'古いエラー'}}));assert.equal(await page.getByText('古いエラー',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No horizontal overflow');
 assert(await page.evaluate(()=>calls.every(args=>args.length===1&&args[0]==='/api/sales/company-evaluations')));
 // Actual editor module: save/history, validation preserves input, uncertain saves reconcile only.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('company-evaluation-selected',{detail:{companyId:'company-1'}})));
 const editor=page.locator('#company-evaluation-editor');await editor.locator('#company-evaluation-save-form').waitFor();
 await editor.locator('[name="reason"]').fill('保存テストの判断理由');
 await editor.getByRole('button',{name:'下書き保存',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#company-evaluation-save-message')?.textContent.includes('評価を保存しました'));
 assert.match(await editor.textContent(),/改訂 1/);assert.match(await editor.locator('ol').textContent(),/保存テストの判断理由/);
 assert.equal(await page.evaluate(()=>calls.filter(([,o])=>o?.method==='POST').length),1);
 await editor.locator('[name="reason"]').fill('入力保持を確認する理由');
 await page.evaluate(()=>{detailStatus=400});const beforeInvalid=await page.evaluate(()=>calls.length);
 await editor.getByRole('button',{name:'下書き保存',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#company-evaluation-save-message')?.textContent==='入力または保存結果を確認');
 assert.equal(await editor.locator('[name="reason"]').inputValue(),'入力保持を確認する理由');
 assert.equal(await editor.getByRole('button',{name:'下書き保存',exact:true}).isEnabled(),true);
 assert.equal(await page.evaluate(()=>calls.length),beforeInvalid+1,'400 must not fetch and destroy inputs');
 for(const status of [409,503]){
  await page.evaluate(s=>{detailStatus=s},status);const prior=await page.evaluate(()=>({all:calls.length,posts:calls.filter(([,o])=>o?.method==='POST').length}));
  await editor.getByRole('button',{name:'下書き保存',exact:true}).click();
  await page.waitForFunction(s=>document.querySelector('#company-evaluation-save-message')?.textContent.includes(s===409?'競合':'自動再送せず'),status);
  assert.equal(await page.evaluate(()=>calls.length),prior.all+2,'one POST then one reconciliation GET');
  assert.equal(await page.evaluate(()=>calls.filter(([,o])=>o?.method==='POST').length),prior.posts+1);
 }
 assert(await page.evaluate(()=>calls.filter(([,o])=>o?.method==='POST').every(([,o])=>typeof o.body.expected_revision==='string'&&!('tenant_id'in o.body)&&!('actor_id'in o.body))));
 assert.deepEqual(errors,[]);
 await page.screenshot({path:shotPath(`company-evaluation-${width}.png`),fullPage:true});
 await page.close();
}
console.log('PASS company evaluation real browser PC/mobile: missing/zero/full scores, D review requirement, no external writes, XSS escaping, failures, stale response races, editor save/history/400/409/503, no overflow');
}finally{await browser.close();}
