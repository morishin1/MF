// 画面の表示速度を、手元のブラウザで測る（CI では回さない。改善の前後を比べるための道具）。
//
//   node scripts/perf/measure.mjs [--lag 300] [--base http://127.0.0.1:8713] [--json out.json]
//
// ■ 何を測るか（1画面あたり、はじめて開いたとき／同じタブで2回目に開いたとき）
//   html   … HTML を読み終わった（DOMContentLoaded）
//   init   … 枠（KPLayout / HRLayout / SalesLayout / OfficeLayout / KeieiLayout の init）が返った
//   me     … /api/me の応答が届いた
//   config … /api/public-config の応答が届いた（呼ばなかったときは「—」）
//   main   … その画面の主要APIの応答が届いた（いちばん遅いもの）
//   first  … 最初の有用な描画（その画面の本文が「読み込み中…」でなくなった）
//   apis   … 本文が出るまでに出た /api/* の本数
//
// ■ 3つの開き方
//   初回          … 何も覚えていない（ログイン直後に、いきなりその画面を開いた）
//   初回(ホーム後) … ホームを開いたあと、はじめてその画面を開いた（ふだんの入り方。身元は覚えている）
//   2回目         … 同じタブで、もう一度その画面を開いた
//
// ■ API はすべて代役（本番の DB には触らない）
//   1本あたり --lag ミリ秒（既定 300ms）わざと待たせて返す。Vercel の関数＋Supabase の往復の目安。
//   中身は、画面テストと同じく実物の lib/*.js で組み立てる（画面が壊れずに描ける形）。
//   手元の HTML・JS の読み込みは一瞬なので、本番より「html」は速く出る。比べるのは前後の差。
//
// ■ 本番で測るときは
//   どの画面でも URL に ?perf=1 を付けて開くと、ブラウザのコンソールに同じ項目が出る（js/api-client.js の KPPerf）。
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../../test/_browser.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const LAG = Number(arg("lag", 300));
const OUT = arg("json", null);
const ROUNDS = Number(arg("rounds", 3));

// ---- 静的ファイル（vercel.json の rewrites のうち、測る画面に要るものだけ） ----
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
let BASE = arg("base", null);
let server = null;
if (!BASE) {
  server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    try {
      const body = await readFile(join(ROOT, p));
      res.writeHead(200, { "Content-Type": TYPES[extname(p)] || "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${server.address().port}`;
}

// ---- API の代役（実物の lib/*.js で組み立てる） ----
const O = await import(join(ROOT, "lib/office.js"));
const { hubBusy } = await import(join(ROOT, "test/fixtures/keiei-hub.mjs"));
// 改善前の版（lib/sales-dashboard.js が無い）でも動くように、この道具の場所から読む
const { dashboardSections } = await import(new URL("../../lib/sales-dashboard.js", import.meta.url).href)
  .catch(() => ({ dashboardSections: () => ({}) }));
const jst = (d = 0) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const TODAY = jst();

const ME = {
  email: "owner@8grp.co.jp", appRole: "owner", isAdmin: true,
  access: { recruit: true, sell: true, office: true, keiei: true },
  gw: { employee: { id: "emp-1", display_name: "森田 経営", status: "active" }, roles: ["owner"], isAdmin: true,
    tenantId: "t1", stage: null, available: true },
};

const SALES_STATUS = ["untouched", "attacked", "clicked", "replied", "meeting", "proposal", "reattack_wait"];
const companies = Array.from({ length: 800 }, (_, i) => {
  const st = SALES_STATUS[i % SALES_STATUS.length];
  return { id: `c${i}`, name: `株式会社サンプル${i}`, status: st, statusLabel: st, service: "AI / DX", industry: "製造",
    nextDue: i % 3 ? jst(i % 5 - 2) : null, overdue: i % 7 === 0, next: "フォローする", ownerName: "営業 一郎",
    unhandledClick: i % 37 === 0, clickCount: i % 4, lastClickAt: i % 4 ? new Date().toISOString() : null,
    lastSentAt: i % 2 ? new Date(Date.now() - (i % 60) * 86400000).toISOString() : null, lastService: "AI / DX" };
});
const approaches = Array.from({ length: 120 }, (_, i) => ({ id: `a${i}`, companyId: `c${i}`, companyName: `株式会社サンプル${i}`,
  sentAt: new Date(Date.now() - i * 3600000).toISOString(), service: "AI / DX", employeeName: "営業 一郎", clickCount: i % 3 }));

const STAGES = ["applied", "casual_interview", "first_interview", "ceo_recommend", "offer"];
const applicants = Array.from({ length: 150 }, (_, i) => ({ id: `ap${i}`, name: `応募者 ${i}`, jobTitle: "エンジニア",
  rank: ["A", "B", "C"][i % 3], stage: STAGES[i % STAGES.length], stageLabel: STAGES[i % STAGES.length], status: "todo",
  nextAction: "面談を設定する", nextActionCta: i % 2 ? "面談設定" : null, recruiterName: "人事 花子", createdAt: new Date().toISOString(),
  appliedOn: jst(-i), source: "Wantedly" }));

const officeRows = Array.from({ length: 60 }, (_, i) => O.deriveRow({
  siteContractId: `s${i}`, progressId: null, employeeId: `e${i}`, employeeName: `要員 ${i}`, department: null, employeeKind: "proper",
  partnerName: null, engagementKind: "pp", siteCompany: `顧客${i}社`, primeCompany: null, periodFrom: "2026-04-01", periodTo: null,
  renewalStatus: "confirmed", submissions: [],
  marks: { timesheet_received: i % 2 === 0, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
}, { today: TODAY, deadline: O.timesheetDeadline(TODAY.slice(0, 7)) }));
const office = (month) => ({ month, today: TODAY, deadline: O.timesheetDeadline(month), rows: O.sortRows(officeRows),
  summary: O.summarize(officeRows), stages: O.STAGES, filters: O.FILTERS });

function mock(path, sp) {
  if (path === "/api/me") return ME;
  if (path === "/api/public-config") return { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" };
  if (path === "/api/notifications") return { notifications: [], unread: 0 };
  if (path === "/api/badges") return { badges: { tasks: 2 } };
  if (path === "/api/dashboard") return { date: TODAY, top: { id: "t1", title: "A社の見積を出す" }, actions: [], submittedToday: true };
  if (path === "/api/nippo") return { today: null, recent: [] };
  if (path === "/api/schedule") return { events: [] };
  if (path === "/api/tasks") return { tasks: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `タスク${i}`, status: "todo" })) };
  if (path === "/api/requests") return { requests: [] };
  if (path === "/api/notices") return { notices: [{ id: "n1", title: "お知らせ", body: "本文", category: "general", created_at: new Date().toISOString() }], unread: 1 };
  if (path === "/api/hr/applicants") return { applicants, members: [] };
  if (path === "/api/hr/interviews/today") return { interviews: [] };
  // 本物と同じ：view=dashboard は4段の件数と上位だけ（lib/sales-dashboard.js）。改善前の版は呼ばない
  if (path === "/api/sales/companies" && sp.get("view") === "dashboard") {
    return { today: TODAY, view: "dashboard", total: companies.length, sections: dashboardSections(companies, { today: TODAY }) };
  }
  if (path === "/api/sales/companies") return { companies, today: TODAY };
  if (path === "/api/sales/approaches") return { approaches: sp.get("limit") ? approaches.slice(0, Number(sp.get("limit"))) : approaches };
  if (path === "/api/office") return office(sp.get("month") || TODAY.slice(0, 7));
  if (path === "/api/keiei") return hubBusy();
  return {};
}

// ---- 画面ごとの「本文が出た」 ----
const PAGES = [
  { key: "home",   label: "ホーム",          url: "/home.html",
    ready: "document.querySelector('#tiles .kp-tile')", main: [/\/api\/(dashboard|tasks|nippo|schedule|requests)\b/] },
  { key: "hr",     label: "HRダッシュボード", url: "/hr/",
    ready: "document.querySelector('#good .hr-good-card, #good .hr-empty')", main: [/\/api\/hr\/applicants\b/, /\/api\/hr\/dashboard\b/] },
  { key: "sales",  label: "Salesダッシュボード", url: "/sales/",
    ready: "document.querySelector('#sum a')", main: [/\/api\/sales\/(companies|approaches|dashboard)\b/] },
  { key: "office", label: "Office月次業務", url: "/office/monthly.html",
    ready: "document.querySelector('#rows tr[data-id]')", main: [/\/api\/office(\?|$)/] },
  { key: "keiei",  label: "経営ダッシュボード", url: "/keiei/",
    ready: "(() => { const m = document.querySelector('#kei-main'); return m && m.textContent.trim() && !/読み込み中/.test(m.textContent); })()",
    main: [/\/api\/keiei(\?|$)/] },
];

const INIT = (ready) => {
  // 枠の init が返った時刻
  window.__kp = { init: null, first: null };
  for (const name of ["KPLayout", "HRLayout", "SalesLayout", "OfficeLayout", "KeieiLayout"]) {
    let v;
    Object.defineProperty(window, name, {
      configurable: true,
      get() { return v; },
      set(x) {
        if (x && typeof x.init === "function" && !x.__wrapped) {
          const orig = x.init;
          x.init = async function (...a) {
            const r = await orig.apply(this, a);
            if (window.__kp.init === null) window.__kp.init = performance.now();
            return r;
          };
          x.__wrapped = true;
        }
        v = x;
      },
    });
  }
  // 本文が出た時刻（毎フレーム確かめる）
  const tick = () => {
    let ok = false;
    try { ok = Boolean(eval(ready)); } catch { /* まだ */ }
    if (ok) { window.__kp.first = performance.now(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function visit(page, pg, calls) {
  calls.length = 0;
  await page.goto(`${BASE}${pg.url}`);
  await page.waitForFunction(() => window.__kp && window.__kp.first !== null, null, { timeout: 15000 });
  await page.waitForTimeout(LAG * 3);   // 裏の確認が終わるのを待つ（次の回に持ち越さない）
  return page.evaluate(({ mainSrc }) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource").filter((e) => /\/api\//.test(e.name));
    const done = (re) => {
      const hit = res.filter((e) => re.test(new URL(e.name).pathname + new URL(e.name).search));
      return hit.length ? Math.round(Math.max(...hit.map((e) => e.responseEnd))) : null;
    };
    const mains = mainSrc.map((s) => new RegExp(s));
    const mainHits = res.filter((e) => mains.some((re) => re.test(new URL(e.name).pathname + new URL(e.name).search)));
    const first = window.__kp.first;
    return {
      html: Math.round(nav.domContentLoadedEventEnd),
      init: window.__kp.init === null ? null : Math.round(window.__kp.init),
      me: done(/^\/api\/me$/),
      config: done(/^\/api\/public-config$/),
      main: mainHits.length ? Math.round(Math.max(...mainHits.map((e) => e.responseEnd))) : null,
      mainBytes: mainHits.reduce((a, e) => a + (e.decodedBodySize || 0), 0),
      first: Math.round(first),
      apis: res.filter((e) => e.startTime < first).length,
    };
  }, { mainSrc: pg.main.map((r) => r.source) });
}

const br = await launch();
const results = [];
// 外のフォント（Google Fonts）は、回線しだいで毎回大きくぶれるので、空で返す（前後の比較を、手元の差だけにする）
const noFonts = (page) => page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
for (const pg of PAGES) {
  const rows = { first: [], viaHome: [], second: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      if (!localStorage.getItem("kp_session")) {
        localStorage.setItem("kp_session", JSON.stringify({
          access_token: "h.eyJzdWIiOiJ1c2VyLTEifQ.s", email: "owner@8grp.co.jp", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      }
    });
    await page.addInitScript(INIT, pg.ready);
    await noFonts(page);
    const calls = [];
    await page.route("**/api/**", async (route) => {
      const u = new URL(route.request().url());
      calls.push(u.pathname);
      await new Promise((r) => setTimeout(r, LAG));
      const body = route.request().method() === "GET" ? mock(u.pathname, u.searchParams) : { ok: true };
      if (body === null) return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    rows.first.push(await visit(page, pg, calls));
    rows.second.push(await visit(page, pg, calls));
    await ctx.close();
    // ホームを開いたあとの初回
    if (pg.key !== "home") {
      const ctx2 = await br.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
      const p2 = await ctx2.newPage();
      await p2.addInitScript(() => {
        if (!localStorage.getItem("kp_session")) {
          localStorage.setItem("kp_session", JSON.stringify({
            access_token: "h.eyJzdWIiOiJ1c2VyLTEifQ.s", email: "owner@8grp.co.jp", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
        }
      });
      const home = PAGES[0];
      await p2.addInitScript(INIT, `location.pathname === "/home.html" ? ${home.ready} : ${pg.ready}`);
      await noFonts(p2);
      await p2.route("**/api/**", async (route) => {
        const u = new URL(route.request().url());
        await new Promise((r) => setTimeout(r, LAG));
        const body = route.request().method() === "GET" ? mock(u.pathname, u.searchParams) : { ok: true };
        if (body === null) return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });
      await visit(p2, home, []);
      rows.viaHome.push(await visit(p2, pg, []));
      await ctx2.close();
    }
  }
  // 中央値
  const med = (list, k) => {
    const v = list.map((r) => r[k]).filter((x) => x !== null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const sum = (list) => Object.fromEntries(Object.keys(list[0]).map((k) => [k, med(list, k)]));
  results.push({ key: pg.key, label: pg.label, first: sum(rows.first), viaHome: rows.viaHome.length ? sum(rows.viaHome) : null,
    second: sum(rows.second) });
}
await br.close();
if (server) server.close();

const f = (v) => (v === null || v === undefined ? "—" : String(v));
console.log(`\nAPI 1本 ${LAG}ms・各${ROUNDS}回の中央値（ms。ページを開いた時点から）\n`);
console.log("| 画面 | 回 | HTML | 枠(init) | /api/me | config | 主要API | 主要APIサイズ | 本文が出た | 本文までのAPI本数 |");
console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of results) {
  for (const [k, lb] of [["first", "初回"], ["viaHome", "初回(ホーム後)"], ["second", "2回目"]]) {
    const x = r[k];
    if (!x) continue;
    console.log(`| ${r.label} | ${lb} | ${f(x.html)} | ${f(x.init)} | ${f(x.me)} | ${f(x.config)} | ${f(x.main)} | ${(x.mainBytes / 1024).toFixed(1)}KB | **${f(x.first)}** | ${f(x.apis)} |`);
  }
}
if (OUT) await writeFile(OUT, JSON.stringify({ lag: LAG, rounds: ROUNDS, results }, null, 2));
