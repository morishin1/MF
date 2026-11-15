// Office書類の操作をPC/スマホで検証。架空応募者・架空Storageのみ。
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {PDFDocument} from 'pdf-lib';

const br=await launch();
const A='11111111-1111-4111-8111-111111111111';
const me={email:'office@example.test',isAdmin:true,appRole:'admin',
  gw:{tenantId:'tenant-test',roles:['owner'],employee:{id:'e1',status:'active',display_name:'架空Office担当'}},
  access:{officeHr:true,recruit:true}};
const pdf=await PDFDocument.create();pdf.addPage();
const bytes=Buffer.from(await pdf.save());

async function scenario(width){
 const ctx=await br.newContext({viewport:{width,height:900}});
 await ctx.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:me.email})));
 let primary='employment_contract',canManage=true;
 const uploaded={employment_contract:false,terms:false,contractor_contract:false};
 const documents=[],calls=[],errors=[];
 const page=await ctx.newPage();page.setDefaultTimeout(12000);
 page.on('pageerror',e=>errors.push(String(e)));
 await ctx.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  const send=(obj,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(obj)});
  if(url.pathname.startsWith('/__synthetic_upload/')){calls.push({action:'put'});return route.fulfill({status:200,body:'{}'});}
  if(!url.pathname.startsWith('/api/')){
   if(url.origin!==new URL(BASE).origin)return route.abort();
   return route.continue();
  }
  let body={};try{body=req.postDataJSON()||{};}catch{}
  if(url.pathname==='/api/me')return send(me);
  if(url.pathname==='/api/office/hiring-documents')return send({ready:true,canManageDocuments:canManage,pending:uploaded.employment_contract?0:1,
    candidates:[{id:A,name:'架空 内定者',plannedCategory:'パート・アルバイト',primaryKind:primary,
      availableKinds:primary?['employment_contract','terms']:[],
      uploadedKinds:{...uploaded},workflow:{completed:false,contractKind:primary}}]});
  if(url.pathname==='/api/hr/candidate-documents'){
   if(req.method()==='GET')return send({ready:true,applicant:{id:A,name:'架空 内定者'},documents,
     allowedKinds:['employment_contract','terms'],canUpload:true,canPublish:false});
   calls.push({action:body.action,kind:body.kind,applicantId:body.applicantId});
   if(body.action==='prepare')return send({path:'tenant-test/candidates/'+A+'/staging/test.pdf',uploadUrl:BASE+'/__synthetic_upload/test'});
   if(body.action==='attach'){
    uploaded[body.kind]=true;
    documents.push({id:'doc-'+documents.length,kind:body.kind,filename:body.fileName,
      version:documents.length+1,status:'draft',title:body.kind==='employment_contract'?'雇用契約書':'労働条件通知書'});
    return send({ok:true,document:documents.at(-1)});
   }
   if(body.action==='file')return route.fulfill({status:200,contentType:'application/pdf',body:bytes});
   return send({error:'unexpected'},400);
  }
  if(url.pathname==='/api/notifications')return send({notifications:[],unread:0});
  return send({});
 });
 await page.goto(BASE+'/office/hiring-documents.html');
 await page.locator('.o-person').waitFor();
 assert.equal(await page.locator('.o-person').count(),1);
 assert.match(await page.locator('.o-person').innerText(),/契約書：未アップロード/);
 assert.equal(await page.locator('.o-doc').count(),2,'雇用契約書+任意別紙');
 assert.match(await page.locator('.o-doc').first().innerText(),/雇用契約書/);
 assert.match(await page.locator('.o-doc').nth(1).innerText(),/別紙がある場合/);
 assert.match(await page.locator('#office-hiring-count').innerText(),/契約書：未アップロード/);
 await page.locator('#office-hiring-uploader [data-drop]').waitFor();
 assert.equal(await page.locator('#office-hiring-uploader [data-action="upload"]').isDisabled(),true);
 assert.equal(await page.locator('[data-action="publish"],[data-action="review"],#office-hiring-review').count(),0,'送信・本人公開なし');
 await page.locator('#office-hiring-uploader [data-file]').setInputFiles({name:'契約済み.pdf',mimeType:'application/pdf',buffer:bytes});
 await page.locator('#office-hiring-uploader [data-action="upload"]').click();
 await page.locator('.o-person').filter({hasText:'契約書：アップロード済み'}).waitFor();
 assert.match(await page.locator('#office-hiring-count').innerText(),/契約書：アップロード済み/,'別紙なしで主契約書完了');
 assert.match(await page.locator('.o-doc').nth(1).innerText(),/未アップロード/,'別紙の状態は独立');
 await page.locator('#office-hiring-uploader [data-action="preview"]').waitFor();
 await page.locator('#office-hiring-uploader [data-action="preview"]').click();
 assert.equal(calls.some(x=>x.action==='file'),true,'登録したPDFをプレビュー');
 assert.deepEqual(calls.filter(x=>!['put','file'].includes(x.action)).map(x=>x.action),['prepare','attach']);
 assert.equal(calls.find(x=>x.action==='attach').kind,'employment_contract');
 assert.ok(calls.filter(x=>x.action==='attach').every(x=>x.applicantId===A),'他の応募者に誤登録しない');
 assert.deepEqual(errors,[],'画面JSエラーなし');
 await ctx.close();
}
try{
 await scenario(1280);
 await scenario(390);
 console.log('PASS Office contract archive: PC/mobile, one primary contract, optional terms, upload, preview, no send/publish');
}finally{await br.close();}
