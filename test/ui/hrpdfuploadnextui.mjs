// HR NEXTからPDFだけをアップロードする導線。架空応募者・架空ストレージのみ。
import assert from 'node:assert/strict';
import { launch, BASE } from '../_browser.mjs';

const br=await launch();
const A='11111111-1111-4111-8111-111111111111';
const me={email:'hr@example.test',isAdmin:true,appRole:'admin',
  gw:{tenantId:'tenant-test',isAdmin:true,roles:['owner'],employee:{id:'owner',display_name:'架空担当'}},
  access:{recruit:true,officeHr:true}};
async function checkScenario({width,key,stage='offer',status='offer_draft_pending',kind,label,salaryVisible=true,drop=false}){
 const context=await br.newContext({viewport:{width,height:900}});
 await context.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'hr@example.test'})));
 const a={id:A,name:'架空 応募者',source:'テスト媒体',jobTitle:'事務',stage,
   status,stageLabel:stage==='offer'?'合格通知':'雇用契約',statusLabel:'準備中',
   decision:'hired',nextActionKey:key,nextActionCta:'従来のボタン',offerType:'executive_employee',docs:{}};
 const posted=[],uploaded=[],errors=[];
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
 await context.route('**/*',route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname.startsWith('/__synthetic_upload/')){uploaded.push({method:req.method(),body:req.postDataBuffer()});return route.fulfill({status:200,body:'{}'});}
  if(!url.pathname.startsWith('/api/')){
   if(url.origin!==new URL(BASE).origin)return route.abort();return route.continue();
  }
  const send=(body,statusCode=200)=>route.fulfill({status:statusCode,contentType:'application/json',body:JSON.stringify(body)});
  let body={};try{body=req.postDataJSON()||{};}catch{}
  if(req.method()!=='GET')posted.push({path:url.pathname,body});
  if(url.pathname==='/api/me')return send(me);
  if(url.pathname==='/api/hr/applicants/detail')return send({applicant:a,interviews:[],offers:[],timeline:[],salaryVisible});
  if(url.pathname==='/api/hr/applicants')return send({applicants:[a],employees:[],leadReady:true});
  if(url.pathname==='/api/hr/documents')return send({documents:[],limits:{}});
  if(url.pathname==='/api/hr/candidate-documents'){
   if(req.method()==='GET')return send({ready:true,applicant:{id:A,name:a.name},documents:[],canUpload:true,canPublish:false});
   if(body.action==='prepare')return send({path:'tenant-test/candidates/'+A+'/staging/fixture.pdf',uploadUrl:BASE+'/__synthetic_upload/fixture'});
   if(body.action==='attach')return send({ok:true,document:{id:'doc-1',kind:body.kind,filename:body.fileName,status:'draft',version:1}});
   return send({error:'unexpected_action'},400);
  }
  if(url.pathname==='/api/hr/applicant-state')return send({states:[]});
  if(url.pathname==='/api/notifications')return send({notifications:[],unread:0});
  return send({});
 });
 await page.goto(BASE+'/hr/applicants.html');
 const next=page.locator('#rows [data-applicant="'+A+'"] .hr-list-cta');await next.waitFor();
 assert.ok((await next.innerText()).includes(label),'NEXTを読むだけで目的が分かる');
 await next.click();await page.locator('.hr-pdf-work-modal').waitFor();
 assert.equal(await page.locator('.hr-pdf-work-modal').count(),1,'PDFモーダルは1枚');
 assert.ok((await page.locator('.hr-work-heading').innerText()).includes('PDFをアップロード'));
 assert.equal(await page.locator('.hr-work-state,#hr-work-primary,#hr-notice-create,[data-kind]').count(),0,'不要な状態変更や自動作成ボタンは表示しない');
 if(salaryVisible){
  await page.locator('[data-drop]').waitFor();
  assert.equal(await page.locator('[data-drop]').count(),1,'ドロップエリア1つ');
  assert.equal(await page.locator('[data-action="upload"]').count(),1,'アップロードボタンは1つ');
  assert.equal(await page.locator('[data-action="upload"]').isDisabled(),true,'ファイル未選択なら送らない');
  if(drop){
   await page.evaluate(()=>{
    const file=new File([new Uint8Array(160).fill(37)],'契約書.pdf',{type:'application/pdf'});
    const dt=new DataTransfer();dt.items.add(file);
    document.querySelector('[data-drop]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
   });
  }else{
   await page.locator('[data-file]').setInputFiles({name:'合格通知.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\n'+'.'.repeat(180))});
  }
  assert.equal(await page.locator('[data-action="upload"]').isEnabled(),true,'選択でボタンを有効化');
  await page.locator('[data-action="upload"]').click();
  await page.locator('[data-message]').filter({hasText:'アップロードしました'}).waitFor();
  assert.equal(uploaded.length,1,'PDF実体は一度だけ送る');
  assert.deepEqual(posted.filter(x=>x.path==='/api/hr/candidate-documents').map(x=>x.body.action),['prepare','attach']);
  assert.equal(posted.find(x=>x.body.action==='attach')?.body.kind,kind,'対象の書類種類を固定');
  assert.ok(!(await page.locator('.hr-pdf-work-modal').innerText()).includes('本人に公開する'),'アップロードから公開・送信へ直結しない');
 }else{
  assert.equal(await page.locator('[data-action="upload"]').count(),0,'給与権限がない人はアップロード操作不可');
  assert.match(await page.locator('.hr-pdf-work-modal').innerText(),/権限が必要/);
 }
 assert.ok(!posted.some(x=>['send','publish','confirm','handoff'].includes(x.body.action)),'本人へ送信・公開・合意・Office引継ぎを行わない');
 // NEXTは1つのアップロード画面。名前からは従来の情報・履歴にアクセスできる。
 await page.locator('.hr-pdf-work-modal').getByRole('button',{name:'閉じる',exact:true}).click();
 await page.locator('#rows [data-applicant="'+A+'"] .hr-nm').click();
 await page.locator('.hr-detail #hr-detail-tab').waitFor();
 assert.equal(await page.locator('#hr-detail-recruitment-type').count(),1,'応募者名から詳細へ進み、採用予定区分を確認できる');
 assert.deepEqual(errors,[],'ブラウザエラーなし');
 await context.close();
}
try{
 await checkScenario({width:1440,key:'createOffer',kind:'offer',label:'合格通知PDFをアップロード'});
 await checkScenario({width:390,key:'reviewOffer',kind:'offer',label:'合格通知PDFをアップロード',drop:true});
 await checkScenario({width:1440,key:'createOffer',kind:'offer',label:'合格通知PDFをアップロード',salaryVisible:false});
 console.log('PASS HR NEXT: precise labels, drag-drop/file selection, one upload, fixed applicant/kind, no publish or send, permission gate');
}finally{await br.close();}
