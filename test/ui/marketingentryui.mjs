import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
const browser=await launch();
try {
 for(const grant of [true,false]) {
  const context=await browser.newContext();
  await context.addInitScript(()=>{
   localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'fixture@example.test'}));
   localStorage.setItem('kp_layout',JSON.stringify({appRole:'member',name:'Old Fixture',shows:{marketing:false},stage:null}));
   localStorage.setItem('kp_me',JSON.stringify({at:Date.now(),email:'fixture@example.test',me:{email:'fixture@example.test',appRole:'member',access:{marketing:false},gw:{employee:{id:'fixture',status:'active'},roles:[]}}}));
  });
  await context.route('**/api/**',r=>{
   const path=new URL(r.request().url()).pathname;
   const me={email:'fixture@example.test',appRole:'member',isAdmin:false,access:{marketing:grant,recruit:true,sell:true},gw:{employee:{id:'fixture',display_name:'Fixture',status:'active'},roles:[],tenantId:'fixture',stage:null}};
   const data=path==='/api/me'?me:path==='/api/config'?{}:path.includes('notifications')?{notifications:[],unread:0}:{};
   return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  const page=await context.newPage();
  for(const path of ['nippo.html','calendar.html','timecard.html','tasks.html','home.html']) {
   await page.goto(BASE+'/'+path);
   const nav=page.locator('[data-shortcut="marketing"]');
   if(grant) await nav.waitFor({state:'visible'});
   else {await page.locator('.topbar').waitFor({state:'visible'}); await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kp_me')||'{}').me?.access?.recruit===true); assert.equal(await nav.count(),0,path);}
   if(grant)assert.equal(await nav.getAttribute('href'),'/marketing/',path);
  }
  await page.goto(BASE+'/nippo.html'); await page.reload();
  if(grant) await page.locator('[data-shortcut="marketing"]').waitFor({state:'visible'});
  else {await page.locator('.topbar').waitFor({state:'visible'}); assert.equal(await page.locator('[data-shortcut="marketing"]').count(),0);}
  await context.close();
 }
 console.log('Marketing entry: allowed/denied, cached-to-fresh, repeated navigation and reload PASS');
} finally {await browser.close();}
