import { chromium } from "playwright";
import assert from "node:assert/strict";

const office = { office: true, enger: false };
const enger = { office: false, enger: true };
const proposal = {
  id: "proposal", sourceId: "source", title: "提案", company: "テスト企業",
  sentAt: "2026-11-22T04:00:00Z", status: "対応中", outcome: null, revision: 0,
};
const board = {
  day: "2026-11-22", today: "2026-11-22", roles: office, reasons: { terms: "単価・条件" },
  rows: [proposal], canConfirm: office, meeting: null,
};
const actions = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("**/js/api-client.js*", route => route.fulfill({
    contentType: "text/javascript",
    body: "window.API = { api: async (path, options = {}) => fetch(path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }).then(response => response.json()) };",
  }));
  await page.route("**/js/layout-marketing.js", route => route.fulfill({
    contentType: "text/javascript", body: "window.KPLayout = { init: async () => ({ me: {} }) };",
  }));
  await page.route("**/api/enger/office-daily-review*", route => {
    if (route.request().method() === "POST") {
      const cmd = route.request().postDataJSON();
      actions.push(cmd.action);
      if (cmd.action === "check") Object.assign(proposal, {
        outcome: cmd.outcome, reason: "単価・条件", reasonCode: cmd.reason, fact: cmd.fact, revision: 1,
      });
      if (cmd.action === "save_meeting") {
        board.meeting = { note: cmd.note, next_step: cmd.nextStep, agenda: [proposal], revision: 1 };
      }
      if (cmd.action === "confirm_meeting") board.meeting[cmd.side + "_confirmed_at"] = "now";
    }
    return route.fulfill({ json: board });
  });
  await page.goto("http://127.0.0.1:8713/enger-daily-review.html");
  await page.getByRole("button", { name: "確認結果を記録" }).click();
  await page.getByRole("dialog").waitFor();
  await page.locator("#edr-outcome").selectOption("discuss");
  await page.locator("#edr-reason").selectOption("terms");
  await page.locator("#edr-fact").fill("先方と希望単価に差");
  await page.getByRole("button", { name: "確認結果を保存" }).click();
  await page.getByText("先方と希望単価に差").waitFor();
  await page.getByLabel("双方で確認したこと").fill("再提案の条件を確認");
  await page.getByLabel("次にやること・担当・期限").fill("ENGERが明日確認");
  await page.getByRole("button", { name: "打ち合わせを記録" }).click();
  await page.getByRole("button", { name: "Officeとして確認した" }).click();
  await page.getByText("Office 確認済み ／ ENGER 未確認").waitFor();
  board.roles = enger;
  board.canConfirm = enger;
  await page.reload();
  await page.getByRole("button", { name: "ENGERとして確認した" }).click();
  await page.getByText("Office 確認済み ／ ENGER 確認済み").waitFor();
  assert.deepEqual(actions, ["check", "save_meeting", "confirm_meeting", "confirm_meeting"]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("Chromium mobile: Office screening, shared meeting record, confirmations from both teams");
} finally {
  await browser.close();
}
