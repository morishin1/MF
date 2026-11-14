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
  if(url.pathname==='/api/hr/applicants/detail')return send({applicant:person,interviews:[interview],offers:[],timeline:[],salaryVisible:true});
  if(url.pathname==='/api/hr/applicants')return send({applicants:[person],employees:[]});
  if(url.pathname==='/api/hr/documents')return send({documents:[],limits:{}});
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
 await page.locator('#rows .hr-doc-state').first().click();await page.locator('#hr-detail-box').waitFor();await page.getByRole('button',{name:'書類',exact:true}).waitFor();
 assert.ok(writes.some(w=>w.path==='/api/hr/applicant-state'&&w.body.action==='read'));
 await page.goto(BASE+'/hr/intake.html');await page.locator('#rows [data-id]').waitFor();
 assert.equal(await page.locator('#sync').isDisabled(),true);await page.locator('#rows button').click();await page.locator('#detail[open]').waitFor();
 assert.match(await page.locator('pre').textContent(),/fiction@example.test/);
 await page.locator('#reason').fill('原文と職種を確認しました');await page.locator('#correct').click();await page.locator('#detail[open]').waitFor({state:'hidden'});
 assert.ok(writes.some(w=>w.path==='/api/hr/intake'&&w.body.action==='correct'&&w.body.fields.name===person.name));
 await page.goto(BASE+'/hr/trials.html');await page.getByRole('button',{name:/架空 応募者/}).waitFor();await page.getByRole('button',{name:/架空 応募者/}).click();
 await page.locator('#tr-scores button').first().click();assert.ok(await page.locator('#tr-scores button.on').count());
 await page.goto(BASE+'/hr/interviews.html?applicantId='+id+'&interviewId=iv1');await page.locator('#iv-note').waitFor();await page.locator('#iv-note').fill('過去の営業実績を具体的な件数で確認');
 await page.waitForFunction(()=>document.getElementById('iv-status').textContent.includes('保存しました'));
 assert.ok(writes.some(w=>w.path==='/api/hr/interviews'&&w.body.memo?.includes('具体的な件数')));
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/hr-integrated-'+width+'.png',fullPage:true});await context.close();console.log(`PASS ${width}px: list column order, new-first filter, document modal/read, intake correction JSON, trial score buttons, interview autosave`);
 }
}finally{await browser.close();}
