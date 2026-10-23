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
  const html = await readFile(new URL("../../sales/proposals.html", import.meta.url), "utf8");
  assert.match(html, /if \(view === "kpi"\) SalesProposalJourney.show\(\)/);
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
  await page.addScriptTag({content:await readFile(new URL("../../js/sales-proposal-journey.js",import.meta.url),"utf8")});
  await page.evaluate(()=>SalesProposalJourney.show());
  assert.match(await page.locator("#pj-content").innerText(),/読み込んでいます/);
  await page.evaluate(()=>requests[0].resolve(fixture));
  await page.locator(".pj-card").first().waitFor();
  assert.equal(await page.locator(".pj-card").count(),7);
  assert.match(await page.locator("#pj-content").innerText(),/未確認：20件/);
  assert.match(await page.locator("#pj-content").innerText(),/面談→合格：—/);
  await page.locator(".pj-records summary").click();
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
  await page.waitForFunction(()=>document.querySelector(".pj-card strong")?.textContent.includes("8"));
  await page.evaluate(()=>requests[1].resolve(fixture));
  assert.match(await page.locator(".pj-card strong").first().innerText(),/^8/);
  assert.match(await page.locator("#pj-content").innerText(),/取得上限/);
  await page.locator("#pj-refresh").click();
  await page.evaluate(()=>requests[3].reject(new Error('<script>bad</script>')));
  await page.locator('[role="alert"]').waitFor();
  assert.match(await page.locator('[role="alert"]').innerText(),/0件ではありません/);
  assert.equal(await page.locator(".pj-card").count(),0);
  await page.locator("#pj-refresh").click();
  await page.evaluate(()=>requests[4].resolve({...fixture,rows:[],counts:{sent:0,adjusted:0,scheduled:0,held:0,accepted:0,won:0,working:0},coverage:{acceptedUnknown:0}}));
  await page.locator(".pj-card").first().waitFor();
  await page.locator(".pj-records summary").click();
  assert.match(await page.locator(".pj-records tbody").innerText(),/提案はありません/);
  assert.equal(await page.evaluate(()=>requests.every(r=>/^\/api\/sales\/proposals\/journey\?days=(1|7|30|90|365)$/.test(r.url))),true);
  assert.deepEqual(errors,[]);
  console.log("proposal journey UI: mobile, evidence, pagination, stale response, retry and empty state passed");
} finally { await browser.close(); }
