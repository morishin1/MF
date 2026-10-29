// Real-browser regression with synthetic data only. All API calls are intercepted;
// no real authentication, database writes, AI, Google sync, or notifications.
import assert from "node:assert/strict";
import { shotPath } from "../_shot.mjs";
import { launch, BASE } from "../_browser.mjs";

assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname),
  "Run against a local static server, never a live deployment");
const DATE = "2026-10-28";
const originals = [
  {
    id: "copy-source", title: "定例レビュー", body: "本人の作業メモ <img id=copy-xss>",
    planned_quantity: 0, planned_quantity_unit: "件", location: "テスト会議室", category: "meeting", all_day: false, source: "self", visibility: "shared",
    // UTC is the previous day, and this event spans two JST dates.
    starts_at: "2026-10-27T15:30:00.000Z", ends_at: "2026-10-29T02:00:00.000Z",
    gcal_event_id: "never-copy-google-id", gcal_synced_at: "2026-10-20T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
    source_id: "never-copy-source-id", status: "done", attendees: ["nobody@example.invalid"],
    // The real personal GET omits employee_id. Do not accidentally require it.
  },
  {
    id: "all-day-source", title: "終日作業", body: "複数日の作業メモ", location: "テスト拠点",
    category: "visit", all_day: true, source: "self", visibility: "shared",
    starts_at: "2026-10-27T15:00:00.000Z", ends_at: "2026-10-30T14:59:00.000Z",
  },
];
const team = [{ id: "other-person", title: "他メンバーのテスト予定", category: "meeting", source: "self",
  startsAt: "2026-10-28T00:00:00.000Z", endsAt: "2026-10-28T01:00:00.000Z",
  allDay: false, employeeId: "employee-other", employeeName: "テスト社員B", location: "共有会議室" }];
const excluded = [
  { ...originals[0], id:"private-source", visibility:"private" },
  { ...originals[0], id:"busy-source", visibility:"busy" },
  { ...originals[0], id:"other-owner-source", employee_id:"employee-other" },
  ...["booking","leave","hr","google"].map(source => ({...originals[0], id:"excluded-"+source, source})),
];
const own = structuredClone([...originals, ...excluded]), mutations = [], errors = [], unmockedMutations = [];
const payloadKeys = ["title", "body", "location", "category", "allDay", "startsAt", "endsAt", "visibility", "plannedQuantity", "plannedQuantityUnit"].sort();
let quantityAvailable = true;
let nextSaveGate = null, observeSave = null, failNextSave = false, checks = 0;
const check = (ok, name) => { assert(ok, name); checks++; console.log("ok " + name); };
const br = await launch();
let releaseSave = null;

async function setupPage(timezoneId, viewport = { width: 1380, height: 940 }) {
  const page = await br.newPage({ viewport, timezoneId, serviceWorkers: "block" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "synthetic-token", email: "test@example.invalid" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "テスト社員", shows: {}, stage: null }));
  });
  // Block third-party font/image requests as well as any accidental external API.
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== new URL(BASE).origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") return send({ email: "test@example.invalid", appRole: "member", isAdmin: false, shows: {},
      gw: { tenantId: "tenant-test", roles: [], stage: null, employee: { id: "employee-test", display_name: "テスト社員", status: "active" } } });
    if (url.pathname === "/api/schedule") {
      if (method === "GET") {
        const from = Date.parse(url.searchParams.get("from")), to = Date.parse(url.searchParams.get("to"));
        return send({ events: own.filter(e => Date.parse(e.starts_at) >= from && Date.parse(e.starts_at) < to),
          quantityAvailable, tasks: [], bookings: [], external: { events: [] }, googleLink: { connected: true, canWrite: true } });
      }
      const data = JSON.parse(req.postData() || "{}");
      mutations.push({ method, path: url.pathname, data });
      observeSave?.(); observeSave = null;
      if (method !== "POST") return send({ error: "unexpected_mutation" }, 500);
      if (nextSaveGate) { const gate = nextSaveGate; nextSaveGate = null; await gate; }
      if (failNextSave) { failNextSave = false; return route.abort("failed"); }
      const saved = {
        id: "copy-created-" + mutations.length, title: data.title, body: data.body, location: data.location,
        category: data.category, all_day: data.allDay, source: "self", visibility: data.visibility,
        planned_quantity: data.plannedQuantity, planned_quantity_unit: data.plannedQuantityUnit,
        starts_at: new Date(data.startsAt).toISOString(), ends_at: new Date(data.endsAt).toISOString(),
      };
      own.push(saved);
      return send({ event: saved, google: null });
    }
    if (url.pathname === "/api/schedule/team") return send({ events: team,
      people: [{ id: "employee-test", name: "テスト社員" }, { id: "employee-other", name: "テスト社員B" }] });
    if (!["GET", "HEAD"].includes(method)) unmockedMutations.push({ method, path: url.pathname });
    if (url.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  return page;
}

async function loadCalendar(page) {
  await page.goto(BASE + "/calendar.html?date=" + DATE);
  await page.locator('#cal-dayevents [data-cal-event-id="copy-source"]').waitFor();
}
const dialog = page => page.locator("#cal-duplicate");
const field = (page, name) => dialog(page).locator('[name="' + name + '"]');
const submit = page => dialog(page).locator('button[type="submit"]');
async function copyFromDetail(page, id = "copy-source") {
  await page.locator('.oc-grid [data-cal-event-id="' + id + '"]').click();
  await page.locator(".cal-drawer").getByRole("button", { name: "複製する", exact: true }).click();
  await dialog(page).waitFor({ state: "visible" });
}
async function cancel(page) {
  await dialog(page).getByRole("button", { name: "キャンセル", exact: true }).click();
  await dialog(page).waitFor({ state: "hidden" });
}
async function dateField(page, name, value) {
  await field(page, name).fill(value);
  await field(page, name).blur(); // type=date change drives duration-preserving movement
}
async function screenshot(page, name) {
  if (!process.env.CALENDAR_DUPLICATE_SCREENSHOTS) return;
  await page.screenshot({ path: shotPath(name + ".png"), fullPage: true });
}

try {
  // A non-Japanese browser timezone must not move the copied Japanese work date.
  const page = await setupPage("America/Los_Angeles");
  await loadCalendar(page);
  const initialUrl = page.url(), initialHistory = await page.evaluate(() => history.length);
  check(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) === "America/Los_Angeles", "非JSTブラウザで検証");
  await copyFromDetail(page);
  check(await page.locator(".cal-drawer").count() === 0, "詳細を閉じて複製画面だけを開く");
  check(await field(page, "title").inputValue() === originals[0].title, "社員IDなしの本人予定から件名を引き継ぐ");
  check(await field(page, "body").inputValue() === originals[0].body, "本人メモを引き継ぐ");
  check(await field(page, "category").inputValue() === "meeting" && await field(page, "location").inputValue() === "テスト会議室", "区分と場所を引き継ぐ");
  check(await field(page, "startDate").inputValue() === DATE && await field(page, "startTime").inputValue() === "00:30", "UTC前日でも日本時間の日付と時刻を維持");
  check(await field(page, "endDate").inputValue() === "2026-10-29" && await field(page, "endTime").inputValue() === "11:00", "日またぎの終了日時を維持");
  check(await page.locator("#copy-xss").count() === 0, "複製内容をHTMLとして実行しない");
  check(mutations.length === 0, "複製を開くだけでは保存しない");
  check(await field(page, "quantity").inputValue() === "0件", "予定数字のゼロを引き継ぐ");
  await submit(page).click();
  check(mutations.length === 0 && (await dialog(page).locator('[role="status"]').innerText()).includes("新しい開始日または時刻"), "元日時のままでは保存できない");
  await field(page, "title").fill("キャンセルされる編集");
  await cancel(page);
  check(mutations.length === 0 && JSON.stringify(own.slice(0, 2)) === JSON.stringify(originals), "取消は書込みも元予定変更もしない");
  check(page.url() === initialUrl && await page.evaluate(() => history.length) === initialHistory, "取消でURLや履歴を増やさない");
  check(await page.evaluate(() => document.body.style.overflow !== "hidden"), "取消後は本文スクロールを復元");
  await page.evaluate(() => duplicateEvent("missing-event"));
  check(await dialog(page).isHidden(), "存在しない予定IDで複製フォームを開かない");

  for (const event of excluded) {
    await page.evaluate(id => duplicateEvent(id), event.id);
    check(await dialog(page).isHidden(), "対象外予定を関数直接呼出でも複製しない: " + event.id);
  }
  check(await page.locator('#cal-dayevents [data-cal-event-id="private-source"]').getByRole("button", {name:"複製", exact:true}).count() === 0, "非公開予定に複製ボタンを表示しない");
  // The expanded event list and daily row are distinct entry points.
  await page.locator("#cal-list-section > summary").click();
  await page.locator('#cal-list [data-cal-event-id="copy-source"]').getByRole("button", { name: "複製", exact: true }).click();
  check(await field(page, "title").inputValue() === originals[0].title, "一覧から再表示して取消した内容を残さない");
  await dateField(page, "startDate", "2026-11-07");
  check(await field(page, "endDate").inputValue() === "2026-11-08", "開始日変更時に日またぎの日数を維持");
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "hidden" });
  check(mutations.length === 0, "Escapeでも未保存のまま閉じる");
  await page.locator('#cal-dayevents [data-cal-event-id="copy-source"]').getByRole("button", { name: "複製", exact: true }).click();
  check(await field(page, "startDate").inputValue() === DATE, "日別の複製で前回の変更日付を残さない");
  await dialog(page).click({ position: { x: 2, y: 2 } });
  await dialog(page).waitFor({ state: "hidden" });
  check(mutations.length === 0, "背景クリックでも未保存のまま閉じる");

  await copyFromDetail(page);
  await dateField(page, "startDate", "2026-11-07");
  await field(page, "title").fill("変更後の定例レビュー");
  await dialog(page).locator("details > summary").click();
  await field(page, "body").fill("変更後の本人メモ");
  await field(page, "location").fill("別のテスト会議室");
  await field(page, "category").selectOption("other");
  await field(page, "startTime").fill("09:15");
  await field(page, "endTime").fill("10:45");
  await field(page, "title").fill("   ");
  await submit(page).click();
  check(mutations.length === 0 && (await dialog(page).locator('[role="status"]').innerText()).includes("業務内容"), "空の業務内容では保存しない");
  await field(page, "title").fill("変更後の定例レビュー");
  await dateField(page, "endDate", "2026-11-06");
  await submit(page).click();
  check(mutations.length === 0 && (await dialog(page).locator('[role="status"]').innerText()).includes("終了日時"), "開始より前の終了日時では保存しない");
  await dateField(page, "endDate", "2026-11-08");
  await screenshot(page, "calendar-duplicate-desktop");
  nextSaveGate = new Promise(resolveGate => { releaseSave = resolveGate; });
  const observed = new Promise(resolveObserved => { observeSave = resolveObserved; });
  const requested = page.waitForRequest(req => req.method() === "POST" && new URL(req.url()).pathname === "/api/schedule");
  // Two synchronous submit events deliberately bypass the disabled-button affordance.
  await dialog(page).locator("form").evaluate(form => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await requested;
  await observed;
  check(mutations.length === 1, "連続送信してもPOSTは1回");
  check(await submit(page).isDisabled() && await dialog(page).getByRole("button", { name: "キャンセル", exact: true }).isDisabled(), "保存中は送信と取消を無効にする");
  check(await field(page, "title").isDisabled(), "保存中の内容変更を防ぐ");
  await page.keyboard.press("Escape");
  await dialog(page).click({ position: { x: 2, y: 2 } });
  check(await dialog(page).isVisible(), "保存中はEscape・背景クリックでも閉じない");
  releaseSave(); releaseSave = null;
  await dialog(page).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.getElementById("cal-message").textContent.includes("複製しました"));
  const created = mutations[0];
  assert.deepEqual(Object.keys(created.data).sort(), payloadKeys);
  assert.deepEqual(created.data, { title: "変更後の定例レビュー", body: "変更後の本人メモ", location: "別のテスト会議室",
    category: "other", allDay: false, startsAt: "2026-11-07T09:15:00+09:00", endsAt: "2026-11-08T10:45:00+09:00", visibility: "shared", plannedQuantity: 0, plannedQuantityUnit: "件" });
  check(created.method === "POST", "編集後の内容と日付を新規POSTの許可項目だけで保存");
  assert.deepEqual(own.slice(0, 2), originals);
  check(await page.locator('.oc-grid [data-cal-event-id="copy-created-1"]').count() === 1, "複製先の日付へ移動して新しい予定を表示");
  check(mutations.length === 1, "保存と一覧再取得で二重登録しない");
  check(await page.evaluate(() => document.body.style.overflow !== "hidden"), "保存後も本文スクロールを復元");

  // Team mode remains read-only, including direct invocation of the global handler.
  await loadCalendar(page);
  await page.locator("#scope-team").click();
  await page.locator('.ct-event[data-ct-event="other-person"]').click();
  check(await page.locator(".cal-drawer").getByRole("button", { name: /複製/ }).count() === 0, "他人の予定詳細には複製操作を出さない");
  await page.evaluate(() => { duplicateEvent("other-person"); duplicateEvent("copy-source"); });
  check(await dialog(page).isHidden() && mutations.length === 1, "全員表示では関数直接呼出でも複製しない");
  await page.keyboard.press("Escape");

  // Unknown network outcome must not invite an automatic retry or allow Enter to resubmit.
  await loadCalendar(page);
  await copyFromDetail(page);
  await dateField(page, "startDate", "2026-11-09");
  failNextSave = true;
  await submit(page).click();
  await page.waitForFunction(() => document.querySelector('#cal-duplicate [role="status"]').textContent.includes("保存結果を確認できませんでした"));
  check(await dialog(page).isVisible() && await submit(page).isDisabled(), "結果不明時は画面を維持し再送信しない");
  await dialog(page).locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await page.keyboard.press("Enter");
  check(mutations.length === 2, "結果不明時の再submit・EnterでもPOSTを増やさない");
  await cancel(page);
  await page.evaluate(() => duplicateEvent("copy-source"));
  check(await dialog(page).isHidden() && mutations.length === 2, "結果不明後は閉じて再複製しても再送しない");

  // A page navigation and Back/Forward do not restore a live unsaved dialog.
  const historyPage = await setupPage("Asia/Tokyo");
  await historyPage.goto(BASE + "/calendar.html?date=2026-10-27");
  await loadCalendar(historyPage); await copyFromDetail(historyPage);
  await field(historyPage, "title").fill("破棄する下書き");
  await historyPage.goBack(); await historyPage.goForward();
  await historyPage.locator('#cal-dayevents [data-cal-event-id="copy-source"]').waitFor();
  check(await dialog(historyPage).isHidden() && mutations.length === 2, "Back/Forward復帰は下書きを再送・再表示しない");
  await historyPage.close();

  // Japanese timezone, narrow viewport, multi-day inclusive all-day convention.
  const mobile = await setupPage("Asia/Tokyo", { width: 390, height: 760 });
  await loadCalendar(mobile);
  await mobile.locator('#cal-dayevents [data-cal-event-id="all-day-source"]').getByRole("button", { name: "複製", exact: true }).click();
  check(await field(mobile, "allDay").isChecked(), "終日フラグを引き継ぐ");
  check(await field(mobile, "startDate").inputValue() === DATE && await field(mobile, "endDate").inputValue() === "2026-10-30", "複数日終日の最終日を含めて引き継ぐ");
  check(await field(mobile, "startTime").isDisabled() && await field(mobile, "endTime").isDisabled(), "終日では時刻欄を無効にする");
  await field(mobile, "allDay").uncheck();
  check(await field(mobile, "startTime").isEnabled(), "終日解除で保存前に時間指定へ変更できる");
  await field(mobile, "allDay").check();
  await dateField(mobile, "startDate", "2026-12-31");
  check(await field(mobile, "endDate").inputValue() === "2027-01-02", "終日の3日間を年またぎでも維持");
  const bounds = await dialog(mobile).locator("form").evaluate(node => {
    const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
  check(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height + 1, "スマホの複製ダイアログが画面内に収まる");
  await screenshot(mobile, "calendar-duplicate-mobile");
  await submit(mobile).click();
  await dialog(mobile).waitFor({ state: "hidden" });
  await mobile.waitForFunction(() => document.getElementById("cal-message").textContent.includes("複製しました"));
  assert.deepEqual(mutations[2].data, { title: "終日作業", body: "複数日の作業メモ", location: "テスト拠点", category: "visit",
    allDay: true, startsAt: "2026-12-31T00:00:00+09:00", endsAt: "2027-01-02T23:59:00+09:00", visibility: "shared", plannedQuantity: null, plannedQuantityUnit: null });
  check(true, "終日の終了は最終日23:59、JSTで新規保存");
  assert.deepEqual(own.slice(0, 2), originals);
  check(mutations.every(x => x.method === "POST" && JSON.stringify(Object.keys(x.data).sort()) === JSON.stringify(payloadKeys)), "元予定ID・同期ID・履歴・完了・参加者・push指定を一度も送らない");
  // Legacy schema still allows a no-number source; it must omit number keys.
  quantityAvailable = false;
  const legacyPage = await setupPage("Asia/Tokyo"); await loadCalendar(legacyPage);
  await legacyPage.locator('#cal-dayevents [data-cal-event-id="all-day-source"]').getByRole("button", { name: "複製", exact: true }).click();
  check(await field(legacyPage, "quantity").isDisabled(), "旧schemaは数字入力を無効にする");
  await dateField(legacyPage, "startDate", "2026-11-10"); await submit(legacyPage).click();
  await dialog(legacyPage).waitFor({state:"hidden"});
  check(!Object.hasOwn(mutations.at(-1).data,"plannedQuantity"), "旧schemaは時間・内容だけを新規保存");
  await legacyPage.close();
  check(unmockedMutations.length === 0, "通知・Google・AIなど別APIへの書込みなし");
  check(errors.length === 0, "画面JavaScriptエラーなし: " + errors.join(" / "));
  console.log(`カレンダー複製 UI: ${checks} checks passed (mock API only)`);
} finally {
  releaseSave?.();
  await br.close();
}
