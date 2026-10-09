// Office ホームの「今月のOfficeカレンダー」「今週のOffice予定」と、定例業務マスター（/office/recurring.html）を実際のブラウザで通す。
// サーバは偽物（page.route）。予定の分け方・権限の判定はサーバ（lib/office-recurring.js）の値をそのまま使う。
//
// ■ 何を守るテストか
//   1. Office ホームの並び：件数 → 今月のOfficeカレンダー → 今日やること → 今週のOffice予定 → 月次進捗（カレンダーは件数のすぐ下。1280・390 とも）
//   2. カレンダー：月〜日の格子・今日の印・1日3件まで＋「+N件」・期限超過は赤・完了は取り消し線。前月／今日／次月で月を移る
//   3. 日付を押すと右ドロワー：カテゴリごとに、業務名・担当・期限・状態・備考・完了ボタン・定例業務へのリンク
//   4. 完了を押すと、サーバへ送り、その場で表示が変わる
//   5. 期限超過・今日の予定は「今日やること」に1件ずつ入る（担当つき・確認するでドロワー）
//   6. 今週のOffice予定：今日・明日・今週・期限超過の件数と、要確認 → 期限超過 → 今日 → 明日 → 今週 → 今後 の順
//   7. 390px は月の格子を縮めず、日付を横に流して選んだ日の予定をカードで出す。1280・768・390 で横にはみ出さない
//   8. 定例業務：一覧・カテゴリの絞り込み・作る（ルールの送り方）・停止の確認・Excel 最新版の同期の入口と最終同期の表示
import { launch, BASE } from "../_browser.mjs";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const GW = await import("../../lib/gw.js");
const L = await import("../../lib/office-recurring.js");

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const TODAY = "2026-10-07";
const ME = { email: "fin@example.jp", appRole: "member", isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "e-me", display_name: "経理 太郎", status: "active" }, roles: ["finance"], tenantId: "t1", stage: { key: "member", allowed: [] } },
  access: GW.memberAccessOf({ roles: ["finance"], apps: ["office"] }) };

const ev = (id, date, title, extra = {}) => ({ id, recurringTaskId: extra.recurringTaskId ?? "m1", title, description: null, category: "finance", categoryLabel: "経理",
  date, dueOn: extra.dueOn || date, status: "pending", priority: "normal", note: null, url: null, source: "recurring",
  assigneeId: "e-me", assigneeName: "経理 太郎", assigneeMissing: false, overdueDays: 0, completedAt: null, completedByName: null, canEdit: true, ...extra });
function calendarBody(from, to) {
  const all = [
    ev("e-today", TODAY, "給与データ確認", { note: "社長確認の前に" }),
    ev("e-tom", "2026-10-08", "10日振込予約"),
    ev("e-wk", "2026-10-09", "勤怠締め", { category: "labor", categoryLabel: "労務・総務", assigneeMissing: true, assigneeName: null, canEdit: false }),
    ev("e-done", "2026-10-05", "通帳記帳", { status: "done", completedAt: "2026-10-05T01:00:00Z", completedByName: "経理 太郎" }),
    ev("e-late-in", "2026-10-02", "小口現金締め", { overdueDays: 5 }),
    ...["A", "B", "C", "D", "E"].map((s, i) => ev(`e-many${i}`, "2026-10-15", `月中の作業${s}`)),
    ev("e-later", "2026-10-16", "15日入金確認"),
    ev("e-nov", "2026-11-10", "10日振込予約"),
  ];
  return {
    today: TODAY, from, to,
    events: all.filter((e) => e.date >= from && e.date <= to),
    overdue: from > "2026-09-25" ? [ev("e-old", "2026-09-25", "請求書確認", { overdueDays: 12, recurringTaskId: null })] : [],
    categories: L.CATEGORIES.map((c) => ({ key: c.key, label: c.label, view: true, edit: ["finance", "sales_admin", "all", "ecnw", "other"].includes(c.key) })),
    employees: [{ id: "e-me", name: "経理 太郎" }], me: "e-me",
  };
}

async function openHome(width = 1280) {
  const page = await br.newPage({ viewport: { width, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date(`${TODAY}T03:00:00Z`));
  const calls = { get: [], post: [] };
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "fin@example.jp" })); for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k); });
  await page.route("**/api/**", async (r) => {
    const req = r.request(), u = new URL(req.url());
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send(ME);
    if (u.pathname === "/api/office-tasks/calendar") {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}"); calls.post.push(b);
        const base = calendarBody("2026-09-28", "2026-11-08").events.find((e) => e.id === b.id) || ev(b.id, TODAY, "x");
        return send({ event: { ...base, status: b.action === "complete" ? "done" : b.action === "skip" ? "skipped" : "pending", completedAt: b.action === "complete" ? "2026-10-07T03:00:00Z" : null, completedByName: "経理 太郎", overdueDays: 0 } });
      }
      calls.get.push(`${u.searchParams.get("from")}..${u.searchParams.get("to")}`);
      return send(calendarBody(u.searchParams.get("from"), u.searchParams.get("to")));
    }
    if (u.pathname === "/api/office") return send({ notReady: true, message: "（テスト）" });
    if (u.pathname === "/api/badges") return send({ badges: {} });
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/office/`);
  await page.waitForSelector(".oc-day, .oc-sd", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { page, calls, errs };
}

console.log("\n=== Office ホーム：並び・カレンダー ===");
{
  const { page, calls, errs } = await openHome();
  const order = await page.evaluate(() => ["cards", "calBox", "todo", "weekBox", "progBox"].map((id) => { const n = document.getElementById(id); return n && !n.hidden ? Math.round(n.getBoundingClientRect().top) : -1; }));
  const shown = order.filter((y) => y >= 0);
  check(order[2] > order[1] && order[3] > order[2] && shown.every((y, i) => i === 0 || y > shown[i - 1]), `件数 → カレンダー → 今日やること → 今週の予定 → 月次進捗（${order.join(",")}）`);
  check(await page.evaluate(() => document.getElementById("cards").nextElementSibling?.id === "calBox"), "カレンダーは件数（サマリーカード）のすぐ下");
  check(calls.get[0] === "2026-09-28..2026-11-01", `今月の格子の範囲を取る（${calls.get[0]}）`);
  check((await page.locator("#calMonth").innerText()) === "2026年10月", "見出しは 2026年10月");
  const cells = await page.locator(".oc-grid .oc-day").count();
  check(cells === 35, `月〜日の格子（${cells}マス）`);
  check((await page.locator(".oc-day.today").getAttribute("data-date")) === TODAY, "今日の印");
  check((await page.locator('.oc-day[data-date="2026-10-15"] .oc-ev').count()) === 3 && (await page.locator('.oc-day[data-date="2026-10-15"] .oc-more').innerText()) === "+2件", "1日3件まで＋「+2件」");
  check(await page.locator('.oc-day[data-date="2026-10-02"] .oc-ev.overdue').count() === 1, "期限超過は赤");
  check(await page.locator('.oc-day[data-date="2026-10-05"] .oc-ev.done').count() === 1, "完了は取り消し線");
  check(await page.locator("#calToday").isDisabled(), "今月のときは「今日」を押せない");

  console.log("\n— 日付を押すと右ドロワー —");
  await page.click('.oc-day[data-date="2026-10-07"]');
  await page.waitForSelector(".of-drawer");
  const dr = await page.locator(".of-drawer").innerText();
  check(dr.includes("10月7日（水）") && dr.includes("経理") && dr.includes("給与データ確認") && dr.includes("担当：経理 太郎") && dr.includes("期限：10/7") && dr.includes("備考：社長確認の前に"), "業務名・カテゴリ・担当・期限・備考");
  check(await page.locator('.of-drawer a[href="/office/recurring.html?id=m1"]').count() === 1, "定例業務の設定へのリンク");
  await page.locator('.of-drawer [data-event="e-today"] [data-act="complete"]').click();
  await page.waitForTimeout(500);
  check(JSON.stringify(calls.post[0]) === JSON.stringify({ action: "complete", id: "e-today" }), "完了をサーバへ送る");
  check((await page.locator('.of-drawer [data-event="e-today"]').innerText()).includes("完了") && await page.locator('.of-drawer [data-event="e-today"] [data-act="reopen"]').count() === 1, "その場で「完了」になり、未完了に戻すが出る");
  await page.keyboard.press("Escape");
  check(await page.locator(".of-drawer").count() === 0, "Esc で閉じる");
  await page.click('.oc-day[data-date="2026-10-09"]');
  check(await page.locator('.of-drawer [data-event="e-wk"] [data-act]').count() === 0 && (await page.locator('.of-drawer [data-event="e-wk"]').innerText()).includes("担当者未設定"), "直せない予定はボタンを出さない・担当者未設定");
  await page.keyboard.press("Escape");

  console.log("\n— 今日やること・今週のOffice予定 —");
  const todo = await page.locator("#todo").innerText();
  check(todo.includes("請求書確認") && todo.includes("12日超過") && todo.includes("担当：経理 太郎"), "期限超過が今日やることに（担当つき）");
  check(todo.includes("小口現金締め"), "範囲の中の期限超過も入る");
  await page.locator('#todo [data-office-event]').first().click();
  check(await page.locator(".of-drawer").count() === 1, "「確認する」でドロワー");
  await page.keyboard.press("Escape");
  const tiles = Object.fromEntries(await page.locator("#wkTiles [data-wk]").evaluateAll((ns) => ns.map((n) => [n.dataset.wk, n.querySelector(".val").textContent.replace("件", "").trim()])));
  check(tiles.overdue === "2" && tiles.tomorrow === "1", `今日・明日・今週・期限超過の件数（${JSON.stringify(tiles)}）`);
  const kinds = await page.locator("#wkList [data-wk-row]").evaluateAll((ns) => ns.map((n) => n.dataset.wkRow));
  const rank = ["check", "overdue", "today", "tomorrow", "week", "later"];
  check(kinds.length > 0 && kinds.every((k, i) => i === 0 || rank.indexOf(k) >= rank.indexOf(kinds[i - 1])), `要確認 → 期限超過 → 今日 → 明日 → 今週 → 今後（${[...new Set(kinds)].join(",")}）`);
  check(kinds[0] === "check", "担当者未設定は「要確認」で先頭");

  console.log("\n— 月を移る —");
  await page.click("#calNext");
  await page.waitForFunction(() => document.getElementById("calMonth").textContent === "2026年11月");
  check(calls.get.includes("2026-10-26..2026-12-06"), `次月の格子の範囲を取る（${calls.get.join(" / ")}）`);
  await page.click("#calToday");
  await page.waitForFunction(() => document.getElementById("calMonth").textContent === "2026年10月");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 幅ごと ===");
for (const w of [1280, 768, 390]) {
  const { page } = await openHome(w);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${w}px：横にはみ出さない（${over}）`);
  const ys = await page.evaluate(() => ["cards", "calBox", "todo"].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top)));
  check(ys[0] < ys[1] && ys[1] < ys[2], `${w}px：カレンダーは件数の下・今日やることの上（${ys.join(",")}）`);
  const grid = await page.locator(".oc-grid").isVisible(), strip = await page.locator("#calStrip").isVisible();
  if (w === 390) {
    check(!grid && strip, "390px：格子ではなく、日付を横に流す");
    check((await page.locator("#calCards").innerText()).includes("給与データ確認"), "390px：選んだ日（今日）の予定をカードで出す");
    await page.click('.oc-sd[data-date="2026-10-15"]');
    check((await page.locator("#calCards").innerText()).includes("月中の作業E"), "390px：日付を押すと、その日のカード（+N件に隠れたものも全部）");
  } else check(grid && !strip, `${w}px：月の格子`);
  await page.close();
}

console.log("\n=== 定例業務（/office/recurring.html） ===");
{
  const page = await br.newPage({ viewport: { width: 1280, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date(`${TODAY}T03:00:00Z`));
  const posts = [];
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  // Excel を読む部品（cdnjs）は手元の node_modules の同じ版を返す（CI からも外へ出ない）
  await page.route("https://cdnjs.cloudflare.com/ajax/libs/xlsx/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(require.resolve("xlsx/dist/xlsx.full.min.js"), "utf8") }));
  const master = (id, title, category, active = true, extra = {}) => ({ id, title, description: null, category, categoryLabel: L.categoryLabel(category), assigneeId: "e-me", assigneeName: "経理 太郎", assigneeMissing: false,
    department: null, priority: "normal", note: null, url: null, recurrenceType: "monthly", recurrenceRule: { day: 10, shift: "prev" }, dueRule: { type: "same" },
    ruleText: "毎月 10日（土日祝は前の営業日）", dueText: "予定日と同じ", startOn: "2026-10-01", endOn: null, active, source: "manual", nextDate: active ? "2026-10-09" : null, updatedAt: "2026-10-06T00:00:00Z", canEdit: true, ...extra });
  const masters = [master("m1", "10日振込予約", "finance"), master("m2", "勤怠締め", "labor", true, { canEdit: false, assigneeMissing: true, assigneeName: null }), master("m3", "古い作業", "finance", false)];
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "fin@example.jp" })); for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k); });
  await page.route("**/api/**", async (r) => {
    const req = r.request(), u = new URL(req.url());
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send(ME);
    if (u.pathname === "/api/office-tasks/recurring") {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}"); posts.push(b);
        if (b.action === "import_preview") {
          const out = L.classifyExcel(b.cells, { periodStart: b.periodStart });
          return send({ ...out, rows: out.rows.map((x) => ({ ...x, ruleText: L.describeRule(x.recurrenceType, x.recurrenceRule), registered: false, canEdit: true })) });
        }
        if (b.action === "import_commit") return send({ masters: b.rows.filter((x) => x.kind !== "single").length, singles: b.rows.filter((x) => x.kind === "single").length, skipped: 0, events: 3 });
        if (b.action === "set_active") return send({ master: { ...masters.find((m) => m.id === b.id), active: b.active, nextDate: null } });
        return send({ master: master("m9", b.title, b.category), made: 3 });
      }
      return send({ today: TODAY, masters, employees: [{ id: "e-me", name: "経理 太郎" }],
        categories: L.CATEGORIES.map((c) => ({ key: c.key, label: c.label, col: c.col, view: true, edit: ["finance", "sales_admin", "all", "ecnw", "other"].includes(c.key) })),
        priorities: L.PRIORITIES, perms: { hr: false, fin: true, app: true, admin: false },
        sync: { ready: true, applying: null, failed: null, last: { id: "s1", periodStart: "2026-09", periodLabel: "2026年9月〜2027年8月", fileName: "年間予定表.xlsx", total: 180, new: 180, update: 0, unchanged: 0, stop: 0, reactivate: 0, status: "committed", byName: "経理 太郎", createdAt: "2026-10-09T05:04:00Z", committedAt: "2026-10-09T05:05:00Z" } } });
    }
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/office/recurring.html`);
  await page.waitForSelector(".rc-item");
  check(await page.locator("#kp-office-nav .kp-ostab.on, #kp-office-nav a.on", { hasText: "定例業務" }).count() >= 1, "Office の「社内管理 › 定例業務」が選ばれている");
  check(await page.locator(".rc-item").count() === 2, "初めは有効なものだけ（2件）");
  const t1 = await page.locator('.rc-item[data-id="m1"]').innerText();
  check(t1.includes("毎月 10日（土日祝は前の営業日）") && t1.includes("経理") && t1.includes("経理 太郎") && t1.includes("有効") && t1.includes("次回"), "業務名・カテゴリ・繰り返し・担当・状態・次回予定");
  check((await page.locator('.rc-item[data-id="m2"]').innerText()).includes("担当者未設定") && await page.locator('[data-role="assignee-missing"]').count() === 1, "担当者未設定を知らせる");
  check(await page.locator('.rc-item[data-id="m2"] .ops button').count() === 0, "直せないカテゴリは操作を出さない");
  await page.selectOption("#fState", "all");
  check(await page.locator(".rc-item").count() === 3, "「すべて」で停止も出る");
  await page.click('.of-chip[data-cat="labor"]');
  check(await page.locator(".rc-item").count() === 1, "カテゴリで絞り込む");
  await page.click('.of-chip[data-cat=""]');

  console.log("\n— 作る —");
  await page.click("#newBtn");
  await page.fill("#e-title", "給与データ確認");
  await page.selectOption("#e-cat", "finance");
  await page.selectOption("#e-type", "monthly");
  await page.selectOption("#e-day", "8");
  await page.selectOption("#e-shift", "prev");
  await page.selectOption("#e-due", "day");
  await page.fill("#e-dueN", "10");
  await page.selectOption("#e-who", "e-me");
  await page.click("#e-save");
  await page.waitForTimeout(400);
  const c = posts.find((p) => p.action === "create");
  check(c && c.title === "給与データ確認" && c.recurrenceType === "monthly" && JSON.stringify(c.recurrenceRule) === JSON.stringify({ shift: "prev", day: 8 })
    && JSON.stringify(c.dueRule) === JSON.stringify({ type: "day", day: 10 }) && c.assigneeEmployeeId === "e-me", `作るときの送り方（${JSON.stringify(c)}）`);
  check(await page.locator(".of-drawer").count() === 0 && (await page.locator("#list").innerText()).includes("給与データ確認"), "保存すると閉じて一覧に出る");
  await page.click("#newBtn");
  await page.selectOption("#e-type", "yearly");
  check(await page.locator("#e-month").count() === 1, "毎年は月を選べる");
  await page.selectOption("#e-type", "weekly");
  check(await page.locator("#ruleBox [data-dow]").count() === 7, "毎週は曜日");
  await page.keyboard.press("Escape");

  console.log("\n— 停止 —");
  await page.locator('.rc-item[data-id="m1"] [data-act="toggle"]').click();
  await page.waitForTimeout(300);
  check(posts.some((p) => p.action === "set_active" && p.id === "m1" && p.active === false), "停止を送る（確かめてから）");

  console.log("\n— Excel 最新版の同期（入口と最終同期の表示。中身は test/ui/officesyncui.mjs） —");
  check((await page.locator("#syncOpen").innerText()).includes("年間予定表を最新版として同期"), "「年間予定表を最新版として同期」のボタン");
  check((await page.locator('[data-role="sync-info"]').innerText()).includes("2026年9月〜2027年8月") && (await page.locator('[data-role="sync-info"]').innerText()).includes("最終同期：2026/10/09 14:05"), "ページ上部に Excel最新版の期と最終同期");
  await page.click("#syncOpen");
  check((await page.locator("#syncBox").innerText()).includes("手動登録した定例業務と過去の履歴は変更しません"), "同期の説明");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  for (const w of [768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `定例業務 ${w}px：横にはみ出さない（${over}）`);
  }
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
