// Real entry/legacy/compact UI; synthetic APIs only, external traffic blocked.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {launch} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const root=new URL('../../',import.meta.url);
const company='11111111-1111-4111-8111-111111111111',sales='22222222-2222-4222-8222-222222222222';
const session='44444444-4444-4444-8444-444444444444';
const dest='https://enger.jp/business/agent-meeting?companyId='+company;
const requests=[];let mode='ready',linked=false;
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 try{
  if(path==='/js/api-client.js'){
   res.setHeader('content-type','text/javascript');res.end(`window.API={api:async(url,opts={})=>{const r=await fetch(url,{method:opts.method||'GET',headers:{'content-type':'application/json'},body:opts.body?JSON.stringify(opts.body):undefined});const data=await r.json();if(!r.ok){const e=Error(data.hint||data.error);e.code=data.error;e.hint=data.hint;e.body=data;throw e;}return data;}};`);return;
  }
  if(path==='/js/sales-layout.js'){
   res.setHeader('content-type','text/javascript');res.end('window.SalesLayout={init:async()=>({canSell:true})};');return;
  }
  if(path.startsWith('/api/')){
   requests.push({path,url:req.url,method:req.method});res.setHeader('content-type','application/json');
   if(path==='/api/sales/enger-company-action'){
    assert.equal(req.method,'POST');let raw='';for await(const b of req)raw+=b;
    assert.deepEqual(JSON.parse(raw),{id:company});linked=true;res.end(JSON.stringify({companyId:sales}));return;
   }
   if(path==='/api/sales/enger-meeting-entry'){
    if(mode==='retry'){res.statusCode=503;res.end(JSON.stringify({error:'unavailable',hint:'反映は要確認です。'}));return;}
    if(mode==='unlinked'||mode==='confirm'&&!linked){res.statusCode=409;
     res.end(JSON.stringify({error:mode==='confirm'?'sales_link_confirmation_required':'company_link_required',companyId:company,hint:'企業の連携を確認してください。'}));return;}
    const s=new URL(req.url,'http://localhost').searchParams.get('sessionId');
    res.end(JSON.stringify({ok:true,companyId:company,companyName:'合成検証企業',url:mode==='unsafe'?'https://other.invalid/?password=secret':dest+(s?'&sessionId='+s:''),session:s?{id:s}:null}));return;
   }
   res.end(JSON.stringify({rows:[],items:[],canShare:true}));return;
  }
  if(path==='/test-compact'){
   res.setHeader('content-type','text/html');res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/sales-company-segments.css"><main id="compact" style="max-width:900px;margin:auto"></main><script src="/js/api-client.js"></script><script type="module">import {renderCompactProposal} from '/js/sales-company-compact-proposal.js';renderCompactProposal(document.getElementById('compact'),{companyId:'${company}',brief:{suggestions:{talents:[{id:'${sales}',talentNo:'P-TEST',title:'合成人材',skills:['Java']}]}}});</script></html>`);return;
  }
  const file=new URL('.'+path,root);if(!file.pathname.startsWith(root.pathname))throw Error('path');
  res.setHeader('content-type',path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/plain');res.end(await readFile(file));
 }catch(e){res.statusCode=404;res.end(String(e.message));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;let browser;
try{
 browser=await launch();
 for(const width of [1360,390]){
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin===base)return route.continue();
   if(u.origin==='https://enger.jp')return route.fulfill({contentType:'text/html',body:'<h1>合成ENGER商談</h1>'});
   return route.abort();
  });
  const start=base+'/sales/enger-meeting.html?companyId='+company;
  mode='ready';requests.length=0;await page.goto(start);await page.waitForURL(dest);
  assert(requests.every(r=>r.method==='GET'),'normal start never creates session/account/publication');
  mode='retry';requests.length=0;await page.goto(start);await page.waitForSelector('#entry-retry:visible');
  await page.click('#entry-retry');await page.waitForTimeout(100);assert.equal(requests.length,2);assert(requests.every(r=>r.method==='GET'));
  await page.screenshot({path:shotPath('sales-enger-entry-'+width+'.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  mode='confirm';linked=false;requests.length=0;await page.goto(start);await page.waitForSelector('#entry-confirm:visible');
  assert.equal(requests.filter(r=>r.method==='POST').length,0);
  await page.locator('#entry-confirm').evaluate(b=>{b.click();b.click();});await page.waitForURL(dest);
  assert.equal(requests.filter(r=>r.method==='POST').length,1,'double click produces one explicit company link');
  mode='unlinked';await page.goto(base+'/sales/enger-meeting.html?salesCompanyId='+sales);await page.waitForSelector('#entry-retry:visible');assert.equal(await page.isVisible('#entry-confirm'),false);
  mode='unsafe';await page.goto(start);await page.waitForSelector('#entry-retry:visible');assert.match(await page.textContent('#entry-status'),/URL/);assert.match(page.url(),/enger-meeting.html/);
  mode='ready';requests.length=0;await page.goto(base+'/sales/company-meeting.html?companyId='+company+'&sessionId='+session+'&selection=ignored&password=secret');
  await page.waitForURL(dest+'&sessionId='+session);assert(!requests.some(r=>/password|selection|meeting-session|visible-publish/.test(r.url)));
  requests.length=0;await page.goto(base+'/test-compact');await page.waitForSelector('.lp-compact-go');
  assert.equal(await page.getAttribute('.lp-compact-go','href'),'/sales/enger-meeting.html?companyId='+company);
  assert.equal(await page.locator('dialog').count(),0);assert.equal(requests.filter(r=>r.method==='POST').length,0);
  assert.match(await page.textContent('.lp-compact-selection'),/表示しただけでは企業へ公開されません/);
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS Chromium 1360/390: canonical handoff, explicit single company link, retry without writes, unsafe URL rejection, legacy session continuity, no auto publication/account/session');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
