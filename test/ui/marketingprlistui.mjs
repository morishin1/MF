// Synthetic-only acceptance. Never uses a live API or saves real data.
import assert from 'node:assert/strict';
import {launch,BASE} from '../_browser.mjs';
const browser=await launch();let checks=0;
const check=(v,label)=>{assert.ok(v,label);checks++;console.log('ok',label);};
const prod={sources:[{key:'site_news',biz:'site',label:'自社サイト原本',state:'ok',count:45},{key:'plan',biz:null,label:'制作予定',state:'ok',count:2},{key:'mugen_contents',biz:'mugen',label:'記事',state:'not_connected',count:null},{key:'space_articles',biz:'space',label:'記事',state:'forbidden',count:null},{key:'ec_sns',biz:'ec',label:'記事',state:'not_ready',count:null}],items:[...Array.from({length:45},(_,i)=>({key:'site_news:'+i,origin:'site_news',biz:'site',medium:'column',mediumLabel:'コラム',title:'自社サイト記事 '+i,summary:'記事の説明',owner:null,ownerFrom:'none',state:{key:'drafting',label:'作成中'}})),...Array.from({length:2},(_,i)=>({key:'plan:'+i,origin:'plan',biz:'mugen',medium:'sns',mediumLabel:'SNS',title:'無限道場の企画 '+i,summary:'制作予定',state:{key:'review',label:'確認待ち'},version:1}))],employees:[],videoSites:[]};
try{
 for(const width of [1440,768,390]){
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.route('**/js/api-client.js*',r=>r.fulfill({contentType:'application/javascript',body:`window.__calls=[];window.API={isLoggedIn:()=>true,api:async(path,options={})=>{window.__calls.push({path,method:options.method||'GET'});if(options.method&&options.method!=='GET')throw Error('write forbidden');if(path==='/api/marketing?view=production')return ${JSON.stringify(prod)};if(path==='/api/marketing?view=work')return {sources:[],items:[],openCount:0};if(path==='/api/marketing/pr-drafts')return {ready:true,items:[]};return {};}};`}));
  await context.route('**/js/marketing-layout.js*',r=>r.fulfill({contentType:'application/javascript',body:`window.MarketingLayout={init:async()=>{document.body.classList.add('marketing-app','of-app');return {};},esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt:s=>s||'',fmtDay:s=>s||'',pill:s=>'<span>'+String(s)+'</span>'};`}));
  await context.route(/^https:\/\/fonts\./,r=>r.fulfill({contentType:'text/css',body:''}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(BASE+'/marketing/?step=dashboard&biz=mugen');
  await page.locator('#prodSiteTabs [role=tab]').first().waitFor({state:'attached'});
  const nav=page.locator('#marketing-primary-tabs');
  check((await nav.locator('button').allTextContents()).map(s=>s.replace(/dashboard|edit_note|campaign|list_alt|monitoring/g,'').trim()).join('|')==='ダッシュボード|PRを作る|拡散する|PR一覧|効果を分析','primary order '+width);
  for(const step of ['dashboard','pr','distribution','list','analytics']){
   const tab=page.locator('#mkt-tab-'+step);await tab.click();await tab.hover();
   check(await tab.evaluate(el=>getComputedStyle(el).backgroundColor)==='rgb(255, 255, 255)','white selected and hover '+step+' '+width);
   check(await page.locator('.mkt-primary-panel:visible').count()===1,'only one primary panel '+step+' '+width);
  }
  await page.locator('#mkt-tab-pr').click();
  const title=page.locator('#marketing-handoff-pr-composer .mpr-field').filter({hasText:'タイトル'}).locator('input').first();
  await title.fill('保存しない入力途中のPR');
  await page.getByRole('tab',{name:'2. 発表内容'}).click();
  await page.locator('#mkt-tab-list').click();
  check(await page.locator('#prodList .mk-item').count()===20,'page bounded to20 '+width);
  check(await page.locator('#pr-site-all').getAttribute('aria-selected')==='true','dashboard business does not leak into list '+width);
  check(!(await page.locator('#marketing-handoff-pr-composer').isVisible()),'composer not in list '+width);
  await page.locator('#pr-site-site').click();
  await page.locator('#prodPagination').getByRole('button',{name:'次へ'}).click();
  check(await page.locator('#prodList .mk-item').count()===20&&new URL(page.url()).searchParams.get('prPage')==='2','next page and URL '+width);
  await page.reload();await page.locator('#prodList .mk-item').first().waitFor();
  check(await page.locator('#pr-site-site').getAttribute('aria-selected')==='true'&&(await page.locator('#prodPagination').innerText()).includes('2 / 3'),'site/page restore '+width);
  await page.locator('#prodPagination').getByRole('button',{name:'次へ'}).click();
  check(await page.locator('#prodList .mk-item').count()===5&&await page.locator('#prodPagination').getByRole('button',{name:'次へ'}).isDisabled(),'last page boundary '+width);
  await page.locator('#pr-site-mugen').click();check(await page.locator('#prodList .mk-item').count()===2,'site isolates plans '+width);
  await page.locator('#prodList .mk-hd').first().click();
  await page.locator('#prodList [data-f=snsText]').first().fill('ページ移動しても残す未保存文案');
  await page.locator('#pr-site-site').click();await page.locator('#pr-site-mugen').click();
  check(await page.locator('#prodList [data-f=snsText]').first().inputValue()==='ページ移動しても残す未保存文案','inline unsaved text retained across site tabs '+width);
  await page.locator('#pr-site-space').click();
  check((await page.locator('#pr-site-space').innerText()).includes('権限なし')&&!(await page.locator('#pr-site-space').innerText()).includes('0件'),'forbidden not zero '+width);
  await page.locator('#pr-site-space').press('Home');check(await page.locator('#pr-site-all').getAttribute('aria-selected')==='true','site keyboard Home '+width);
  await page.locator('#pr-site-all').press('End');check(await page.locator('#pr-site-ec').getAttribute('aria-selected')==='true','site keyboard End '+width);
  await page.locator('#pr-site-ec').press('ArrowRight');check(await page.locator('#pr-site-all').getAttribute('aria-selected')==='true','site keyboard wraps '+width);
  await page.reload();await page.locator('#prodList .mk-item').first().waitFor();
  check(await page.locator('#pr-site-all').getAttribute('aria-selected')==='true','all-site survives reload with dashboard filter '+width);
  await page.locator('#pr-site-mugen').click();await page.locator('#pr-site-site').click();await page.goBack();
  check(await page.locator('#pr-site-mugen').getAttribute('aria-selected')==='true','Back restores site '+width);
  await page.goForward();check(await page.locator('#pr-site-site').getAttribute('aria-selected')==='true','Forward restores site '+width);
  await page.locator('#mkt-tab-pr').click();
  await title.fill('戻る前の入力');await page.getByRole('tab',{name:'2. 発表内容'}).click();
  await page.locator('#mkt-tab-list').click();await page.locator('#mkt-tab-pr').click();
  check(await page.getByRole('tab',{name:'2. 発表内容'}).getAttribute('aria-selected')==='true','composer tab survives navigation '+width);
  await page.getByRole('tab',{name:'1. 基本情報'}).click();check(await title.inputValue()==='戻る前の入力','unsaved draft survives navigation '+width);
  check(!(await page.locator('#mk-worklist').evaluate(el=>el.open)),'inquiry fold remains collapsed '+width);
  await page.locator('#mkt-tab-pr').press('End');check(await page.locator('#mkt-tab-analytics').getAttribute('aria-selected')==='true','primary keyboard End '+width);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no document horizontal overflow '+width);
  await page.goto(BASE+'/marketing/?tab=production&biz=mugen');await page.locator('#prodList .mk-item').first().waitFor();
  check(await page.locator('#mkt-panel-list').isVisible()&&await page.locator('#prodList .mk-item').count()===2,'legacy production link '+width);
  await page.goto(BASE+'/marketing/?tab=work&biz=space');await page.locator('#prodSiteTabs button').first().waitFor({state:'attached'});
  check(await page.locator('#mkt-panel-pr').isVisible()&&await page.locator('#mk-worklist').evaluate(el=>el.open),'legacy inquiry link '+width);
  check((await page.evaluate(()=>window.__calls)).every(x=>x.method==='GET'),'navigation never writes '+width);
  check(!errors.length,'no JS errors '+width+': '+errors.join('|'));
  await context.close();
 }
}finally{await browser.close();}
console.log(`${checks} synthetic marketing PR list browser checks passed`);
