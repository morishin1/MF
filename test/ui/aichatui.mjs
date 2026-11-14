// Q&A replaces general AI chat. Real-browser checks use synthetic fixtures only.
import assert from 'node:assert/strict';import {launch,BASE} from '../_browser.mjs';
const br=await launch();
for(const width of [1100,390]){
 const page=await br.newPage({viewport:{width,height:900}}),posted=[];let sent=false;
 await page.addInitScript(()=>{localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'fixture@example.test'}));localStorage.setItem('kp_layout',JSON.stringify({appRole:'member',name:'架空',shows:{},stage:null}));});
 await page.route('**/api/**',async route=>{const u=new URL(route.request().url()),method=route.request().method(),send=b=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
  if(u.pathname==='/api/me')return send({email:'fixture@example.test',appRole:'member',shows:{},gw:{employee:{id:'self',display_name:'架空',status:'active'},roles:[],tenantId:'t'}});
  if(u.pathname==='/api/questions')return send({questions:[{id:'q',title:'有給の申請方法',answer:'申請画面から提出します。',sourceUrl:'/requests.html'}],categories:[{code:'hr',label:'人事・労務'}]});
  if(u.pathname==='/api/ai/inquiries'){if(method==='POST'){sent=true;posted.push(route.request().postDataJSON());return send({inquiry:{id:'i'}});}assert.equal(u.searchParams.get('scope'),'mine');return send({inquiries:sent?[{id:'i',subject:'質問',status:'new'}]:[]});}
  if(u.pathname==='/api/ai/inquiry')return send({inquiry:{id:'i',subject:'質問',status:'waiting_user'},messages:[{sender_type:'admin',content:'担当者の回答'}]});
  assert.notEqual(u.pathname,'/api/ai/ask','Q&A does not call an LLM');return send({notifications:[],unread:0});
 });
 await page.goto(`${BASE}/messages.html`);await page.locator('#qa-results summary').waitFor();await page.locator('#qa-query').fill('有給');await page.locator('#qa-search button[type=submit]').click();await page.locator('#qa-results summary').click();assert.match(await page.locator('#qa-results').textContent(),/申請画面/);await page.locator('#qa-ask').click();assert.equal(posted.length,0);await page.locator('#qa-note').fill('申請について確認したいです');await page.locator('#qa-ask-form button').click();await page.locator('[data-inquiry]').waitFor();assert.equal(posted[0].threadId,null);await page.locator('[data-inquiry]').click();await page.getByText('担当者の回答',{exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
}
await br.close();console.log('PASS Q&A browser: search, answer, explicit staff question, own reply history, desktop/mobile width, no AI generation');
