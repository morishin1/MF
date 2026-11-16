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
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',C='cccccccc-cccc-4ccc-8ccc-cccccccccccc',D='dddddddd-dddd-4ddd-8ddd-dddddddddddd',E='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',Z='ffffffff-ffff-4fff-8fff-ffffffffffff',F='12121212-1212-4121-8121-121212121212',G='13131313-1313-4131-8131-131313131313',H='14141414-1414-4141-8141-141414141414';
const base={createdAt:'2026-11-14T01:23:00Z',updatedAt:'2026-11-14T01:23:00Z',source:'Wantedly',note:'',docs:{resume:false,workHistory:false},recruiterName:'架空 担当'};
const people=()=>[
 // A：予定日時が過去でも、実施済みと決めつけず面談・評価へ進む
 {...base,id:A,name:'応募者A',jobTitle:'営業',email:'a@example.test',profileUrl:'https://www.wantedly.com/id/applicant_a',stage:'casual_interview',status:'interview_scheduled',statusLabel:'面談予定',nextActionKey:'conduct',nextActionCta:'面談を実施済みにする',nextInterviewId:'iv-a',nextInterviewKind:'casual',nextInterviewAt:'2026-11-10T01:00:00Z',docs:{resume:true,workHistory:false}},
 // B：メール未登録・面談なし → 面談を設定する（メール登録は補助）
 {...base,id:B,name:'応募者B',jobTitle:'エンジニア',email:null,profileUrl:'https://portfolio.example.test/b',stage:'applied',status:'todo',statusLabel:'未対応',nextAction:'日程調整を送る前に、メールアドレスを登録してください',nextActionKey:'registerEmail',nextActionCta:'メールアドレスを登録'},
 // C：面談実施済み・評価待ち → 面談記録を確認する
 {...base,id:C,name:'応募者C',jobTitle:'営業',email:'c@example.test',profileUrl:null,stage:'casual_interview',status:'eval_pending',statusLabel:'評価待ち',nextActionKey:'evaluate',nextActionCta:'評価を入力'},
 // D：面談が取消され日程調整へ戻った → 開始は出さない
 {...base,id:D,name:'応募者D',jobTitle:'営業',email:'d@example.test',profileUrl:'javascript:alert(1)',stage:'applied',status:'scheduling',statusLabel:'日程調整中',nextActionKey:'schedule',nextActionKind:'casual',nextActionCta:'手動で面談を設定'},
 // E：予定状態だが有効な面談記録が無い → 開始は出さない
 {...base,id:E,name:'応募者E',jobTitle:'営業',email:'e@example.test',stage:'casual_interview',status:'interview_scheduled',statusLabel:'面談予定',nextActionKey:'checkInterviews',nextActionCta:'面談タブを確認',nextInterviewId:null,nextInterviewAt:null},
 // F：最終面談の予定あり → 主ボタンは面談・評価、最終面談の案内は補助
 {...base,id:F,name:'応募者F',jobTitle:'営業',email:'f@example.test',stage:'ceo_interview',status:'interview_scheduled',statusLabel:'面談予定',nextActionKey:'conduct',nextActionCta:'面談を実施済みにする',nextInterviewId:'iv-f',nextInterviewKind:'ceo',nextInterviewAt:'2026-11-21T05:30:00Z'},
 // G：Officeへ引継ぎ済み（記録あり）／H：引継ぎ済みだが担当者・日時の記録が無い
 {...base,id:G,name:'応募者G',jobTitle:'営業',email:'g@example.test',stage:'joining_scheduled',status:'accepted',statusLabel:'承諾済み',handoffState:'done',offerType:'executive_employee'},
 {...base,id:H,name:'応募者H',jobTitle:'営業',email:'h@example.test',stage:'joining_scheduled',status:'accepted',statusLabel:'承諾済み',handoffState:'done',offerType:'executive_employee'},
 // Z：見送り済み → 通常一覧には出さない
 {...base,id:Z,name:'終了者Z',jobTitle:'営業',email:'z@example.test',stage:'applied',status:'passed',decision:'rejected',statusLabel:'見送り'},
];
const interviews={
 [A]:[{id:'iv-a',applicantId:A,kind:'casual',kindLabel:'カジュアル面談',scheduledAt:'2026-11-10T01:00:00Z',memo:'',done:false,canceled:false,meetingUrl:'https://meet.google.com/aaa-bbbb-ccc'}],
 [B]:[],
 [C]:[{id:'iv-c',applicantId:C,kind:'casual',kindLabel:'カジュアル面談',scheduledAt:'2026-11-10T01:00:00Z',conductedAt:'2026-11-10T01:40:00Z',memo:'記録済み',done:true,canceled:false}],
 [D]:[{id:'iv-d',applicantId:D,kind:'casual',kindLabel:'カジュアル面談',scheduledAt:'2026-11-18T01:00:00Z',memo:'',done:false,canceled:true}],
 [E]:[],[Z]:[],
 [F]:[{id:'iv-f',applicantId:F,kind:'ceo',kindLabel:'最終面談',scheduledAt:'2026-11-21T05:30:00Z',memo:'',done:false,canceled:false}],
};
const browser=await launch();
const shots=[];
async function open(me,width,height=900){
 const context=await browser.newContext({viewport:{width,height},timezoneId:'Asia/Tokyo',deviceScaleFactor:SCALE});
 const state={rows:people(),writes:[],created:null,failSave:false,holdSave:null};
 // 埋め込み（sandbox付きiframe）の中では localStorage に触れないので、そこでは何もしない
 await context.addInitScript(email=>{try{localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email}));}catch{}},me.email);
 await context.route('**/*',async route=>{
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
   const id=b?.id||url.searchParams.get('id'),applicant=state.rows.find(a=>a.id===id);
   if(b){if(state.holdSave)await state.holdSave;if(state.failSave)return send({hint:'保存に失敗しました'},403);applicant.profileUrl=b.profileUrl;return send({applicant});}
   if(!applicant)return send({error:'not_found'},404);
   const offers=id===G?[{id:'offer-g',applicantId:G,offerType:'executive_employee',status:'accepted',handoffReady:true,handoffAt:'2026-11-13T02:30:00Z',handoffByName:'架空 人事'}]:[];
   return send({applicant,interviews:interviews[id]||[],offers,timeline:[],salaryVisible:true,interviewers:[],stepMoves:{current:applicant.stage,options:[]}});
  }
  if(url.pathname==='/api/hr/applicants'){
   if(b){const created={...base,id:'99999999-9999-4999-8999-999999999999',name:b.name,jobTitle:b.jobTitle,source:b.source,email:b.email||null,profileUrl:b.profileUrl||null,stage:'applied',status:'todo',statusLabel:'未対応',nextActionKey:b.email?'sendSchedulingLink':'registerEmail',nextActionCta:b.email?'日程調整を送る':'メールアドレスを登録'};state.created=b;state.rows.push(created);interviews[created.id]=[];return send({applicant:created});}
   return send({applicants:state.rows,employees:[],jobTitles:{options:['営業','エンジニア','マーケティング']}});
  }
  if(url.pathname==='/api/hr/documents'){
   const id=url.searchParams.get('applicantId');
   return send({documents:[{docType:'resume',label:'履歴書',icon:'description',latest:id===A?{id:'doc-a',filename:'A-履歴書.pdf',mimeType:'application/pdf'}:null,history:[]},{docType:'work_history',label:'職務経歴書',icon:'work_history',latest:null,history:[]},{docType:'skill_sheet',label:'スキルシート',icon:'assignment_ind',latest:null,history:[]}]});
  }
  if(url.pathname==='/api/hr/applicants/lms-trial'){if(b)return send({error:'test_only'},409);const id=url.searchParams.get('id'),p=state.rows.find(a=>a.id===id);return send({available:true,configured:true,missing:[],applicant:{id,name:p?.name,email:p?.email},interviewDone:id===C,mail:{configured:true,reason:null,from:'採用 <recruit@example.test>'},draft:{subject:'面談のお礼と体験のご案内',body:'本文 {{無限道場体験URL}}',existing:false,missing:[]},sends:[],lms:{ok:true,stage:{key:'none',label:'未案内'}}});}
  if(url.pathname==='/api/hr/interviews/today')return send({interviews:[]});
  if(url.pathname==='/api/hr/interviews')return send({ok:true,interview:interviews[A][0]});
  if(url.pathname==='/api/notifications')return send({notifications:[],unread:0});
  return send({});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
 return {context,page,errors,state};
}

try {
 for (const width of [1440,390]) {
  const {context,page,state,errors}=await open(staff,width);
  const openProfile=async id=>{await page.locator(`[data-profile="${id}"]`).click();await page.locator('#hr-profile-edit-url').waitFor();};
  const close=()=>page.locator('#hr-profile-modal').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.goto(BASE+'/hr/applicants.html');await page.locator('[data-profile]').first().waitFor();
  const original=JSON.parse(JSON.stringify(state.rows));
  await openProfile(C);
  await page.locator('#hr-profile-edit-url').fill('https://www.wantedly.com/id/new_profile');
  await page.locator('#hr-profile-save').click();await page.locator('#hr-profile-save-msg').filter({hasText:'保存しました'}).waitFor();
  assert.equal(await page.locator('#hr-profile-open').getAttribute('href'),'https://www.wantedly.com/id/new_profile');
  assert.deepEqual(state.writes.filter(w=>w.path.endsWith('/detail')).map(w=>w.body),[{id:C,profileUrl:'https://www.wantedly.com/id/new_profile'}]);
  await close();await openProfile(C);assert.equal(await page.locator('#hr-profile-edit-url').inputValue(),'https://www.wantedly.com/id/new_profile');
  await page.locator('#hr-profile-edit-url').fill('javascript:alert(1)');await page.locator('#hr-profile-save').click();
  await page.locator('#hr-profile-save-msg').filter({hasText:'入力してください'}).waitFor();
  assert.equal(state.writes.filter(w=>w.path.endsWith('/detail')).length,1);
  state.failSave=true;await page.locator('#hr-profile-edit-url').fill('https://www.wantedly.com/id/changed');await page.locator('#hr-profile-save').click();
  await page.locator('#hr-profile-save-msg').filter({hasText:'保存に失敗'}).waitFor();
  assert.equal(await page.locator('#hr-profile-edit-url').inputValue(),'https://www.wantedly.com/id/changed');
  state.failSave=false;let release;state.holdSave=new Promise(r=>release=r);
  await page.locator('#hr-profile-save').click();assert.ok(await page.locator('#hr-profile-save').isDisabled());assert.ok(await page.locator('#hr-profile-edit-url').isDisabled());
  await page.evaluate(()=>saveProfileUrl());assert.equal(state.writes.filter(w=>w.path.endsWith('/detail')).length,3);
  await close();await openProfile(A);release();state.holdSave=null;
  await page.waitForTimeout(100);assert.equal(await page.locator('#hr-profile-modal').getAttribute('data-applicant'),A);
  assert.equal(await page.locator('#hr-profile-edit-url').inputValue(),original[0].profileUrl);
  await close();await openProfile(C);assert.equal(await page.locator('#hr-profile-edit-url').inputValue(),'https://www.wantedly.com/id/changed');
  await page.locator('#hr-profile-edit-url').fill('');await page.locator('#hr-profile-save').click();await page.locator('#hr-profile-save-msg').filter({hasText:'保存しました'}).waitFor();
  assert.equal(state.rows.find(a=>a.id===C).profileUrl,null);
  assert.deepEqual(state.rows,original,'プロフィール以外・他応募者は不変（追加後クリア）');
  await page.screenshot({path:shotPath('hr-wantedly-'+width+'.png')});
  assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS profile add/edit/reopen/clear, validation, errors, duplicate clicks and navigation isolation at desktop/mobile');
}finally{await browser.close();}
