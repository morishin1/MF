// Synthetic accounts only. Verify the user's complete administration flow in a real browser.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
import * as GW from '../../lib/gw.js';
import * as MA from '../../lib/member-access.js';
const br=await launch();
const e=(id,name,extra={})=>({id,display_name:name,email:id+'@example.com',user_id:'u-'+id,department:'営業部',employment_type:'業務委託',status:'active',roles:[],accounts:{},...MA.accessForMember([],'u-'+id,new Map(),[]),...extra});
const rows=[e('owner','管理 太郎',{roles:['owner'],employment_type:'役員'}),e('agent','営業 花子',{engagement_stage:'trial'}),e('staff','開発 一郎',{employment_type:'正社員',engagement_stage:'probation'})];
const agents=[{employeeId:'agent',name:'営業 花子',email:'agent@example.com',employmentType:'業務委託',status:'active',roleAssigned:true,enabled:false,companyIds:[]}];
const company='cccccccc-0000-4000-8000-000000000001';
const calls=[];
const page=await br.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Tokyo'});
const errors=[];page.on('pageerror',x=>errors.push(x.message));
page.on('dialog',d=>d.accept());
await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'owner@example.com'})));
await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),method=req.method(),body=JSON.parse(req.postData()||'{}');
  const send=(x,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(x)});
  if(url.pathname==='/api/me')return send({email:'owner@example.com',appRole:'owner',memberships:[],gw:{employee:rows[0],roles:['owner'],tenantId:'t1'},access:GW.accessOf({isAdmin:false,isHr:true,roles:['owner']})});
  if(url.pathname==='/api/employees'){
    if(method==='PATCH'){calls.push({path:url.pathname,body});Object.assign(rows.find(x=>x.id===body.id),body);return send({employee:rows.find(x=>x.id===body.id)});}
    return send({employees:rows,canManage:true,canGrantRoles:true,canGrantOwner:true,meEmployeeId:'owner',appsState:'table',kindReady:true});
  }
  if(url.pathname==='/api/enger/agent-users'){
    if(method==='GET')return send(url.searchParams.has('companyQuery')?{companies:[{id:company,name:'テスト商談株式会社'}]}:{agents,companyNames:{[company]:'テスト商談株式会社'}});
    calls.push({path:url.pathname,method,body});
    if(method==='POST'){
      rows.push(e('created',body.name,{email:body.email,engagement_stage:body.engagementStage}));
      agents.push({employeeId:'created',name:body.name,email:body.email,status:'active',roleAssigned:true,enabled:false,companyIds:[]});
      return send({ok:true,employeeId:'created',initialPassword:'SyntheticPassword123!'});
    }
    Object.assign(agents.find(x=>x.employeeId===body.employeeId),{enabled:body.enabled,companyIds:body.companyIds});return send({ok:true});
  }
  if(url.pathname==='/api/employees/account'){calls.push({path:url.pathname,body});return send({ok:true,password:'SyntheticChanged123!',email:'agent@example.com'});}
  if(url.pathname==='/api/member-documents')return send({members:rows.map(x=>({employeeId:x.id,documentCount:2,missingCount:1,contractStatus:'契約書あり・署名未確認'}))});
  if(url.pathname==='/api/partners')return send({companies:[]});
  if(url.pathname.includes('notifications'))return send({notifications:[],unread:0});
  return send({badges:{}});
});
try{
  await page.goto(BASE+'/admin-members.html');await page.waitForSelector('#list .mb-agent-badge');
  const row=page.locator('#list tr[data-employee="agent"]');
  assert.match(await row.innerText(),/トライアル/);assert.match(await row.innerText(),/エージェント/);
  assert.equal(await row.locator('.md-rail').count(),0);assert.equal(await row.locator('.mb-doc-icon').count(),2);
  for(const width of [1440,1280,1024,768,390]){
    await page.setViewportSize({width,height:1000});
    const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth-innerWidth,table:document.querySelector('#list .mb-list-frame').scrollWidth-document.querySelector('#list .mb-list-frame').clientWidth}));
    if(overflow.page>1)console.log(await page.evaluate(()=>[...document.querySelectorAll("body *")].map(n=>({tag:n.tagName,id:n.id,cls:n.className,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})).filter(n=>n.right>innerWidth+1&&n.width>0).slice(0,18)));
    assert.ok(overflow.page<=1&&overflow.table<=1,JSON.stringify({width,...overflow}));
  }
  await page.screenshot({path:shotPath('member-modal-ux-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:shotPath('member-modal-ux-desktop.png')});
  await page.selectOption('#f-role','agent');assert.equal(await page.locator('#list tbody tr').count(),1);
  await page.selectOption('#f-role','');
  await row.locator('[data-role="open-detail"]').click();
  await page.selectOption('#member-stage','probation');
  await page.waitForFunction(()=>document.querySelector('#list tr[data-employee="agent"]').textContent.includes('試用期間'));
  await page.keyboard.press('Escape');
  await row.locator('[data-role="row-password"]').click();
  assert.equal(await page.locator('#mb-account').isVisible(),true);
  await page.fill('#ac-pw','NewSynthetic123!');
  await page.getByRole('button',{name:'パスワードを変更',exact:true}).click();
  assert.ok(calls.some(c=>c.path==='/api/employees/account'));
  await page.waitForFunction(()=>document.querySelector('#ac-pw').value==='');
  assert.equal(await page.locator('#ac-pw').inputValue(),'');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#e-account').innerHTML(),'');
  await row.locator('[data-role="open-detail"]').click();
  await page.locator('#mb-member').getByRole('button',{name:'ENGER利用設定へ',exact:true}).click();
  assert.equal(await page.locator('#ag-detail').isVisible(),true);
  await page.fill('#ag-company-query','テスト');await page.getByRole('option',{name:'テスト商談株式会社'}).click();
  await page.check('#ag-active');await page.check('#ag-contract-confirm');await page.check('#ag-nda-confirm');
  await page.click('#ag-save');await page.waitForFunction(()=>document.querySelector('#ag-next-action').textContent.includes('利用開始しました'));
  assert.match(await row.innerText(),/利用中/);await page.keyboard.press('Escape');
  await page.click('#add-btn');await page.fill('#e-name','新規 エージェント');await page.fill('#e-email','new@example.com');
  await page.selectOption('#e-type','業務委託');await page.selectOption('#e-stage','trial');await page.check('#e-agent-role');await page.click('#e-save');
  await page.waitForSelector('#first-account-email');
  assert.equal(await page.locator('#first-account-email').innerText(),'new@example.com');
  assert.match(await page.locator('#e-account').innerText(),/SyntheticPassword123!/);
  assert.equal(await page.locator('#e-account a[href="https://enger.jp/business/login"]').count(),1);
  const post=calls.find(c=>c.method==='POST');assert.equal(post.body.engagementStage,'trial');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#e-account').innerHTML(),'');
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(x=>x.includes('SyntheticPassword'))),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: 5 widths without horizontal scrolling; role/stage filters; saved stage; password modal; ENGER setup; registration credentials and cleanup');
}finally{await br.close();}
