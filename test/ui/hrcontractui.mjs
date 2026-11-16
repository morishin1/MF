// 現行境界：HRは内定通知まで、正式契約はOfficeの登録済PDF保管。
// 旧LegalSign/署名確定のUI期待を、HRに操作を出さないことの検証に置換。
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
const br=await launch();
try {
 for(const width of [1440,390]) for(const office of [true,false]) {
  const ctx=await br.newContext({viewport:{width,height:900}});
  await ctx.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'hr@example.test'})));
  const a={id:'a1',name:'架空 内定者',stage:'offer',status:'accepted',decision:'hired',offerType:'part_time',nextActionKey:'formalContract',nextActionCta:'正式契約へ',docs:{}};
  const writes=[],errors=[];
  await ctx.route('**/*',route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!==new URL(BASE).origin)return route.abort();
   if(!url.pathname.startsWith('/api/'))return route.continue();
   const send=b=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
   if(req.method()!=='GET')writes.push({path:url.pathname,body:req.postDataJSON()});
   if(url.pathname==='/api/me')return send({email:'hr@example.test',access:{recruit:true,officeHr:office},gw:{tenantId:'t',roles:office?['owner']:['recruiter'],isAdmin:office,employee:{id:'e1'}}});
   if(url.pathname==='/api/hr/applicants')return send({applicants:[a],employees:[]});
   if(url.pathname==='/api/hr/applicants/detail')return send({applicant:a,interviews:[],offers:[],timeline:[],salaryVisible:true});
   if(url.pathname==='/api/hr/documents')return send({documents:[]});
   if(url.pathname==='/api/hr/applicant-state')return send({states:[]});
   return send({});
  });
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
  await page.goto(BASE+'/hr/applicants.html?id=a1');await page.locator('#hr-work-primary').waitFor();
  assert.match(await page.locator('#hr-work-primary').innerText(),/Officeへ依頼/);
  await page.locator('#hr-work-primary').click();await page.locator('#action-root .hr-modal').waitFor();
  assert.match(await page.locator('#action-root').innerText(),/Office人事労務/);
  assert.equal(await page.locator('#ct-signed,#ct-publish,#of-send,[data-action="upload"]').count(),0,'HRに契約確定・署名・契約アップロードを出さない');
  assert.equal(await page.locator('#action-root a[href="/office/hiring-documents.html"]').count(),office?1:0,'Office権限に従った導線');
  assert.ok(!writes.some(w=>w.path!=='/api/hr/applicant-state'),'依頼の案内を開くだけで契約・採否・送信を変更しない');
  assert.deepEqual(errors,[]);await ctx.close();
 }
 console.log('PASS HR/Office boundary at desktop/mobile: no contract signing/publication, role-specific archive link, no business writes');
}finally{await br.close();}
