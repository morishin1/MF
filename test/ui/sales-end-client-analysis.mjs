// Salesエンド営業タブ：既存2タブを壊さず、集計・注記・画面幅を検証。
// 全APIは合成応答。顧客DBへは接続しない。
import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";
import { session, salesDesignFixture } from "../fixtures/sales-design.mjs";

const browser = await launch();
const apiCalls = [];
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript((s) => localStorage.setItem("kp_session", JSON.stringify(s)), session);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    apiCalls.push(req.method() + " " + url.pathname + url.search);
    if (url.pathname === "/api/sales/end-client-analysis") {
      const data = {
        version: 1, days: Number(url.searchParams.get("days")), periodSince: "2026-10-22",
        asOfJst: "2026-11-20", scope: "manager",
        inventory: {
          registeredCompanies: 7500, endClients: { flaggedCount: 29, industryKnown: 0, sizeKnown: 0 },
          registeredCandidates: 13000, candidatesAvailable: 11700,
          immediate: 4384, proposable: 7123, candidateSheets: 9395, candidateSourceMail30: 1100,
          registeredJobs: 5900, jobsNotClosed: 4780,
          roles: [{ title: "クラウドエンジニア", count: 2264 },
            { title: "<img src=x onerror=alert(1)>", count: 12 }],
          proposalHistory: {
            totalRecords: 1752, lostRecords: 679, rejectedRecords: 950, proposingRecords: 114,
            lossReasons: [{ label: "スキル・条件不一致", count: 300 }],
          },
        },
        activity: {
          salesTargets: 4065, approachesTotal: 457, approachesSent: 284, approachClicks: 24,
          proposalsSent: 394, meetingScreenSessions: 49,
          portalActiveMembers: 10, portalOffers: 2, portalSubmissions: 5,
        },
        contracts: {
          totalRecords: 35, statusWorking: 34, statusPlanned: 1, companyNames: 29,
          endDateMissing: 33, withProposalId: 1,
          salesDealRecords: 0, salesWonDealRecords: 0, salesSuccessFeeRecords: 0,
        },
        notes: ["ステータスは実稼働の証明ではありません。"],
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    }
    return route.fulfill({ status: req.method() === "GET" ? 200 : 405,
      contentType: "application/json", body: JSON.stringify(salesDesignFixture(url.pathname)) });
  });

  await page.goto(BASE + "/sales/analytics.html?tab=end");
  await page.waitForSelector(".an-ec-card");
  assert.equal(await page.locator("#an-tab-end").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#an-proposal-panel").isVisible(), false);
  assert.equal(await page.locator("#an-attack-panel").isVisible(), false);
  assert.match(await page.locator("#an-end-body").innerText(), /4,384/);
  assert.match(await page.locator("#an-end-body").innerText(), /Sales成約ステージ台帳/);
  assert.match(await page.locator("#an-end-body").innerText(), /実商談数ではない/);
  assert.equal(await page.locator("#an-end-body img").count(), 0, "API由来ラベルはHTMLとして挿入しない");

  await page.locator("#period button").first().click(); // 30日
  await page.waitForFunction(() => document.querySelector("#an-end-body")?.textContent?.includes("2026-11-20"));
  assert.ok(apiCalls.some((call) => call.includes("/api/sales/end-client-analysis?days=30")));

  await page.locator("#an-tab-proposal").click();
  assert.equal(await page.locator("#an-proposal-panel").isVisible(), true);
  await page.locator("#an-tab-attack").click();
  assert.equal(await page.locator("#an-attack-panel").isVisible(), true);
  await page.locator("#an-tab-end").click();
  await page.waitForSelector(".an-ec-card");

  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, width: innerWidth,
  }));
  assert.ok(layout.scroll <= layout.width + 1, "モバイルの横はみ出しがない " + JSON.stringify(layout));
  assert.equal(apiCalls.filter((s) => !s.startsWith("GET ")).length, 0, "分析は読み取り専用");
  assert.deepEqual(pageErrors, []);
  console.log("Sales end-client analytics: tabs, 30-day reload, source notes, safe rendering and mobile width OK");
} finally {
  await browser.close();
}
