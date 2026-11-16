// Fictional applicants only. Current compact details and category isolation.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const br=await launch();
try {
 for(const width of [1920,1440,390,320]) {
  const ctx=await br.newContext({viewport:{width,height:1000}});
  await ctx.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'owner@example.test'})));
  const base={jobTitle:'マッチングカスタマーサクセス',source:'Wantedly',createdAt:'2026-11-16T01:00:00Z',updatedAt:'2026-11-16T01:00:00Z',stage:'applied',status:'todo',decision:null,email:null,docs:{},nextActionKey:'detail'};
  const rows=[{...base,id:'a1',name:'架空 未分類',offerType:null},{...base,id:'a2',name:'架空 パート',offerType:'part_time'},{...base,id:'a3',name:'架空 委託',offerType:'contractor'}];
  const writes=[],requests=[],errors=[];let fail=false;
  await ctx.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin!==new URL(BASE).origin)return route.abort();
   if(!u.pathname.startsWith('/api/'))return route.continue();
   requests.push(u.pathname);const send=(b,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(b)});
   const body=req.method()==='GET'?null:req.postDataJSON();if(body)writes.push({path:u.pathname,body});
   if(u.pathname==='/api/me')return send({email:'owner@example.test',isAdmin:true,access:{recruit:true,officeHr:true},gw:{tenantId:'t1',roles:['owner'],isAdmin:true,employee:{id:'e1'}}});
   if(u.pathname==='/api/hr/applicants')return send({applicants:rows,employees:[]});
   if(u.pathname==='/api/hr/applicants/detail'){
    const a=rows.find(a=>a.id===(body?.id||u.searchParams.get('id')));
    if(body){if(fail)return send({hint:'別の担当者が更新しました'},409);assert.equal(body.action,'classifyRecruitment');a.offerType=body.offerType;a.updatedAt='2026-11-16T02:00:00Z';return send({applicant:a});}
    return send({applicant:a,interviews:[],offers:[],timeline:[],salaryVisible:true});
   }
   if(u.pathname==='/api/hr/documents')return send({documents:['resume','work_history','skill_sheet','other'].map((docType,i)=>({docType,label:['履歴書','職務経歴書','スキルシート','その他'][i],latest:null,history:[]}))});
   if(u.pathname==='/api/hr/candidate-documents')return send({ready:true,documents:u.searchParams.get('applicantId')==='a3'?[{id:'notice1',kind:'offer',title:'内定通知書',filename:'内定通知書.pdf',status:'draft'}]:[]});
   if(u.pathname==='/api/hr/applicant-state')return send({states:[]});
   if(u.pathname==='/api/notifications')return send({notifications:[],unread:0});
   return send({});
  });
  const page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(BASE+'/hr/applicants.html');await page.locator('#rows [data-applicant=a1]').waitFor();
  assert.equal(await page.locator('#rows [data-applicant]').count(),1,'初期表示は未分類のみ');
  assert.match(await page.locator('[data-category=unassigned]').innerText(),/未分類.*1/s);
  assert.equal(await page.locator('[data-category=active]').count(),0,'すべての区分を混在表示するタブなし');
  await page.locator('#rows [data-applicant=a1] input[type=checkbox]').check();
  await page.locator('#rows .hr-nm').click();await page.locator('#hr-detail-recruitment-type').waitFor();
  assert.deepEqual((await page.locator('.hr-detail-tabs [role=tab]').allTextContents()).map(t=>t.replace(/person|forum|history/g,'').trim()),['応募者情報','面談・評価','連絡・履歴']);
  assert.equal(await page.getByLabel('人材区分',{exact:true}).count(),0);
  assert.equal(await page.locator('[data-lms-trial],#hr-work-link-lms').count(),0);
  assert.ok(!requests.some(p=>p.includes('lms-trial')),'非表示の体験案内を取得しない');
  assert.equal(await page.locator('#hr-docs-app .hr-file-row').count(),2,'応募者情報内に応募書類を表示');
  const size=await page.locator('#hr-detail-box').boundingBox();
  assert.ok(size.width<=1001 && size.x>=9 && size.x+size.width<=width-9,'幅は最大1000px、スマホは画面内');
  assert.ok(size.height<=(width<=600?921:851),'固定の全画面高にしない');
  await page.locator('#hr-tab-activity').click();
  const short=await page.locator('#hr-detail-box').boundingBox();assert.ok(short.height<650,'少ない内容で余白だけの高いモーダルにしない');
  await page.locator('#hr-tab-overview').click();
  if(width===1920||width===390)await page.screenshot({path:shotPath('hr-compact-'+width+'.png')});
  // Failed classification keeps the selection and applicant untouched.
  fail=true;await page.locator('#hr-detail-recruitment-type').selectOption('part_time');
  await page.locator('#hr-detail-category-msg').filter({hasText:'別の担当者'}).waitFor();
  assert.equal(await page.locator('#hr-detail-recruitment-type').inputValue(),'');assert.equal(rows[0].offerType,null);
  fail=false;await page.locator('#hr-detail-recruitment-type').selectOption('part_time');
  await page.waitForFunction(()=>document.querySelector('#hr-detail-recruitment-type')?.value==='part_time'&&document.querySelector('#hr-detail-recruitment-type')?.disabled===false);
  await page.locator('.hr-person-actions').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#rows [data-applicant]').length===0);
  assert.match(await page.locator('[data-category=unassigned]').innerText(),/未分類.*0/s);
  assert.equal((await page.locator('#bulkbar').innerText()).trim(),'','移動した応募者を一括操作の選択に残さない');
  await page.locator('[data-category=part_time]').click();await page.locator('#rows [data-applicant=a1]').waitFor();
  assert.equal(await page.locator('#rows [data-applicant]').count(),2,'選択した区分でだけ表示');
  assert.match(await page.locator('[data-category=part_time]').innerText(),/2/);
  const changes=writes.filter(x=>x.path==='/api/hr/applicants/detail');
  assert.equal(changes.length,2);assert.deepEqual(Object.keys(changes[1].body).sort(),['action','expectedOfferType','expectedUpdatedAt','id','offerType'].sort());
  assert.equal(rows[0].stage,'applied');assert.equal(rows[0].decision,null);assert.equal(rows[1].offerType,'part_time');
  await page.locator('[data-category=contractor]').click();await page.locator('#rows [data-applicant=a3] .hr-nm').click();
  await page.locator('[data-doc=candidate-notice1]').waitFor();
  assert.equal(await page.locator('[data-doc=candidate-notice1]').count(),1,'登録済み通知書を重複させない');
  assert.match(await page.locator('[data-doc=candidate-notice1]').innerText(),/内定通知書.pdf/);
  assert.equal(await page.locator('[data-doc=candidate-notice1] .material-symbols-outlined').first().textContent(),'mark_email_read','通知書をアイコンで識別');
  assert.deepEqual(errors,[]);await ctx.close();
  console.log('PASS compact detail, hidden LMS/talent, integrated files, scoped classification, stale recovery '+width+'px');
 }
}finally{await br.close();}
