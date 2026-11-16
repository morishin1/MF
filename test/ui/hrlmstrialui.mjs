// 無限道場体験はHRから非表示。既存データ・送信APIを削除せず、表示・自動取得だけを止める。
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
const br=await launch();
try {
 for(const width of [1440,390]) for(const lead of [false,true]){
  const ctx=await br.newContext({viewport:{width,height:900}});
  await ctx.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'staff@example.test'})));
  const a={id:'a1',name:'架空 応募者',stage:lead?'md_trial':'casual_interview',status:lead?'todo':'eval_pending',leadCategory:lead?'mugendojo':'recruitment',nextActionKey:lead?'chooseLeadNext':'evaluate',nextActionCta:'評価を入力',docs:{}};
  const calls=[],writes=[],errors=[];
  await ctx.route('**/*',route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!==new URL(BASE).origin)return route.abort();
   if(!u.pathname.startsWith('/api/'))return route.continue();calls.push(u.pathname);
   if(req.method()!=='GET')writes.push(u.pathname);
   const send=b=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
   if(u.pathname==='/api/me')return send({email:'staff@example.test',access:{recruit:true},gw:{tenantId:'t1',roles:['recruiter'],employee:{id:'e1'}}});
   if(u.pathname==='/api/hr/applicants')return send({applicants:[a],employees:[]});
   if(u.pathname==='/api/hr/applicants/detail')return send({applicant:a,interviews:[],offers:[],timeline:[]});
   if(u.pathname==='/api/hr/documents')return send({documents:[]});
   if(u.pathname==='/api/hr/applicant-state')return send({states:[]});
   return send({});
  });
  const page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(BASE+'/hr/applicants.html?id=a1');
  if(!lead){await page.locator('#hr-work-link-info').click();await page.locator('#hr-tab-overview').waitFor();}
  else await page.locator('.hr-detail #hr-detail-tab').waitFor();
  assert.equal(await page.locator('[data-lms-trial],[data-lms-invite],[data-lms-next-invite],#hr-work-link-lms').count(),0,'体験・案内パネルを出さない');
  assert.equal(await page.getByLabel('人材区分',{exact:true}).count(),0);
  assert.ok(!calls.some(p=>p.includes('lms-trial')),'非表示パネルのAPIを自動取得しない');
  assert.ok(writes.every(p=>p==='/api/hr/applicant-state'),'閲覧だけで案内送信や採否変更をしない');
  assert.deepEqual(errors,[]);await ctx.close();
 }
 console.log('PASS hidden LMS UI and no eager reads/sends for applicant/lead at desktop/mobile');
}finally{await br.close();}
