// Component browser coverage; no real accounts, APIs, mail, or writes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "../_browser.mjs";
const browser = process.env.TEST_PLAYWRIGHT
  ? await (await import(process.env.TEST_PLAYWRIGHT)).chromium.launch({ executablePath:process.env.TEST_CHROME })
  : await launch();
try {
  const page = await browser.newPage({ viewport:{ width:390, height:844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const html = await readFile(new URL("../../sales/analytics.html", import.meta.url), "utf8");
  assert.match(html, /SalesAnalyticsHub.init/);
  assert.match(html, /id="proposal-journey"/);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  await page.setContent(`<style>body{margin:12px}*{box-sizing:border-box}${css}</style><div id="proposal-journey"></div>`);
  await page.evaluate(() => {
    window.API = { api: (url) => new Promise((resolve,reject) => window.requests.push({url,resolve,reject})) };
    window.requests = [];
    window.fixture = {
      since:"2026-10-01", until:"2026-10-23T11:00:00Z", cohortCount:21,
      counts:{sent:21,adjusted:4,scheduled:3,held:2,accepted:1,won:0,working:0},
      rates:{heldFromSent:9.5,acceptedFromHeld:null}, coverage:{acceptedUnknown:20},
      rows:Array.from({length:21},(_,i)=>({id:`p-${i}`,title:i===0?'<img src=x onerror="window.bad=1">':`提案${i}`,companyName:'テスト企業',sentAt:'2026-10-01T00:00:00Z',acceptedEvidence:i===0?'snapshot':null})),
    };
  });
  await page.addScriptTag({content:await readFile(new URL("../../js/sales-analytics-charts.js",import.meta.url),"utf8")});
  await page.addScriptTag({content:await readFile(new URL("../../js/sales-proposal-journey.js",import.meta.url),"utf8")});
  await page.evaluate(()=>SalesProposalJourney.show());
  assert.match(await page.locator("#pj-content").innerText(),/読み込んでいます/);
  await page.evaluate(()=>requests[0].resolve(fixture));
  // 開いた時点でグラフ（7段の棒）が出る。「グラフを表示」などの操作は要らない
  await page.locator("#pj-chart [data-chart-key]").first().waitFor();
  assert.equal(await page.locator("#pj-chart [data-chart-key]").count(),7);
  assert.match(await page.locator("#pj-chart").innerText(),/前の段を通った件数ではありません/);
  assert.equal(await page.locator("#pj-chart .sc-row").first().locator(".sc-val").innerText(),"21件");
  assert.match(await page.locator("#pj-content").innerText(),/未確認：20件/);
  // 棒を押すと、その段の記録がある提案だけが根拠の表に出る（ENGER合格の証拠は1件）
  await page.locator('#pj-chart [data-chart-key="accepted"]').click();
  assert.equal(await page.locator(".pj-records").getAttribute("open"),"");
  assert.equal(await page.locator(".pj-records tbody tr").count(),1);
  assert.match(await page.locator(".pj-filter").innerText(),/ENGER合格/);
  assert.equal(await page.locator('#pj-chart [data-chart-key="accepted"]').getAttribute("class"),"sc-row sc-on");
  await page.locator("[data-pj-clear]").click();
  assert.equal(await page.locator(".pj-filter").count(),0);
  assert.match(await page.locator("#pj-content").innerText(),/面談→合格：—/);
  assert.equal(await page.locator(".pj-records tbody tr").count(),20);
  assert.equal(await page.locator(".pj-records tbody img").count(),0);
  assert.match(await page.locator(".pj-records tbody").innerText(),/証拠あり・日付未確認/);
  assert.equal(await page.locator(".pj-records tbody a").first().getAttribute("href"),"proposals.html?id=p-0");
  assert.equal(await page.evaluate(()=>!!window.bad),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),"mobile viewport does not overflow");
  await page.locator('[data-pj-page="1"]').click();
  assert.equal(await page.locator(".pj-records tbody tr").count(),1);
  // A slower old response must not replace the new period.
  await page.locator("#pj-days").selectOption("7");
  await page.locator("#pj-days").selectOption("1");
  await page.evaluate(()=>requests[2].resolve({...fixture, counts:{...fixture.counts,sent:8},coverage:{acceptedUnknown:7,activityTruncated:true}}));
  await page.waitForFunction(()=>document.querySelector("#pj-chart .sc-val")?.textContent.includes("8"));
  await page.evaluate(()=>requests[1].resolve(fixture));
  assert.match(await page.locator("#pj-chart .sc-val").first().innerText(),/^8/);
  assert.match(await page.locator("#pj-content").innerText(),/取得上限/);
  await page.locator("#pj-refresh").click();
  await page.evaluate(()=>requests[3].reject(new Error('<script>bad</script>')));
  await page.locator('[role="alert"]').waitFor();
  assert.match(await page.locator('[role="alert"]').innerText(),/0件ではありません/);
  assert.equal(await page.locator("#pj-chart").count(),0,"取得失敗ではグラフ（0件の棒）を出さない");
  assert.equal(await page.locator("#pj-content").getAttribute("data-state"),"error");
  // 失敗の中の「再試行」から取り直せる。未設定（503）は別の言い方
  await page.locator("[data-pj-retry]").click();
  await page.evaluate(()=>requests[4].reject(Object.assign(new Error("db/138 を適用してください"),{code:"not_ready",status:503})));
  await page.locator('[data-state="not-ready"][role="status"]').waitFor();
  assert.match(await page.locator("#pj-content").innerText(),/未設定/);
  assert.equal(await page.locator("#pj-chart").count(),0);
  await page.locator("[data-pj-retry]").click();
  await page.evaluate(()=>requests[5].resolve({...fixture,rows:[],counts:{sent:0,adjusted:0,scheduled:0,held:0,accepted:0,won:0,working:0},coverage:{acceptedUnknown:0}}));
  await page.locator('.pj-empty[data-state="empty"]').waitFor();
  assert.match(await page.locator(".pj-empty").innerText(),/取得できました：この期間に送信した提案は0件です/);
  assert.equal(await page.locator("#pj-chart").count(),0,"0件では空の棒を描かない");
  await page.locator(".pj-records summary").click();
  assert.match(await page.locator(".pj-records tbody").innerText(),/提案はありません/);
  // 一度読めたら、もう一度開いても（タブに戻っても）取り直さない
  await page.evaluate(()=>SalesProposalJourney.show());
  assert.equal(await page.evaluate(()=>requests.length),6);
  assert.equal(await page.evaluate(()=>requests.every(r=>/^\/api\/sales\/proposals\/journey\?days=(1|7|30|90|365)$/.test(r.url))),true);
  assert.deepEqual(errors,[]);
  console.log("proposal journey UI: chart on open, bar → evidence filter, mobile, pagination, stale response, error / not-ready / empty, no refetch passed");
} finally { await browser.close(); }
