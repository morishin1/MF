// Synthetic browser fixtures only; no production data, AI calls, mail or Slack sends.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
const browser=await launch();
const id='11111111-1111-4111-8111-111111111111',mid='22222222-2222-4222-8222-222222222222';
const me={userId:'reviewer',email:'hr@example.test',access:{recruit:true,officeHr:true},isAdmin:true,gw:{roles:['owner'],isAdmin:true,tenantId:'tenant',employee:{id:'emp',display_name:'架空 担当'}}};
const person={id,name:'架空 応募者',jobTitle:'営業',createdAt:'2026-11-14T01:23:00Z',updatedAt:'2026-11-14T01:23:00Z',email:'fiction@example.test',source:'自社フォーム',stage:'applied',status:'todo',statusLabel:'未対応',note:'',nextActionCta:'詳細を確認',nextActionKey:'detail',docs:{resume:true,resumeId:'doc1',workHistory:false},decisionDueOn:'2026-11-15'};
const mail={id:mid,provider:'gmail',provider_message_id:'abcdef0123456789',received_at:'2026-11-14T01:00:00Z',subject:'営業への応募',sender_address:'noreply@provider.test',body_text:'氏名：架空 応募者\nfiction@example.test\n営業への応募',status:'review',candidate_name_guess:'架空 応募者',job_title_guess:'営業',source_guess:'自社フォーム',updated_at:'2026-11-14T00:00:00Z',read:false};
const analysis={mail_id:mid,classification:'application',fields:{name:person.name,email:person.email,jobTitle:'営業',source:'自社フォーム'},state:'review',reason:'応募が明記',updated_at:mail.updated_at};
const trial={id:'trial1',applicantId:id,applicantName:person.name,jobTitle:'営業',startOn:'2026-11-14',endOn:'2026-11-27',status:'planned',basis:'employment',agreementConfirmed:true,agreementReference:'架空合意書',kpiDescription:'提案10件',reviewScores:{}};
const interview={id:'iv1',applicantId:id,kind:'casual',scheduledAt:'2026-11-14T02:00:00Z',memo:'',done:false};
const writes=[];let seen=false;
try{
 for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'});
 await context.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'hr@example.test'})));
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==new URL(BASE).origin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const send=b=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
  const b=req.method()==='GET'?null:req.postDataJSON();if(b)writes.push({path:url.pathname,body:b});
  if(url.pathname==='/api/me')return send(me);
  if(url.pathname==='/api/hr/applicant-state'){if(b){seen=true;return send({ok:true});}return send({states:[{id,unread:!seen,kind:'application'}]});}
  if(url.pathname==='/api/hr/applicants/detail')return send({stepMoves:{current:'applied',options:[{key:'applied',label:'応募受付',state:'current'},{key:'casual_interview',label:'採用面談',state:'allowed'}]},applicant:person,interviews:[interview],offers:[],timeline:[],salaryVisible:true});
  if(url.pathname==='/api/hr/applicants')return send({applicants:[person],employees:[]});
  if(url.pathname==='/api/hr/documents'&&url.searchParams.has('id'))return send({url:'https://files.example.test/resume.pdf',mimeType:'application/pdf',filename:'履歴書.pdf'});
  if(url.pathname==='/api/hr/documents')return send({documents:[{docType:'resume',label:'履歴書',icon:'description',latest:{id:'doc1',filename:'履歴書.pdf',mimeType:'application/pdf'},history:[]},{docType:'work_history',label:'職務経歴書',icon:'work_history',latest:null,history:[]},{docType:'skill_sheet',label:'スキルシート',icon:'assignment_ind',latest:null,history:[]},{docType:'other',label:'その他の書類',icon:'attach_file',latest:null,history:[]}],limits:{}});
  if(url.pathname==='/api/hr/inbox'){if(b)return send({ok:true});if(url.searchParams.has('id'))return send({mail});return send({mails:[mail],openCount:1,unreadCount:1,syncConfigured:false,manualSyncReady:false,readsReady:true});}
  if(url.pathname==='/api/hr/intake'){if(b){assert.equal(typeof b,'object','HTTP JSON body must not be double serialized');return send({ok:true});}return send({analyses:[analysis],budget:{committed_yen:5,budget_yen:1000}});}
  if(url.pathname==='/api/hr/trials')return send({trials:[trial]});
  if(url.pathname==='/api/hr/interviews'){if(b?.action==='memo')interview.memo=b.memo;return send({ok:true,interview});}
  if(url.pathname==='/api/notifications')return send({notifications:[],unread:0});
  return send({});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(7000);
 await page.goto(BASE+'/hr/applicants.html');await page.locator('#rows [data-applicant]').waitFor();
 assert.deepEqual(await page.locator('#thead th').allTextContents(),['','登録日時','応募者','現在の状態','書類','社内メモ','NEXT','担当者']);
 assert.match(await page.locator('#rows td').nth(1).textContent(),/2026\/11\/14 10:23/);
 const newBox=await page.locator('#hr-new-filter').boundingBox(),allBox=await page.locator('[data-stage="all"]').boundingBox();assert.ok(newBox.x<allBox.x,'new filter precedes all');
 await page.locator('#rows [data-doc-kind="resume"]').click();await page.locator('#pdf-preview-root iframe').waitFor();assert.equal(await page.locator('#hr-detail-box').count(),0);await page.locator('#pdf-preview-root').getByRole('button',{name:'閉じる',exact:true}).click();
 await page.locator('#rows [data-applicant]').click();await page.locator('.hr-work-modal').waitFor();assert.equal(await page.locator('.hr-detail-tabs').count(),0);await page.screenshot({path:'/tmp/hr-task-'+width+'.png',fullPage:true});
 await page.locator('#hr-work-status').click();await page.locator('#mv-to').waitFor();await page.getByRole('button',{name:'やめる',exact:true}).click();
 await page.getByRole('button',{name:'応募者情報を見る',exact:true}).click();await page.getByRole('tab',{name:'書類・契約',exact:true}).click();
 assert.ok(writes.some(w=>w.path==='/api/hr/applicant-state'&&w.body.action==='read'));
 assert.equal(await page.locator('.hr-detail-tabs [role="tab"]').count(),4);
 assert.equal(await page.locator('#hr-detail-next').count(),0);
 assert.equal(await page.locator('#hr-docs-app > .hr-file-row').count(),2);
 assert.equal(await page.locator('#hr-docs-optional').getAttribute('open'),null);
 assert.equal(await page.locator('[role="dialog"]:visible').count(),1);
 const styles=await page.locator('#hr-detail-box').evaluate(n=>({shell:getComputedStyle(n).overflow,body:getComputedStyle(n.querySelector('#hr-detail-tab')).overflowY}));assert.deepEqual(styles,{shell:'hidden',body:'auto'});
 await page.screenshot({path:'/tmp/hr-documents-'+width+'.png',fullPage:true});
 await page.goto(BASE+'/hr/intake.html');await page.locator('#rows [data-id]').waitFor();
 assert.equal(await page.locator('#sync').isDisabled(),true);await page.locator('#rows button').click();await page.locator('#detail[open]').waitFor();
 assert.match(await page.locator('pre').textContent(),/fiction@example.test/);
 await page.locator('#reason').fill('原文と職種を確認しました');await page.locator('#correct').click();await page.locator('#detail[open]').waitFor({state:'hidden'});
 assert.ok(writes.some(w=>w.path==='/api/hr/intake'&&w.body.action==='correct'&&w.body.fields.name===person.name));
 await page.goto(BASE+'/hr/trials.html');await page.getByRole('button',{name:/架空 応募者/}).waitFor();await page.getByRole('button',{name:/架空 応募者/}).click();
 await page.locator('#tr-scores button').first().click();assert.ok(await page.locator('#tr-scores button.on').count());
 await page.goto(BASE+'/hr/interviews.html?applicantId='+id+'&interviewId=iv1');await page.locator('#iv-note').waitFor();
 assert.deepEqual((await page.locator('.iv-tab .lab').allTextContents()).map(x=>x.replace(/\s+/g,' ').trim()),
   ['1. 導入2分','2. 会社紹介8分','3. 経験・希望8分','4. 仕事の提案6分','5. 条件・質問4分','6. 次の案内2分']);
 await page.locator('#iv-note').fill('過去の営業実績を具体的な件数で確認');
 await page.locator('.iv-tab').nth(1).click();await page.locator('.iv-present-grid').waitFor();
 assert.equal(await page.locator('.eight-slide').count(),1);
 assert.match(await page.locator('.iv-script').textContent(),/担当者が話す内容/);
 await page.getByRole('button',{name:'次のページ'}).click();
 assert.match(await page.locator('.eight-slide h3').textContent(),/20年以上のIT経験/);
 const [candidatePage]=await Promise.all([context.waitForEvent('page'),page.getByRole('button',{name:/候補者に見せる画面を開く/}).click()]);
 await candidatePage.locator('#present-slide .eight-slide').waitFor();
 assert.equal(await candidatePage.locator('.iv-script').count(),0,'candidate must not see speaker notes');
 assert.match(await candidatePage.locator('#present-slide .eight-slide h3').textContent(),/20年以上のIT経験/);
 await page.getByRole('button',{name:'次のページ'}).click();
 await candidatePage.waitForFunction(()=>document.querySelector('.eight-slide-footer span')?.textContent?.trim()==='3 / 7');
 await candidatePage.close();
 await page.waitForFunction(()=>document.getElementById('iv-status').textContent.includes('保存しました'));
 assert.ok(writes.some(w=>w.path==='/api/hr/interviews'&&w.body.memo?.includes('具体的な件数')));
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/hr-integrated-'+width+'.png',fullPage:true});await context.close();console.log(`PASS ${width}px: list column order, new-first filter, document modal/read, intake correction JSON, trial score buttons, interview autosave`);
 }
}finally{await browser.close();}
