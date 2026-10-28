// Actual browser / fake API only. No candidate, database, mail or storage connection.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const browser=await launch(),id='00000000-0000-4000-8000-000000000001';
try {
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:960}}),calls=[],errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'tester@example.test'})));
  const data={enabled:true,canStart:false,canManage:true,canMigrateLegacy:false,canResolveDelivery:true,applicant:{id,name:'テスト 太郎',email:'candidate@example.test'},flow:{id:'flow',phase:'offer_preparing',version:1},documents:[{id:'doc',kind:'offer',version:1,filename:'内定通知書.pdf',sha256:'a'.repeat(64),responseMode:'offer_accept',state:'draft',current:true}]};
  await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!==new URL(BASE).origin)return route.abort();
   if(!u.pathname.startsWith('/api/'))return route.continue();
   if(u.pathname!=='/api/hr/pdf-flow')return route.fulfill({status:404,body:'{}'});
   let body=data;if(req.method()==='POST'){
    const b=req.postDataJSON();calls.push(b);
    if(b.action==='previewSend')body={confirmation:{to:data.applicant.email,from:'採用窓口 <recruiting@example.test>',filename:'内定通知書.pdf',version:1,subject:'内定通知書のご確認',body:'本人専用リンクからご確認ください。',digest:'digest'}};
    else if(b.action==='send'){data.flow.phase='offer_waiting';data.documents[0].state='sent';}
    else return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'test_only',hint:'このテスト操作は未実行です'})});
   }
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${BASE}/hr/pdf-flow.html?applicantId=${id}`);
  await page.getByRole('heading',{name:'テスト 太郎'}).waitFor();
  assert.ok(await page.getByText('内定通知書準備中',{exact:true}).isVisible());
  await page.locator('[data-act=send]').click();
  await page.locator('#pdf-expiry').fill('2026-12-01T12:00');await page.locator('#pdf-requested-at').fill('2026-10-01T12:00');await page.locator('#pdf-evidence').fill('本人メールでPDF交付を希望した記録を確認');
  await page.locator('#pdf-dialog-submit').click();assert.equal(calls.length,0);
  await page.locator('#pdf-confirm').check();await page.locator('#pdf-dialog-submit').click();
  await page.getByRole('heading',{name:'内容を確認してメール送信'}).waitFor();
  assert.ok((await page.locator('#pdf-dialog-content').innerText()).includes('candidate@example.test'));
  await page.locator('#pdf-confirm').check();await page.locator('#pdf-dialog-submit').click();
  await page.waitForFunction(()=>!document.getElementById('pdf-dialog').open);
  assert.equal(calls.filter(x=>x.action==='send').length,1);assert.equal(calls.at(-1).confirmDigest,'digest');
  assert.ok(await page.locator('.pdf-step.current').getByText('内定承諾待ち').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:shotPath(`hr-pdf-flow-${width}.png`),fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 const page=await browser.newPage({viewport:{width:390,height:960}}),calls=[];
 let response={applicantName:'テスト 太郎',document:{id:'doc',kind:'offer',version:2,sha256:'b'.repeat(64),filename:'内定通知書.pdf',responseMode:'offer_accept',expiresAt:'2026-12-01'},agreementText:'この第2版PDFを確認して内定を承諾します。',canRespond:true};
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==new URL(BASE).origin)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();assert.equal(u.search,'');assert.equal(req.method(),'POST');const b=req.postDataJSON();calls.push(b);if(b.action==='file')return route.fulfill({status:200,contentType:'application/pdf',body:'%PDF-1.4\nsynthetic test bytes'});if(b.action==='accept')response={...response,canRespond:false};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});});
 await page.goto(`${BASE}/hr/pdf-response.html#token=${'c'.repeat(64)}`);await page.locator('#response-submit').waitFor();assert.ok(!page.url().includes('#'));
 await page.locator('#response-agreed').check();await page.locator('#response-submit').click();assert.equal(calls.filter(x=>x.action==='accept').length,0);
 const download=page.waitForEvent('download');await page.locator('#response-download').click();await download;
 await page.waitForFunction(()=>!document.getElementById('response-submit').disabled);await page.locator('#response-submit').click();
 await page.getByText('回答を記録しました。',{exact:true}).waitFor();assert.equal(calls.filter(x=>x.action==='accept').length,1);assert.equal(calls.find(x=>x.action==='accept').version,2);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:shotPath('hr-pdf-response-390.png'),fullPage:true});await page.close();
 console.log('HR PDF actual browser/mock-only: desktop/mobile, explicit send confirmation, candidate PDF-before-accept, fragment/POST PASS');
} finally {await browser.close();}
