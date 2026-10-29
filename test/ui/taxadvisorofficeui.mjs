// 税理士（tax_advisor）が Office を開いたときの行き先を、実際のブラウザで通す（偽の API・架空の人・書き込みなし）。
//
// ■ 何を守るテストか（2026-10-29 の不具合）
//   ホーム・Office ホームなどは js/layout-marketing.js を読む。そちらに税理士の扱いが無く、Office ホームを開くと
//   home.html へ送られ、ホームも税理士を受け付けないので home.html を読み直し続けていた。
//   ・Office ホーム・ホームを開くと、税理士タスク（/office/professionals.html?tab=tax）へ。読み直しを繰り返さない
//   ・ヘッダーの Office は専門家タスクへ。ほかの Office の業務・マーケティングは出さない
//   ・経理など社内の人の Office は、これまでどおり開ける（専門家タスクのタブも出る）
import { launch, BASE } from "../_browser.mjs";

const { accessOf, isHrOf } = await import("../../lib/gw.js");
const { appsFromRoles } = await import("../../lib/app-grants.js");

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(path, { roles, appRole, apps }) {
  const page = await br.newPage({ viewport: { width: 1440, height: 900 } });
  let navs = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
  });
  const ap = apps || appsFromRoles(roles);
  const isHr = isHrOf({ roles, apps: ap });
  const writes = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    // 端末の記録（js/device.js の POST /api/devices/me）は、どの画面・どの人でも開くたびに送る既存の動き。業務データではないので数えない
    if (req.method() !== "GET" && !/\/api\/devices\/me\b/.test(url)) writes.push(`${req.method()} ${url}`);
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole, isAdmin: false, roles: [],
        gw: { available: true, employee: { id: "e1", display_name: "架空 税理士", status: "active" }, roles, apps: ap, isHr, tenantId: "t1", stage: null },
        access: accessOf({ isAdmin: false, isHr, roles, apps: ap }) });
    }
    if (/\/api\/office-professionals/.test(url)) return send({ kinds: roles.includes("tax_advisor") ? ["tax"] : ["labor", "tax"], tasks: [], stats: {}, assignable: [], templates: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/${path}`, { waitUntil: "commit" }).catch(() => {});
  await page.waitForTimeout(2500);
  page.navs = navs;
  page.writes = writes;
  return page;
}
const where = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
const TAX = { roles: ["tax_advisor"], appRole: "tax_advisor" };

console.log("— 税理士：Office ホーム・ホームを開くと税理士タスクへ —");
for (const path of ["office/", "home.html", "office/monthly.html"]) {
  const p = await open(path, TAX);
  check(where(p).startsWith("/office/professionals.html"), `${path} → 専門家タスク（いま ${where(p)}）`);
  check(p.navs <= 3, `${path}：読み直しを繰り返さない（遷移 ${p.navs} 回）`);
  check(p.writes.length === 0, `${path}：開くだけでは業務データを書かない（${p.writes.join(" ") || "なし"}）`);
  await p.close();
}

console.log("\n— 税理士：ヘッダーの Office は専門家タスクだけ —");
{
  const p = await open("office/professionals.html?tab=tax", TAX);
  check(where(p) === "/office/professionals.html?tab=tax", `税理士タスクを開ける（いま ${where(p)}）`);
  const office = p.locator('.topbar [data-shortcut="office"]');
  check(await office.count() === 1 && (await office.getAttribute("href")) === "/office/professionals.html", "ヘッダーの Office → /office/professionals.html");
  check(await p.locator('.topbar [data-shortcut="marketing"]').count() === 0, "マーケティングは出さない");
  await p.close();
}
{
  // マーケティングの利用権限が付いていても、税理士には出さない（入っても送り返されるだけ）
  const p = await open("home.html", { ...TAX, apps: ["marketing"] });
  check(where(p).startsWith("/office/professionals.html"), `マーケ付きの税理士も専門家タスクへ（いま ${where(p)}）`);
  check(await p.locator('.topbar [data-shortcut="marketing"]').count() === 0, "マーケ付きでもマーケティングは出さない");
  await p.close();
}

console.log("\n— 経理（社内）：Office はこれまでどおり —");
{
  const p = await open("office/", { roles: ["finance"], appRole: "member" });
  check(where(p) === "/office/", `経理は Office ホームを開ける（いま ${where(p)}）`);
  const tabs = (await p.locator("#kp-office-nav .kp-otab > span").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("/") === "ダッシュボード/請求・支払/契約・書類/専門家タスク", `Office のタブ（いま ${tabs.join("/")}）`);
  await p.close();
}

await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\n税理士の Office 導線：すべて通過");
