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
    calls: [], reqs: [], lag: {}, fail: new Set(),
    companies: [company("c1", "返信商事"), company("c2", "二番商事")],
    unread: 2,
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    st.calls.push(`${req.method()} ${p}${u.search}`);
    // 何を呼んだか（path）と、どのページから呼んだか（referer）。「先読みで別の画面の API が動いていないか」を見るために残す
    st.reqs.push({ method: req.method(), path: p, from: new URL(req.headers().referer || "http://x/", "http://x/").pathname });
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

  // 2回目：API を遅くし、中身も変える（1社増える）。
  // 遅らせる長さは、実行する機械が遅くても「前回の内容が出る」より先に API が返ってしまわない長さにする。
  // 守りたいのは「API の返事を待たずに、前回の内容が出る」という順序で、何ミリ秒以内、という速さではない
  const LAG = 5000;
  st.lag = { "^/api/(me|sales/companies)$": LAG };
  st.companies = [company("c1", "返信商事"), company("c2", "二番商事"), company("c3", "三番商事")];
  await page.goto(`${BASE}/sales/`, { waitUntil: "commit" });
  await page.waitForSelector("#list-replied .sl-row");
  // ページを開いた時点からの時刻（ブラウザの中で測る）。表示した時点で、/api/me はまだ返っていないこと（＝返事を待っていない）
  const shownAt = await page.evaluate(() => Math.round(performance.now()));
  const meDone = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => /\/api\/me$/.test(e.name) && e.responseEnd > 0));
  check(!meDone, `/api/me も一覧も待たずに、前回の内容が出る（${shownAt}ms で表示。そのとき /api/me はまだ返っていない）`);
  check((await rowNames(page)).join() === "返信商事,二番商事", "出ているのは前回の内容");
  check(await page.locator(".sl-bar").count() === 1, "Sales のヘッダーも、/api/me を待たずに出る");
  await page.waitForFunction(() => document.getElementById("kp-swr-chip")?.style.display === "block", null, { timeout: LAG });
  check(/更新中/.test(await page.locator("#kp-swr-chip").innerText()), "画面の隅に小さく「更新中…」");
  // 変わらない行は作り直さない（同じ要素のまま）
  await page.evaluate(() => { window.__first = document.querySelector("#list-replied .sl-row"); });
  await page.waitForFunction(() => document.querySelectorAll("#list-replied .sl-row").length === 3, null, { timeout: LAG + 10000 });
  check((await rowNames(page)).join() === "返信商事,二番商事,三番商事", "裏で取った最新に描き直す");
  check(await page.evaluate(() => window.__first === document.querySelector("#list-replied .sl-row")), "変わらない行は、同じ要素のまま（全体を作り直さない）");
  await page.waitForFunction(() => document.getElementById("kp-swr-chip")?.style.display === "none", null, { timeout: 10000 });
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
  // 画面に現れた企業名を、全部記録しておく（途中で一瞬でも古い内容が出たら、あとから読み取っても見逃さない）。
  // 「何ミリ秒後に0行」という時間の見方だと、遅い機械では、取り直した正しい内容がもう出ていて落ちる
  await page.addInitScript(() => {
    window.__seen = [];
    const rec = () => document.querySelectorAll("#list-replied .sl-row b").forEach((b) => { if (!window.__seen.includes(b.textContent)) window.__seen.push(b.textContent); });
    new MutationObserver(rec).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`${BASE}/sales/`, { waitUntil: "commit" });
  await page.waitForSelector("#list-replied .sl-row");
  check((await rowNames(page)).join() === "返信商事", "取り直した内容を出す");
  const seen = await page.evaluate(() => window.__seen);
  check(seen.join() === "返信商事", `古い内容（2社）は一度も出さず、取り直した内容だけを出す（画面に現れた企業：${seen.join("・")}）`);
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
  // 先読みの対象（タスク画面 tasks.html）の本体の API。ホーム自身も、同じ API を（数回に分けて）呼ぶ（自分の画面のために）。
  // 通知・バッジなどの共通の裏の通信（/api/notifications・/api/badges）は、この画面の本体ではないので、数えない。
  // 見たいのは「リンクに触れたことで、タスク画面の API が動いていないか」だけ
  const BACKGROUND = /^\/api\/(notifications|badges)$/;
  const TASKS_API = /^\/api\/tasks(\/|$)/;
  const taskCalls = () => st.reqs.filter((r) => !BACKGROUND.test(r.path) && TASKS_API.test(r.path));
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await wait(50); return fn(); };
  // 数が落ち着くまで待つ：決まった秒数ではなく、「タスク API の数が、しばらく変わらない」ことを見て決める。
  // ホーム自身が、自分の画面のために同じ API を数回に分けて呼ぶので、1回届いた時点を基準にすると、あとから届いた分を
  // 「触れたせいで増えた」と取り違える（以前の揺れの原因）。最大でも max ミリ秒で打ち切る（落ち着かなければ、そのまま数える）
  const settle = async ({ quiet = 800, max = 10000 } = {}) => {
    const t0 = Date.now();
    let last = taskCalls().length, since = Date.now();
    while (Date.now() - t0 < max) {
      const n = taskCalls().length;
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= quiet) break;
      await wait(50);
    }
    return taskCalls().length;
  };

  await page.goto(`${BASE}/home.html`);
  await page.waitForSelector(".kp-sidebar a[href]");
  // ホーム自身のタスク取得が終わるのを、決まった秒数ではなく「届いたこと・数が落ち着いたこと」で待つ。
  // これ以降に増えた分だけが、触れたことの影響
  check(await until(() => taskCalls().length >= 1), "ホームは、自分の画面のためにタスクを取る（基準にする）");
  await page.waitForLoadState("networkidle");
  const base = await settle();
  const mark = st.reqs.length;                       // ここより後の通信だけを見る

  await page.hover('.kp-sidebar a[href="tasks.html"]');
  // 先読みの印（<link rel="prefetch">）が付くのを、条件で待つ
  await page.waitForSelector('link[rel="prefetch"]', { state: "attached", timeout: 5000 }).catch(() => {});
  const pf = await page.evaluate(() => [...document.querySelectorAll('link[rel="prefetch"]')].map((l) => l.getAttribute("href")));
  check(pf.length === 1 && pf[0] === "/tasks.html", `左メニューのタスクに乗せたら、その HTML だけ先読み（${pf.join()}）`);
  await page.hover('.kp-sidebar a[href="tasks.html"]');
  check(await page.evaluate(() => document.querySelectorAll('link[rel="prefetch"]').length) === 1, "同じリンクは1回だけ");
  await page.waitForLoadState("networkidle");
  await settle();                                    // 先読みが API を動かすなら、ここまでに届く

  // 「API は先読みしない」：触れたあとに、タスク画面の API が増えていないこと。タスク画面のページから出た通信も無いこと。
  // 通知・バッジなどの裏の通信が、たまたま同じ時間に届いても、ここには入らない
  const after = st.reqs.slice(mark);
  check(taskCalls().length === base, `API は先読みしない（タスクの API：触れる前 ${base}回 → 触れたあと ${taskCalls().length}回）`);
  check(!after.some((r) => r.from === "/tasks.html"), "タスク画面のページから出た通信は無い（先読みは HTML だけで、その画面の中身は動かさない）");

  await page.hover("#greet").catch(() => {});
  check(await page.evaluate(() => document.querySelectorAll('link[rel="prefetch"]').length) === 1, "本文の中に乗せても、先読みしない（ヘッダー・メニューだけ）");

  // 見張りが空振りでないこと：タスク画面を実際に開けば、そのページ発のタスク API が記録される
  await page.goto(`${BASE}/tasks.html`);
  check(await until(() => st.reqs.some((r) => r.from === "/tasks.html" && TASKS_API.test(r.path))), "（確認）タスク画面を開くと、そのページ発のタスク API が記録される＝見張りは働いている");
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
