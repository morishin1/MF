// Real list API + isolated in-memory data, real browser. No live data/POSTs.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createMemDb} from '../_memdb.mjs';
import {launch, BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
const root = p=>fileURLToPath(new URL('../../'+p,import.meta.url));
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=uid(1), a=uid(2), b=uid(3);
const mem=createMemDb();
mock.module(root('lib/supabase.js'),{namedExports:{admin:()=>mem.admin(),userClient:()=>mem.admin()}});
mock.module(root('lib/auth.js'),{namedExports:{requireUser:async()=>({id:'test'}),getMemberships:async()=>[]}});
const realGw=await import(root('lib/gw.js'));
const who={tenantId:tenant,roles:['sales'],apps:['sales'],employee:{id:a,display_name:'提案 太郎'}};
mock.module(root('lib/gw.js'),{namedExports:{gwContext:async()=>who,canSell:realGw.canSell}});
const handler=(await import(root('api/sales/proposals/index.js'))).default;
mem.rows.gw_employees=[{id:a,tenant_id:tenant,display_name:'提案 太郎',email:'a@example.test',status:'active'},
{id:b,tenant_id:tenant,display_name:'終了 花子',email:'b@example.test',status:'active'}];
mem.rows.gw_app_grants=[a,b].map(employee_id=>({tenant_id:tenant,employee_id,app_key:'sales'}));
const sent=new Date(Date.now()-86400000).toISOString();
const p=(n,proposal,closing)=>({id:uid(100+n),tenant_id:tenant,source_system:'manual',company_name:`会社${n}`,title:`提案${n}`,
status:'call_wait',sent_at:sent,service:'PC',proposal_owner_id:proposal,closing_owner_id:closing,sales_owner_id:b,handoff_stage:'closing'});
mem.rows.gw_sales_proposals=[p(1,a,b),p(2,a,a),p(3,b,b),p(4,null,null)];
mem.rows.gw_sales_proposals[3].sales_owner_id=null;
mem.rows.gw_sales_proposal_tasks=[1,1,2,3].map((n,i)=>({id:uid(200+i),tenant_id:tenant,proposal_id:uid(100+n),kind:'call',status:'open',due_at:sent,assignee_id:b}));
const browser=await launch();
let writes=0;
try {
 for (const width of [1360,390]) {
  const page=await browser.newPage({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'a@example.test'})));
  await page.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.origin!==new URL(BASE).origin)return route.abort();
    if(!u.pathname.startsWith('/api/'))return route.continue();
    if(req.method()!=='GET'){writes++;return route.fulfill({status:405,body:'{}'});}
    let status=200,body={};
    if(u.pathname==='/api/me')body={email:'a@example.test',access:{sell:true},gw:{employee:who.employee,roles:who.roles,tenantId:tenant}};
    else if(u.pathname==='/api/sales/proposals'){
      const res={setHeader:()=>{},end:v=>{body=JSON.parse(v);}};
      await handler({method:'GET',url:u.pathname+u.search,headers:{}},res);status=res.statusCode;
    }
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  const expectCount=async n=>{await page.waitForFunction(n=>document.getElementById('pp-list-meta').textContent.startsWith(`検索結果：${n}件`),n);};
  const pick=async(id,value,count)=>{await page.locator('#'+id).selectOption(value);await expectCount(count);};
  await page.goto(BASE+'/sales/proposals.html');await expectCount(4);
  // A read-only row is selectable, but selection never grants write permission.
  const checkbox=page.locator(`input[data-pid="${uid(101)}"]:visible`).first();
  await checkbox.check();
  assert.ok(await checkbox.isChecked());
  for(const id of ['pp-bulk-edit','pp-bulk-archive','pp-bulk-restore'])assert.ok(await page.locator('#'+id).isDisabled());
  await page.evaluate(()=>ppSelectAll(true));
  assert.equal(await page.evaluate(()=>selected.size),4);
  assert.ok(await page.locator('#pp-bulk-archive').isDisabled());
  await page.evaluate(()=>ppSelectAll(false));
  assert.ok(await page.getByLabel('提案担当で絞り込み').isVisible());assert.ok(await page.getByLabel('クロージング担当で絞り込み').isVisible());
  await pick('f-proposal-owner',a,2); await pick('f-closing-owner',b,1);
  assert.ok(page.url().includes('proposalOwner='+a)&&page.url().includes('closingOwner='+b));
  assert.ok((await page.locator('#filters').innerText()).includes('すべて'));
  await page.reload();await expectCount(1);assert.equal(await page.locator('#f-closing-owner').inputValue(),b);
  await pick('f-proposal-owner','',2); await pick('f-closing-owner','none',1);await pick('f-proposal-owner','none',1);
  await page.locator('#pp-reset-owners').click();await expectCount(4);assert.ok(!page.url().includes('Owner='));
  await pick('f-proposal-owner',b,1);await pick('f-closing-owner',a,0);
  await page.locator('#pp-reset-owners').click();await expectCount(4);
  await page.goto(BASE+'/sales/proposals.html?owner='+b+'&proposalOwner='+a);await expectCount(2);
  assert.ok(await page.locator('#pp-legacy-owner').isVisible());
  await page.locator('#pp-reset-owners').click();await expectCount(4);assert.ok(await page.locator('#pp-legacy-owner').isHidden());
  await page.evaluate(()=>ppSet('proposalOwner','invalid'));
  await page.waitForSelector('#notice .err');
  assert.equal(await page.locator('#cards .pp-card').count(),0);
  assert.equal(await page.locator('#sum button').count(),0);
  assert.ok((await page.locator('#pp-list-meta').innerText()).includes('取得できません'));
  await page.goto(BASE+'/sales/proposals.html?proposalOwner=invalid');
  await page.waitForSelector('#notice .err');assert.equal(await page.locator('#f-proposal-owner').inputValue(),'invalid');
  await page.locator('#pp-reset-owners').click();await expectCount(4);
  await pick('f-proposal-owner','me',2);await pick('f-closing-owner',b,1);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert.ok(overflow<=1,`overflow ${overflow}`);
  await page.screenshot({path:shotPath(`sales-owner-filters-${width}.png`),fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal(writes,0,'filtering never writes to API');
 console.log('Sales separate owner filters: desktop/mobile/URL/reset/AND/invalid/readonly PASS');
}finally{await browser.close();}
