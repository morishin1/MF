// Real weekly handler + browser, synthetic session and in-memory DB only.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createMemDb } from '../_memdb.mjs';
import { launch, BASE } from '../_browser.mjs';
import { shotPath } from '../_shot.mjs';
const at=p=>new URL('../../'+p,import.meta.url).pathname;
const mem=createMemDb({schema:{tc_weekly_review:{unique:[['user_id','week_start']]}}});
const ctx={tenantId:'tenant-test',employee:{id:'employee-test',display_name:'架空メンバー',status:'active'}};
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>mem.admin(),userClient:()=>mem.admin()}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:'member-test'})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx}});
mock.module(at('lib/actions.js'),{namedExports:{closeItems:async()=>0,shapeItem:v=>v}});
mock.module(at('lib/nippo-eval.js'),{namedExports:{isConfigured:()=>false}});
mock.module(at('api/nippo/evaluate.js'),{namedExports:{shape:v=>v}});
const {default:handler}=await import(at('api/nippo/index.js'));
const br=await launch();
try {
 for(const width of [1280,390]) {
  mem.reset();
  mem.rows.gw_reminder_prefs=[{employee_id:'employee-test',workdays:[2,3,4]}];
  const page=await br.newPage({viewport:{width,height:960},timezoneId:'Asia/Tokyo'});
  await page.clock.setFixedTime(new Date('2026-11-04T03:00:00Z'));
  let failSave=false,failRead=false,denyDiscard=false,posts=0;
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  page.on('dialog',d=>denyDiscard?d.dismiss():d.accept());
  await page.addInitScript(()=>{
   localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'member@example.test'}));
   localStorage.setItem('kp_layout',JSON.stringify({appRole:'member',name:'架空メンバー',shows:{},stage:null}));
  });
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   return url.origin===new URL(BASE).origin?route.continue():route.abort();
  });
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   const send=(o,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
   if(url.pathname==='/api/me')return send({email:'member@example.test',appRole:'member',isAdmin:false,shows:{},gw:{...ctx,roles:[],stage:null}});
   if(url.pathname==='/api/schedule/day-gate')return send({ready:false,targetDate:'2026-11-05',count:0});
   if(url.pathname==='/api/tasks/focus')return send({today:'2026-11-04',tomorrowDate:'2026-11-05',todayTasks:[],tomorrowTasks:[],openTasks:[],carryOver:[],people:[],qualityLevels:[],max:3});
   if(url.pathname==='/api/nippo'&&(url.searchParams.get('view')==='weekly'||req.method()==='POST')) {
    if(req.method()==='POST'){posts++;if(failSave)return send({error:'save_failure',hint:'テスト保存失敗'},503);}
    if(req.method()==='GET'&&failRead)return send({error:'read_failure',hint:'テスト読取失敗'},503);
    const res={setHeader(){},end(v){this.body=JSON.parse(v)}};
    await handler({method:req.method(),url:url.pathname+url.search,headers:{},body:req.method()==='POST'?req.postDataJSON():null},res);
    return send(res.body,res.statusCode);
   }
   if(url.pathname==='/api/nippo')return send({date:'2026-11-04',weekStart:'2026-11-02',me:{userId:'member-test',name:'架空メンバー'},today:null,recent:[],replies:[],evals:[],thanks:[],weekly:null,weekClosing:{isToday:false,filled:false},openActions:[],todayActions:[],criteria:[],kpisToday:[],team:[],notSubmitted:[]});
   return send({});
  });
  await page.goto(BASE+'/nippo.html');
  await page.locator('#w-fields:not([disabled])').waitFor();
  assert.equal(await page.locator('#wk-card').isVisible(),true,'non-closing day is editable');
  assert.match(await page.locator('#wk-note').innerText(),/2026-11-05/);
  assert.equal(await page.locator('#wk-tag').innerText(),'未保存');
  for(const k of ['q1','q2','q3','q4'])await page.locator('#w-'+k).fill('  '+k+' 入力  ');
  await page.locator('#w-fields button').click();
  await page.waitForFunction(()=>document.getElementById('w-msg').textContent.includes('保存しました'));
  assert.equal(await page.locator('#w-q1').inputValue(),'q1 入力','saved server response retained');
  assert.match(await page.locator('#wk-tag').innerText(),/保存済み（4\/4問入力）/);
  assert.equal(posts,1,'weekly save works even when daily schedule gate is closed');
  // A taller artifact viewport fits the whole card below the page's sticky headers.
  // Interaction/overflow checks still run at 960px height. No UI is hidden for capture.
  await page.setViewportSize({width,height:1400});
  await page.locator('#wk-card').scrollIntoViewIfNeeded();
  await page.evaluate(()=>window.scrollBy(0,-200));
  await page.locator('#wk-card').screenshot({path:shotPath(`weekly-review-${width}.png`)});
  await page.setViewportSize({width,height:960});
  await page.reload();await page.locator('#w-fields:not([disabled])').waitFor();
  assert.equal(await page.locator('#w-q1').inputValue(),'q1 入力','reloaded from handler');
  await page.locator('#w-date').fill('2026-10-28');await page.locator('#w-date').dispatchEvent('change');
  await page.waitForFunction(()=>document.getElementById('wk-range').textContent.includes('2026-10-26'));
  assert.equal(await page.locator('#f-date').inputValue(),'2026-11-04','daily target unchanged');
  assert.equal(await page.locator('#w-q1').inputValue(),'');
  await page.locator('#w-q1').fill('過去週');
  denyDiscard=true;await page.locator('#w-date').fill('2026-11-04');await page.locator('#w-date').dispatchEvent('change');
  assert.equal(await page.locator('#w-q1').inputValue(),'過去週');assert.equal(await page.locator('#w-date').inputValue(),'2026-10-26');denyDiscard=false;
  failSave=true;await page.locator('#w-fields button').click();await page.waitForFunction(()=>document.getElementById('w-msg').textContent.includes('テスト保存失敗'));
  assert.equal(await page.locator('#w-q1').inputValue(),'過去週');assert.equal(await page.locator('#wk-tag').innerText(),'未保存の変更あり');failSave=false;
  await page.locator('#w-fields button').click();await page.waitForFunction(()=>document.getElementById('w-msg').textContent.includes('保存しました'));
  assert.equal(mem.rows.tc_weekly_review.find(r=>r.week_start==='2026-10-26').q1,'過去週');
  assert.match(await page.locator('#wk-tag').innerText(),/1\/4問入力/);
  failRead=true;await page.locator('#w-date').fill('2026-11-04');await page.locator('#w-date').dispatchEvent('change');await page.waitForFunction(()=>document.getElementById('w-msg').textContent.includes('テスト読取失敗'));
  assert.equal(await page.locator('#w-q1').inputValue(),'過去週');assert.equal(await page.locator('#w-date').inputValue(),'2026-10-26');failRead=false;
  mem.rows.gw_reminder_prefs=[];
  await page.locator('#w-date').fill('2026-11-04');await page.locator('#w-date').dispatchEvent('change');await page.waitForFunction(()=>document.getElementById('wk-note').textContent.includes('不明'));
  assert.equal(await page.locator('#w-q1').inputValue(),'q1 入力');
  for(const k of ['q1','q2','q3','q4'])await page.locator('#w-'+k).fill('');
  await page.locator('#w-fields button').click();await page.waitForFunction(()=>document.getElementById('wk-tag').textContent.includes('0/4'));
  assert.equal(mem.rows.tc_weekly_review.find(r=>r.week_start==='2026-11-02').q1,null);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
  assert.deepEqual(errors,[]);
  await page.close();console.log(`weekly review UI ${width}px: input, save, reload, week selection, dirty guard, failure retention, unknown workdays passed`);
 }
} finally {await br.close();}
