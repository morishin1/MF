// 日報・勤怠（admin-nippo.html）の最上部「今週の提出・勤怠」と、画面の並び（2026-10-06 経営の人・組織の仕上げ）。
//
// ■ 何を守るテストか
//   1. 経営の「人・組織」を押すと日報・勤怠が開く。2段目は 日報・勤怠／チーム状況／全員のタスク／入社準備／給与管理／概要
//   2. 並び：今週の提出・勤怠 → 今日の要フォロー → 今日の日報 → 溜まっていること → 分析・履歴（たたむ）
//      今ある機能（要フォロー・溜まっていること・提出率・未提出・一覧・提出された日報・直近の傾向・週次評価・月次）を消していない
//   3. KPI 4つ（日報提出率・日報未提出・勤怠要確認・要フォロー人数）と、メンバー別の週の表（月〜日・日報・勤怠・要対応）
//   4. セルは色だけに頼らない（印＋説明 title／読み上げ）。今日の列は背景を変える
//   5. [← 前週] [今週] [次週 →] で週を移る（今週のときは「今週」を押せない）
//   6. 390px は横の表ではなくメンバーごとのカード。1280・768・390 で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";
import { weekBody } from "../fixtures/nippo-week.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(width = 1280) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date("2026-10-07T03:00:00Z"));   // 日本時間 2026-10-07（水）12:00
  const errs = [];
  const asked = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" })); localStorage.removeItem("kp_layout"); });
  await page.route("**/api/**", (r) => {
    const u = r.request().url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(u)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: true, roles: ["owner"],
        gw: { employee: { id: "e1", display_name: "森田 経営", status: "active" }, roles: ["owner"], tenantId: "t1", isAdmin: true, stage: null },
        access: accessOf({ isAdmin: true, roles: ["owner"] }) });
    }
    if (/view=week/.test(u)) { const d = new URL(u).searchParams.get("date"); asked.push(d); return send(weekBody(d)); }
    if (/\/api\/nippo\/admin/.test(u)) {
      return send({ date: "2026-10-07", nippos: [], members: [], replies: [], evals: [], aiEval: { criteria: [] },
        followUps: [{ userId: "u2", name: "佐藤 花子", reasons: [{ kind: "not_submitted", label: "日報未提出2日", detail: "10/5・10/6 の日報がありません" }] }],
        blockers: [], trend: [], notSubmitted: ["佐藤 花子"], weekStart: "2026-10-05" });
    }
    return send({});
  });
  await page.goto(`${BASE}/admin-nippo.html`);
  await page.waitForSelector(".nw-c", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { page, errs, asked };
}

console.log("\n=== Office の「人・組織」（2026-10-07：日報・勤怠は Office。経営はチーム状況で集計を見る） ===");
{
  const { page, errs } = await open();
  check(await page.locator("#kp-keiei-nav").count() === 0, "経営のタブは出さない");
  check((await page.locator("#kp-office-nav .kp-otab.on").innerText()).trim() === "人・組織", "Office の「人・組織」が選ばれている");
  check(/admin-nippo\.html$/.test(await page.locator('#kp-office-nav .kp-otab:has-text("人・組織")').getAttribute("href") || ""), "「人・組織」を押すと日報・勤怠（admin-nippo.html）");
  const subs = (await page.locator("#kp-office-nav .kp-ostab").allInnerTexts()).map((x) => x.trim());
  check(subs[0] === "日報・勤怠", `2段目の初めは日報・勤怠（${subs.join("/")}）`);
  check((await page.locator("#kp-office-nav .kp-ostab.on").innerText()).trim() === "日報・勤怠", "「日報・勤怠」が選ばれている");
  check((await page.locator("h1.kp-greet").innerText()).trim() === "日報・勤怠", "タイトルは「日報・勤怠」");

  console.log("\n=== 並び・今ある機能 ===");
  const order = await page.evaluate(() => ["sec-week", "follow-card", "sec-today", "blk-card", "sec-analysis"]
    .map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? -1));
  check(order.every((y, i) => y >= 0 && (i === 0 || y > order[i - 1])), `今週 → 今日の要フォロー → 今日の日報 → 溜まっていること → 分析・履歴（${order.map(Math.round).join(",")}）`);
  for (const id of ["follow-card", "tiles", "not-submitted", "overview", "list", "blk-card", "trend", "rank-card", "w-form", "m-form"]) {
    check(await page.locator(`#${id}`).count() === 1, `残っている：#${id}`);
  }
  check(await page.locator("#sec-analysis").evaluate((d) => !d.open), "分析・履歴は、はじめはたたんである");
  check((await page.locator("#sec-analysis > summary").innerText()).includes("詳細分析を見る"), "「詳細分析を見る」で開ける");
  check(await page.locator("#sec-analysis #trend, #sec-analysis #rank-card, #sec-analysis #w-form, #sec-analysis #m-form").count() === 4, "提出率・直近の傾向・週次評価・月次はたたんだ中");
  check((await page.locator("#blk-card h2").innerText()).includes("溜まっていること"), "溜まっていること（0件でも場所を出す）");

  console.log("\n=== 今週の提出・勤怠 ===");
  const kpis = (await page.locator(".nw-kpi .lb").allInnerTexts()).map((x) => x.trim());
  check(kpis.join("/") === "日報提出率/日報未提出/勤怠要確認/要フォロー人数", `KPI 4つ（${kpis.join("/")}）`);
  check((await page.locator('[data-kpi="rate"] .v').innerText()).replace(/\s/g, "") === "75%", "日報提出率 75%（6/8）");
  check((await page.locator('[data-kpi="missing"] .v').innerText()).replace(/\s/g, "") === "2件", "日報未提出 2件");
  check((await page.locator('[data-kpi="time"] .v').innerText()).replace(/\s/g, "") === "2件", "勤怠要確認 2件");
  check((await page.locator('[data-kpi="follow"] .v').innerText()).replace(/\s/g, "") === "1人", "要フォロー 1人");
  const head = (await page.locator(".nw-table thead th").allInnerTexts()).map((x) => x.split("\n")[0].trim());
  check(head.join("/") === "メンバー/月/火/水/木/金/土/日/日報/勤怠/要対応", `列（${head.join("/")}）`);
  check(await page.locator(".nw-table thead th.is-today").innerText().then((t) => t.startsWith("水")), "今日（水）の列に印");
  const todayBg = await page.locator(".nw-table thead th.is-today").evaluate((e) => getComputedStyle(e).backgroundColor);
  const otherBg = await page.locator(".nw-table thead th.nw-d").first().evaluate((e) => getComputedStyle(e).backgroundColor);
  check(todayBg !== otherBg, `今日の列は背景が違う（${todayBg} / ${otherBg}）`);
  const states = new Set(await page.locator(".nw-table .nw-c").evaluateAll((xs) => xs.map((x) => x.dataset.state)));
  check(["ok", "nippo", "time", "both", "off", "today"].every((s) => states.has(s)), `6つの状態が出る（${[...states].join(",")}）`);
  const both = page.locator('.nw-table tr[data-user="u2"] .nw-c').nth(1);
  const tip = await both.getAttribute("title");
  check(/両方未完了/.test(tip) && /日報：未提出/.test(tip) && /退勤の打刻がありません/.test(tip), `説明（title）に状態と理由（${tip.replace(/\n/g, " ")}）`);
  check(/両方未完了/.test(await both.getAttribute("aria-label")), "読み上げにも状態");
  check(await both.locator(".material-symbols-outlined").innerText() !== "" && await both.locator(".nw-sym").count() === 1, "色だけでなく印（アイコン・記号）");
  const legend = await page.locator("#nw-legend").innerText();
  check(["正常", "日報未提出", "勤怠要確認", "両方未完了", "休日・対象外"].every((x) => legend.includes(x)), "凡例");
  check((await page.locator('.nw-table tr[data-user="u4"]').innerText()).includes("未使用"), "勤怠を使っていない人は「未使用」（要確認にしない）");
  check((await page.locator(".nw-table tbody tr").first().getAttribute("data-user")) !== "u1", "要対応の多い人が先");

  console.log("\n=== 週を移る ===");
  check(await page.locator("#nw-this").isDisabled(), "今週のときは「今週」を押せない");
  check((await page.locator("#nw-range").innerText()).includes("10/5（月）"), "今週の範囲");
  await page.click("#nw-prev");
  await page.waitForFunction(() => document.getElementById("nw-range").textContent.includes("9/28"));
  check(!(await page.locator("#nw-this").isDisabled()), "前週では「今週」で戻れる");
  await page.click("#nw-this");
  await page.waitForFunction(() => document.getElementById("nw-range").textContent.includes("10/5"));
  await page.click("#nw-next");
  await page.waitForFunction(() => document.getElementById("nw-range").textContent.includes("10/12"));
  check((await page.locator('[data-kpi="follow"] .v').innerText()).trim() === "—", "まだ来ていない週の要フォローは「—」");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 幅ごと ===");
for (const w of [1280, 768, 390]) {
  const { page } = await open(w);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${w}px：横にはみ出さない（${over}）`);
  const tableShown = await page.locator(".nw-table-wrap").isVisible();
  const cardsShown = await page.locator(".nw-cards").isVisible();
  if (w === 390) check(!tableShown && cardsShown && await page.locator(".nw-card").count() === 4, "390px：表ではなくメンバーごとのカード");
  else check(tableShown && !cardsShown, `${w}px：週の表`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
