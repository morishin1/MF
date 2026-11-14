// HR 採用管理UIの受入テスト（共通ヘッダー7項目／応募者ごとのNEXT／応募者別の面談起動／プロフィール／登録）。
// 架空データのみ。本番データ・メール・Slack・AIは一切使わない。
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
// 画面写真を人が見るとき用：HR_SHOT_FONTS にアイコンフォント（sym.css / sym.woff2）を置いたフォルダを渡すと、
// 外部へ出ずにそのファイルを返す。指定が無ければ外部への通信はすべて遮断する（判定には影響しない）。
const FONT_DIR=process.env.HR_SHOT_FONTS&&existsSync(join(process.env.HR_SHOT_FONTS,'sym.woff2'))?process.env.HR_SHOT_FONTS:null;
const SCALE=Number(process.env.HR_SHOT_SCALE)||1;

const owner={userId:'u1',email:'hr@example.test',access:{recruit:true,officeHr:true},isAdmin:true,gw:{roles:['owner'],isAdmin:true,tenantId:'tenant',employee:{id:'emp',display_name:'架空 担当'}}};
const staff={userId:'u2',email:'staff@example.test',access:{recruit:true},isAdmin:false,gw:{roles:['recruiter'],isAdmin:false,tenantId:'tenant',employee:{id:'emp2',display_name:'架空 採用担当'}}};
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc',D='dddddddd-dddd-4ddd-8ddd-dddddddddddd',E='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',Z='ffffffff-ffff-4fff-8fff-ffffffffffff';
const base={createdAt:'2026-11-14T01:23:00Z',updatedAt:'2026-11-14T01:23:00Z',source:'Wantedly',note:'',docs:{resume:false,workHistory:false},recruiterName:'架空 担当'};
const people=()=>[
 // A：カジュアル面談の予定あり → 面談を開始する
 {...base,id:A,name:'応募者A',jobTitle:'営業',email:'a@example.test',profileUrl:'https://www.wantedly.com/id/applicant_a',stage:'casual_interview',status:'interview_scheduled',statusLabel:'面談予定',nextActionKey:'conduct',nextActionCta:'面談を実施済みにする',nextInterviewId:'iv-a',nextInterviewKind:'casual',nextInterviewAt:'2026-11-20T01:00:00Z',docs:{resume:true,workHistory:false}},
 // B：メール未登録・面談なし → 面談を設定する（メール登録は補助）
 {...base,id:B,name:'応募者B',jobTitle:'エンジニア',email:null,profileUrl:'https://portfolio.example.test/b',stage:'applied',status:'todo',statusLabel:'未対応',nextAction:'日程調整を送る前に、メールアドレスを登録してください',nextActionKey:'registerEmail',nextActionCta:'メールアドレスを登録'},
 // C：面談実施済み・評価待ち → 面談記録を確認する
 {...base,id:C,name:'応募者C',jobTitle:'営業',email:'c@example.test',profileUrl:null,stage:'casual_interview',status:'eval_pending',statusLabel:'評価待ち',nextActionKey:'evaluate',nextActionCta:'評価を入力'},
 // D：面談が取消され日程調整へ戻った → 開始は出さない
 {...base,id:D,name:'応募者D',jobTitle:'営業',email:'d@example.test',profileUrl:'javascript:alert(1)',stage:'applied',status:'scheduling',statusLabel:'日程調整中',nextActionKey:'schedule',nextActionKind:'casual',nextActionCta:'手動で面談を設定'},
 // E：予定状態だが有効な面談記録が無い → 開始は出さない
 {...base,id:E,name:'応募者E',jobTitle:'営業',email:'e@example.test',stage:'casual_interview',status:'interview_scheduled',statusLabel:'面談予定',nextActionKey:'checkInterviews',nextActionCta:'面談タブを確認',nextInterviewId:null,nextInterviewAt:null},
 // Z：見送り済み → 通常一覧には出さない
 {...base,id:Z,name:'終了者Z',jobTitle:'営業',email:'z@example.test',stage:'applied',status:'passed',decision:'rejected',statusLabel:'見送り'},
];
const interviews={
 [A]:[{id:'iv-a',applicantId:A,kind:'casual',kindLabel:'カジュアル面談',scheduledAt:'2026-11-20T01:00:00Z',memo:'',done:false,canceled:false,meetingUrl:'https://meet.google.com/aaa-bbbb-ccc'}],
 [B]:[],
 [C]:[{id:'iv-c',applicantId:C,kind:'casual',kindLabel:'カジュアル面談',scheduledAt:'2026-11-10T01:00:00Z',conductedAt:'2026-11-10T01:40:00Z',memo:'記録済み',done:true,canceled:false}],
 [D]:[{id:'iv-d',applicantId:D,kind:'casual',kindLabel:'カジュアル面談',scheduledAt:'2026-11-18T01:00:00Z',memo:'',done:false,canceled:true}],
 [E]:[],[Z]:[],
};
const browser=await launch();
const shots=[];
async function open(me,width,height=900){
 const context=await browser.newContext({viewport:{width,height},timezoneId:'Asia/Tokyo',deviceScaleFactor:SCALE});
 const state={rows:people(),writes:[],created:null};
 // 埋め込み（sandbox付きiframe）の中では localStorage に触れないので、そこでは何もしない
 await context.addInitScript(email=>{try{localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email}));}catch{}},me.email);
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());
  if(FONT_DIR&&url.hostname==='fonts.googleapis.com')return route.fulfill({status:200,contentType:'text/css',body:readFileSync(join(FONT_DIR,'sym.css'),'utf8').replace(/url\([^)]*\)/,'url(https://fonts.gstatic.com/sym.woff2)')});
  if(FONT_DIR&&url.hostname==='fonts.gstatic.com')return route.fulfill({status:200,contentType:'font/woff2',headers:{'access-control-allow-origin':'*'},body:readFileSync(join(FONT_DIR,'sym.woff2'))});
  if(url.origin!==new URL(BASE).origin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const send=(b,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(b)});
  const b=req.method()==='GET'?null:req.postDataJSON();if(b)state.writes.push({path:url.pathname,body:b});
  if(url.pathname==='/api/me')return send(me);
  if(url.pathname==='/api/hr/applicant-state')return send(b?{ok:true}:{states:[]});
  if(url.pathname==='/api/hr/applicants/detail'){
   const id=url.searchParams.get('id'),applicant=state.rows.find(a=>a.id===id);
   if(!applicant)return send({error:'not_found'},404);
   return send({applicant,interviews:interviews[id]||[],offers:[],timeline:[],salaryVisible:true,interviewers:[],stepMoves:{current:applicant.stage,options:[]}});
  }
  if(url.pathname==='/api/hr/applicants'){
   if(b){const created={...base,id:'99999999-9999-4999-8999-999999999999',name:b.name,jobTitle:b.jobTitle,source:b.source,email:b.email||null,profileUrl:b.profileUrl||null,stage:'applied',status:'todo',statusLabel:'未対応',nextActionKey:b.email?'sendSchedulingLink':'registerEmail',nextActionCta:b.email?'日程調整を送る':'メールアドレスを登録'};state.created=b;state.rows.push(created);interviews[created.id]=[];return send({applicant:created});}
   return send({applicants:state.rows,employees:[],jobTitles:{options:['営業','エンジニア','マーケティング']}});
  }
  if(url.pathname==='/api/hr/documents'){
   const id=url.searchParams.get('applicantId');
   return send({documents:[{docType:'resume',label:'履歴書',icon:'description',latest:id===A?{id:'doc-a',filename:'A-履歴書.pdf',mimeType:'application/pdf'}:null,history:[]},{docType:'work_history',label:'職務経歴書',icon:'work_history',latest:null,history:[]},{docType:'skill_sheet',label:'スキルシート',icon:'assignment_ind',latest:null,history:[]}]});
  }
  if(url.pathname==='/api/hr/interviews/today')return send({interviews:[]});
  if(url.pathname==='/api/hr/interviews')return send({ok:true,interview:interviews[A][0]});
  if(url.pathname==='/api/notifications')return send({notifications:[],unread:0});
  return send({});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
 return {context,page,errors,state};
}
const LABELS=['ダッシュボード','応募者管理','採用判断','応募分析','採用資料','メールひな型','操作マニュアル'];
const navLabels=page=>page.locator('.hr-nav a').evaluateAll(ns=>ns.map(n=>[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent).join('').trim()));
const shot=async(page,name)=>{const p=shotPath(name);if(FONT_DIR)await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:p});shots.push(p);};
try{
 // ---- PCヘッダー：7項目が1つのヘッダー・1行に収まる ----
 for(const width of [1440,1280]){
  const {context,page,errors}=await open(owner,width);
  await page.goto(BASE+'/hr/dashboard.html');await page.locator('.hr-nav a').first().waitFor();
  assert.deepEqual(await navLabels(page),LABELS,width+'px：7項目・指定の順');
  assert.equal(await page.locator('.hr-bar').count(),1,'ヘッダーは1つ');assert.equal(await page.locator('.hr-nav').count(),1,'ナビは1つ（重複なし）');
  const bodyText=await page.locator('.hr-bar').innerText();
  for(const banned of ['その他','面談ナビ','トライアル','内定・契約'])assert.ok(!bodyText.includes(banned),banned+' はヘッダーに出ない');
  const geometry=await page.evaluate(()=>{const nav=document.querySelector('.hr-nav'),tops=[...nav.querySelectorAll('a')].map(a=>Math.round(a.getBoundingClientRect().top));const bar=document.querySelector('.hr-bar').getBoundingClientRect();return {oneRow:new Set(tops).size===1,fits:nav.scrollWidth<=nav.clientWidth+1,barHeight:Math.round(bar.height),pageOverflow:document.documentElement.scrollWidth>window.innerWidth+1};});
  assert.deepEqual(geometry,{oneRow:true,fits:true,barHeight:56,pageOverflow:false},width+'px：1行に収まり横にはみ出さない');
  assert.equal(await page.locator('.hr-actions .hr-manual').count(),0,'マニュアルの重複ボタンなし');
  await shot(page,'hr-header-'+width+'.png');
  // 現在位置
  for(const [path,label] of [['/hr/dashboard.html','ダッシュボード'],['/hr/applicants.html','応募者管理'],['/hr/','応募分析'],['/hr/materials.html','採用資料'],['/hr/templates.html','メールひな型'],['/hr/interviews.html','応募者管理'],['/hr/trials.html','応募者管理'],['/hr/contracts.html','応募者管理'],['/hr/intake.html','応募者管理']]){
   await page.goto(BASE+path);await page.locator('.hr-nav a').first().waitFor();
   const on=await page.locator('.hr-nav a.on').allInnerTexts();
   assert.equal(on.length,1,path+' は1項目だけ選択');assert.ok(on[0].includes(label),path+' → '+label+'（いま '+on[0]+'）');
   assert.equal(await page.locator('.hr-nav a[aria-current="page"]').count(),1);
   assert.equal((await navLabels(page)).length,7,path+' も同じ7項目');
  }
  // 操作マニュアル：既存URLへ同じタブで移動し、ブラウザの戻るで戻れる
  await page.goto(BASE+'/hr/applicants.html');await page.locator('.hr-nav a[data-nav="manual"]').click();await page.waitForURL('**/guide-hr-office.html#hr');
  await page.goBack();await page.waitForURL('**/hr/applicants.html');
  assert.deepEqual(errors,[]);await context.close();
 }
 // ---- モバイル：横スクロールで全項目に届く・重複ナビなし ----
 {
  const {context,page,errors}=await open(owner,390,844);
  await page.goto(BASE+'/hr/applicants.html');await page.locator('#rows [data-applicant]').first().waitFor();
  assert.deepEqual(await navLabels(page),LABELS);assert.equal(await page.locator('.hr-nav').count(),1);
  const m=await page.evaluate(()=>{const nav=document.querySelector('.hr-nav');return {scrolls:nav.scrollWidth>nav.clientWidth,overflowX:getComputedStyle(nav).overflowX,minTap:Math.min(...[...nav.querySelectorAll('a')].map(a=>a.getBoundingClientRect().height)),pageOverflow:[...document.querySelector('.hr-bar').children].some(n=>n!==nav&&n.getBoundingClientRect().right>window.innerWidth+1)||document.querySelector('.hr-bar').getBoundingClientRect().right>window.innerWidth+1};});
  assert.equal(m.scrolls,true);assert.equal(m.overflowX,'auto');assert.ok(m.minTap>=44,'タップ領域44px以上');assert.equal(m.pageOverflow,false,'ヘッダーの部品が画面の外へはみ出さない');
  for(const key of ['manual','templates','home']){const link=page.locator('.hr-nav a[data-nav="'+key+'"]');await link.scrollIntoViewIfNeeded();const box=await link.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=390+1,key+' まで横スクロールで届く');}
  await shot(page,'hr-header-390.png');
  await page.locator('.hr-nav a[data-nav="manual"]').click();await page.waitForURL('**/guide-hr-office.html#hr');
  assert.deepEqual(errors,[]);await context.close();
 }
 // ---- 権限：採用判断は許可されたユーザーだけ。直接URLでも入れない ----
 {
  const {context,page}=await open(staff,1280);
  await page.goto(BASE+'/hr/applicants.html');await page.locator('#rows [data-applicant]').first().waitFor();
  assert.deepEqual(await navLabels(page),LABELS.filter(l=>l!=='採用判断'));
  await page.goto(BASE+'/hr/ceo-review.html');await page.waitForURL('**/hr/applicants.html');
  await context.close();
 }
 // ---- 応募者一覧・NEXT・面談・プロフィール・登録 ----
 for(const width of [1440,390]){
  const {context,page,errors,state}=await open(owner,width,1000);
  await page.goto(BASE+'/hr/applicants.html');await page.locator('#rows [data-applicant]').first().waitFor();
  assert.deepEqual(await page.locator('#thead th').allTextContents(),['','登録日時','応募者・職種','プロフィール','現在の状態','書類','社内メモ','NEXT','担当者']);
  const row=id=>page.locator('#rows [data-applicant="'+id+'"]');
  assert.equal(await row(Z).count(),0,'終了者は通常一覧に出ない');
  assert.match(await row(A).locator('td').nth(1).textContent(),/2026\/11\/14 10:23/,'登録日時');
  assert.equal(await row(A).locator('[data-current-state]').count(),1,'現在の状態は1つ');
  for(const [id,label] of [[A,'面談を開始する'],[B,'面談を設定する'],[C,'評価を入力'],[D,'手動で面談を設定'],[E,'面談タブを確認']]){
   assert.equal(await row(id).locator('.hr-list-cta').count(),1,'NEXTは1つ');
   assert.ok((await row(id).locator('.hr-list-cta').innerText()).includes(label),id+' のNEXT：'+label);
  }
  for(const id of [B,C,D,E])assert.ok(!(await row(id).locator('.hr-list-cta').innerText()).includes('面談を開始'),'予定なし・実施済み・取消では開始を出さない');
  if(width===1440)await shot(page,'hr-applicants-list-1440.png');

  // A：対応モーダル → Aの面談IDへ。Bの情報は出ない
  await row(A).locator('.hr-list-cta').click();await page.locator('.hr-work-modal #hr-work-primary').waitFor();
  assert.equal(await page.locator('[role="dialog"]:visible').count(),1,'モーダルは1枚');
  const order=await page.locator('.hr-work-modal').evaluate(n=>['.hr-work-heading','#hr-work-meta','.hr-work-state','.hr-work-task','#hr-work-primary','#hr-work-links'].map(s=>n.querySelector(s).getBoundingClientRect().top));
  assert.deepEqual(order,[...order].sort((x,y)=>x-y),'表示順は固定');
  assert.match(await page.locator('#hr-work-meta').innerText(),/営業[\s\S]*Wantedly[\s\S]*2026\/11\/14/);
  assert.equal(await page.locator('.hr-work-modal .hr-work-primary').count(),1,'主ボタンは1つ');
  assert.equal((await page.locator('#hr-work-primary').innerText()).includes('面談を開始する'),true);
  assert.equal(await page.locator('#hr-work-primary').getAttribute('href'),'/hr/interviews.html?applicantId='+A+'&interviewId=iv-a');
  assert.deepEqual(await page.locator('#hr-work-links button').evaluateAll(ns=>ns.map(n=>[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent).join('').trim())),['応募者情報','プロフィール','書類・契約','連絡・履歴']);
  await shot(page,'hr-work-interview-'+width+'.png');
  // 面談履歴：外部会議URLは補助リンク、主ボタンは面談ナビ
  await page.locator('#hr-work-link-info').click();await page.getByRole('tab',{name:'面談・評価',exact:true}).click();
  const meet=page.getByRole('link',{name:'Google Meetを開く'});assert.match(await meet.getAttribute('class'),/btn-secondary/);
  assert.equal(await page.getByRole('link',{name:'面談を開始する'}).getAttribute('href'),'/hr/interviews.html?applicantId='+A+'&interviewId=iv-a');
  await page.goto(BASE+'/hr/applicants.html');await row(A).waitFor();await row(A).locator('.hr-list-cta').click();await page.locator('#hr-work-primary').click();
  await page.waitForURL('**/hr/interviews.html?applicantId='+A+'&interviewId=iv-a');await page.locator('#iv-root').getByText('応募者A').first().waitFor();
  const navText=await page.locator('body').innerText();assert.ok(!navText.includes('応募者B'),'面談ナビにBの情報は出ない');
  assert.match(await page.locator('.iv-frame-shell iframe').getAttribute('src'),/8grp\.co\.jp\/recruit\/vision/,'資料の初期表示は採用ビジョン');
  if(width===1440)await shot(page,'hr-interview-navigator-1440.png');
  // 他人の面談IDを付けても開かない
  await page.goto(BASE+'/hr/interviews.html?applicantId='+B+'&interviewId=iv-a');await page.getByText('対象となる有効な面談がありません').waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('応募者A'),'Bの画面にAの面談を出さない');
  await page.goto(BASE+'/hr/interviews.html?applicantId='+D+'&interviewId=iv-d');await page.getByText('対象となる有効な面談がありません').waitFor();

  // B：メール未登録でも主ボタンは面談設定。メール登録は補助
  await page.goto(BASE+'/hr/applicants.html');await row(B).waitFor();await row(B).locator('.hr-list-cta').click();await page.locator('#hr-work-primary').waitFor();
  assert.ok((await page.locator('#hr-work-primary').innerText()).includes('面談を設定する'));
  assert.ok((await page.locator('#hr-work-secondary-action').innerText()).includes('メールアドレスを登録する'));
  assert.equal(await page.locator('.hr-work-modal a[href*="interviews.html"]').count(),0,'面談が無い人に開始は出さない');
  await shot(page,'hr-work-schedule-'+width+'.png');
  await page.locator('#hr-work-primary').click();await page.locator('#iv-when').waitFor();
  assert.equal(state.writes.filter(w=>w.path==='/api/hr/interviews').length,0,'開いただけでは面談を作らない');
  await page.locator('#action-root').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.locator('#hr-work-secondary-action').click();await page.locator('#work-email').waitFor();await page.locator('#action-root').getByRole('button',{name:'戻る',exact:true}).click();

  // C：実施済み → 面談記録を確認する（開始は出さない）
  await page.goto(BASE+'/hr/applicants.html');await row(C).waitFor();await row(C).locator('.hr-list-cta').click();await page.locator('#hr-work-record').waitFor();
  assert.equal(await page.locator('#hr-work-record').getAttribute('href'),'/hr/interviews.html?applicantId='+C+'&interviewId=iv-c');
  assert.ok(!(await page.locator('.hr-work-modal').innerText()).includes('面談を開始する'));
  // D・E：取消／記録なし → 開始を出さない
  for(const id of [D,E]){await page.goto(BASE+'/hr/applicants.html');await row(id).waitFor();await row(id).locator('.hr-list-cta').click();await page.locator('.hr-work-modal .hr-work-task').waitFor();
   assert.ok(!(await page.locator('.hr-work-modal').innerText()).includes('面談を開始する'),id+' に開始を出さない');assert.equal(await page.locator('.hr-work-modal a[href*="interviews.html"]').count(),0);}

  // プロフィール：一覧から。Wantedly は埋め込まず別タブ
  await page.goto(BASE+'/hr/applicants.html');await row(A).waitFor();
  await row(A).locator('[data-profile]').click();await page.locator('#hr-profile-open').waitFor();
  assert.equal(await page.locator('#hr-profile-modal').getAttribute('data-applicant'),A);
  assert.equal(await page.locator('#hr-profile-open').getAttribute('href'),'https://www.wantedly.com/id/applicant_a');
  assert.equal(await page.locator('#hr-profile-open').getAttribute('target'),'_blank');assert.match(await page.locator('#hr-profile-open').getAttribute('rel'),/noopener/);
  assert.equal(await page.locator('#hr-profile-frame').count(),0,'埋込不可サイトはiframeにしない');assert.equal(await page.locator('#hr-profile-noembed').count(),1);
  assert.equal(await page.locator('[data-profile-doc="resume"]').count(),1,'登録済みの履歴書');assert.equal(await page.locator('[data-profile-doc-missing="work_history"]').count(),1);
  assert.ok(!(await page.locator('#hr-profile-modal').innerText()).includes('応募者B'));
  assert.equal(await page.locator('[role="dialog"]:visible').count(),1);
  await shot(page,'hr-profile-external-'+width+'.png');
  await page.locator('#hr-profile-modal').getByRole('button',{name:'閉じる',exact:true}).click();
  // B：埋め込めるURLはプレビュー＋別タブ
  await row(B).locator('[data-profile]').click();await page.locator('#hr-profile-frame').waitFor();
  assert.equal(await page.locator('#hr-profile-frame').getAttribute('src'),'https://portfolio.example.test/b');
  assert.ok(!(await page.locator('#hr-profile-frame').getAttribute('sandbox')).includes('allow-same-origin'));
  assert.equal(await page.locator('#hr-profile-open').getAttribute('href'),'https://portfolio.example.test/b');
  assert.equal(await page.locator('#hr-profile-modal').getAttribute('data-applicant'),B);
  await page.locator('#hr-profile-modal').getByRole('button',{name:'閉じる',exact:true}).click();
  // D：許可されないスキームはリンクにも埋込にもしない
  await row(D).locator('[data-profile]').click();await page.locator('#hr-profile-invalid').waitFor();
  assert.equal(await page.locator('#hr-profile-modal a[href^="javascript"]').count(),0);assert.equal(await page.locator('#hr-profile-frame').count(),0);
  await page.locator('#hr-profile-modal').getByRole('button',{name:'閉じる',exact:true}).click();
  // 詳細（対応モーダル）から開いたら、戻ると対応モーダルへ
  await row(A).locator('.hr-list-cta').click();await page.locator('#hr-work-link-profile').click();await page.locator('#hr-profile-open').waitFor();
  await page.locator('#hr-profile-modal').getByRole('button',{name:'戻る',exact:true}).click();
  assert.equal(await page.locator('#hr-profile-modal').count(),0);assert.equal(await page.locator('.hr-work-modal #hr-work-primary').count(),1,'戻り先は対応モーダル');
  await page.locator('#hr-work-link-info').click();await page.locator('#hr-detail-profile').click();await page.locator('#hr-profile-open').waitFor();

  // 応募者登録：職種プルダウン・メール空欄で保存 → その人の「面談を設定する」
  await page.goto(BASE+'/hr/applicants.html?new=1');await page.locator('#a-job').waitFor();
  assert.equal(await page.locator('#a-job').evaluate(n=>n.tagName),'SELECT');
  assert.deepEqual(await page.locator('#a-job option').allTextContents(),['選んでください','営業','エンジニア','マーケティング','その他（職種名を入力）']);
  await page.locator('#a-name').fill('新規 登録');await page.locator('#a-job').selectOption('エンジニア');await page.locator('input[name="a-source"][value="Wantedly"]').check();
  await page.locator('#a-url').fill('javascript:alert(1)');await page.getByRole('button',{name:'追加する',exact:true}).click();
  assert.match(await page.locator('#a-msg').innerText(),/https:\/\//);assert.equal(state.created,null,'不正なURLでは登録しない');
  await page.locator('#a-url').fill('https://www.wantedly.com/id/new_person');
  if(width===1440)await shot(page,'hr-register-1440.png');
  await page.getByRole('button',{name:'追加する',exact:true}).click();await page.locator('.hr-work-modal #hr-work-primary').waitFor();
  assert.equal(state.created.jobTitle,'エンジニア');assert.equal(state.created.email,undefined,'メール空欄で登録できる');assert.equal(state.created.profileUrl,'https://www.wantedly.com/id/new_person');
  assert.ok((await page.locator('.hr-work-heading h2').innerText()).includes('新規 登録'));assert.ok((await page.locator('#hr-work-primary').innerText()).includes('面談を設定する'),'登録後は面談設定が前面');
  // その他の職種も入力できる（既存の自由入力を失わない）
  await page.goto(BASE+'/hr/applicants.html?new=1');await page.locator('#a-job').selectOption('__other');assert.equal(await page.locator('#a-job-other').isVisible(),true);
  // 送信・採否・契約の書き込みは一切発生していない
  assert.equal(state.writes.filter(w=>['send','sendOffer','sendSchedulingLink','decide','conduct'].includes(w.body?.action)||w.body?.decision).length,0,'画面遷移だけで送信・採否変更をしない');
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS HR seven-item header at 1440/1280/390, active item per page, permission-gated decision link and direct URL, retained entries; list columns/one state/one NEXT, closed applicants hidden, applicant-scoped interview launch (A only, never B), no start for none/cancelled/done, interview-first without email, profile preview from list/detail with safe URL and external fallback, job title dropdown and email-optional registration');
 console.log('screenshots:\n'+shots.join('\n'));
}finally{await browser.close();}
