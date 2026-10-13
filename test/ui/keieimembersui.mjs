// 経営「メンバー実行状況」（/keiei/#members・keiei/members.js）を実際のブラウザで通す。
//
// ■ 何を守るテストか
//   画面に返す中身は、本物の api/keiei/index.js（view=members・hub）を偽の DB で動かして作る（手で書いた応答ではない）。
//   材料は test/fixtures/member-exec.mjs（架空の4人。良好・注意・要対応と、出さない人）。
//   1. 「人・組織」の2段目の先頭が「メンバー実行状況」で、選ばれている
//   2. 今日の状況（6つの数）・今日の要フォロー（要対応の人だけ）
//   3. 一覧：問題のある人が上（要対応 → 注意 → 良好）。全員が見える。日報・今日の3つ・期限超過・明日の3つ・状態
//   4. 行を押すと詳細（①今日の日報 ②今日やる3つ ③止まっているもの ④明日の3つ ⑤今週）。日報・タスクの画面へのリンク
//   5. 絞り込み（状態・期限超過あり）
//   6. 経営ホームに要約（要フォロー・日報未提出・明日の3つ未登録）と「メンバー実行状況を見る」
//   7. 1280・1440 は表、390 はカード（横スクロール0）。詳細は 390 で下から開く
//   8. 読み込み中・対象のメンバーがいないとき
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launch, BASE } from "../_browser.mjs";
import { createMemDb } from "../_memdb.mjs";
import * as FX from "../fixtures/member-exec.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const atRoot = (p) => join(ROOT, p);
const realNow = Date.now;
Date.now = () => Date.parse(FX.NOW_ISO);

const mem = createMemDb();
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-owner" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
const GW = await import(atRoot("lib/gw.js"));
const CTX = { tenantId: FX.TENANT, isAdmin: false, isHr: true, roles: ["owner"], apps: [], employee: { id: "e1", display_name: "経営 テスト" } };
mock.module(atRoot("lib/gw.js"), { namedExports: { ...GW, gwContext: async () => CTX } });
const { default: keiei } = await import(atRoot("api/keiei/index.js"));
async function callApi(url) {
  const r = { statusCode: 0, setHeader() {}, end(b) { r.body = b; } };
  await keiei({ method: "GET", headers: {}, url }, r);
  return r;
}
const reset = (rows = FX.memberExecRows()) => { mem.reset(); mem.state.missing = null; Object.assign(mem.rows, rows); };

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(width = 1280, hash = "#members", { delay = 0 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date(FX.NOW_ISO));
  const errs = [], moved = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" })); for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k); });
  await page.route("**/api/**", async (r) => {
    const u = new URL(r.request().url());
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: typeof b === "string" ? b : JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: false, roles: ["owner"],
        gw: { employee: { id: "e1", display_name: "経営 テスト", status: "active" }, roles: ["owner"], tenantId: FX.TENANT, isAdmin: false, stage: null },
        access: GW.accessOf({ isAdmin: false, roles: ["owner"] }) });
    }
    if (u.pathname === "/api/keiei") {
      if (delay) await new Promise((ok) => setTimeout(ok, delay));
      const out = await callApi(u.pathname + u.search);
      return send(out.body, out.statusCode);
    }
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.route(/\/admin[^/]*\.html(\?.*)?(#.*)?$/, (route) => {
    if (route.request().isNavigationRequest()) { moved.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 200, contentType: "text/html", body: "<title>元</title>" }); }
    return route.continue();
  });
  await page.goto(`${BASE}/keiei/index.html${hash}`);
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:20px;height:20px;display:inline-block;flex:none}" });
  if (!delay) await page.waitForSelector('[data-block="list"], .kei-banner, [data-block="member-exec"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  return { page, errs, moved };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

console.log("\n=== メンバー実行状況（1280px） ===");
{
  reset();
  const { page, errs, moved } = await open();
  const subs = (await page.locator("#kp-keiei-nav .kp-ostab").allInnerTexts()).map((x) => x.trim());
  check(subs[0] === "メンバー実行状況", `人・組織の2段目の先頭（${subs.join("/")}）`);
  check((await page.locator("#kp-keiei-nav .kp-ostab.on").innerText()).trim() === "メンバー実行状況", "メンバー実行状況が選ばれている");
  check((await page.locator("#kp-keiei-nav .kp-otab.on").getAttribute("data-ktab")) === "people", "1段目は人・組織");
  const sum = Object.fromEntries(await page.locator("[data-sum]").evaluateAll((ns) => ns.map((n) => [n.dataset.sum, n.querySelector(".val").textContent.replace(/\s/g, "")])));
  check(sum.nippo === "3/4人" && sum.focus === "2/4人" && sum.follow === "2人" && sum.overdue === "3件" && sum.tomorrow === "1人" && sum.consult === "1人", `今日の状況（${JSON.stringify(sum)}）`);
  check(await page.locator('[data-sum="follow"].bad').count() === 1 && await page.locator('[data-sum="nippo"].bad').count() === 0, "問題のある数字だけ目立たせる");
  const follow = await page.locator('[data-role="follow"] .km-frow').evaluateAll((ns) => ns.map((n) => n.innerText.replace(/\s+/g, " ")));
  check(follow.length === 2 && follow[0].includes("藤本") && follow[0].includes("期限超過 2件") && follow[1].includes("今福") && follow[1].includes("相談あり"), `今日の要フォロー（${follow.join(" | ")}）`);
  const order = await page.locator("table.km-t tr.km-row").evaluateAll((ns) => ns.map((n) => `${n.dataset.emp}:${n.dataset.status}`));
  check(order.join(",") === "e2:danger,e4:danger,e3:warn,e1:good", `問題のある人が上・全員が見える（${order.join(",")}）`);
  const fujimoto = await page.locator('tr.km-row[data-emp="e2"]').innerText();
  check(fujimoto.includes("まだ") && fujimoto.includes("1/3") && fujimoto.includes("2") && fujimoto.includes("未登録") && fujimoto.includes("要対応"), `行の中身（${fujimoto.replace(/\s+/g, " ")}）`);
  check(!(await page.locator("#kei-main").innerText()).includes("退職 テスト") && !(await page.locator("#kei-main").innerText()).includes("他社"), "退職済み・他社は出ない");

  console.log("\n— 絞り込み —");
  await page.selectOption("#km-status", "warn");
  check(await page.locator("tr.km-row").count() === 1 && (await page.locator("tr.km-row").getAttribute("data-emp")) === "e3", "状態：注意");
  await page.selectOption("#km-status", "");
  await page.locator("label", { hasText: "期限超過あり" }).locator("input").check();
  check((await page.locator("tr.km-row").evaluateAll((ns) => ns.map((n) => n.dataset.emp))).join(",") === "e2,e3", "期限超過あり");
  await page.locator("label", { hasText: "期限超過あり" }).locator("input").uncheck();

  console.log("\n— 詳細（右から） —");
  await page.click('tr.km-row[data-emp="e4"]');
  await page.waitForSelector('.km-dr [data-sec="week"]', { timeout: 8000 });
  const secs = await page.locator(".km-dr [data-sec]").evaluateAll((ns) => ns.map((n) => n.dataset.sec));
  check(["nippo", "today", "stuck", "tomorrow", "week"].every((s) => secs.includes(s)), `①〜⑤（${secs.join(",")}）`);
  const dr = await page.locator(".km-dr").innerText();
  check(dr.includes("見積の値引き幅を相談したい") && dr.includes("先方の決裁待ち") && dr.includes("完了条件：先方に送付済み"), "相談・ブロッカー・完了条件");
  const box = await page.locator(".km-dr").boundingBox();
  check(box && box.x > 600 && box.y === 0, `右から開く（x=${box?.x}, y=${box?.y}）`);
  check((await page.locator('.km-dr [data-sec="nippo"] a').getAttribute("href")) === "/admin-nippo.html#dr-n-u4-2026-10-15", "日報を詳しく見る → 日報・勤怠（その日報へ）");
  check((await page.locator('.km-dr [data-sec="today"] a').getAttribute("href")) === "/admin-tasks.html", "全員のタスクへ");
  await page.keyboard.press("Escape");
  check(await page.locator("#km-drawer").count() === 0, "Esc で閉じる");
  await page.click('.km-frow[data-emp="e2"] button');
  await page.waitForSelector('.km-dr [data-sec="stuck"]', { timeout: 8000 });
  const st = await page.locator('.km-dr [data-sec="stuck"]').innerText();
  check(st.includes("請求書の再発行") && st.includes("見積の修正") && st.includes("2回"), `要フォローの「確認する」から開く・止まっているもの（${st.replace(/\s+/g, " ").slice(0, 120)}）`);
  check(await overflow(page) <= 0, "1280px：横にはみ出さない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  check(moved.length === 0, "ここでは処理しない（元の画面へ勝手に移らない）");
  await page.close();
}

console.log("\n=== 1440px・390px ===");
{
  reset();
  const { page } = await open(1440);
  check(await overflow(page) <= 0 && await page.locator("table.km-t").isVisible(), "1440px：表・横にはみ出さない");
  await page.close();
}
{
  reset();
  const { page, errs } = await open(390);
  check(await overflow(page) <= 0, `390px：横スクロール0（${await overflow(page)}）`);
  check(!(await page.locator(".km-table-wrap").isVisible()) && await page.locator(".km-card").count() === 4, "390px：表ではなくカード");
  const card = await page.locator('.km-card[data-emp="e2"]').innerText();
  check(card.includes("要対応") && card.includes("日報") && card.includes("1/3") && card.includes("期限超過") && card.includes("未登録"), `カードの中身（${card.replace(/\s+/g, " ")}）`);
  await page.click('.km-card[data-emp="e2"] button');
  await page.waitForSelector('.km-dr [data-sec="nippo"]', { timeout: 8000 });
  const b = await page.locator(".km-dr").boundingBox();
  check(b && b.x === 0 && b.y > 0, `390px：詳細は下から（x=${b?.x}, y=${b?.y}）`);
  check(await overflow(page) <= 0, "390px：詳細を開いても横にはみ出さない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 経営ホームの要約 ===");
{
  reset();
  const { page } = await open(1280, "#home");
  await page.waitForSelector('[data-block="member-exec"]', { timeout: 8000 }).catch(() => {});
  const t = await page.locator('[data-block="member-exec"]').innerText().catch(() => "");
  check(/要フォロー\s*2/.test(t) && /日報未提出\s*1/.test(t) && /明日の3つ未登録\s*1/.test(t), `ホーム：要フォロー2・日報未提出1・明日の3つ未登録1（${t.replace(/\s+/g, " ")}）`);
  check((await page.locator('[data-role="members-more"]').getAttribute("href")) === "#members", "メンバー実行状況を見る →");
  await page.close();
}

console.log("\n=== 読み込み中・空のとき ===");
{
  reset();
  const { page } = await open(1280, "#members", { delay: 1500 });
  check((await page.locator("#kei-main").innerText()).includes("読み込み中"), "読み込み中と出す（0人とは出さない）");
  await page.close();
}
{
  reset({ ...FX.memberExecRows(), gw_employees: [] });
  const { page, errs } = await open();
  check(await page.locator('[data-role="empty"]').count() === 1, "対象のメンバーがいないとき");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
Date.now = realNow;
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
