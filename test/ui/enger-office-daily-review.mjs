import { chromium } from "playwright";
import assert from "node:assert/strict";

const office = { office: true, enger: false };
const enger = { office: false, enger: true };
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
    body: "window.API = { api: async (path, options = {}) => fetch(path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }).then(response => response.json()) };",
  }));
  await page.route("**/js/layout-marketing.js", route => route.fulfill({
    contentType: "text/javascript", body: "window.KPLayout = { init: async () => ({ me: {} }) };",
  }));
  await page.route("**/api/enger/office-daily-review*", route => {
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
  await page.goto("http://127.0.0.1:8713/enger-daily-review.html");
  await page.getByRole("heading", { name: "今日の打ち合わせ", exact: true }).waitFor();
  return page;
}

try {
  const page = await openBoard(office, { width: 390, height: 844 });
  const meeting = page.locator("#edr-meeting");
  const normal = page.getByRole("article").filter({ hasText: "通常企業" });
  await page.getByRole("heading", { name: "今日の議題 0件" }).waitFor();
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
  await meeting.getByRole("button", { name: "記録してOfficeの確認を完了" }).click();
  await meeting.getByText("Office 確認済み", { exact: true }).waitFor();
  assert.equal(await meeting.locator("form").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  const desktop = await openBoard(enger, { width: 1280, height: 800 });
  const shared = desktop.locator("#edr-meeting");
  await shared.getByText("先方と希望単価に差").waitFor();
  await shared.getByText("再提案する条件を確認").waitFor();
  assert.equal(await shared.locator("form").count(), 0);
  assert.equal(await desktop.getByRole("button", { name: "確認済みにする" }).count(), 0);
  await shared.getByRole("button", { name: "ENGERの確認を完了" }).click();
  await shared.getByText("ENGER 確認済み", { exact: true }).waitFor();
  assert.deepEqual(actions.map(cmd => [cmd.action, cmd.side]), [
    ["check", undefined], ["check", undefined], ["save_meeting", "office"], ["confirm_meeting", "enger"],
  ]);
  assert.equal(actions[2].agenda[0].fact, "先方と希望単価に差");
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("Office mobile and ENGER desktop: visible agenda, single-click screening and confirmations, draft retained, no horizontal overflow");
} finally {
  await browser.close();
}
