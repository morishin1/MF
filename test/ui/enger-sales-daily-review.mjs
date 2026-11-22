import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const proposals = readFileSync(new URL("../../sales/proposals.html", import.meta.url), "utf8");
const officeHome = readFileSync(new URL("../../office/index.html", import.meta.url), "utf8");
assert.ok(proposals.includes('data-proposal-coordination'));
assert.ok(!officeHome.includes("daily-review"));

const sales = { sales: true, enger: false };
const enger = { sales: false, enger: true };
const base = {
  sentAt: "2026-11-22T04:00:00Z", status: "対応中", outcome: null, revision: 0,
  companyResponse: "先方確認中", candidateResponse: "開始日確認済み",
};
const fixture = {
  day: "2026-11-22", today: "2026-11-22", reasons: { terms: "単価・条件" },
  rows: [
    { ...base, id: "normal", sourceId: "normal", title: "通常の提案", company: "通常企業" },
    { ...base, id: "issue", sourceId: "issue", title: "相談する提案", company: "相談企業" },
  ],
  meeting: null,
};
const actions = [];
const browser = await chromium.launch();

async function openBoard(roles, viewport) {
  const page = await browser.newPage({ viewport });
  await page.route("**/js/api-client.js*", route => route.fulfill({
    contentType: "text/javascript",
    body: "window.API = { isLoggedIn: () => true, api: async (path, options = {}) => fetch(path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }).then(response => response.json()) };",
  }));
  await page.route("**/js/layout-marketing.js", route => route.fulfill({
    contentType: "text/javascript", body: "window.KPLayout = { init: async () => { document.body.dataset.app = 'gw'; return { me: {} }; } };",
  }));
  await page.route("**/js/sales-layout.js*", route => route.fulfill({
    contentType: "text/javascript", body: "window.SalesLayout = { init: async (opts) => { document.body.dataset.app = opts.active; } };",
  }));
  await page.route("**/api/sales/proposals/daily-review*", route => {
    if (route.request().method() === "POST") {
      const cmd = route.request().postDataJSON();
      actions.push(cmd);
      if (cmd.action === "check") Object.assign(fixture.rows.find(row => row.id === cmd.id), {
        outcome: cmd.outcome, reason: fixture.reasons[cmd.reason], reasonCode: cmd.reason, fact: cmd.fact, revision: 1,
      });
      if (cmd.action === "save_meeting") {
        fixture.meeting = {
          note: cmd.note, next_step: cmd.nextStep,
          agenda: fixture.rows.filter(row => row.outcome === "discuss"), revision: 1,
          [cmd.side + "_confirmed_at"]: "now",
        };
      }
      if (cmd.action === "confirm_meeting") fixture.meeting[cmd.side + "_confirmed_at"] = "now";
    }
    return route.fulfill({ json: { ...fixture, roles, canConfirm: roles } });
  });
  await page.goto("http://127.0.0.1:8713/sales/proposals-daily-review.html");
  await page.getByRole("heading", { name: "今日の打ち合わせ", exact: true }).waitFor();
  await page.locator(roles.sales ? 'body[data-app="proposals"]' : 'body[data-app="gw"]').waitFor();
  return page;
}

try {
  const page = await openBoard(sales, { width: 390, height: 844 });
  const meeting = page.locator("#edr-meeting");
  const normal = page.getByRole("article").filter({ hasText: "通常企業" });
  await page.getByRole("heading", { name: "今日の議題 0件" }).waitFor();
  await page.getByRole("link", { name: "Salesの提案管理" }).waitFor();
  assert.ok((await page.getByRole("heading", { name: "今日の打ち合わせ", exact: true }).boundingBox()).y < 400);
  await normal.getByRole("button", { name: "確認済みにする" }).click();
  await page.getByText("提案を確認済みにしました。").waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(actions.map(cmd => [cmd.action, cmd.outcome]), [["check", "checked"]]);

  await meeting.getByLabel("決まったこと").fill("再提案する条件を確認");
  const issue = page.getByRole("article").filter({ hasText: "相談企業" });
  await issue.getByRole("button", { name: "議題に追加" }).click();
  const dialog = page.getByRole("dialog", { name: "議題に追加" });
  await dialog.getByText("相談企業 ／ 相談する提案").waitFor();
  await dialog.getByText("先方確認中", { exact: false }).waitFor();
  assert.equal(await dialog.locator("select").count(), 1);
  await dialog.getByLabel("相談する理由").selectOption("terms");
  await dialog.getByLabel("確認した事実").fill("先方と希望単価に差");
  await dialog.getByRole("button", { name: "議題に追加" }).click();
  await meeting.getByText("先方と希望単価に差").waitFor();
  assert.equal(await meeting.getByLabel("決まったこと").inputValue(), "再提案する条件を確認");
  await meeting.getByLabel("次の対応・担当・期限").fill("ENGERが明日確認");
  await meeting.getByRole("button", { name: "記録してSalesの確認を完了" }).click();
  await meeting.getByText("Sales 確認済み", { exact: true }).waitFor();
  assert.equal(await meeting.locator("form").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  const desktop = await openBoard(enger, { width: 1280, height: 800 });
  const shared = desktop.locator("#edr-meeting");
  assert.equal(await desktop.getByRole("link", { name: "Salesの提案管理" }).count(), 0);
  await shared.getByText("先方と希望単価に差").waitFor();
  await shared.getByText("再提案する条件を確認").waitFor();
  assert.equal(await shared.locator("form").count(), 0);
  assert.equal(await desktop.getByRole("button", { name: "確認済みにする" }).count(), 0);
  await shared.getByRole("button", { name: "ENGERの確認を完了" }).click();
  await shared.getByText("ENGER 確認済み", { exact: true }).waitFor();
  assert.deepEqual(actions.map(cmd => [cmd.action, cmd.side]), [
    ["check", undefined], ["check", undefined], ["save_meeting", "sales"], ["confirm_meeting", "enger"],
  ]);
  assert.equal(actions[2].agenda[0].fact, "先方と希望単価に差");
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const termCalls = [];
  let confirmed = false;
  await desktop.route("**/api/sales/proposals/coordination*", route => {
    if (route.request().method() === "POST") {
      termCalls.push(route.request().postDataJSON());
      confirmed = true;
    }
    return route.fulfill({ json: { canSave: false, canConfirm: true,
      source: { id: "case-id", company: "提案企業", job: "開発エンジニア", revision: "v1", line: {}, contacts: [] },
      record: { revision: 1, decision: "企業の希望を確認する", nextStep: "Salesが明日までに企業へ回答",
        engerConfirmedAt: confirmed ? "now" : null },
    } });
  });
  await desktop.goto("http://127.0.0.1:8713/sales/proposals-daily-review.html?proposal=case-id");
  const casePanel = desktop.getByRole("region", { name: "提案の認識合わせ" });
  await casePanel.getByText("企業の希望を確認する", { exact: true }).waitFor();
  assert.equal(await desktop.locator("#edr-board").isHidden(), true);
  assert.equal(await desktop.locator("#edr-board-nav").isHidden(), true);
  assert.equal(await casePanel.getByRole("heading", { name: "ENGERの入力と認識合わせ" }).count(), 0);
  assert.equal(await casePanel.getByRole("link", { name: "ENGERの提案詳細に戻る" }).count(), 1);
  await desktop.setViewportSize({ width: 390, height: 844 });
  const confirm = casePanel.getByRole("button", { name: "確認", exact: true });
  assert.ok((await confirm.boundingBox()).y < 844);
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await confirm.click();
  await casePanel.getByText("Sales・ENGER 確認済み", { exact: true }).waitFor();
  assert.deepEqual(termCalls, [{ sourceId: "case-id", action: "confirm", revision: 1, sourceRevision: "v1" }]);
  console.log("Sales mobile and ENGER desktop: visible agenda, single-click screening and confirmations, draft retained, no horizontal overflow");
} finally {
  await browser.close();
}
