// マーケティングのダッシュボード P0（2026-10-25）を、実際のブラウザで確かめる。API はすべて偽（架空データ）。書き込みは無い。
//
// ■ 何を守りたいのか（仕様書 7. 受入テスト）
//   ・並べ方：ヘッダー（PRを作成・発信管理）→ 期間・事業 → 6つのKPI → サイト別の更新状況｜今週やること → 媒体別 → 記事別 → 詳細（折りたたみ）
//   ・1366px で、KPI とサイト別の更新状況・今週やることが最初の画面に入る。390／768／1440px で横にはみ出さない
//   ・未計測は「—」と「未計測」（0件と書かない）。未接続・権限なし・取得失敗・保留・記録なしを別々に出す
//   ・公開設定日を実反映日として出さない（「確認待ち」）。取得範囲が直近30日だけと出す
//   ・期間・事業は URL に残り、再読込・ほかの画面から戻っても消えない
//   ・KPI を押すと根拠（計測の接続状況・原本の一覧）を開く。開いただけでは何も書かない
//   ・確認用の注意書きは省略しない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const NOW = Date.now(), iso = (ms) => new Date(ms).toISOString(), day = (ms) => iso(ms).slice(0, 10);
const me = { email: "owner@example.com", appRole: "owner", isAdmin: false, roles: [],
  gw: { employee: { id: "e1", display_name: "架空 経営者", status: "active" }, roles: ["owner"], tenantId: "t1" },
  access: { recruit: true, sell: true, office: true, keiei: true, marketing: true } };
const src = (key, biz, label, state, extra = {}) => ({ key, biz, label, state, count: state === "ok" ? 1 : null, original: null, need: [], missing: [], ...extra });
const prodBody = (siteState = "ok", items = null) => ({ fetchedAt: iso(NOW), canManage: true, planReady: false, canLinkInquiries: false,
  sources: [src("site_news", "site", "自社サイトのお知らせ・コラム", siteState, { fetchedAt: iso(NOW) }), src("plan", null, "制作予定", "not_ready"),
    src("mugen_contents", "mugen", "コラム・SNS文案・YouTube動画", "not_connected")],
  items: items ?? [{ key: "site_news:n1", origin: "site_news", id: "n1", biz: "site", medium: "column", title: "架空のお知らせ", state: { key: "published", label: "公開済み" },
    publishedOn: day(NOW - 2 * 86400000), owner: null, due: null, publicUrl: "https://8grp.co.jp/news/x" }] });
const workBody = { fetchedAt: iso(NOW), readsReady: false, unreadCount: null, newCount: 0, openCount: 0,
  sources: [src("hr_lead", "mugen", "無料カウンセリング", "ok", { fetchedAt: iso(NOW) }), src("space_inquiry", "space", "問い合わせ・予約", "forbidden"),
    src("site_contact", "site", "会社HPのお問い合わせ", "forbidden"), src("ec_contact", "ec", "問い合わせ", "on_hold"), src("ec_order", "ec", "注文・発送確認", "on_hold")],
  items: [] };

async function open(width, height, { prod = prodBody(), prodStatus = 200, path = "/marketing/" } = {}) {
  const ctx = await br.newContext({ viewport: { width, height }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@example.com" })));
  const calls = [];
  await ctx.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    calls.push({ method: r.request().method(), path: u.pathname + u.search });
    const send = (b, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(u.pathname)) return send(me);
    if (/\/api\/marketing/.test(u.pathname) && u.searchParams.get("view") === "production") return prodStatus === 200 ? send(prod) : send({ error: "x" }, prodStatus);
    if (/\/api\/marketing/.test(u.pathname)) return send(workBody);
    if (/notifications/.test(u.pathname)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await ctx.route(/^https:\/\/fonts\./, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector("#marketing-omnichannel .om-kpi");
  await page.waitForSelector('#marketing-site-status .mk-site-row[data-site="site"] .om-badge');
  await page.waitForTimeout(300);
  // アイコンの字（オフラインでは文字のまま出る）は幅だけそろえる（本番は Material Symbols の字形）
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:18px;height:18px;display:inline-block}" });
  return { ctx, page, calls, errs };
}
// 共通の枠（端末の合図 /api/devices/me など）は数えない。この画面が使う API（マーケティング）の書き込みだけ
const writes = (calls) => calls.filter((c) => c.method !== "GET" && /^\/api\/marketing\b/.test(c.path));
const box = (page, sel) => page.locator(sel).first().evaluate((n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

console.log("— 1366×768：最初の画面に KPI・サイト別の更新状況・今週やること —");
{
  const { ctx, page, calls, errs } = await open(1366, 768);
  check(await page.title() !== "", "画面が開く");
  check((await page.locator("#mk-preview-note").innerText()).includes("閲覧のみで確認"), "確認用ブランチの注意書きがある（省略しない）");
  const acts = await page.locator(".mk-head-acts a").evaluateAll((ns) => ns.map((n) => [n.textContent.trim(), n.className, n.getAttribute("href")]));
  check(acts.length === 2 && acts[0][0] === "PRを作成" && !/\bsec\b/.test(acts[0][1]) && acts[1][0] === "発信管理" && /\bsec\b/.test(acts[1][1]),
    `ヘッダーの右に主操作「PRを作成」（青）と副操作「発信管理」（${JSON.stringify(acts)}）`);
  check(await page.getByText("PRから発信を始める").count() === 0 && await page.getByText("PRリリースを作成・展開する").count() === 0, "重複した主操作は無い");
  const kpis = await page.locator("#marketing-omnichannel .om-kpi").evaluateAll((ns) => ns.map((n) => {
    const r = n.getBoundingClientRect(); return { t: n.querySelector(".om-kpi-title").textContent, v: n.querySelector(".om-kpi-value").textContent, s: n.textContent, top: Math.round(r.top), bottom: r.bottom };
  }));
  check(kpis.map((k) => k.t).join("|") === "発信数|Web PV|SNS流入|メールクリック|有効問い合わせ|商談・成約", `6つのKPI（${kpis.map((k) => k.t).join("|")}）`);
  check(kpis.every((k) => k.v === "—" && k.s.includes("未計測") && !/\d+件/.test(k.s)), "未計測は「—」と「未計測」。0件・件数で出さない");
  check(new Set(kpis.map((k) => k.top)).size === 1, "PC では6つが1段に並ぶ");
  check(kpis.every((k) => k.bottom <= 768), "KPI は最初の画面に入る");
  const site = await box(page, "#marketing-site-status"), tasks = await box(page, "#marketing-tasks"), kpiBox = await box(page, "#marketing-omnichannel .om-kpis");
  check(kpiBox.bottom <= site.top, "KPI はサイト別の更新状況より先（上）");
  check(Math.abs(site.top - tasks.top) < 2 && tasks.left > site.left, "サイト別の更新状況（左）と今週やること（右）が横に並ぶ");
  check(site.top < 768 && tasks.top < 768, `サイト別の更新状況・今週やることの上部が最初の画面に入る（上端 ${Math.round(site.top)}px）`);
  const order = await page.evaluate(() => ["marketing-omnichannel", "marketing-site-status", "marketing-channels", "marketing-articles", "mk-details"]
    .map((id) => document.getElementById(id).getBoundingClientRect().top));
  check(order.every((y, i) => i === 0 || y > order[i - 1]), "上から KPI → サイト別 → 媒体別 → 記事別 → 詳細");
  check(!(await page.locator("#mk-details").evaluate((d) => d.open)), "詳細（制作予定・問い合わせ・接続状態・原本グラフ）は初めは折りたたみ");
  const rows = await page.locator("#marketing-site-status .mk-site-row").evaluateAll((ns) => ns.map((n) => [n.dataset.site, n.querySelector(".om-badge").textContent, n.querySelector(".mk-site-date").textContent]));
  check(JSON.stringify(rows.map((r) => r[0])) === JSON.stringify(["site", "mugen", "space", "machi", "ec"]), "サイトは1行ずつ（コーポレート・無限道場・EIGHT SPACE・AIまち・8EC）");
  check(rows[0][1] === "確認待ち" && /^公開設定 \d{4}\/\d{2}\/\d{2}$/.test(rows[0][2]), `公開設定日は「確認待ち」（実反映とは扱わない）（${rows[0].join(" ")}）`);
  check(rows.slice(1, 4).every((r) => r[1] === "未接続") && rows[4][1] === "保留", "未接続と保留を分けて出す");
  await page.locator('#marketing-site-status .mk-site-row[data-site="site"] summary').click();
  check((await page.locator('#marketing-site-status .mk-site-row[data-site="site"] .mk-site-note').innerText()).includes("直近30日の記録"), "行を開くと、取得範囲（直近30日）と実反映未照合を出す");
  check((await page.locator("#marketing-tasks .om-tasks li").count()) === 3 && (await page.locator("#marketing-tasks").innerText()).includes("設定に必要なこと"), "今週やることは3件（設定に必要なこと。件数を作らない）");
  check((await page.locator("#marketing-articles").innerText()).includes("未計測") && await page.locator("#marketing-articles canvas, #marketing-articles svg").count() === 0, "記事別は「未計測」（空のグラフを出さない）");
  check(await overflow(page) <= 0, "横にはみ出さない");
  await page.screenshot({ path: shotPath("marketing-dashboard-p0-1366.png") });
  check(writes(calls).length === 0 && errs.length === 0, `開いただけでは何も書かない・画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n— 期間・事業は URL に残り、再読込・戻るで消えない／KPI から根拠を開く —");
{
  const { ctx, page, calls, errs } = await open(1440, 900);
  await page.selectOption('#marketing-omnichannel select[aria-label="集計期間"]', "90");
  await page.selectOption('#marketing-omnichannel select[aria-label="事業"]', "space");
  const u = new URL(page.url());
  check(u.searchParams.get("days") === "90" && u.searchParams.get("biz") === "space" && !u.searchParams.has("tab"), `URL に期間・事業が残る（${u.search}）`);
  check(await page.locator('#marketing-omnichannel select[aria-label="事業"] option[value="ec"]').evaluate((o) => o.disabled), "EC は保留中で選べない");
  await page.reload();
  await page.waitForSelector("#marketing-omnichannel .om-kpi");
  check(await page.locator('#marketing-omnichannel select[aria-label="集計期間"]').inputValue() === "90"
    && await page.locator('#marketing-omnichannel select[aria-label="事業"]').inputValue() === "space", "再読込しても期間・事業はそのまま");
  check(!(await page.locator("#mk-details").evaluate((d) => d.open)), "期間・事業だけでは詳細を開かない");
  // KPI：Web PV → 計測の接続状況、有効問い合わせ → 問い合わせの一覧（事業の絞り込みを引き継ぐ）
  await page.locator('#marketing-omnichannel .om-kpi[data-kpi="pageviews"]').click();
  check(await page.locator("#mk-details").evaluate((d) => d.open) && await page.locator("#om-connections").evaluate((d) => d.open), "Web PV を押すと、計測の接続状況を開く");
  await page.locator('#marketing-omnichannel .om-kpi[data-kpi="inquiries"]').click();
  await page.waitForTimeout(300);
  const u2 = new URL(page.url());
  check(await page.locator("#mk-worklist").evaluate((d) => d.open) && await page.locator("#tab-work").getAttribute("aria-selected") === "true"
    && u2.searchParams.get("tab") === "work" && u2.searchParams.get("biz") === "space", `有効問い合わせを押すと、問い合わせの一覧を同じ事業で開く（${u2.search}）`);
  check(await page.locator('#bizChips button[data-biz="space"]').getAttribute("aria-pressed") === "true", "一覧の事業の絞り込みもそろう");
  // ほかの画面（発信管理）へ行って戻る
  await page.locator(".mk-head-acts a", { hasText: "発信管理" }).click();
  await page.waitForURL(/publishing\.html/);
  await page.goBack();
  await page.waitForSelector("#marketing-omnichannel .om-kpi");
  const u3 = new URL(page.url());
  check(u3.searchParams.get("days") === "90" && u3.searchParams.get("biz") === "space"
    && await page.locator('#marketing-omnichannel select[aria-label="事業"]').inputValue() === "space", `ほかの画面から戻っても期間・事業は消えない（${u3.search}）`);
  check(writes(calls).length === 0, "絞り込み・KPI・行き来では何も書かない");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n— 取得できなかったとき・権限なし・記録なし：別々に出す（0件にしない） —");
for (const [label, opt, want] of [
  ["取得失敗", { prodStatus: 500 }, "取得失敗"],
  ["権限なし", { prod: prodBody("forbidden", []) }, "権限なし"],
  ["記録なし", { prod: prodBody("ok", []) }, "取得済み"],
]) {
  const { ctx, page } = await open(1280, 900, opt);
  await page.waitForFunction(() => document.querySelector('#marketing-site-status .mk-site-row[data-site="site"] .om-badge')?.textContent !== "取得中");
  const b = await page.locator('#marketing-site-status .mk-site-row[data-site="site"] .om-badge').innerText();
  const d = await page.locator('#marketing-site-status .mk-site-row[data-site="site"] .mk-site-date').innerText();
  check(b === want && !/0件/.test(d) && (label !== "記録なし" || d === "直近30日：公開記録なし"), `${label}：コーポレートは「${b}」${d !== "—" ? `・${d}` : ""}`);
  await ctx.close();
}

console.log("\n— 幅ごとに：横にはみ出さない・KPI の列 —");
for (const [w, h, cols] of [[1440, 900, 6], [1024, 768, 3], [768, 1024, 3], [390, 844, 2]]) {
  const { ctx, page } = await open(w, h);
  const tops = await page.locator("#marketing-omnichannel .om-kpi").evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().top)));
  const perRow = tops.filter((t) => t === tops[0]).length;
  check(perRow === cols, `${w}px：KPI は1段に ${cols} つ（いま ${perRow}）`);
  check(await overflow(page) <= 0, `${w}px：横にはみ出さない`);
  const clipped = await page.evaluate(() => [...document.querySelectorAll(".om-kpi, .mk-site-row summary, .om-tasks li, .mk-head-acts a")]
    .filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow === "visible").length);
  check(clipped === 0, `${w}px：文字が枠からはみ出さない`);
  if (w === 390 || w === 768 || w === 1440) await page.screenshot({ path: shotPath(`marketing-dashboard-p0-${w}.png`), fullPage: true });
  await ctx.close();
}

await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\nマーケティングのダッシュボード（P0）：すべて通過");
