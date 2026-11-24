import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launch} from '../_browser.mjs';
const base='http://127.0.0.1:8713',id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const c={key:'enger:'+id(1),name:'検証会社',verified:true,engerId:id(1)}, actor={id:id(5),name:'担当者'};
const source=await readFile(new URL('../../sales/outcome-review.html',import.meta.url),'utf8');
const browser=await launch();
try {
  const page=await browser.newPage({viewport:{width:1100,height:740},timezoneId:'Asia/Tokyo'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const records=[],writes=[];
  const data={company:c,signal:{suggested:true,sent:3,lost:3,open:0,unknownReason:2},proposals:[{id:id(2),title:'開発案件',talent:'T',verified:true}],
    employees:[actor],me:actor.id,jobs:[],records,allowRank:true,allowTerms:true};
  await page.route('**/js/api-client.js*',r=>r.fulfill({contentType:'text/javascript',body:'window.API={api:async (url,options={})=>{const r=await fetch(url,{method:options.method||"GET",body:options.body?JSON.stringify(options.body):undefined});return await r.json();}};'}));
  await page.route('**/js/layout-marketing.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
  await page.route('**/js/sales-layout.js*',r=>r.fulfill({contentType:'text/javascript',body:'window.SalesLayout={init:async()=>({me:{}})};'}));
  await page.route('**/api/sales/proposals/outcome-review*',async r=>{
    if(r.request().method()==='POST') {
      const b=r.request().postDataJSON();writes.push(b);records.push({kind:b.kind,entity_key:b.entity,revision:1,payload:b.data});
      return r.fulfill({json:{revision:1}});
    }
    const p=new URL(r.request().url()).searchParams;
    if(p.get('proposal')) return r.fulfill({json:{...data,proposal:{id:id(2),jobTitle:'開発案件',talent:'T',lost:true,
      flow:['マッチング','提案','所属確認','結果','合否'].map(label=>({label,value:'未確認',state:'unknown'}))}}});
    if(!p.size) return r.fulfill({json:{results:[],coverage:{proposal:{linked:0,total:30},closing:{linked:0,total:2}}}});
    return r.fulfill({json:data});
  });
  await page.route(base+'/sales/outcome-review.html*',r=>r.fulfill({contentType:'text/html',body:source}));
  await page.goto(base+'/sales/outcome-review.html?company='+encodeURIComponent(c.key));
  await page.getByRole('heading',{name:'検証会社の改善商談'}).waitFor();
  await page.getByLabel('改善の確認日').fill('2026-12-15');
  await page.locator('form[data-kind=meeting] button').click();
  await page.getByText('記録を保存しました。').waitFor();
  assert.equal(writes[0].kind,'meeting');assert.equal(writes[0].data.ownerId,actor.id);
  await page.reload();await page.getByText(/次回確認：2026-12-15/).waitFor();
  await page.getByText(/提案別の進捗/).click();await page.getByRole('link',{name:'開発案件 ／ T'}).click();
  await page.locator('.spf-steps li').first().waitFor();
  assert.deepEqual(await page.locator('.spf-steps li span').allTextContents(),['マッチング','提案','所属確認','結果','合否']);
  await page.getByText('見送りの根拠を記録',{exact:true}).click();
  assert.equal(await page.locator('form[data-kind=feedback] textarea[name=quote]').isVisible(),true);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.goto(base+'/sales/outcome-review.html');await page.getByRole('heading',{name:'提案担当の面談率'}).waitFor();
  assert.match(await page.locator('main').innerText(),/0 \/ 30件/);assert.deepEqual(errors,[]);
  console.log('Improvement meeting save/reload, company-to-proposal navigation, five steps, feedback, mobile and unrated dashboard passed');
} finally {await browser.close();}
