// ヘッダーの近道（採用HR・Sales）を、実際のブラウザで見る（管理画面・メンバー画面とも）。
//
// ■ 何を守りたいのか
//   ・権限のある人にだけ出る（owner/admin は両方、採用担当は HR、営業は Sales）
//   ・出し分けは /api/me の access（サーバの canRecruit / canSell）どおり
//   ・一般メンバーの画面でも、権限があれば出る。権限を付けたら、再読込で出る
//   ・メンバー表示で確認中も、実際の権限どおりに出る
//   ・行き先が /hr/ と /sales/
//   ・メンバー表示・通知・ログアウトを壊さない
//   ・狭い画面で「HR」「Sales」に縮み、通知・ログアウトを押し出さない
//   ・入口はヘッダーだけ。左メニュー（管理者・メンバーとも）には採用・営業を置かない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

/**
 * @param {string} path
 * @param {{appRole:string, isAdmin?:boolean, roles?:string[], width?:number, memberView?:boolean}} who
 */
/** サーバ（lib/gw.js accessOf）と同じ結果を返す。/api/me の access の代わり */
const accessOf = (w) => {
  const r = w.roles || [];
  return {
    recruit: Boolean(w.isAdmin) || ["owner", "hr", "recruiter"].some((x) => r.includes(x)),
    sell: Boolean(w.isAdmin) || ["owner", "manager", "sales"].some((x) => r.includes(x)),
  };
};

async function open(path, who) {
  const page = await br.newPage({
    viewport: { width: who.width || 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript((w) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout");
    localStorage.removeItem("kp_me");
    localStorage.removeItem("kp_nav_open");
    if (w.memberView) localStorage.setItem("kp_view", "member");
    else localStorage.removeItem("kp_view");
  }, who);
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      // who.roles は途中で書き換える（権限を付けたあとの再読込を再現する）
      return send({
        email: "a@b.c", appRole: who.appRole, isAdmin: Boolean(who.isAdmin), roles: [],
        gw: { employee: { id: "e1", display_name: "森田", status: "active" },
              roles: who.roles || [], tenantId: "t1", stage: null },
        ...(who.noAccess ? {} : { access: accessOf(who) }),
      });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 3 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(900);
  return page;
}

const shortcuts = (page) => page.locator(".topbar [data-shortcut]").evaluateAll((ns) =>
  ns.map((n) => ({ key: n.dataset.shortcut, href: n.getAttribute("href"), text: n.innerText.trim() })));

console.log("— owner：採用HR と Sales の両方 —");
{
  const page = await open("admin-dashboard.html", { appRole: "owner", roles: ["owner"] });
  const sc = await shortcuts(page);
  check(sc.map((s) => s.key).join(",") === "hr,sales", `並び（いま ${sc.map((s) => s.key)}）`);
  check(sc.find((s) => s.key === "hr")?.href === "/hr/", "採用HR → /hr/");
  check(sc.find((s) => s.key === "sales")?.href === "/sales/", "Sales → /sales/");
  check(sc.find((s) => s.key === "hr")?.text.includes("採用HR"), "PCでは「採用HR」と出る");
  check(await page.locator(".topbar .kp-shortcut.btn-secondary").count() === 2, "既存の secondary ボタン");
  check(await page.locator(".topbar .kp-shortcut.on").count() === 0, "ダッシュボードでは active にしない");

  // 既存の3つを壊していない
  check(await page.locator(".topbar button:has-text('メンバー表示')").isVisible(), "メンバー表示ボタン");
  check(await page.locator("#kp-bell-btn").isVisible(), "通知ボタン");
  check((await page.locator("#kp-bell-badge").innerText()).trim() === "3", "通知の件数");
  check(await page.locator(".topbar button:has-text('ログアウト')").isVisible(), "ログアウト");
  await page.click("#kp-bell-btn");
  check(await page.locator("#kp-bell-panel").isVisible(), "通知パネルが開く");

  // ヘッダーの高さを極端に変えない
  const h = await page.locator(".topbar").evaluate((n) => n.getBoundingClientRect().height);
  check(h <= 64, `ヘッダーの高さ ${Math.round(h)}px`);

  // 正式な入口はヘッダー。左メニューには置かない（二重導線にしない）
  const side = await page.locator(".kp-sidebar").evaluate((n) =>
    [...n.querySelectorAll("a")].map((a) => a.getAttribute("href")));
  check(!side.some((h) => /(^|\/)hr\/$/.test(h || "")), "左メニューに「採用」は置かない");
  check(!side.some((h) => /(^|\/)sales\/$/.test(h || "")), "左メニューに「営業」は置かない");

  await page.screenshot({ path: shotPath("header-shortcuts-pc.png") });
  await page.close();
}

console.log("\n— admin（会計の管理者）も両方 —");
{
  const page = await open("admin-dashboard.html", { appRole: "admin", isAdmin: true, roles: [] });
  check((await shortcuts(page)).map((s) => s.key).join(",") === "hr,sales", "管理者に両方");
  await page.close();
}

console.log("\n— 権限に応じて出し分ける —");
for (const [roles, want, label] of [
  [["recruiter"], "hr", "採用担当 → 採用HRだけ"],
  [["hr"], "hr", "人事 → 採用HRだけ"],
  [["sales"], "sales", "営業 → Salesだけ"],
  [["manager"], "sales", "マネージャー → Salesだけ"],
  [[], "", "権限なし → どちらも出さない"],
]) {
  const page = await open("home.html", { appRole: "member", roles });
  const got = (await shortcuts(page)).map((s) => s.key).join(",");
  check(got === want, `${label}（いま "${got}"）`);
  await page.close();
}

console.log("\n— サーバの access どおりに出す（役割名ではなく判定結果で） —");
{
  // 役割が何であっても、サーバが「入れない」と言えば出さない（逆も同じ）
  const page = await open("home.html", { appRole: "member", roles: ["sales"], noAccess: false });
  check((await shortcuts(page)).map((s) => s.key).join(",") === "sales", "access.sell のときだけ Sales");
  await page.close();
  // 前の版の /api/me（access 無し）を覚えていても、同じ基準で出す
  const old = await open("home.html", { appRole: "member", roles: ["recruiter"], noAccess: true });
  check((await shortcuts(old)).map((s) => s.key).join(",") === "hr", "access が無い古い応答でも同じ基準");
  await old.close();
}

console.log("\n— 一般メンバーの画面：並びと、既存の氏名・通知・ログアウト —");
{
  const page = await open("home.html", { appRole: "member", roles: ["recruiter", "sales"] });
  const order = await page.locator(".topbar").evaluate((bar) => {
    const pick = (el) => {
      if (el.matches?.(".brand")) return "エイト";
      if (el.dataset?.shortcut) return el.dataset.shortcut === "hr" ? "採用HR" : "Sales";
      if (el.classList?.contains("kp-who-name")) return "氏名";
      if (el.id === "kp-bell-btn") return "通知";
      if (el.tagName === "BUTTON" && /ログアウト/.test(el.textContent)) return "ログアウト";
      return null;
    };
    return [...bar.querySelectorAll(".brand, [data-shortcut], .kp-who-name, #kp-bell-btn, button")]
      .map(pick).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  });
  check(order.join(" | ") === "エイト | 採用HR | Sales | 氏名 | 通知 | ログアウト",
    `PC の並び（いま ${order.join(" | ")}）`);
  const side = await page.locator(".kp-sidebar").innerText().catch(() => "");
  check(!/採用|営業|Sales/.test(side), "メンバーの左メニューには追加しない");
  await page.screenshot({ path: shotPath("header-shortcuts-member.png") });
  await page.close();
}

console.log("\n— 権限を付けたら、再ログインなしで再読込後に出る —");
{
  const who = { appRole: "member", roles: [] };
  const page = await open("home.html", who);
  check((await shortcuts(page)).length === 0, "付ける前は出ない");
  // メンバー管理で「採用担当」「営業担当」を付けた（gw_role_grants に入った）
  who.roles = ["recruiter", "sales"];
  await page.reload();
  await page.waitForTimeout(900);
  check((await shortcuts(page)).map((s) => s.key).join(",") === "hr,sales", "再読込で 採用HR・Sales が出る");
  // 外したら、再読込で消える
  who.roles = [];
  await page.reload();
  await page.waitForTimeout(900);
  check((await shortcuts(page)).length === 0, "外したら再読込で消える");
  await page.close();
}

console.log("\n— メンバー表示で確認中も、実際の権限どおりに出る —");
{
  const page = await open("home.html", { appRole: "owner", roles: ["owner"], memberView: true });
  check((await shortcuts(page)).map((s) => s.key).join(",") === "hr,sales",
    "メンバー表示中も、同じ権限のメンバーと同じく近道が出る");
  check(await page.locator(".topbar button:has-text('管理画面に戻る')").isVisible(), "管理画面に戻る");
  await page.close();
}

console.log("\n— スマホ幅：短縮して、通知・ログアウトを押し出さない —");
for (const [width, path, who] of [
  [390, "admin-dashboard.html", { appRole: "owner", roles: ["owner"] }],
  [360, "admin-dashboard.html", { appRole: "owner", roles: ["owner"] }],
  [390, "home.html", { appRole: "member", roles: ["recruiter", "sales"] }],
  [360, "home.html", { appRole: "member", roles: ["recruiter", "sales"] }],
]) {
  const page = await open(path, { ...who, width });
  const sc = await shortcuts(page);
  check(sc.map((s) => s.text).join("/") === "HR/Sales", `${width}px:「HR」「Sales」に縮む（いま ${sc.map((s) => s.text).join("/")}）`);
  const inView = async (sel) => page.locator(sel).evaluate((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
  });
  check(await inView("#kp-bell-btn"), `${width}px ${path}: 通知が画面内`);
  check(await inView(".topbar .kp-who-name"), `${width}px ${path}: 氏名が画面内`);
  check(await inView(".topbar button:has-text('ログアウト')"), `${width}px: ログアウトが画面内`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${width}px: 横スクロールが出ない（はみ出し ${overflow}px）`);
  if (width === 390) await page.screenshot({ path: shotPath(`header-shortcuts-sp-${path.replace(".html", "")}.png`) });
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
