// 表示速度：「まず見せて、裏で最新にする」を、実際のブラウザで見る。
//
// ■ 何を守りたいのか（表示速度の要件 §7・§8・§9・§11・§12・§17・§28〜31・§37）
//   ・2回目は、本文が API の返事を待たずに出る（前回の内容）。小さく「更新中…」
//   ・最新が違えば、変わったところだけ描き直す（変わらない行は作り直さない）
//   ・最新の取得に失敗しても、前回の内容は消さない（「最新情報を取得できませんでした」）
//   ・HR・Sales などの専用ヘッダーも、2回目は /api/me を待たずに出る
//   ・更新（POST 等）のあとは、前回の内容を出さない（取り直したものを出す）
//   ・ログアウトしたら、覚えている画面データを消す
//   ・通知は60秒以内なら取りにいかない。ベルを開いたときは取りにいく
//   ・ヘッダー・メニューのリンクに触れたら、その画面の HTML だけ先読みする
import { launch, BASE, jstToday } from "../_browser.mjs";
import { dashboardSections } from "../../lib/sales-dashboard.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const TODAY = jstToday();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ME = {
  email: "owner@8grp.co.jp", appRole: "owner", isAdmin: true,
  access: { recruit: true, sell: true, office: true, keiei: true },
  gw: { employee: { id: "emp-1", display_name: "森田 経営", status: "active" }, roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null },
};
const company = (id, name, over = {}) => ({ id, name, status: "replied", statusLabel: "返信あり", service: "AI / DX",
  next: "返信に対応する", nextDue: TODAY, overdue: false, ownerName: "営業 一郎", clickCount: 0, lastClickAt: null,
  lastSentAt: null, unhandledClick: false, ...over });

/** 1つのタブ（同じ sessionStorage・localStorage）で画面を開いていく */
async function tab() {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    if (!localStorage.getItem("kp_session") && !sessionStorage.getItem("__loggedOut")) {
      localStorage.setItem("kp_session", JSON.stringify({ access_token: "h.eyJzdWIiOiJ1c2VyLTEifQ.s",
        email: "owner@8grp.co.jp", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    }
  });
  const st = {
    calls: [], lag: {}, fail: new Set(),
    companies: [company("c1", "返信商事"), company("c2", "二番商事")],
    unread: 2,
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    st.calls.push(`${req.method()} ${p}${u.search}`);
    const lag = Object.entries(st.lag).find(([re]) => new RegExp(re).test(p))?.[1] || 0;
    if (lag) await wait(lag);
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) }).catch(() => {});
    if ([...st.fail].some((re) => new RegExp(re).test(p))) return send({ error: "db_query_failed" }, 500);
    if (p === "/api/me") return send(ME);
    if (p === "/api/public-config") return send({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" });
    if (p === "/api/notifications") return send({ notifications: [{ id: "n1", title: "お知らせ", created_at: new Date().toISOString() }], unread: st.unread });
    if (p === "/api/badges") return send({ badges: {} });
    if (p === "/api/sales/companies" && req.method() === "GET" && u.searchParams.get("view") === "dashboard") {
      return send({ today: TODAY, view: "dashboard", total: st.companies.length, sections: dashboardSections(st.companies, { today: TODAY }) });
    }
    if (p === "/api/sales/companies" && req.method() === "POST") return send({ company: company("c9", "新規商事") });
    if (p === "/api/sales/approaches") return send({ approaches: [] });
    if (p === "/api/hr/applicants") return send({ applicants: [{ id: "a1", name: "応募 花子", jobTitle: "エンジニア", rank: "A", stage: "applied", stageLabel: "応募", status: "todo", statusLabel: "未対応" }] });
    if (p === "/api/hr/interviews/today") return send({ interviews: [] });
    return send({});
  });
  return { ctx, page, st, errs };
}
const count = (st, re) => st.calls.filter((c) => re.test(c)).length;
const rowNames = (page) => page.locator("#list-replied .sl-row b").allInnerTexts();

console.log("\n=== Sales ダッシュボード：2回目は前回の内容をすぐ出し、裏で最新にする ===");
{
  const { ctx, page, st, errs } = await tab();
  await page.goto(`${BASE}/sales/`);
  await page.waitForSelector("#list-replied .sl-row");
  check((await rowNames(page)).join() === "返信商事,二番商事", "はじめて：取って描く");
  check(count(st, /view=dashboard/) === 1, "ダッシュボードは件数と上位だけを取る（view=dashboard）");
  check(count(st, /GET \/api\/sales\/companies$/) === 0, "企業の全件は取らない");
  check(count(st, /approaches\?days=14&limit=15/) === 1, "最近の営業履歴は15件だけ取る");

  // 2回目：API を遅くし、中身も変える（1社増える）
  st.lag = { "^/api/(me|sales/companies)$": 1500 };
  st.companies = [company("c1", "返信商事"), company("c2", "二番商事"), company("c3", "三番商事")];
  await page.goto(`${BASE}/sales/`, { waitUntil: "commit" });
  await page.waitForSelector("#list-replied .sl-row");
  // ページを開いた時点からの時刻（ブラウザの中で測る）。API は 1500ms かかる
  const shownAt = await page.evaluate(() => Math.round(performance.now()));
  const meDone = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => /\/api\/me$/.test(e.name) && e.responseEnd > 0));
  check(!meDone && shownAt < 1400, `/api/me も一覧も待たずに、前回の内容が出る（${shownAt}ms・/api/me はまだ）`);
  check((await rowNames(page)).join() === "返信商事,二番商事", "出ているのは前回の内容");
  check(await page.locator(".sl-bar").count() === 1, "Sales のヘッダーも、/api/me を待たずに出る");
  await page.waitForFunction(() => document.getElementById("kp-swr-chip")?.style.display === "block", null, { timeout: 1500 });
  check(/更新中/.test(await page.locator("#kp-swr-chip").innerText()), "画面の隅に小さく「更新中…」");
  // 変わらない行は作り直さない（同じ要素のまま）
  await page.evaluate(() => { window.__first = document.querySelector("#list-replied .sl-row"); });
  await page.waitForFunction(() => document.querySelectorAll("#list-replied .sl-row").length === 3, null, { timeout: 4000 });
  check((await rowNames(page)).join() === "返信商事,二番商事,三番商事", "裏で取った最新に描き直す");
  check(await page.evaluate(() => window.__first === document.querySelector("#list-replied .sl-row")), "変わらない行は、同じ要素のまま（全体を作り直さない）");
  await page.waitForFunction(() => document.getElementById("kp-swr-chip")?.style.display === "none", null, { timeout: 2000 });
  check(true, "最新になったら「更新中…」は消える");

  // 最新の取得に失敗：前回の内容は消さない
  st.lag = {};
  st.fail = new Set(["^/api/sales/companies$"]);
  await page.goto(`${BASE}/sales/`);
  await page.waitForSelector("#list-replied .sl-row");
  await page.waitForFunction(() => /取得できませんでした/.test(document.getElementById("kp-swr-chip")?.textContent || ""), null, { timeout: 3000 });
  check((await rowNames(page)).length === 3, "失敗しても、前回の内容は出したまま");
  check(/前回の内容を表示しています/.test(await page.locator("#kp-swr-chip").innerText()), "「最新情報を取得できませんでした」と小さく出す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n=== 更新のあとは、前回の内容を出さない ===");
{
  const { ctx, page, st } = await tab();
  await page.goto(`${BASE}/sales/`);
  await page.waitForSelector("#list-replied .sl-row");
  check(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith("kp_swr:"))), "画面データを sessionStorage に覚える");
  // 企業を追加（POST）
  await page.evaluate(() => API.createSalesCompany({ name: "新規商事", siteUrl: "https://new.example.jp/" }));
  check(await page.evaluate(() => !Object.keys(sessionStorage).some((k) => k.startsWith("kp_swr:sales"))), "POST のあと、覚えている画面データは捨てる");
  st.lag = { "^/api/sales/companies$": 800 };
  st.companies = [company("c1", "返信商事")];
  await page.goto(`${BASE}/sales/`, { waitUntil: "commit" });
  await page.waitForSelector(".sl-bar");
  await page.waitForTimeout(300);
  check(await page.locator("#list-replied .sl-row").count() === 0, "古い内容（2社）は出さず、取り直すのを待つ");
  await page.waitForSelector("#list-replied .sl-row");
  check((await rowNames(page)).join() === "返信商事", "取り直した内容を出す");
  await ctx.close();
}

console.log("\n=== ログアウトしたら、覚えている画面データを消す ===");
{
  const { ctx, page } = await tab();
  await page.goto(`${BASE}/hr/`);
  await page.waitForSelector(".hr-bar");
  await page.waitForFunction(() => Object.keys(sessionStorage).some((k) => k.startsWith("kp_swr:")));
  check(await page.evaluate(() => Boolean(localStorage.getItem("kp_me"))), "身元も覚えている");
  await page.evaluate(() => { sessionStorage.setItem("__loggedOut", "1"); });
  await page.click("#hr-user-btn");
  await page.click("#hr-user-menu button");
  await page.waitForURL(/index\.html/);
  const left = await page.evaluate(() => ({ swr: Object.keys(sessionStorage).filter((k) => k.startsWith("kp_swr:")).length,
    me: localStorage.getItem("kp_me"), layout: localStorage.getItem("kp_layout"), session: localStorage.getItem("kp_session") }));
  check(left.swr === 0, "画面データ（応募者など）は残らない");
  check(left.me === null && left.layout === null && left.session === null, "身元・メニューの枠・セッションも残らない");
  await ctx.close();
}

console.log("\n=== 通知・バッジは、毎画面すぐには取りにいかない ===");
{
  const { ctx, page, st } = await tab();
  await page.goto(`${BASE}/home.html`);
  await page.waitForSelector("#kp-bell-btn");
  await page.waitForFunction(() => !document.getElementById("kp-bell-badge")?.classList.contains("hidden"), null, { timeout: 4000 });
  check(count(st, /\/api\/notifications$/) === 1, "1画面目は取りにいく");
  await page.goto(`${BASE}/tasks.html`);
  await page.waitForSelector("#kp-bell-btn");
  await page.waitForTimeout(1500);
  check(count(st, /\/api\/notifications$/) === 1, "60秒以内に開いた次の画面では、通知を取りにいかない");
  check(await page.locator("#kp-bell-badge").innerText() === "2", "数字は前回のものをすぐ出す");
  check(count(st, /\/api\/badges$/) === 1, "バッジも、45秒以内は取りにいかない");
  st.unread = 5;
  await page.click("#kp-bell-btn");
  await page.waitForFunction(() => document.getElementById("kp-bell-badge")?.textContent === "5", null, { timeout: 3000 });
  check(count(st, /\/api\/notifications$/) === 2, "ベルを開いたときは、最新を取りにいく");
  await ctx.close();
}

console.log("\n=== 触れたリンクだけ、HTML を先読みする ===");
{
  const { ctx, page, st } = await tab();
  await page.goto(`${BASE}/home.html`);
  await page.waitForSelector(".kp-sidebar a[href]");
  const before = count(st, /./);
  await page.hover('.kp-sidebar a[href="tasks.html"]');
  await page.waitForTimeout(200);
  const pf = await page.evaluate(() => [...document.querySelectorAll('link[rel="prefetch"]')].map((l) => l.getAttribute("href")));
  check(pf.length === 1 && pf[0] === "/tasks.html", `左メニューのタスクに乗せたら、その HTML だけ先読み（${pf.join()}）`);
  await page.hover('.kp-sidebar a[href="tasks.html"]');
  check(await page.evaluate(() => document.querySelectorAll('link[rel="prefetch"]').length) === 1, "同じリンクは1回だけ");
  check(count(st, /./) === before, "API は先読みしない");
  await page.hover("#greet").catch(() => {});
  check(await page.evaluate(() => document.querySelectorAll('link[rel="prefetch"]').length) === 1, "本文の中に乗せても、先読みしない（ヘッダー・メニューだけ）");
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
