// All APIs and assets are local/mocked; never uses real credentials or production.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launch} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const root=new URL('../../',import.meta.url);
const browser=await launch();
try {
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!=='http://gw.test')return route.fulfill({status:200,body:''});
  if(url.pathname==='/js/api-client.js')return route.fulfill({contentType:'text/javascript',body:`window.calls=0;window.API={isLoggedIn:()=>false,login:async()=>{calls++;await new Promise(r=>setTimeout(r,100));throw Error('synthetic')},logout:()=>{}};`});
  if(['/js/device.js','/js/layout.js'].includes(url.pathname))return route.fulfill({contentType:'text/javascript',body:''});
  const path=url.pathname==='/'?'index.html':url.pathname.slice(1);
  try{return route.fulfill({body:readFileSync(new URL(path,root)),contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 const page=await context.newPage();
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await page.goto('http://gw.test/');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(await page.locator('#go').isVisible());
  await page.screenshot({path:shotPath(`gw-login-${width}.png`),fullPage:true});
  assert(await page.locator('.welcome img').evaluate(img=>img.complete&&img.naturalWidth===250));
  if(width<=760) assert(await page.evaluate(()=>document.querySelector('#login-card').getBoundingClientRect().top<document.querySelector('.welcome').getBoundingClientRect().top));
  const loginTop=await page.locator('#login-card').evaluate(el=>el.offsetTop);
  const summary=page.locator('#values-details summary');
  await summary.focus();await summary.press('Enter');
  assert(await page.locator('#values-details').evaluate(el=>el.open));
  assert.equal(await page.locator('.values li').count(),5);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('#login-card').evaluate(el=>el.offsetTop),loginTop);
  await page.screenshot({path:shotPath(`gw-mvv-values-${width}.png`),fullPage:true});
  await summary.press('Space');assert(!(await page.locator('#values-details').evaluate(el=>el.open)));
  await summary.press('Enter');await summary.press('Enter');
  assert(!(await page.locator('#values-details').evaluate(el=>el.open)));

 }
 await page.locator('#email').fill('synthetic@example.invalid');await page.locator('#pw').fill('synthetic-password');
 await page.locator('#show-password').click();assert.equal(await page.locator('#pw').getAttribute('type'),'text');
 await page.locator('#pw').press('Enter');await page.waitForFunction(()=>document.getElementById('err').textContent);
 assert.equal(await page.evaluate(()=>calls),1);assert.equal(await page.locator('#pw').inputValue(),'');
 assert.equal(await page.locator('#pw').getAttribute('type'),'password');
 assert.equal(await page.evaluate(()=>localStorage.getItem('kp_login_email')),null);

 // Real browser regressions for the /api/me-before-MFA boundary (synthetic only).
 const active={userId:'u-synthetic',appRole:'member',gw:{available:true,employee:{status:'active'},stage:{key:'member'}}};
 const retired={...active,gw:{...active.gw,left:true,employee:{status:'left'},stage:{key:'left'}}};
 for(const scenario of ['retired','active','mfa-error','unknown','late-retired','switched-user']){
  const c=await browser.newContext();
  await c.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin!=='http://gw.test')return route.fulfill({body:''});
   if(u.pathname==='/js/api-client.js')return route.fulfill({contentType:'text/javascript',body:`
    window.mfaCalls=0;window.logoutCalls=0;window.meCalls=0;
    const active=${JSON.stringify(active)},retired=${JSON.stringify(retired)},scenario=${JSON.stringify(scenario)};
    window.API={isLoggedIn:()=>false,login:async()=>{},logout:()=>logoutCalls++,
      me:async()=>{meCalls++;if(scenario==='late-retired')return new Promise(r=>window.releaseMe=()=>r(retired));if(scenario==='unknown')return {};if(scenario==='retired')return retired;if(scenario==='switched-user'&&meCalls>1)return {...active,userId:'u-other'};return active;},
      mfaStatus:async()=>{mfaCalls++;if(scenario==='mfa-error')throw Error('synthetic 403');return {factors:[],verified:false};}};`});
   if(u.pathname==='/js/layout.js')return route.fulfill({contentType:'text/javascript',body:`window.KPLayout={homeFor:()=>'/home.html'};`});
   if(u.pathname==='/js/device.js')return route.fulfill({body:''});
   if(['/home.html','/retiree/'].includes(u.pathname))return route.fulfill({contentType:'text/html',body:'<h1>Synthetic destination</h1>'});
   const path=u.pathname==='/'?'index.html':u.pathname.slice(1);
   try{return route.fulfill({body:readFileSync(new URL(path,root)),contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html'});}catch{return route.fulfill({status:404,body:''});}
  });
  const p=await c.newPage();await p.goto('http://gw.test/?next=%2Fadmin-members.html');
  // Only retired should ignore next. Active normal path uses no next in this fixture.
  if(scenario!=='retired')await p.goto('http://gw.test/');
  await p.locator('#email').fill('synthetic@example.invalid');await p.locator('#pw').fill('synthetic-password');await p.locator('#go').click();
  if(scenario==='retired'||scenario==='active'){
   await p.waitForURL('http://gw.test/'+(scenario==='retired'?'retiree/':'home.html'));
  }else if(scenario==='late-retired'){
   await p.waitForFunction(()=>typeof releaseMe==='function');
   await p.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide'));releaseMe();});
   await p.waitForTimeout(100);assert.equal(new URL(p.url()).pathname,'/');assert.equal(await p.evaluate(()=>mfaCalls),0);assert.equal(await p.evaluate(()=>logoutCalls),0);
  }else if(scenario==='switched-user'){
   await p.waitForFunction(()=>document.getElementById('go')&&!document.getElementById('go').disabled&&meCalls===0);
   assert.equal(new URL(p.url()).pathname,'/');
  }else{
   await p.waitForFunction(()=>document.getElementById('err').textContent);
   assert.equal(new URL(p.url()).pathname,'/');assert.equal(await p.evaluate(()=>logoutCalls),1);
  }
  console.log('Identity/MFA browser regression passed: '+scenario);await c.close();
 }
 console.log('GW login: responsive, keyboard, visibility and failed submission checks passed');
}finally{await browser.close();}
