// Actual history pages, synthetic APIs only; no real Slack/mail/DB writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import {launch} from '../_browser.mjs';
import {accessOf} from '../../lib/gw.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const server=createServer(async(req,res)=>{try{const p=resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!p.startsWith(root))throw Error();const content=await readFile(p);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(p)]||'text/plain');res.end(content);}catch{res.statusCode=404;res.end('Not found');}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let browser;
try{
 browser=await launch();let count=0;
 const channel={hr:'C0CCSBTDB1S',office:'C0CCLMUQZ7G',sales:'C0CCQHQN3SM'};
 for(const width of [1280,390])for(const dept of ['hr','office','sales']){
  const context=await browser.newContext({viewport:{width,height:850},timezoneId:'Asia/Tokyo'}),page=await context.newPage();
  const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'synthetic@example.test'})));
  let fail=false;
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1')return route.abort();
   if(!u.pathname.startsWith('/api/'))return route.continue();
   calls.push([u.pathname,route.request().method()]);
   let body={},status=200;
   if(u.pathname==='/api/me')body={email:'synthetic@example.test',appRole:'member',gw:{employee:{id:'e-test',display_name:'確認用'},roles:['owner'],tenantId:'t-test'},access:accessOf({roles:['owner']})};
   if(u.pathname==='/api/slack-history'){
    assert.equal(u.searchParams.get('department'),dept);
    if(fail){status=503;body={error:'not_ready'};}
    else body={ready:true,history:[{id:'fake',department:dept,summary:'確認用の業務まとめ <script>notExecutable()</script>',sent_at:'2026-10-29T03:00:00Z',slack_permalink:`https://8grp.slack.com/archives/${channel[dept]}/p1793242800000000`,coverage_status:'partial',coverage_note:'一部取得できませんでした',period_start:'2026-10-28T23:00:00Z',period_end:'2026-10-29T03:00:00Z'}]};
   }
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  const path=dept==='hr'?'/hr/inbox.html':`/${dept}/slack-history.html`;
  await page.goto('http://127.0.0.1:'+server.address().port+path);
  await page.getByText('送信済み 1件',{exact:true}).waitFor();count++;
  assert.equal(await page.locator('.slack-history-card').count(),1);count++;
  assert.ok((await page.locator('.slack-history-warning').textContent()).includes('取得不足'));count++;
  assert.equal(await page.locator('.slack-history-card a').getAttribute('href'),`https://8grp.slack.com/archives/${channel[dept]}/p1793242800000000`);count++;
  assert.ok((await page.locator('.slack-history-summary').textContent()).includes('<script>'));count++;
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));count++;
  fail=true;await page.getByRole('button',{name:'履歴を更新'}).click();await page.getByText(/Slack通知履歴は準備中/).waitFor();
  assert.equal(await page.locator('.slack-history-card').count(),0);count++;
  assert.ok(!calls.some(([p,m])=>p.startsWith('/api/hr/inbox')||m!=='GET'));count++;
  assert.deepEqual(errors,[]);count++;
  await context.close();
 }
 console.log(`Slack history browser ${count}/${count} PASS (1280/390px, 3 departments, synthetic only)`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
