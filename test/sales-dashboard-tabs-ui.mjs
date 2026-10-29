import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { buildSalesDashboardAnalysis, previousSalesPeriod } from '../lib/sales-dashboard-analysis.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch(process.env.TEST_CHROME ? {executablePath:process.env.TEST_CHROME} : {});
try {
 const page=await browser.newPage();
 await page.route('https://sales.test/**', route=>route.fulfill({body:'<html></html>',contentType:'text/html'}));
 await page.goto('https://sales.test/');
 const html=(await fs.readFile(new URL('../sales/index.html',import.meta.url),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
 await page.setContent(html);
 const period={key:'custom',from:'2026-10-28',to:'2026-10-29',days:2,sinceIso:'2026-10-27T15:00:00Z',untilIso:'2026-10-29T15:00:00Z'};
 const proposals=Array.from({length:15},(_,i)=>({id:String(i),company_id:'c',company_name:'試験企業 <script>',sales_owner_id:'a',sent_at:'2026-10-28T00:00:00Z',status:'reply_wait'}));
 const data=buildSalesDashboardAnalysis({period,previous:previousSalesPeriod(period),proposals,employees:[{id:'a',display_name:'担当A'}]});
 assert.equal(data.metrics.trend[0].sent,15); assert.equal(data.metrics.trend[1].sent,0);
 assert.equal(data.metrics.companies[0].blastCandidate,true);
 await page.evaluate(d=>{window.API={api:async()=>d};},data);
 await page.addScriptTag({content:await fs.readFile(new URL('../js/sales-dashboard-report.js',import.meta.url),'utf8')});
 await page.evaluate(()=>SalesDashboardReport.load());
 assert.equal(await page.locator('.db-analysis-tabs button').count(),5);
 await page.locator('[data-analysis-tab="companies"]').click();
 assert.equal(await page.getByRole('cell',{name:'試験企業 <script>',exact:true}).count(),1);
 assert.equal(await page.locator('.db-report-grid > section:visible').count(),1);
 await page.locator('[data-analysis-tab="owners"]').click();
 await page.selectOption('#db-ranking-metric','conversionRate');
 assert.match(await page.locator('#db-ranking-bars').innerText(),/0.0%/);
 await page.selectOption('#db-ranking-metric','duration');
 assert.match(await page.locator('#db-ranking-bars').innerText(),/未計測/);
 await page.locator('[data-analysis-tab="blast"]').click();
 assert.match(await page.locator('.db-report-grid').innerText(),/ブラスト限定候補/);
 await page.locator('[data-analysis-tab="overview"]').click();
 for(const width of [390,768,1440]) {
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width);
 }
 console.log('PASS analysis tabs, company classification, rankings, missing measurement, chart layout 390/768/1440');
} finally { await browser.close(); }
