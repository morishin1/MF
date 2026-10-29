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

mem.rows.gw_sales_proposals[0].sales_owner_id=a;
mem.rows.gw_sales_proposal_hot_marks=[];
const browser=await launch();
try {
 for(const width of [1360,390]) {
  mem.rows.gw_sales_proposal_hot_marks=[];
  const page=await browser.newPage({viewport:{width,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  let writes=0, fail=false;
  await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'fake',email:'a@example.test'})));
  await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());
   if(u.origin!==new URL(BASE).origin)return route.abort();
   if(!u.pathname.startsWith('/api/'))return route.continue();
   let status=200,body={};
   if(u.pathname==='/api/me')body={email:'a@example.test',access:{sell:true},gw:{employee:who.employee,roles:who.roles,tenantId:tenant}};
   else if(u.pathname==='/api/sales/proposals/hot'){
    writes++;const b=req.postDataJSON();await new Promise(r=>setTimeout(r,250));
    if(fail){status=500;body={error:'save_failed'};}
    else {mem.rows.gw_sales_proposal_hot_marks=[{proposal_id:b.id,tenant_id:tenant,is_hot:b.isHot,version:b.expectedVersion+1}];body={isHot:b.isHot,hotVersion:b.expectedVersion+1};}
   }else if(u.pathname==='/api/sales/proposals'){
    const res={setHeader(){},end:v=>body=JSON.parse(v)};await handler({method:'GET',url:u.pathname+u.search,headers:{}},res);status=res.statusCode;
   }
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(BASE+'/sales/proposals.html');
  const off=page.locator('button.pp-hot[aria-pressed="false"]:visible');await off.waitFor();assert.equal(await off.count(),1);
  await off.click();
  await page.waitForFunction(()=>document.querySelector('button.pp-hot[aria-busy="true"]'));
  assert.equal(await page.locator('button.pp-hot[aria-pressed="true"]').count(),0);
  await page.evaluate(id=>ppToggleHot(id),uid(101));assert.equal(writes,1);
  const on=page.locator('button.pp-hot[aria-pressed="true"]:visible');await on.waitFor();
  assert.ok(!await page.evaluate(()=>openId),'flame click does not open detail');
  await page.reload();await on.waitFor();
  fail=true;await on.click();await page.waitForFunction(()=>!hotPending.size);assert.equal(writes,2);assert.equal(await on.count(),1,'failed save remains on after readback');
  await page.screenshot({path:shotPath(`sales-hot-${width}.png`),fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Hot marker actual page: desktop/mobile, save/reload, readonly, pending, click isolation, failure PASS');
}finally{await browser.close();}
