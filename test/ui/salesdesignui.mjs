// Layout regression: real Sales pages and styles, synthetic read-only API data.
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {launch,BASE} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
import {companyId,session,salesDesignFixture} from '../fixtures/sales-design.mjs';

const browser=await launch();
let checks=0;
const writes=[];
const same=(a,b,label)=>{assert.ok(Math.abs(a-b)<2,`${label}: ${a} / ${b}`);checks++;};
try {
  const page=await browser.newPage({viewport:{width:1360,height:900},timezoneId:'Asia/Tokyo'});
  await page.addInitScript(s=>localStorage.setItem('kp_session',JSON.stringify(s)),session);
  await page.route('**/api/**',route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()!=='GET')writes.push({path,method:req.method()});
    return route.fulfill({status:req.method()==='GET'?200:405,contentType:'application/json',body:JSON.stringify(salesDesignFixture(path))});
  });
  // Check every Sales route, including the meeting and submissions pages that
  // previously used separate colors, and utility routes reached from menus.
  const pages=readdirSync(new URL('../../sales/',import.meta.url)).filter(n=>n.endsWith('.html')).sort();
  for(const width of [1360,390]) {
    await page.setViewportSize({width,height:900});
    for(const name of pages) {
      console.log('Checking',width,name);
      await page.goto(BASE+'/sales/'+name+(name==='company-meeting.html'?'?companyId='+companyId:''));
      if(!['company-meeting.html','company-submissions.html','analytics-preview.html'].includes(name))await page.waitForSelector('.sl-bar');
      const layout=await page.evaluate(()=>{
        const container=document.querySelector('.wrap.sl-wrap,main.lc-wrap,main.ap-wrap,main.slack-history-wrap,body > .wrap');
        const r=container.getBoundingClientRect();
        return {x:r.x,width:r.width,max:getComputedStyle(container).maxWidth,bg:getComputedStyle(document.body).backgroundColor,
          pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,available:document.documentElement.clientWidth,
          css:!!document.querySelector('link[href*="sales-design.css?v="]')};
      });
      assert.ok(layout.css,name+' loads versioned shared Sales styles');
      assert.equal(layout.max,'1200px',name+' uses dashboard width');
      same(layout.width,Math.min(1200,layout.available),name+' container width');
      assert.equal(layout.bg,'rgb(246, 246, 242)',name+' uses dashboard background');
      assert.ok(layout.pageWidth<=layout.viewport+1,name+' has no page-wide horizontal overflow: '+JSON.stringify(layout));
      checks+=4;
      await page.screenshot({path:shotPath('sales-design-'+name.replace('.html','')+'-'+width+'.png'),fullPage:false});
    }
  }
  for(const width of [1360,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto(BASE+'/sales/company-segments.html');
    await page.locator('#lc-rows tr[data-id="'+companyId+'"] td:nth-child(3)').click();
    await page.waitForSelector('#lc-dialog[open]');
    await page.waitForFunction(()=>!document.querySelector('#lc-tab-analysis').disabled);
    const initial=await page.locator('#lc-dialog').boundingBox();
    for(const step of ['analysis','proposal','info','proposal']) {
      await page.click('#lc-tab-'+step);
      const rect=await page.locator('#lc-dialog').boundingBox();
      same(initial.x,rect.x,'dialog x after '+step);
      same(initial.y,rect.y,'dialog y after '+step);
      same(initial.width,rect.width,'dialog width after '+step);
      same(initial.height,rect.height,'dialog height after '+step);
    }
    await page.waitForSelector('.lp-compact-search input');
    const controls=await page.locator('.lp-compact-search').evaluate(el=>({
      rect:{width:el.clientWidth,scroll:el.scrollWidth},
      items:[...el.querySelectorAll('input,select,button')].map(n=>({tag:n.tagName,x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.getBoundingClientRect().width}))
    }));
    assert.ok(controls.rect.scroll<=controls.rect.width+1,'search controls fit modal');
    if(width>760){
      for(const c of controls.items)same(c.y,controls.items[0].y,'desktop search toolbar single row');
      assert.ok(controls.items.find(c=>c.tag==='SELECT').width<200,'filter does not occupy whole row');
    }
    const nav=await page.locator('.lc-stage-bar-three').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    assert.ok(nav.scroll<=nav.width+1,'three stages fit mobile and desktop');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).overflow),'hidden','dialog locks background scroll');
    await page.locator('.lp-compact-search input').focus();
    const focus=await page.locator('.lp-compact-search input').evaluate(el=>getComputedStyle(el).outlineStyle);
    assert.notEqual(focus,'none','keyboard focus remains visible');
    await page.screenshot({path:shotPath('sales-design-company-modal-'+width+'.png')});
    await page.click('#lc-close');
    assert.notEqual(await page.evaluate(()=>getComputedStyle(document.body).overflow),'hidden','closing restores page scroll');
    checks+=6;
  }
  assert.deepEqual(writes,[],'layout inspection never writes business data');
  console.log(`${checks} layout checks passed across ${pages.length} Sales pages at desktop and mobile sizes`);
} finally { await browser.close(); }
