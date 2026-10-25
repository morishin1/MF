// Local UI contract tests: mocked API only. No real data/auth/mail/network.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {launch} from '../_browser.mjs';
const html=readFileSync(new URL('../../marketing/inquiry-desk.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../../js/marketing-intake-ui.js',import.meta.url),'utf8');
const br=await launch();let n=0;
const check=(condition,label)=>{assert.ok(condition,label);n++;console.log('ok',label);};
try {
for(const width of [1280,390]) {
const page=await br.newPage({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'});
await page.route('**/*',route=>{const u=new URL(route.request().url());route.fulfill({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/html',body:u.pathname.endsWith('inquiry-desk.html')?html:u.pathname.endsWith('marketing-intake-ui.js')?js:''});});
await page.addInitScript(()=>{
  window.calls=[];window.failMode='';window.items=[];window.employee={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',name:'架空担当'};
  window.MarketingLayout={init:async()=>({employee:window.employee})};
  window.API={api:async(path,opt={})=>{window.calls.push({path,...opt});if(window.failMode==='unready')throw Object.assign(Error('保存先が未準備です'),{status:503});if(opt.method&&window.failMode==='conflict')throw Object.assign(Error('stale'),{status:409});if(!opt.method){if(path.includes('?id=')){const item=window.items[0];return {item,canEdit:true,events:[{kind:'受付',at:item.createdAt,detail:'<img src=x onerror="window.pwned=1">'}],original:item.channel==='phone'?null:{key:'space_inquiry:x',url:'/office/marketing.html',body:'<script>window.pwned=1</script>',subject:'原文'}};}return {items:window.items,employees:[window.employee],sources:[{biz:'mugen',state:'ok'},{biz:'space',state:'ok'},{biz:'site',state:'forbidden'}]};}
    const b=opt.body;let item;if(opt.method==='POST'){item={...b,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',version:1,state:'open',receivedBy:'本人',ownerName:window.employee.name,createdAt:new Date().toISOString(),canEdit:true};window.items=[item];}else{item={...window.items[0],...b,version:b.version+1};window.items=[item];}return {ok:true,item,duplicate:false};}};
});
await page.goto('http://127.0.0.1:8713/marketing/inquiry-desk.html');
await page.getByRole('button',{name:'受付を追加',exact:true}).click();
await page.locator('#biz').selectOption('mugen');await page.locator('#caller-name').fill('架空電話');await page.locator('#caller-contact').fill('090-0000-0000');await page.locator('#caller-subject').fill('商品について相談');await page.locator('#callback-wish').fill('午後に折返し');await page.locator('#create-owner').selectOption('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');await page.locator('#create-due').fill('2026-10-26T15:00');await page.locator('#create-next').fill('折返し案内する');
await page.getByRole('button',{name:'受付内容を確認'}).click();
check(await page.locator('#confirm-dialog').isVisible(),'phone confirmation opens '+width);
check((await page.evaluate(()=>window.calls.filter(c=>c.method))).length===0,'confirmation does not save '+width);
await page.getByRole('button',{name:'戻る',exact:true}).click();
check((await page.evaluate(()=>window.calls.filter(c=>c.method))).length===0,'cancel does not save '+width);
await page.getByRole('button',{name:'受付内容を確認'}).click();await page.getByRole('button',{name:'この内容で保存'}).dblclick();
await page.locator('#detail-pane').waitFor({state:'visible'});
let writes=await page.evaluate(()=>window.calls.filter(c=>c.method));
check(writes.length===1&&writes[0].body.channel==='phone','double click creates once '+width);
check(writes[0].body.receivedAt&&writes[0].body.requestId&&!writes[0].body.receivedBy,'server-owned receiver and request id '+width);
check(await page.locator('#detail-content').innerText().then(t=>t.includes('架空電話')),'phone details visible '+width);
check(!(await page.evaluate(()=>window.pwned)),'history escapes HTML '+width);
await page.locator('#edit-state').selectOption('done');await page.getByRole('button',{name:'変更内容を確認'}).click();
check(await page.locator('#edit-error').innerText().then(t=>t.includes('完了結果')),'completion requires result '+width);
await page.locator('#edit-result').fill('折返し説明し、相手が了承');await page.getByRole('button',{name:'変更内容を確認'}).click();await page.evaluate(()=>window.failMode='conflict');await page.getByRole('button',{name:'この内容で保存'}).click();await page.locator('#confirm-error').filter({hasText:'競合'}).waitFor();
check(await page.locator('#confirm-dialog').isVisible(),'conflict keeps input '+width);
await page.evaluate(()=>window.failMode='');await page.getByRole('button',{name:'この内容で保存'}).click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});
writes=await page.evaluate(()=>window.calls.filter(c=>c.method==='PATCH'));
check(writes.length===2&&writes[0].body.requestId===writes[1].body.requestId,'retry preserves idempotency key '+width);
check(writes[1].body.state==='done'&&writes[1].body.version===1,'explicit completion uses version '+width);
await page.getByRole('button',{name:'受付を追加',exact:true}).click();await page.locator('#channel').selectOption('email');await page.locator('#source-type').selectOption('space_inquiry');await page.locator('#source-id').fill('cccccccc-cccc-4ccc-cccc-cccccccccccc');await page.locator('#create-owner').selectOption('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');await page.locator('#create-due').fill('2026-10-26T15:00');await page.locator('#create-next').fill('予約の問い合わせを確認');
await page.getByRole('button',{name:'受付内容を確認'}).click();await page.getByRole('button',{name:'この内容で保存'}).click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});
writes=await page.evaluate(()=>window.calls.filter(c=>c.method==='POST'));
check(writes[1].body.sourceType==='space_inquiry'&&writes[1].body.biz==='space'&&!('subject' in writes[1].body),'Space email links original without copying body '+width);
check(await page.locator('#detail-content').innerText().then(t=>t.includes('<script>'))&&!(await page.evaluate(()=>window.pwned)),'original body escaped '+width);
check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow '+width);
await page.evaluate(()=>window.failMode='unready');await page.getByRole('button',{name:'再読込',exact:true}).click();await page.locator('#desk-error').filter({hasText:'未準備'}).waitFor();
check(await page.getByRole('button',{name:'受付を追加',exact:true}).isDisabled(),'missing SQL disables create '+width);
check((await page.evaluate(()=>window.calls)).every(c=>c.path.startsWith('/api/marketing/intake')),'never calls sending or read-mark APIs '+width);
await page.close();
}
console.log(`${n} UI contract checks passed (fake API only)`);
}finally{await br.close();}
