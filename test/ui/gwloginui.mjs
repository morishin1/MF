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
 console.log('GW login: responsive, keyboard, visibility and failed submission checks passed');
}finally{await browser.close();}
