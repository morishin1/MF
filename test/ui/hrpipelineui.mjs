// Actual browser, local fixtures only: no real applicants, database or email.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {OFFER_TYPES_PUBLIC} from '../../lib/hr-offer-types.js';
import fs from 'node:fs';
const browser=await launch();
try {
 for(const width of [1440,1280,390]) {
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],writes=[];
  page.setDefaultTimeout(7000);
  page.on('pageerror',e=>{errors.push(String(e));console.error(String(e));});
  const a={id:'a1',name:'確認用 太郎',jobTitle:'生成AIを活用したITサービスの運営・顧客サポート',source:'Wantedly',stage:'offer',stageLabel:'内定',status:'offer_draft_pending',statusLabel:'合格通知作成待ち',decision:'hired',nextActionKey:'chooseOfferType',nextActionCta:'採用区分を選ぶ',note:'メモの一行目\nメモの二行目\n詳しい内容はスクロールで確認',recruiterName:'採用 担当',docs:{},alerts:[{key:'overdue',label:'期限超過'}],overdue:true,decisionDueOn:'2026-10-20'};
  const rows=[a,{...a,id:'a2',name:'確認用 花子',stage:'ceo_interview',stageLabel:'社長面談',status:'interview_scheduled',statusLabel:'面談予定',decision:null,nextActionKey:'conduct',nextActionCta:'面談を実施済みにする'},{...a,id:'a3',name:'合意済み 次郎',status:'accepted',statusLabel:'承諾済み',pdfFlow:{phase:'terms_preparing',acceptedAt:'2026-11-14'}}];
  const me={userId:'pipeline-tester',email:'owner@example.test',isAdmin:true,appRole:'admin',access:{recruit:true,officeHr:true},gw:{tenantId:'tenant',isAdmin:true,roles:['owner'],employee:{id:'owner',display_name:'確認用'}}};
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'owner@example.test'})));
  await page.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!==new URL(BASE).origin)return route.abort();
   if(!u.pathname.startsWith('/api/')){
    if(process.env.TEST_OFFLINE!=='1')return route.continue();
    try {const body=fs.readFileSync(new URL('../..'+u.pathname,import.meta.url));const ext=u.pathname.split('.').pop();return route.fulfill({body,contentType:({html:'text/html',js:'application/javascript',css:'text/css',svg:'image/svg+xml'}[ext]||'application/octet-stream')});}catch{return route.fulfill({status:404,body:''});}
   }
   const send=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   if(req.method()!=='GET')writes.push(req.postDataJSON());
   if(u.pathname==='/api/me')return send(me);
   if(u.pathname==='/api/hr/applicants/detail'){const id=u.searchParams.get('id');return send({applicant:rows.find(a=>a.id===id)||a,interviews:[],offers:[],timeline:[],offerTypes:OFFER_TYPES_PUBLIC,offerTypeReady:true,salaryVisible:true});}
   if(u.pathname==='/api/hr/applicants')return send({applicants:rows,employees:[],statuses:[],sources:{counts:[]}});
   if(u.pathname==='/api/hr/documents')return send({documents:[],limits:{}});
   if(u.pathname==='/api/notifications')return send({notifications:[],unread:0});
   return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html`);await page.locator('[data-applicant="a1"]').waitFor();
  assert.equal(await page.locator('#rows [data-current-state]').count(),3);
  assert.equal(await page.getByRole('columnheader',{name:'警告',exact:true}).count(),0);
  assert.equal(await page.locator('#rows select').count(),0,'one display state per person');
  assert.equal(await page.locator('.hr-pipeline-arrow').count(),5);
  assert.match(await page.locator('[data-applicant="a3"] a.hr-list-cta').getAttribute('href'),/admin-hr\.html#agreement-a3/);
  if(width>=1280){const wrap=await page.locator('body > .wrap').boundingBox();assert.ok(wrap.width>=width-2,'uses full viewport width');const row=await page.locator('[data-applicant="a1"]').boundingBox();assert.ok(row.height<=90,'normally about two lines');}
  if(process.env.TEST_SHOTS==='1')await page.screenshot({path:`pipeline-${width}.png`,fullPage:true});
  rows[1].status='ceo_decision_pending';rows[1].statusLabel='社長判断待ち';rows[1].nextActionKey='decide';rows[1].nextActionCta='採用判断をする';
  await page.evaluate(()=>load());await page.waitForFunction(()=>document.getElementById('hr-new-count').textContent==='1');
  await page.getByRole('button',{name:/^新着 1$/}).click();assert.equal(await page.locator('#rows tr.click').count(),1);
  await page.reload();await page.waitForFunction(()=>document.getElementById('hr-new-count').textContent==='1');
  await page.locator('[data-applicant="a2"] .hr-nm').click();await page.locator('#hr-detail-next').waitFor().catch(async e=>{console.error(await page.locator('#modal-root').textContent());throw e;});
  assert.equal(await page.locator('#hr-new-count').textContent(),'0','opening latest state marks it read');
  await page.evaluate(()=>{closeModal();});
  await page.locator('[data-applicant="a1"] button.hr-list-cta').click();
  await page.getByRole('heading',{name:'この方をどの形で迎えますか？'}).waitFor();
  assert.equal(await page.locator('#ot-cards [role="radio"]').count(),6);
  assert.match(await page.locator('#ot-cards').textContent(),/2週間トライアル/);
  assert.equal(writes.length,0,'no mail or applicant changes on navigation');
  assert.deepEqual(errors,[]);
  await page.close();console.log(`HR pipeline browser ${width}px PASS`);
 }
} finally {await browser.close();}
