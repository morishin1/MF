// Actual browser and fictional APIs only: no production records or messages.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const browser=await launch();
async function open(path,width){
 const page=await browser.newPage({viewport:{width,height:950},timezoneId:'Asia/Tokyo'}),writes=[],errors=[],gets=[];
 const checklist=[{id:'resume',title:'履歴書',required:true,status:'未提出',canUpload:true},{id:'returned',title:'本人確認書類',required:true,status:'要再提出',reviewNote:'画像が不鮮明です。文字を読める状態で再提出してください。',canUpload:true},{id:'sent',title:'職務経歴書',required:true,status:'確認待ち',submittedAt:'2026-11-14T01:00:00Z',canUpload:true},{id:'optional',title:'追加資料',required:false,status:'未提出',canUpload:true},{id:'na',title:'対象外の書類',required:true,status:'対象外',canUpload:false}];
 const uploads=[{id:'sent-file',itemId:'sent',source:'procedure',title:'職務経歴書',filename:'職務経歴書.pdf',mimeType:'application/pdf',createdAt:'2026-11-14T01:00:00Z'}];
 const fx={checklist,uploads,hold:false,release:null,fail:false,unconfigured:false,unavailable:false,uncommitted:false};
 page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
 await page.addInitScript(()=>{localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'member@example.test'}));localStorage.setItem('kp_layout',JSON.stringify({appRole:'member',name:'架空 メンバー',shows:{}}));});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==new URL(BASE).origin)return route.abort();
  const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(req.method()!=='GET')writes.push({path:url.pathname,method:req.method(),body:(req.headers()['content-type']||'').includes('application/json')?req.postDataJSON():null});else gets.push(url.pathname);
  if(url.pathname==='/api/me')return send({email:'member@example.test',appRole:'member',shows:{},access:{},gw:{tenantId:'t',roles:[],employee:{id:'e',display_name:'架空 メンバー',status:'active'}}});
  if(url.pathname==='/api/notifications')return send({notifications:[],unread:0});
  if(url.pathname==='/api/my-documents'){
   if(fx.unavailable)return send({error:'unavailable'},503);
   if(url.searchParams.get('file'))return send({url:BASE+'/test/fixtures/sample.pdf',mimeType:'application/pdf'});
   return send({employee:true,checklist:fx.unconfigured?[]:checklist,uploads,received:[{id:'terms',source:'notice',title:'労働条件通知書',filename:'条件.pdf'}],checklistState:fx.unconfigured?'unconfigured':'ready',notReady:[]});
  }
  if(url.pathname==='/api/hr/candidate-documents')return send({ready:true,documents:[]});
  if(url.pathname==='/api/onboarding/upload'){
   if(req.method()==='POST')return send({fileId:'new-file',uploadUrl:BASE+'/api/fixture-file',storagePath:'fixture.pdf'});
   if(req.method()==='PATCH'){if(fx.hold)await new Promise(resolve=>fx.release=resolve);if(!fx.uncommitted){checklist[0].status='確認待ち';checklist[0].submittedAt='2026-11-14T02:00:00Z';uploads.push({id:'new-file',itemId:'resume',source:'procedure',filename:'履歴書.pdf',title:'履歴書',mimeType:'application/pdf'});}return send({ok:true,fileId:'new-file'});}
  }
  if(url.pathname==='/api/fixture-file')return route.fulfill({status:fx.fail?500:200,body:''});
  return send({contracts:[],factors:[],badges:{}});
 });
 await page.goto(BASE+'/'+path);await page.locator('.kp-subnav').getByText('提出書類',{exact:true}).waitFor();return {page,writes,errors,gets,fx};
}
async function finish(t){assert.deepEqual(t.errors,[]);assert.ok(await t.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');await t.page.close();}
try{
 for(const width of [1440,390]){
  let t=await open('mypage.html',width),p=t.page;assert.deepEqual(await p.locator('.kp-subnav').allTextContents(),['基本情報契約書提出書類']);assert.equal(await p.locator('.member-page-links').count(),0);assert.equal(await p.locator('#profile-supplement').isVisible(),false);assert.equal(await p.locator('#basic-profile').isVisible(),true);assert.ok(!t.gets.includes('/api/onboarding/me'),'basic does not request unrelated documents');await finish(t);
  t=await open('contracts.html',width);p=t.page;await p.getByRole('heading',{name:'会社から届いた契約書・通知書',exact:true}).waitFor();assert.equal(await p.locator('[data-my-upload-start]').count(),0);assert.equal(await p.locator('[data-submission-id]').count(),0);await finish(t);
  t=await open('submissions.html',width);p=t.page;await p.getByText('提出完了まで、あと2件',{exact:true}).waitFor();assert.equal(await p.locator('[data-submission-id="na"]').count(),0);assert.equal(await p.locator('[data-submission-id="optional"]').isVisible(),false);assert.equal(await p.locator('[data-submission-id="resume"] .hr-upload-state').innerText(),'未提出');assert.equal(await p.locator('[data-submission-id="sent"] .hr-upload-state').innerText(),'提出済み');assert.match(await p.locator('[data-submission-id="returned"]').innerText(),/画像が不鮮明/);
  if(process.env.TEST_SHOTS==='1')await p.screenshot({path:shotPath('submissions-'+width+'.png'),fullPage:true});
  t.fx.hold=true;await p.locator('[data-my-upload="0"]').setInputFiles({name:'履歴書.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-fixture')});await p.getByText('提出を確定しています…',{exact:true}).waitFor();assert.equal(await p.locator('[data-submission-id="resume"] .hr-upload-state').innerText(),'未提出');t.fx.release();await p.getByText('提出完了まで、あと1件',{exact:true}).waitFor();assert.match(await p.locator('[data-my-message]').innerText(),/履歴書を提出しました/);
  assert.deepEqual(t.writes.filter(x=>!['/api/onboarding/upload','/api/fixture-file','/api/devices/me'].includes(x.path)),[],'only the existing upload can write');assert.deepEqual(t.writes.filter(x=>x.path==='/api/onboarding/upload').map(x=>x.method),['POST','PATCH']);
  t.fx.unconfigured=true;await p.reload();await p.getByText('提出する書類は、会社側で確認・設定中です。',{exact:true}).waitFor();assert.equal(await p.getByText('必要書類はすべて提出済みです。',{exact:true}).count(),0);
  t.fx.unavailable=true;await p.reload();await p.getByRole('button',{name:'再読み込み',exact:true}).first().waitFor();assert.equal(await p.getByText('必要書類はすべて提出済みです。',{exact:true}).count(),0);
  t.fx.unavailable=false;t.fx.unconfigured=false;await p.getByRole('button',{name:'再読み込み',exact:true}).first().click();await p.getByText('提出完了まで、あと1件',{exact:true}).waitFor();await finish(t);
 }
 for(const mode of ['fail','uncommitted']){
  const t=await open('submissions.html',390),p=t.page;t.fx[mode]=true;await p.locator('[data-my-upload="0"]').waitFor({state:'attached'});await p.locator('[data-my-upload="0"]').setInputFiles({name:'履歴書.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-fixture')});
  await p.waitForFunction(()=>document.querySelector('[data-my-message]').textContent.includes('失敗')||document.querySelector('[data-my-message]').textContent.includes('確定を確認できません'));assert.equal(await p.locator('[data-submission-id="resume"] .hr-upload-state').innerText(),'未提出');assert.ok(!(await p.locator('[data-my-message]').innerText()).includes('提出しました'));await finish(t);
 }
 console.log('PASS PC/mobile: three tabs, basic-only, contracts-only, upload confirmation, returned reasons, optional/N/A, unavailable/unconfigured, retry and failure preservation');
}finally{await browser.close();}
