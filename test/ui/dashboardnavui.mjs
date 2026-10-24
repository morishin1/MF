// HR・Sales・Office・経営の「ダッシュボード」導線を、実際のブラウザで通す（PC 1280px・スマホ 390px）。
//
// ■ 守ること
//   1. 共通ヘッダーの 採用HR／Sales／Office／経営 を押すと、それぞれ既存のダッシュボードが開く
//        採用HR → /hr/applicants.html（採用ダッシュボード）  Sales → /sales/  Office → /office/  経営 → /keiei/（#home）
//   2. 各機能の中の「ダッシュボード」タブでも同じ画面へ戻り、そのタブが選ばれた状態になる
//   3. HR の「応募分析」（/hr/）は、ダッシュボードとは別のタブとして開ける
//   4. 直接URL・再読込・ブラウザの戻る／進む・他の機能から戻る、でも選択状態が正しい
//   5. 新しいページは作っていない（行き先はすべて既存の画面）
// サーバは偽物（page.route）。実データ・実DBには一切つながない（Office の GET の副作用も起きない）。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { hubBusy } from "../fixtures/keiei-hub.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const { accessOf } = await import("../../lib/gw.js");
const OWNER = { roles: ["owner"], isAdmin: false };

async function openCtx(width) {
  const ctx = await br.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@example.test" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
  });
  await ctx.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname === "/api/me") {
      return send({ email: "owner@example.test", appRole: "owner", isAdmin: false, roles: [],
        gw: { employee: { id: "e1", display_name: "架空 経営者", status: "active" }, roles: OWNER.roles, tenantId: "t1", stage: null, isOwner: true },
        access: accessOf({ roles: OWNER.roles, isAdmin: false }) });
    }
    if (url.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    if (url.pathname === "/api/badges") return send({ badges: {} });
    // 経営ダッシュボードの中身は、既存テストと同じ架空の集計（test/fixtures/keiei-hub.mjs）
    if (url.pathname === "/api/keiei" && url.searchParams.get("view") === "hub") return send(hubBusy());
    if (url.pathname === "/api/hr/applicants") return send({ applicants: [], employees: [], sources: { options: [], counts: [] }, category: "all", leadReady: true });
    return send({});
  });
  return ctx;
}
const path = (page) => new URL(page.url()).pathname + new URL(page.url()).hash;
const go = async (page, url) => { await page.goto(BASE + url); await page.waitForLoadState("domcontentloaded"); };
const clickAndWait = async (page, locator, re) => {
  await Promise.all([page.waitForURL(re, { timeout: 15000 }), page.locator(locator).first().click()]);
  await page.waitForLoadState("domcontentloaded");
};
const textOf = async (page, sel) => (await page.locator(sel).first().innerText({ timeout: 15000 })).replace(/\s+/g, " ").trim();

// 各機能の「いま選ばれているダッシュボードのタブ」
const SELECTED = {
  hr: async (p) => ({ text: await textOf(p, ".hr-nav a.on"), href: await p.locator(".hr-nav a.on").first().getAttribute("href") }),
  sales: async (p) => ({ text: await textOf(p, ".sl-nav a.on"), href: await p.locator(".sl-nav a.on").first().getAttribute("href") }),
  office: async (p) => ({ text: await textOf(p, "#kp-office-nav .kp-otab.on"), href: await p.locator("#kp-office-nav .kp-otab.on").first().getAttribute("href") }),
  keiei: async (p) => ({ text: await textOf(p, "#kp-keiei-nav .kp-otab.on"), href: await p.locator("#kp-keiei-nav .kp-otab.on").first().getAttribute("data-ktab") }),
};
const DASH = {
  hr: { url: /\/hr\/applicants\.html$/, href: "/hr/applicants.html" },
  sales: { url: /\/sales\/(index\.html)?$/, href: "/sales/" },
  office: { url: /\/office\/(index\.html)?$/, href: "/office/" },
  keiei: { url: /\/keiei\/(#home)?$/, href: "home" },
};
async function expectDashboard(page, key, label) {
  await page.waitForSelector({ hr: ".hr-nav a.on", sales: ".sl-nav a.on", office: "#kp-office-nav .kp-otab.on", keiei: "#kp-keiei-nav .kp-otab.on" }[key], { timeout: 15000 });
  const s = await SELECTED[key](page);
  check(DASH[key].url.test(new URL(page.url()).pathname + new URL(page.url()).hash), `${label}：ダッシュボードの画面（いま ${path(page)}）`);
  check(s.text.includes("ダッシュボード") && s.href === DASH[key].href, `${label}：「ダッシュボード」タブが選ばれている（いま ${s.text} → ${s.href}）`);
}

for (const width of [1280, 390]) {
  const W = `[${width}px]`;
  console.log(`\n=== ${W} 共通ヘッダー → 各ダッシュボード ===`);
  const ctx = await openCtx(width);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${new URL(page.url()).pathname}: ${String(e).slice(0, 140)}`));

  // GW の本人ホームから、ヘッダーの4つを順に押す（本人ホームの「ホーム」は変えていない）
  await go(page, "/home.html");
  await page.waitForSelector('.topbar [data-shortcut="hr"]', { timeout: 15000 });
  const hrefs = await page.locator(".topbar [data-shortcut]").evaluateAll((ns) => Object.fromEntries(ns.map((n) => [n.dataset.shortcut, n.getAttribute("href")])));
  check(hrefs.hr === "/hr/applicants.html" && hrefs.sales === "/sales/" && hrefs.office === "/office/" && hrefs.keiei === "/keiei/",
    `${W} ヘッダーの行き先（いま ${JSON.stringify(hrefs)}）`);

  await clickAndWait(page, '.topbar [data-shortcut="hr"]', /\/hr\/applicants\.html/);
  await expectDashboard(page, "hr", `${W} 採用HR`);
  check((await textOf(page, "h1.hr-title")).includes("採用ダッシュボード"), `${W} 採用HR：見出しは採用ダッシュボード`);
  await page.screenshot({ path: shotPath(`dashnav-hr-${width}.png`) });
  // HR の応募分析は別タブ（/hr/）。押すと応募分析が選ばれ、ダッシュボードで戻れる
  await clickAndWait(page, '.hr-nav a[href="/hr/"]', /\/hr\/$/);
  await page.waitForSelector(".hr-nav a.on");
  check((await SELECTED.hr(page)).text.includes("応募分析") && (await SELECTED.hr(page)).href === "/hr/", `${W} 応募分析は別タブで開く`);
  await clickAndWait(page, '.hr-nav a[href="/hr/applicants.html"]', /\/hr\/applicants\.html$/);
  await expectDashboard(page, "hr", `${W} HR内の「ダッシュボード」タブ`);
  // 戻る／進む
  await page.goBack(); await page.waitForURL(/\/hr\/$/); await page.waitForSelector(".hr-nav a.on");
  check((await SELECTED.hr(page)).text.includes("応募分析"), `${W} 戻る：応募分析が選ばれている`);
  await page.goForward(); await page.waitForURL(/\/hr\/applicants\.html$/);
  await expectDashboard(page, "hr", `${W} 進む`);
  // 再読込
  await page.reload(); await page.waitForLoadState("domcontentloaded");
  await expectDashboard(page, "hr", `${W} 再読込`);

  // Sales（GW へ戻ってからヘッダーで）
  await go(page, "/home.html");
  await page.waitForSelector('.topbar [data-shortcut="sales"]');
  await clickAndWait(page, '.topbar [data-shortcut="sales"]', /\/sales\//);
  await expectDashboard(page, "sales", `${W} Sales`);
  await clickAndWait(page, '.sl-nav a[href="/sales/companies.html"]', /\/sales\/companies\.html$/);
  await clickAndWait(page, '.sl-nav a[href="/sales/"]', /\/sales\/$/);
  await expectDashboard(page, "sales", `${W} Sales内の「ダッシュボード」タブ`);

  // Office
  await go(page, "/home.html");
  await page.waitForSelector('.topbar [data-shortcut="office"]');
  await clickAndWait(page, '.topbar [data-shortcut="office"]', /\/office\//);
  await expectDashboard(page, "office", `${W} Office`);
  check((await textOf(page, "h1.of-title")) === "Office ダッシュボード", `${W} Office：見出しは Office ダッシュボード`);
  check(await page.locator('.topbar [data-shortcut="office"].on').count() === 1, `${W} Office：ヘッダーの Office が選ばれている`);
  await page.screenshot({ path: shotPath(`dashnav-office-${width}.png`) });
  // 別のタブへ移ってから「ダッシュボード」で戻る
  const other = page.locator("#kp-office-nav .kp-otab").nth(1);
  const otherHref = await other.getAttribute("href");
  await Promise.all([page.waitForURL((u) => !/\/office\/$/.test(u.pathname), { timeout: 15000 }), other.click()]);
  check(!/\/office\/$/.test(new URL(page.url()).pathname), `${W} Office：別のタブ（${otherHref}）へ移れる`);
  await page.waitForSelector("#kp-office-nav .kp-otab");
  await clickAndWait(page, '#kp-office-nav .kp-otab[href="/office/"]', /\/office\/$/);
  await expectDashboard(page, "office", `${W} Office内の「ダッシュボード」タブ`);

  // 経営（他の機能＝Office から）
  await clickAndWait(page, '.topbar [data-shortcut="keiei"]', /\/keiei\//);
  await expectDashboard(page, "keiei", `${W} 経営`);
  await page.screenshot({ path: shotPath(`dashnav-keiei-${width}.png`) });
  await page.locator('#kp-keiei-nav .kp-otab[data-ktab="sales"]').click();
  await page.waitForFunction(() => document.querySelector('#kp-keiei-nav .kp-otab.on')?.dataset.ktab === "sales");
  await page.locator('#kp-keiei-nav .kp-otab[data-ktab="home"]').click();
  await page.waitForFunction(() => document.querySelector('#kp-keiei-nav .kp-otab.on')?.dataset.ktab === "home");
  await expectDashboard(page, "keiei", `${W} 経営内の「ダッシュボード」タブ`);
  await page.goBack(); await page.waitForFunction(() => document.querySelector('#kp-keiei-nav .kp-otab.on')?.dataset.ktab === "sales");
  check(true, `${W} 経営：戻るで売上・営業へ`);
  await page.goForward(); await page.waitForFunction(() => document.querySelector('#kp-keiei-nav .kp-otab.on')?.dataset.ktab === "home");
  await expectDashboard(page, "keiei", `${W} 経営：進む`);
  await page.reload(); await page.waitForLoadState("domcontentloaded");
  await expectDashboard(page, "keiei", `${W} 経営：再読込`);

  // 経営 → 採用HR（他の機能から戻る）
  await clickAndWait(page, '.topbar [data-shortcut="hr"]', /\/hr\/applicants\.html/);
  await expectDashboard(page, "hr", `${W} 経営から採用HRへ`);

  // 直接URL
  for (const [key, url] of [["hr", "/hr/applicants.html"], ["sales", "/sales/"], ["office", "/office/"], ["keiei", "/keiei/"]]) {
    await go(page, url);
    await expectDashboard(page, key, `${W} 直接URL ${url}`);
  }
  // 旧 HR ダッシュボードのURL（hr-dashboard.html）は採用ダッシュボードへ（クエリは引き継ぐ）
  await page.goto(BASE + "/hr-dashboard.html?id=x1");
  await page.waitForURL(/\/hr\/applicants\.html\?id=x1$/);
  check(true, `${W} 旧URL hr-dashboard.html → 採用ダッシュボード（クエリ付き）`);

  // 本人ホームの「ホーム」は変えていない
  await go(page, "/home.html");
  await page.waitForSelector(".topbar");
  const side = await page.locator("body").innerText();
  check(side.includes("ホーム"), `${W} GW本人ホームの「ホーム」はそのまま`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 1, `${W} 本人ホーム：横にはみ出さない（${over}px）`);
  if (errors.length) console.log(`  （参考）画面のエラー ${errors.length}件：${[...new Set(errors)].slice(0, 3).join(" / ")}`);
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nダッシュボード導線：すべて通過");
process.exit(bad ? 1 : 0);
