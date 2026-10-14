// 採用HR（/hr/*）のヘッダーを、スマホ幅でも使えるようにする。
//
// ■ 何を守りたいのか
//   ・390px・360px で、画面全体が横に伸びない（以前は、ヘッダーが縮まず 740px 以上はみ出していた）
//   ・ヘッダーは2段（上：ロゴ・戻る・操作／下：横に流せるタブ）。通知・ログイン中のメニュー・応募者追加が画面の中に収まる
//   ・タブ（ダッシュボード・応募者・CEO REVIEW）は、横に流せば全部押せる
//   ・PC 幅（1280px）は、これまでどおり1行（高さ 56px）
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const { accessOf } = await import("../../lib/gw.js");

const PAGES = ["/hr/", "/hr/applicants.html", "/hr/ceo-review.html", "/hr/document.html"];

async function open(path, width) {
  const page = await br.newPage({ viewport: { width, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "own@8grp.co.jp" })));
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send({ email: "own@8grp.co.jp", appRole: "owner", isAdmin: true, roles: [], memberships: [],
      gw: { employee: { id: "e1", display_name: "森田" }, roles: ["owner"], tenantId: "t1" }, access: accessOf({ isAdmin: true, roles: ["owner"] }) });
    return send({});
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector(".hr-bar");
  await page.waitForTimeout(500);
  return page;
}

for (const w of [390, 360]) {
  for (const path of PAGES) {
    const page = await open(path, w);
    const m = await page.evaluate(() => {
      const W = window.innerWidth;
      const inside = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= W + 1; };
      const nav = document.querySelector(".hr-nav");
      return { over: document.documentElement.scrollWidth - W, bell: inside("#hr-bell-btn"), user: inside("#hr-user-btn"), add: inside(".hr-add"), logo: inside(".hr-logo"),
        navScroll: nav.scrollWidth, navClient: nav.clientWidth, barH: document.querySelector(".hr-bar").getBoundingClientRect().height,
        tabs: [...document.querySelectorAll(".hr-nav a")].map((a) => a.innerText.trim()) };
    });
    check(m.over <= 0, `${w}px ${path}: 画面全体が横に伸びない（${m.over}）`);
    check(m.bell && m.user && m.add && m.logo, `${w}px ${path}: ロゴ・通知・メニュー・応募者追加が画面の中`);
    check(m.tabs.length === 4, `${w}px ${path}: タブは4つ（${m.tabs.join("|")}）`);
    if (path === "/hr/") await page.screenshot({ path: shotPath(`hr-header-${w}.png`) });
    await page.close();
  }
}

console.log("— タブは、横に流せば全部押せる —");
{
  const page = await open("/hr/", 360);
  const last = page.locator(".hr-nav a").last();
  await last.scrollIntoViewIfNeeded();
  const r = await last.evaluate((a) => { const b = a.getBoundingClientRect(); return { l: b.left, r: b.right, w: window.innerWidth }; });
  check(r.r <= r.w + 1 && r.l >= 0, "最後のタブ（メールひな型）を、画面の中に出せる");
  await page.close();
}

console.log("— PC 幅はこれまでどおり1行 —");
{
  const page = await open("/hr/", 1280);
  const h = await page.locator(".hr-bar").evaluate((e) => e.getBoundingClientRect().height);
  check(Math.round(h) === 57 || Math.round(h) === 56, `1280px: ヘッダーは1行（高さ ${h}）`);
  const t = await page.locator(".hr-add").innerText();
  check(t.includes("応募者追加"), "1280px: 応募者追加の文字が出る");
  check((await page.locator(".hr-back").innerText()).includes("GWへ戻る"), "1280px: 戻るの文字が出る");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
