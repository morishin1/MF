// UI wiring uses synthetic data; API persistence and authorization run in salesv1api.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {proposalMail} from '../../lib/sales-meeting-closeout.js';
import {shotPath} from '../_shot.mjs';
const pwModule=await import('playwright'),pw=pwModule.default||pwModule;
const root=fileURLToPath(new URL('../../',import.meta.url));
const CO='11111111-2222-4333-8444-555555555555',ID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),file=path.resolve(root,'.'+url.pathname);
 if(!file.startsWith(path.resolve(root)+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':(mime[path.extname(file)]||'text/plain')+'; charset=utf-8'});res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const opts={headless:true};
if(process.env.TEST_CHROME)opts.executablePath=process.env.TEST_CHROME;
const browser=await pw.chromium.launch(opts);
try{
 for(const width of [1360,390]){
  let row={id:ID,stage:0,status:'active',version:1,selectedKeys:[],startedAt:new Date().toISOString(),
   stepDetails:{layout:'compact_v1'},staffNotes:{},stepChecks:{},closeout:{}};
  const calls=[],errors=[];let saveFails=false,mailSent=false;
  const page=await browser.newPage({viewport:{width,height:900},timezoneId:'Asia/Tokyo'});
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic-test',expires_at:4102444800})));
  await page.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url());
   if(u.origin!==origin)return route.abort();
   if(!u.pathname.startsWith('/api/')){
    const file=path.resolve(root,'.'+u.pathname);
    if(!file.startsWith(path.resolve(root)+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:(mime[path.extname(file)]||'text/plain')+'; charset=utf-8',body:fs.readFileSync(file)});
   }
   const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   const p=u.pathname,b=request.postData()?JSON.parse(request.postData()):{};
   if(p==='/api/me')return send({appRole:'member',email:'sales@example.test',gw:{tenantId:'tenant-a',apps:['sales'],roles:['sales'],employee:{display_name:'営業テスト'}}});
   if(p==='/api/public-config')return send({supabaseUrl:'https://example.invalid',supabaseAnonKey:'synthetic'});
   if(p==='/api/sales/company-meeting-screen')return send({companyName:'表示確認株式会社',displayId:'00311',items:[]});
   if(p==='/api/sales/company-workflow-status')return send({analysis:{summary:'表示確認用の企業情報です。'}});
   if(p==='/api/sales/company-portal')return send({canIssue:true,previewDemoAllowed:false,canResetBusinessPassword:false,
    members:[{id:'member-a',email:'customer@example.test',displayName:'田中',status:'active'}],portal:{displayId:'00311',loginUrl:'https://enger.jp/business/login'}});
   if(p==='/api/sales/meeting-session'){
    if(request.method()==='GET')return send({session:row,companyOfferCount:2});
    calls.push(b);
    if(b.action==='save_step'){
     if(saveFails)return send({error:'fixture_failure',hint:'保存に失敗しました'},503);
     row={...row,version:row.version+1,staffNotes:{...row.staffNotes,[b.stage]:b.note},stepChecks:{...row.stepChecks,[b.stage]:b.checks},
      stepDetails:{...row.stepDetails,...(b.details?{'0':b.details}:{})}};
    }else if(b.action==='compact_stage')row={...row,stage:b.stage,version:row.version+1};
    return send({session:row});
   }
   if(p==='/api/sales/meeting-closeout'){
    if(request.method()==='GET')return send({mailConfigured:true,mailFrom:'its@gw.8grp.co.jp',draft:{
     ...proposalMail({companyName:'表示確認株式会社',companyNo:'00311',portalUrl:'https://enger.jp/business/login?next='+encodeURIComponent('/business/offers?companyId='+CO),password:null,itemsCount:0,action:'次回の対応をご案内します'}),accountReady:true},closeout:mailSent?{status:'sent'}:null});
    calls.push(b);mailSent=true;row={...row,status:'closed'};return send({ok:true,mailSent:true});
   }
   return send({});
  });
  const url=origin+'/sales/company-meeting.html?companyId='+CO+'&sessionId='+ID+'&flow=v1';
  await page.goto(url);await page.locator('#meeting-v1-pane-0').waitFor({state:'visible'});
  assert.equal(await page.locator('#meeting-stages button').count(),3);
  await page.locator('#meeting-v1-problem').fill('Java人材2名');
  await page.locator('#meeting-v1-budget').fill('月80万円');
  await page.locator('#meeting-v1-start').fill('12月');
  await page.locator('[data-v1-check="intro"]').check();await page.locator('[data-v1-check="agenda"]').check();
  saveFails=true;await page.locator('#meeting-v1-pane-0 [data-v1-save]').click();
  await page.getByText('保存に失敗しました',{exact:true}).waitFor();
  assert.equal(await page.locator('#meeting-v1-problem').inputValue(),'Java人材2名');
  saveFails=false;await page.locator('#meeting-v1-pane-0 [data-v1-save]').click();
  await page.waitForFunction(()=>document.querySelector('#meeting-v1-save-state').textContent.includes('保存済み'));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#meeting-v1-problem').value==='Java人材2名');
  await page.locator('#meeting-forward').click();await page.locator('#meeting-v1-pane-1').waitFor({state:'visible'});
  await page.locator('#meeting-v1-purpose').fill('担当者と導入時期を確認');
  await page.locator('[data-v1-check="purpose"]').check();await page.locator('[data-v1-check="decision"]').check();
  await page.locator('#meeting-forward').click();await page.locator('#meeting-v1-pane-2').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#meeting-thank-you-copy').value.includes('ログインID：00311'));
  await page.locator('#meeting-step5-outcome').selectOption('offer');await page.locator('#meeting-next-action').fill('来週面談候補日を確認');
  const body=await page.locator('#meeting-thank-you-copy').inputValue();
  await page.locator('#meeting-thank-you-copy').fill(body+'\n画面で編集した追記です。');
  await page.locator('#meeting-mail-confirm').check();assert.equal(await page.locator('#meeting-send').isEnabled(),true);
  await page.locator('#meeting-v1-subject').fill('本日の商談ありがとうございました');
  assert.equal(await page.locator('#meeting-mail-confirm').isChecked(),false);
  await page.locator('#meeting-mail-confirm').check();
  const expected=await page.locator('#meeting-thank-you-copy').inputValue();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No page overflow at '+width);
  if(process.env.SALES_V1_SHOTS)await page.screenshot({path:shotPath('sales-v1-'+width+'.png'),fullPage:true});
  await page.locator('#meeting-send').click();await page.getByText('お礼文を送信し、商談結果と次回対応を保存しました。',{exact:true}).waitFor();
  const sends=calls.filter(x=>x.mailText);assert.equal(sends.length,1);assert.equal(sends[0].mailText,expected);
  assert.equal(sends[0].mailSubject,'本日の商談ありがとうございました');assert.equal(await page.locator('#meeting-send').isDisabled(),true);
  assert.deepEqual(errors,[]);await page.close();console.log('PASS Sales v1 '+width+'px: save/reload, failure/retry, 3 stages, edited mail, confirmation, one send, no overflow');
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
