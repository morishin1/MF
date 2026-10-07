// グループウェア：メニュー整理・権限分担（2026-10-07）を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・Office は 人・組織／請求・支払／契約・書類／端末・貸与品。人・組織は日報・勤怠が初め（今週の提出・勤怠）
//   ・経営は 人・組織＝チーム状況（全体の集計）。日報・勤怠は経営に置かない（同じ機能を二重に出さない）
//   ・権限・アクセス分析は経営の「リスク・権限」。端末・貸与品は Office。⚙はシステム設定と AIナレッジだけ
//   ・見えるかどうかは、その人の権限（/api/me の access。サーバの lib/gw.js accessOf）だけで決まる
//   ・人事だけの人は、日報・勤怠・端末・貸与品を開ける（以前は管理者・経営者だけで、API とずれていた）
//   ・権限の無い画面を直接開くと、入れずにホームへ戻る
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const GW = await import("../../lib/gw.js");

// 人の種類（サーバと同じ計算で access を作る）
const ctxOf = (roles, { isAdmin = false, apps = ["office"] } = {}) => ({ isAdmin, roles, apps, isHr: GW.isHrOf({ roles, apps }) });
const PEOPLE = {
  hr:      { appRole: "member", ctx: ctxOf(["hr"]) },
  finance: { appRole: "member", ctx: ctxOf(["finance"]) },
  owner:   { appRole: "owner",  ctx: ctxOf(["owner"], { apps: [] }) },
  member:  { appRole: "member", ctx: ctxOf([], { apps: [] }) },
};

async function open(path, who, { width = 1440 } = {}) {
  const p = PEOPLE[who];
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({
        email: "a@b.c", appRole: p.appRole, isAdmin: p.ctx.isAdmin, access: GW.accessOf(p.ctx),
        gw: { employee: { id: "e1", display_name: "テスト", status: "active" }, roles: p.ctx.roles, apps: p.ctx.apps, tenantId: "t1", stage: { key: "member" } },
      });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(1000);
  return page;
}
const labels = async (page, sel) => (await page.locator(sel).allInnerTexts()).map((x) => x.trim());
const otabs = (page) => labels(page, "#kp-office-nav .kp-otab");
const ostabs = (page) => labels(page, "#kp-office-nav .kp-ostab");

console.log("— 人事だけの人：Office は 人・組織（日報・勤怠が初め）／契約・書類／端末・貸与品 —");
{
  const page = await open("admin-nippo.html", "hr");
  check(/admin-nippo\.html/.test(page.url()), `日報・勤怠を開ける（以前は管理者・経営者だけ。いま ${page.url().replace(BASE, "")}）`);
  check((await otabs(page)).join("/") === "ホーム/人・組織/契約・書類/端末・貸与品", `Office のタブ（いま ${(await otabs(page)).join("/")}）`);
  check((await ostabs(page)).join("/") === "日報・勤怠/メンバー/入退社/勤怠管理/評価・キャリア", `人・組織の中（いま ${(await ostabs(page)).join("/")}）`);
  check((await page.locator("#kp-office-nav .kp-otab.on").innerText()).trim() === "人・組織", "人・組織が選ばれている");
  check((await page.locator("#kp-office-nav .kp-ostab.on").innerText()).trim() === "日報・勤怠", "日報・勤怠が選ばれている");
  const href = await page.locator('#kp-office-nav .kp-otab:has-text("人・組織")').getAttribute("href");
  check(/admin-nippo\.html$/.test(href || ""), `人・組織を押すと、日報・勤怠（今週の提出・勤怠）を開く（いま ${href}）`);
  check(await page.locator("#kp-keiei-nav").count() === 0, "経営のタブは出さない（日報・勤怠は Office）");
  await page.close();

  const dev = await open("admin-devices.html", "hr");
  check(/admin-devices\.html/.test(dev.url()), "端末・貸与品を開ける（API と同じ人事の権限）");
  check((await dev.locator("#kp-office-nav .kp-otab.on").innerText()).trim() === "端末・貸与品", "Office の「端末・貸与品」が選ばれている");
  check((await labels(dev, ".kp-subnav .kp-subtab")).join("/") === "端末管理/アカウント・貸与品", "端末管理／アカウント・貸与品の帯");
  await dev.close();
  const as = await open("admin-assets.html", "hr");
  check(/admin-assets\.html/.test(as.url()), "アカウント・貸与品を開ける");
  await as.close();

  // 経営・⚙の画面は開けない
  for (const path of ["admin-analytics.html", "admin-settings.html", "admin-team.html"]) {
    const x = await open(path, "hr");
    check(!x.url().includes(path), `${path} は開けない（ホームへ戻る。いま ${x.url().replace(BASE, "")}）`);
    await x.close();
  }
}

console.log("\n— 経理だけの人：請求・支払／契約・書類。人・組織・端末・貸与品は出ない —");
{
  const page = await open("admin-expenses.html", "finance");
  check((await otabs(page)).join("/") === "ホーム/請求・支払/契約・書類", `Office のタブ（いま ${(await otabs(page)).join("/")}）`);
  check((await ostabs(page)).join("/") === "請求・支払/経費精算/月次業務", `請求・支払の中（いま ${(await ostabs(page)).join("/")}）`);
  await page.close();
  for (const path of ["admin-nippo.html", "admin-devices.html", "admin-members.html"]) {
    const x = await open(path, "finance");
    check(!x.url().includes(path), `${path} は開けない（いま ${x.url().replace(BASE, "")}）`);
    await x.close();
  }
}

console.log("\n— 経営者：経営は 人・組織＝チーム状況（集計）。権限・アクセス分析は「リスク・権限」—");
{
  const page = await open("admin-team.html", "owner");
  const k1 = await labels(page, "#kp-keiei-nav .kp-otab");
  check(k1.join("/") === "ホーム/売上・営業/人・組織/財務/リスク・権限", `経営のタブ（いま ${k1.join("/")}）`);
  const people = await page.locator('#kp-keiei-nav .kp-otab[data-ktab="people"]').getAttribute("href");
  check(people === "/admin-team.html", `人・組織を押すと、チーム状況（いま ${people}）`);
  const k2 = await labels(page, "#kp-keiei-nav .kp-ostab");
  check(k2.join("/") === "チーム状況/全員のタスク/入社準備/給与管理/概要" && !k2.includes("日報・勤怠"), `人・組織の中に日報・勤怠は無い（いま ${k2.join("/")}）`);
  await page.close();

  const an = await open("admin-analytics.html", "owner");
  check((await an.locator("#kp-keiei-nav .kp-otab.on").innerText()).trim() === "リスク・権限", "アクセス分析は経営の「リスク・権限」");
  const r2 = await labels(an, "#kp-keiei-nav .kp-ostab");
  check(r2.join("/") === "リスク・未処理/経営設定・セキュリティ/権限/アクセス分析", `リスク・権限の中（いま ${r2.join("/")}）`);
  check((await an.locator("#kp-keiei-nav .kp-ostab.on").innerText()).trim() === "アクセス分析", "アクセス分析が選ばれている");
  const roles = await an.locator('#kp-keiei-nav .kp-ostab:has-text("権限")').first().getAttribute("href");
  check(roles === "/admin-members.html#roles", `権限はメンバー一覧の権限へ（いま ${roles}）`);
  await an.close();

  // ⚙はシステム設定と AIナレッジだけ
  const st = await open("admin-settings.html", "owner");
  await st.locator("#kp-admin-menu-btn").click().catch(() => {});
  await st.waitForTimeout(300);
  const gear = (await st.locator(".kp-bell-item").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  check(gear.some((x) => x.includes("システム設定")) && gear.some((x) => x.includes("AIナレッジ")), `⚙にシステム設定・AIナレッジ（いま ${gear.join(" / ")}）`);
  check(!gear.some((x) => /権限|端末|アクセス分析/.test(x)), "⚙に権限・端末・貸与品・アクセス分析は無い");
  await st.close();

  // 経営者は Office の日報・勤怠も開ける（Office の画面として）
  const nip = await open("admin-nippo.html", "owner");
  check(/admin-nippo\.html/.test(nip.url()) && (await nip.locator("#kp-office-nav .kp-otab.on").innerText()).trim() === "人・組織", "経営者が日報・勤怠を開くと Office の人・組織");
  await nip.close();
}

console.log("\n— 一般の社員：管理の画面はどれも開けない —");
for (const path of ["admin-nippo.html", "admin-devices.html", "admin-assets.html", "admin-analytics.html"]) {
  const x = await open(path, "member");
  check(!x.url().includes(path), `${path} は開けない（いま ${x.url().replace(BASE, "")}）`);
  await x.close();
}

console.log("\n— スマホ幅（390px）：Office のタブが横にはみ出さない —");
{
  const page = await open("admin-nippo.html", "hr", { width: 390 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `横にはみ出さない（${over}px）`);
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
