// Office の権限分割（人事・労務 officeHr／経理・事務 officeFinance）を、実際のブラウザで通す。
//
// ■ 何を守りたいのか
//   ・人事（hr）は人事・労務だけ、経理（finance）は経理・事務だけ、管理者・経営者は両方
//   ・Office のヘッダーが出る人は、押して入れる（出たのに 403・追い返される、を作らない）
//   ・左メニューは担当のグループだけ。担当でない画面を直接開いたら、ホームへ戻す
//   ・ダッシュボードは、担当の行だけ読む・出す（担当でない API を呼んで 403 の行を作らない）
//   ・責任者（manager）は、今までどおり /office/（月末月初）だけ。人事・労務、経理・事務の管理画面には入れない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// サーバ（lib/gw.js accessOf）そのもの。/api/me の access の代わりに返す
const { accessOf: serverAccessOf } = await import("../../lib/gw.js");

/**
 * @param {string} path
 * @param {{appRole?:string, isAdmin?:boolean, roles?:string[], width?:number}} who
 */
async function open(path, who) {
  const page = await br.newPage({ viewport: { width: who.width || 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = [];
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
  });
  const isAdmin = Boolean(who.isAdmin);
  const roles = who.roles || [];
  const appRole = who.appRole || (roles.includes("owner") ? "owner" : isAdmin ? "admin" : "member");
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    calls.push(url);
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({
        email: "a@b.c", appRole, isAdmin, roles: [],
        gw: { employee: { id: "e1", display_name: "森田", status: "active" }, roles, tenantId: "t1", stage: null },
        access: serverAccessOf({ isAdmin, roles }),
      });
    }
    if (/\/api\/badges/.test(url)) return send({ badges: { esign: 2, timecard: 3, requests: 1, expenses: 4 } });
    if (/\/api\/hr\b/.test(url)) return send({ tabs: [], onboarding: [{ id: "p1" }], offboarding: [] });
    if (/\/api\/closing/.test(url)) return send({ month: "2026-09", closing: { status: "open" }, canClose: false, blockers: [], rows: [] });
    if (/\/api\/billing-progress/.test(url)) return send({ progress: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(1100);
  page.calls = calls;
  return page;
}

const pathOf = (page) => new URL(page.url()).pathname;
const side = (page) => page.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts()
  .then((a) => a.map((x) => x.trim()));
const groups = (page) => page.locator(".kp-side-group .lb").allInnerTexts().then((a) => a.map((x) => x.trim()));
const officeBtn = (page) => page.locator('.topbar [data-shortcut="office"]');
const rowsOf = (page) => page.locator(".od-row .od-label").allInnerTexts().then((a) => a.map((x) => x.trim()));
const called = (page, re) => page.calls.some((u) => re.test(u));

const HR_PAGE = "admin-members.html";
const FIN_PAGE = "admin-expenses.html";

console.log("— 人事（hr）: 人事・労務だけ —");
{
  const p = await open(HR_PAGE, { roles: ["hr"] });
  check(pathOf(p) === `/${HR_PAGE}`, `人事は 人事・労務の画面（${HR_PAGE}）を開ける（いま ${pathOf(p)}）`);
  check((await groups(p)).join("|") === "人事・労務", `左メニューは「人事・労務」のグループだけ（いま ${(await groups(p)).join("|")}）`);
  const items = await side(p);
  check(items.includes("ダッシュボード") && items.includes("メンバー") && items.includes("勤怠管理") && items.includes("雇用契約"), `人事・労務の項目が並ぶ（${items.join("|")}）`);
  check(!items.some((x) => ["経費精算", "月次業務", "社内文書", "会計", "お知らせ配信"].includes(x)), "経理・事務の項目は出ない");
  check((await p.locator(".topbar .kp-app").innerText()).includes("管理"), "ヘッダーに「/ 管理」が出る（管理画面の中）");
  // Office は全員 /office/（2026-10-02）。人事だけの人は /office（月末月初）に入れないので、Office は出さない
  check(await officeBtn(p).count() === 0, "人事だけの人には、ヘッダーの Office を出さない（/office に入れない）");
  // 管理画面へは ⚙管理 から。担当者には管理画面の入口だけ
  check(await p.locator("#kp-admin-menu-btn").count() === 1, "⚙管理が出る（管理画面の入口）");
  await p.locator("#kp-admin-menu-btn").click();
  const menu = await p.locator("#kp-admin-menu-panel a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check(menu.join() === "admin-dashboard.html", `⚙管理は管理画面の入口だけ（権限・端末・設定は出さない。いま ${menu.join()}）`);
  await p.close();

  const f = await open(FIN_PAGE, { roles: ["hr"] });
  check(pathOf(f) === "/home.html", `人事が 経理・事務の画面（${FIN_PAGE}）を直接開いたらホームへ（いま ${pathOf(f)}）`);
  await f.close();
  for (const u of ["admin-closing.html", "admin-month-start.html", "admin-docs.html", "admin-notices.html", "admin-site-news.html", "admin-settings.html"]) {
    const q = await open(u, { roles: ["hr"] });
    check(pathOf(q) === "/home.html", `人事が ${u} を直接開いたらホームへ`);
    await q.close();
  }

  const d = await open("admin-dashboard.html", { roles: ["hr"] });
  check(pathOf(d) === "/admin-dashboard.html", "人事はダッシュボードを開ける");
  const rows = await rowsOf(d);
  check(rows.join("|") === "入社手続き待ち|退社手続き待ち|契約待ち|勤怠確認|休暇・稟議の承認", `ダッシュボードは人事・労務の行だけ（いま ${rows.join("|")}）`);
  check(called(d, /\/api\/hr\b/) && !called(d, /\/api\/closing/) && !called(d, /\/api\/billing-progress/), "担当でない API（月次・請求）は呼ばない");
  await d.close();
}

console.log("\n— 経理（finance）: 経理・事務だけ —");
{
  const p = await open(FIN_PAGE, { roles: ["finance"] });
  check(pathOf(p) === `/${FIN_PAGE}`, `経理は 経理・事務の画面（${FIN_PAGE}）を開ける（いま ${pathOf(p)}）`);
  check((await groups(p)).join("|") === "経理・事務", `左メニューは「経理・事務」のグループだけ（いま ${(await groups(p)).join("|")}）`);
  const items = await side(p);
  check(items.includes("ダッシュボード") && items.includes("経費精算") && items.includes("月次業務") && items.includes("社内文書"), `経理・事務の項目が並ぶ（${items.join("|")}）`);
  check(!items.some((x) => ["メンバー", "勤怠管理", "雇用契約", "入退社", "評価・キャリア", "会計", "お知らせ配信"].includes(x)), "人事・労務の項目・会計・お知らせ配信は出ない");
  check(await officeBtn(p).count() === 1 && (await officeBtn(p).getAttribute("href")) === "/office/", "ヘッダーの Office → /office/（役割で行き先を変えない）");
  check(await p.locator("#kp-admin-menu-btn").count() === 1, "⚙管理が出る（管理画面の入口）");
  await p.close();

  const h = await open(HR_PAGE, { roles: ["finance"] });
  check(pathOf(h) === "/home.html", `経理が 人事・労務の画面（${HR_PAGE}）を直接開いたらホームへ（いま ${pathOf(h)}）`);
  await h.close();
  for (const u of ["admin-hr.html", "admin-timecard.html", "admin-contracts.html", "admin-career.html", "admin-notices.html"]) {
    const q = await open(u, { roles: ["finance"] });
    check(pathOf(q) === "/home.html", `経理が ${u} を直接開いたらホームへ`);
    await q.close();
  }

  const d = await open("admin-dashboard.html", { roles: ["finance"] });
  const rows = await rowsOf(d);
  check(rows.join("|") === "経費承認|月次未完了|請求・支払の進行中", `ダッシュボードは経理・事務の行だけ（いま ${rows.join("|")}）`);
  check(!called(d, /\/api\/hr\b/) && called(d, /\/api\/closing/) && called(d, /\/api\/billing-progress/), "担当でない API（人事）は呼ばない");
  await d.close();

  // 月末月初（/office/）は、経理・事務の「月次業務」の中の「月末月初業務」から入る（経理は access.office もある）
  const c = await open("admin-closing.html", { roles: ["finance"] });
  const tabs = (await c.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("|") === "月次締め|月初作業管理|月末月初業務", `月次業務の帯に「月末月初業務」が出る（いま ${tabs.join("|")}）`);
  await c.close();
}

console.log("\n— 管理者・経営者: 両方 —");
for (const [who, label] of [[{ isAdmin: true }, "管理者"], [{ roles: ["owner"] }, "経営者"]]) {
  const p = await open(HR_PAGE, who);
  check((await groups(p)).join("|") === "人事・労務|経理・事務", `${label}: 左メニューは両方のグループ（いま ${(await groups(p)).join("|")}）`);
  const items = await side(p);
  check(items.includes("会計") && items.includes("お知らせ配信"), `${label}: 会計・お知らせ配信も出る`);
  check(await p.locator("#kp-admin-menu-btn").count() === 1, `${label}: ⚙管理が出る`);
  await p.close();
  const f = await open(FIN_PAGE, who);
  check(pathOf(f) === `/${FIN_PAGE}`, `${label}: 経理・事務の画面も開ける`);
  await f.close();
  const d = await open("admin-dashboard.html", who);
  check((await rowsOf(d)).length === 8, `${label}: ダッシュボードは8行（人事・労務5＋経理・事務3）`);
  await d.close();
}

console.log("\n— 人事＋経理: 両方に入れる —");
{
  const p = await open(HR_PAGE, { roles: ["hr", "finance"] });
  check((await groups(p)).join("|") === "人事・労務|経理・事務", "人事＋経理: 両方のグループ");
  await p.close();
}

console.log("\n— 責任者（manager）: 今までどおり /office/ だけ —");
{
  const h = await open("home.html", { roles: ["manager"] });
  check(await officeBtn(h).count() === 1 && (await officeBtn(h).getAttribute("href")) === "/office/", "ヘッダーの Office → /office/（月末月初）");
  await h.close();
  for (const u of [HR_PAGE, FIN_PAGE, "admin-dashboard.html"]) {
    const q = await open(u, { roles: ["manager"] });
    check(pathOf(q) === "/home.html", `責任者が ${u} を直接開いたらホームへ`);
    await q.close();
  }
}

console.log("\n— 入れない人（採用担当・営業・IT・一般）: Office の画面は開けない・ヘッダーにも出ない —");
for (const roles of [["recruiter"], ["sales"], ["it"], []]) {
  const h = await open("home.html", { roles });
  check(await officeBtn(h).count() === 0, `${JSON.stringify(roles)}: ヘッダーに Office を出さない`);
  await h.close();
  const q = await open(HR_PAGE, { roles });
  check(pathOf(q) === "/home.html", `${JSON.stringify(roles)}: 人事・労務の画面を直接開いたらホームへ`);
  await q.close();
}

console.log("\n— スマホ幅（人事）: 横スクロールしない —");
{
  const p = await open(HR_PAGE, { roles: ["hr"], width: 390 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `390px: 横スクロールが出ない（はみ出し ${overflow}px）`);
  await p.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
