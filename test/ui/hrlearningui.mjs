import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
let browser;const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const definitions=[['communication','コミュニケーション'],['mvv','MVVへの共感・実践'],['teamwork','協力・報連相'],['initiative','主体的な行動'],['attitude','仕事への向き合い方']].map(([key,label])=>({key,label}));
const metadata={itemsDefinition:definitions,grades:[{key:'great',label:'◎'},{key:'good',label:'○'},{key:'fair',label:'△'},{key:'bad',label:'×'}],decisions:[{key:'recommend',label:'一緒に働きたい'},{key:'hold',label:'もう少し確認'},{key:'decline',label:'見送りを提案'}]};
try{for(const width of [1440,390]){
 browser=await launch();
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Tokyo'}),writes=[],errors=[];
 let item={id:A,name:'架空 育成担当テスト',email:'learner@example.test',version:1,participation:'on',source:'HR',lmsStatus:'verified',courses:[{id:'course',title:'無限道場 通常講座',kind:'regular',started:false,progressPercent:25,lessonsDone:2,lessonsTotal:8,assignmentsDone:1,assignmentsTotal:3,aiChallengeCount:1,outputCount:1,aiFeedbackCount:1,teacherFeedbackCount:0,lastActivityAt:'2026-11-15T00:00:00Z'},{id:'trial',title:'無限道場 体験版',kind:'trial',started:false,progressPercent:50,lessonsDone:3,lessonsTotal:6,assignmentsDone:2,assignmentsTotal:4,aiChallengeCount:1,outputCount:1,aiFeedbackCount:0,teacherFeedbackCount:0,trial:{mvvAnswered:true,aiTried:true,challengeSubmitted:false,outputSubmitted:false,reflectionSubmitted:false}}],plan:{startOn:'2026-11-01',endOn:'2026-11-14',goals:[{label:'課題を2件提出',target:2,current:1}]},reviews:{},dates:{day:14,remaining:0,active:false,checkpoint:'day14'},goalPercent:50,evaluationStatus:'評価待ち',learning:false,trialActive:false,evaluationPending:true};
 await context.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'hr@example.test'})));
 await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==new URL(BASE).origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});const body=req.method()==='POST'?req.postDataJSON():null;if(body)writes.push({path:url.pathname,body});
  if(url.pathname==='/api/me')return send({email:'hr@example.test',access:{recruit:true},isAdmin:false,gw:{tenantId:'tenant',roles:['recruiter'],employee:{id:'emp',display_name:'架空 担当'}}});
  if(url.pathname==='/api/hr/learning'){
   if(body){assert.equal(body.expectedVersion,item.version);item={...item,version:item.version+1};if(body.action==='participation')item.participation=body.participation?'on':'off';if(body.action==='plan')item.plan=body.plan;if(body.action==='review')item.reviews={...item.reviews,[body.checkpoint]:{...body.evaluation,recordedAt:'2026-11-17T00:00:00Z'}};return send({ok:true,item});}
   return send({items:[item],nextOffset:null,...metadata});
  }
  if(url.pathname==='/api/hr/applicants')return send({applicants:[{id:A,name:item.name,email:item.email,createdAt:'2026-11-15T00:00:00Z',stage:'applied',status:'todo',docs:{resume:true},offerType:null}],employees:[]});
  if(url.pathname==='/api/hr/applicant-state')return send({states:[]});
  return send({});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
 await page.goto(BASE+'/hr/learning.html');await page.getByRole('button',{name:item.name,exact:true}).waitFor();
 assert.equal(await page.locator('.hr-nav a[href="/hr/learning.html"]').count(),1,'recruiter can use training');
 assert.equal(await page.locator('.hr-nav a[href="/hr/ceo-review.html"]').count(),0);
 await page.getByRole('button',{name:item.name,exact:true}).hover();assert.equal(await page.locator('#learning-dialog').evaluate(d=>d.open),false,'hover never opens detail');
 await page.getByRole('button',{name:item.name,exact:true}).click();await page.locator('#learning-dialog[open]').waitFor();
 assert.equal(await page.locator('.learning-course').count(),2,'regular and trial displayed separately');
 const geometry=await page.evaluate(()=>{const d=document.querySelector('#learning-dialog');return {overflow:document.documentElement.scrollWidth>innerWidth+1,dialogOverflow:d.scrollWidth>d.clientWidth+1,width:d.getBoundingClientRect().width};});
 assert.equal(geometry.overflow,false);assert.equal(geometry.dialogOverflow,false);assert.ok(geometry.width<=960);
 await page.locator('[data-goal=current]').fill('2');await page.getByRole('button',{name:'目標を保存',exact:true}).click();await page.getByText('保存しました。',{exact:true}).waitFor();
 assert.equal(writes.at(-1).body.plan.goals[0].current,2);
 const review=page.locator('form[data-review="day14"]');for(const {key} of definitions)await review.locator('[name='+key+']').selectOption('good');await review.locator('[name=decision]').selectOption('hold');await review.locator('[name=note]').fill('担当者が判断する');await review.getByRole('button',{name:'評価を保存',exact:true}).click();await page.getByText('保存しました。',{exact:true}).waitFor();assert.equal(writes.at(-1).body.action,'review');
 const closeBox=await page.locator('#learning-close').boundingBox();assert.ok(closeBox.y>=0&&closeBox.y+closeBox.height<=900,'close stays visible while detail scrolls');
 await page.screenshot({path:shotPath('learning-'+width+'.png')});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#learning-dialog').evaluate(d=>d.open),false);
 await page.getByRole('button',{name:item.name,exact:true}).click();await page.locator('#learning-dialog[open]').waitFor();assert.equal(await page.locator('#learning-dialog').evaluate(d=>d.scrollTop),0,'reopened details start at the learning overview');await page.keyboard.press('Escape');
 await page.goto(BASE+'/hr/applicants.html');const icon=page.locator('[data-learning-id="'+A+'"]').first();await icon.waitFor();
 for(const checkWidth of width===1440?[1440,1280,1101,1024,768]:[390,320]){
  await page.setViewportSize({width:checkWidth,height:900});
  const geometry=await page.locator('.hr-doc-actions').first().evaluate(group=>{const bs=[...group.querySelectorAll('button')].map(b=>b.getBoundingClientRect()),cell=group.closest('td').getBoundingClientRect();return {count:bs.length,sameTop:Math.max(...bs.map(b=>b.top))-Math.min(...bs.map(b=>b.top)),sameWidth:Math.max(...bs.map(b=>b.width))-Math.min(...bs.map(b=>b.width)),sameHeight:Math.max(...bs.map(b=>b.height))-Math.min(...bs.map(b=>b.height)),inside:bs.every(b=>b.left>=cell.left&&b.right<=cell.right+1),pageOverflow:document.documentElement.scrollWidth>innerWidth+1};});
  assert.equal(geometry.count,6);assert.ok(geometry.sameTop<1,checkWidth+'px icons stay in one row');assert.ok(geometry.sameWidth<1&&geometry.sameHeight<1,checkWidth+'px equal icon boxes');assert.equal(geometry.inside,true,checkWidth+'px icons fit inside the document cell');assert.equal(geometry.pageOverflow,false,checkWidth+'px no horizontal page overflow');
 }
 await page.setViewportSize({width,height:900});await page.locator('.hr-doc-actions').first().screenshot({path:shotPath('hr-document-icons-'+width+'.png')});await icon.hover();assert.equal(writes.length,2,'hover is read-only');await icon.click();await page.waitForFunction(()=>document.querySelector('[data-learning-id]')?.getAttribute('aria-pressed')==='false');assert.equal(writes.length,3);assert.equal(writes.at(-1).path,'/api/hr/learning');assert.equal(writes.at(-1).body.action,'participation');assert.equal(await page.locator('#hr-detail-box').count(),0,'icon never opens applicant detail');
 assert.deepEqual(errors,[]);await context.close();await browser.close();console.log('HR learning browser '+width+'px: roles, click-only details, separate progress, goals, five-item review, icon isolation, no overflow passed');
}}finally{await browser?.close();}
