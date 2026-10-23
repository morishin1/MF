// Fixture-only navigation: no authentication, network business data or writes.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launch} from '../_browser.mjs';
const browser=await launch();
try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const html=await readFile(new URL('../../sales/analytics.html',import.meta.url),'utf8');
  const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const body=html.slice(html.indexOf('<div class="wrap">'),html.indexOf('<div id="drawer-root">'));
  await page.route('https://sales-fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:`<style>*{box-sizing:border-box}body{margin:12px}${css}</style>${body}`}));
  await page.goto('https://sales-fixture.invalid/analytics.html#proposal');
  await page.evaluate(()=>{window.calls={attack:0,proposal:0};window.SalesProposalJourney={show(){window.calls.proposal++;}};});
  await page.addScriptTag({content:await readFile(new URL('../../js/sales-analytics-hub.js',import.meta.url),'utf8')});
  await page.evaluate(()=>SalesAnalyticsHub.init({loadAttack(){window.calls.attack++;}}));
  assert.equal(await page.locator('#ah-panel-proposal').isVisible(),true);
  await page.locator('#ah-tab-proposal').click();
  assert.equal(await page.evaluate(()=>calls.proposal),1);
  await page.locator('#ah-tab-matching').click();
  assert.match(await page.locator('#ah-panel-matching').innerText(),/未接続/);
  assert.match(await page.locator('#ah-plan').innerText(),/仮説例（未検証）/);
  await page.locator('#ah-question').selectOption('1');
  await page.locator('#ah-tab-attack').click();
  assert.equal(await page.evaluate(()=>calls.attack),1);
  await page.goBack();
  assert.equal(await page.locator('#ah-panel-matching').isVisible(),true);
  assert.equal(await page.locator('#ah-question').inputValue(),'1');
  await page.locator('#ah-tab-matching').focus();await page.keyboard.press('End');
  assert.equal(await page.locator('#ah-tab-proposal').getAttribute('aria-selected'),'true');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile no page overflow');
  console.log('PASS analytics hub browser: deep link, repeated clicks, matching limits, choice, Back and keyboard');
} finally {await browser.close();}
