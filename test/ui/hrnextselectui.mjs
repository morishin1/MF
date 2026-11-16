// 架空の応募者/メモだけを使ったNEXT選択テスト。実DB・メール・契約を触らない。
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const browser=await launch();
const ID='11111111-1111-4111-8111-111111111111';
async function scenario(width,{stale=false,useMainButton=false}={}){
 const ctx=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Tokyo'});
 await ctx.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'owner@example.test'})));
 const a={id:ID,name:'架空 申込者',jobTitle:'事務',source:'Wantedly',stage:'applied',stageLabel:'新規応募',
  status:'todo',statusLabel:'未対応',decision:null,nextAction:'面談を設定してください',
  nextActionCta:'面談を設定する',nextActionKey:'schedule',note:'内定通知書をお出しできておりません。',
  recruiterName:'テスト担当',docs:{},manualProgress:null,progressRevision:null};
 const calls=[],errs=[];
 const page=await ctx.newPage();page.setDefaultTimeout(9000);page.on('pageerror',e=>errs.push(String(e)));
 await ctx.route('**/api/**',route=>{
  const req=route.request(),u=new URL(req.url());let b={};try{b=req.postDataJSON()||{}}catch{}
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(u.pathname==='/api/me')return send({email:'owner@example.test',appRole:'admin',isAdmin:true,
   gw:{tenantId:'test',isAdmin:true,roles:['owner'],employee:{id:'owner',display_name:'テスト担当'}},access:{recruit:true,officeHr:true}});
  if(u.pathname==='/api/hr/applicants')return send({applicants:[{...a}],employees:[],statuses:[],sources:{counts:[]}});
  if(u.pathname==='/api/hr/applicants/detail')return send({applicant:{...a},interviews:[],offers:[],timeline:[],salaryVisible:true,
   progressMoves:{locked:null,options:[{key:'offer',label:'合格通知',state:'allowed'},{key:'interview',label:'カジュアル面談',state:'allowed'}]},
   salaryVisible:true});
  if(u.pathname==='/api/hr/progress'){
   calls.push({action:'progress',b});
   if(b.dryRun)return send({from:'事前選考',to:'合格通知',warnings:[],notes:[],token:'fixture-one-time-token'});
   if(stale)return send({error:'stale',hint:'状態が更新されています。再読み込みしてください。'},409);
   assert.deepEqual({to:b.to,method:b.method},{to:'offer',method:'other'});
   assert.equal(b.token,'fixture-one-time-token');
   assert.match(b.confirmedOn,/^\d{4}-\d{2}-\d{2}$/);
   a.manualProgress={phase:'offer',method:'other',recordedAt:'2026-11-15T00:00:00Z'};
   a.progressRevision='fixture-1';
   return send({ok:true,progressRevision:'fixture-1'});
  }
  if(u.pathname==='/api/hr/candidate-documents')return send({ready:true,applicant:{id:ID,name:a.name,email:null},
   canUpload:true,canPublish:false,documents:[]});
  if(u.pathname==='/api/hr/documents')return send({documents:[],limits:{},types:[]});
  if(u.pathname==='/api/notifications')return send({notifications:[],unread:0});
  if(req.method()!=='GET')calls.push({action:u.pathname,b});
  return send({});
 });
 await page.goto(BASE+'/hr/applicants.html');
 await page.locator('#rows [data-applicant="'+ID+'"] .hr-next-phase-trigger').waitFor();
 assert.equal(await page.locator('#rows select').count(),0,'no narrow split dropdown');
 const main=page.locator('#rows [data-applicant="'+ID+'"] .hr-list-cta');
 assert.ok(!(await main.innerText()).includes('へ移動'),'main NEXT opens a task, never silently changes the stage');
 if(useMainButton){
  await main.click();await page.locator('.hr-work-modal').waitFor();
  assert.equal(calls.filter(x=>x.action==='progress').length,0,'main action does not change the stage');
  await page.locator('.hr-work-heading button').getByText('閉じる',{exact:true}).click();
 }
 await page.locator('[data-applicant="'+ID+'"] .hr-next-phase-trigger').click();
 await page.locator('#hr-next-phase').waitFor();
 const options=await page.locator('#hr-next-phase option').allTextContents();
 assert.ok(options.some(t=>t.includes('★ メモからの候補：内定通知書の準備（未発行）')));
 assert.ok(!options.some(t=>t.includes('契約締結済み')));
 await page.getByRole('button',{name:'変更を保存',exact:true}).click();
 assert.match(await page.locator('#hr-phase-message').innerText(),/変更先を選択/);
 assert.equal(calls.filter(x=>x.action==='progress').length,0,'empty selection never saves');
 await page.selectOption('#hr-next-phase','phase:offer');
 assert.equal(await page.locator('#hr-phase-message').innerText(),'','selection clears old validation errors');
 if(process.env.TEST_SHOTS==='1')await page.screenshot({path:shotPath('hr-office-next-'+width+'.png')});
 assert.equal(calls.filter(x=>x.action==='progress').length,0,'selection alone never saves');
 await page.getByRole('button',{name:'キャンセル',exact:true}).click();
 assert.equal(calls.filter(x=>x.action==='progress').length,0,'cancel never saves');
 await page.locator('[data-applicant="'+ID+'"] .hr-next-phase-trigger').click();
 await page.selectOption('#hr-next-phase','phase:offer');
 await page.getByRole('button',{name:'変更を保存',exact:true}).click();
 if(stale){
  await page.locator('#hr-next-result-'+ID).getByText('再読み込み').waitFor();
  assert.equal(a.manualProgress,null,'失敗時に管理段階を進めない');
 }else{
  await page.waitForFunction(id=>document.querySelector('[data-applicant="'+id+'"] [data-current-state]')?.textContent.includes('合格通知の準備'),ID);
  assert.equal(a.stage,'applied');assert.equal(a.status,'todo');assert.equal(a.decision,null);
  assert.ok((await page.locator('[data-applicant="'+ID+'"] .hr-list-cta').innerText()).includes('合格通知PDFをアップロード'));
  await page.locator('[data-applicant="'+ID+'"] .hr-list-cta').click();
  await page.locator('.hr-pdf-drop').waitFor();
  assert.equal(await page.locator('.hr-pdf-work-modal').count(),1);
  assert.equal(await page.locator('#hr-pdf-next-drop [data-kind],#hr-pdf-next-drop #hr-notice-create').count(),0);
 }
 assert.equal(calls.filter(x=>x.action==='progress').length,2,'dryRunと検証済み保存の2回だけ');
 assert.equal(calls.some(x=>x.action!=='progress'&&!(x.action==='/api/hr/applicant-state'&&x.b.action==='read')),false,'PDF送信・メール送信・合意記録をしない');
 assert.deepEqual(errs,[],'画面のJavaScriptエラーなし');
 await ctx.close();
}
try{
 await scenario(1440,{useMainButton:true});
 await scenario(390);
 await scenario(1280,{stale:true,useMainButton:true});
 console.log('PASS Office-style NEXT: explicit stage dialog, no save on selection/cancel, audit, primary action never moves stages, upload and stale guard');
}finally{await browser.close();}
