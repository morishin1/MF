// Fictional fixtures only; no production applicants, mail or database writes.
import assert from 'node:assert/strict';
import {launch,BASE,jstToday} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const browser=await launch();
const me={userId:'overview-test',email:'owner@example.test',isAdmin:true,appRole:'admin',access:{recruit:true,officeHr:true},gw:{tenantId:'t',isAdmin:true,roles:['owner'],employee:{id:'owner',display_name:'架空 担当'}}};
const base={stage:'applied',status:'todo',statusLabel:'未対応',source:'Wantedly',createdAt:'2026-11-16T02:36:00Z',docs:{resume:true},recruiterName:'架空 担当',nextActionKey:'registerEmail',nextActionCta:'メールアドレスを登録',note:''};
const people=[
 {...base,id:'a',name:'ダッシュボード 確認太郎',jobTitle:'地域と企業をつなぐ営業・事業開発メンバー',offerType:'executive_employee'},
 {...base,id:'b',name:'Alexandria Kobayashi',jobTitle:'AI・DX開発エンジニア',offerType:'contractor',status:'interview_scheduled',statusLabel:'面談予定'},
 {...base,id:'c',name:'架空 評価花子',jobTitle:'カスタマーサクセス',status:'eval_pending',statusLabel:'評価入力待ち',source:'ハローワーク'},
 {...base,id:'d',name:'架空 判断次郎',jobTitle:'事業開発',status:'ceo_decision_pending',statusLabel:'社長判断待ち',source:'ハローワーク'},
 {...base,id:'e',name:'架空 トライアル',jobTitle:'ITエンジニア',offerType:'trial_2weeks'},
 {...base,id:'z',name:'終了済み',status:'done'},
 {...base,id:'lead',name:'受講受付',leadCategory:'mugendojo'},
];
try{
 for(const width of [1440,1280,1100,1024,768,620,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'}),writes=[],errors=[];
  let failInterviews=false,failApplicants=false;
  await context.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'owner@example.test'})));
  await context.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin!==new URL(BASE).origin)return route.abort();
   if(!u.pathname.startsWith('/api/'))return route.continue();
   const send=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   if(req.method()!=='GET')writes.push({path:u.pathname,body:req.postDataJSON()});
   if(u.pathname==='/api/me')return send(me);
   if(u.pathname==='/api/hr/applicants')return failApplicants?route.fulfill({status:500,body:'{}'}):send({applicants:people,employees:[],sources:{counts:[{label:'Wantedly',count:999}]}});
   if(u.pathname==='/api/hr/applicant-state')return send({states:[{id:'e',currentTrial:{status:'active'}}]});
   if(u.pathname==='/api/hr/interviews/today')return failInterviews?route.fulfill({status:500,body:'{}'}):send({interviews:[
    {id:'today',applicantId:'b',name:people[1].name,scheduledAt:jstToday()+'T10:00:00+09:00'},
    {id:'cancel',applicantId:'a',name:'取消済み',scheduledAt:jstToday()+'T11:00:00+09:00',canceled:true},
    {id:'done',applicantId:'a',name:'実施済み',scheduledAt:jstToday()+'T12:00:00+09:00',done:true},
    {id:'tomorrow',applicantId:'a',name:'明日',scheduledAt:jstToday(1)+'T10:00:00+09:00'},
   ]});
   if(u.pathname==='/api/hr/inbox')return send({openCount:2,unreadCount:1});
   if(u.pathname==='/api/notifications')return send({notifications:[],unread:0});
   if(u.pathname==='/api/hr/spot')return send({count:0});
   if(u.pathname==='/api/hr/applicants/detail')return send({applicant:people.find(a=>a.id===u.searchParams.get('id')),interviews:[],timeline:[],offers:[],salaryVisible:true});
   return send({});
  });
  const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(String(e)));
  const noOverflow=async label=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' '+width+'px no horizontal overflow');
  await page.goto(BASE+'/hr/dashboard.html');await page.locator('#hr-home-content').waitFor({state:'visible'});
  assert.deepEqual(await page.locator('.hr-kpi strong').allTextContents(),['5','1','1','1','1']);
  const categoryTotal=(await page.locator('#hr-home-categories b').allTextContents()).reduce((n,s)=>n+Number(s.replace('名','')),0);
  assert.equal(categoryTotal,5,'category breakdown includes unassigned exactly once');
  assert.equal(await page.locator('#count-today').innerText(),'1件');
  assert.equal(await page.locator('#today-interviews a').count(),1);
  await noOverflow('dashboard');
  if(process.env.TEST_SHOTS==='1'&&[1440,390].includes(width))await page.screenshot({path:shotPath('hr-overview-dashboard-'+width+'.png'),fullPage:true});
  // Saved list state must never corrupt a KPI's explicit filter link.
  await page.evaluate(()=>sessionStorage.setItem('hr-applicants-view',JSON.stringify({version:2,category:'closed',stage:'screening',q:'never matches',y:2000})));
  await page.locator('.hr-kpi[href*="scope=decision"]').click();await page.locator('#rows tr[data-applicant="d"]').waitFor();
  assert.equal(await page.locator('#rows tr.click').count(),1,'KPI shows its exact population');
  assert.equal(await page.locator('#q').inputValue(),'');
  assert.match(await page.locator('#source-summary').innerText(),/ハローワーク\s*1/);
  assert.ok(!(await page.locator('#source-summary').innerText()).includes('999'),'sources use visible rows, not global totals');
  await page.getByRole('button',{name:'絞り込みを解除',exact:true}).click();await page.locator('#rows tr[data-applicant="a"]').waitFor();
  assert.equal(await page.locator('#rows tr.click').count(),5);
  assert.equal(await page.locator('#cat-tabs button.on').getAttribute('data-category'),'active');
  await noOverflow('applicant list');
  assert.equal(await page.locator('#stage-tabs .hr-new').count(),0,'stage tabs do not duplicate new badges');
  const nm=await page.locator('[data-applicant="b"] .hr-nm').evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth,whiteSpace:getComputedStyle(e).whiteSpace}));
  assert.ok(nm.scroll<=nm.client+1&&nm.whiteSpace!=='nowrap','long names remain readable');
  const note=await page.locator('[data-applicant="a"] textarea').boundingBox();assert.ok(note.height>=60,'notes have room for multiple lines');
  await page.locator(width<=1100?'#chk-all-cards':'#chk-all').check();assert.match(await page.locator('#bulkbar').innerText(),/5名選択中/);
  await page.locator('#bulkbar').getByRole('button',{name:'選択解除'}).click();
  await page.locator('#q').fill('架空 判断');assert.equal(await page.locator('#rows tr.click').count(),1);
  assert.match(await page.locator('#source-summary').innerText(),/ハローワーク\s*1/);
  await page.locator('#q').fill('');
  if(width>=1280){
   await page.locator('[data-applicant="e"]').scrollIntoViewIfNeeded();
   const top=await page.locator('#thead th').first().boundingBox();assert.ok(top.y>=55,'column headings remain visible under sticky nav');
  }
  if(process.env.TEST_SHOTS==='1'&&[1440,1280,390].includes(width)){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:shotPath('hr-overview-list-'+width+'.png'),fullPage:true});}
  await page.getByRole('tab',{name:/区分未設定/}).click();assert.equal(await page.locator('#rows tr.click').count(),2);
  assert.match(await page.locator('#list-summary').innerText(),/2名を表示/);
  assert.deepEqual(writes,[],'viewing, searching and selecting does not save/send anything');
  if(width===1440){
   failInterviews=true;await page.goto(BASE+'/hr/dashboard.html');await page.locator('#hr-home-content').waitFor({state:'visible'});
   assert.equal(await page.locator('.hr-kpi strong').first().innerText(),'5','interview failure preserves applicant counts');
   assert.equal(await page.locator('#count-today').innerText(),'確認できません');
   failApplicants=true;await page.locator('#hr-home-refresh').click();await page.getByText(/採用状況を更新できません/).waitFor();
   assert.equal(await page.locator('.hr-kpi strong').first().innerText(),'5','refresh failure never replaces previous counts with zero');
  }
  assert.deepEqual(errors,[]);await context.close();console.log('HR dashboard/list overview '+width+'px PASS');
 }
}finally{await browser.close();}
