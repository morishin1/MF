// 経営「予定・日報確認」（/keiei/#schedule・keiei/schedule.js）を実際のブラウザで通す。
//
// ■ 何を守るテストか
//   画面に返す中身は、本物の api/keiei/index.js（view=schedule）を偽の DB で動かして作る（手で書いた応答ではない）。
//   材料は test/fixtures/keiei-schedule.mjs（今日 2026-10-09 金。翌営業日 10-13 火）。
//   1. 初期表示は 全員×日。要対応の人が上。集計（今日の日報・翌営業日の予定・要対応）
//   2. 集計カードを押すと一覧を絞る（aria-pressed・解除できる）。名前で探す
//   3. 行・セルを押すと右のドロワー（その日の予定全体）。予定を押すと予定1件の詳細（前後の空き・関連する日報）。メモは出さない
//   4. 全員×週：予定あり・未登録・休暇・対象外の印。前後移動・今日へ
//   5. メンバー別×日・週・月。月は日付を押すとドロワー
//   6. 経営確認のボタン（Phase 2）はまだ出さない
//   7. 1280・390 で横スクロール0。390 はドロワーが全画面
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { createMemDb } from "../_memdb.mjs";
import * as FX from "../fixtures/keiei-schedule.mjs";

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
const reset = (rows = FX.scheduleRows()) => { mem.reset(); mem.state.missing = null; Object.assign(mem.rows, rows); };

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const SHOTS = process.env.KS_SHOTS || "";

async function open(width = 1280, hash = "#schedule") {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date(FX.NOW_ISO));
  const errs = [], calls = [];
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
      calls.push(u.search);
      const out = await callApi(u.pathname + u.search);
      return send(out.body, out.statusCode);
    }
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/keiei/index.html${hash}`);
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:20px;height:20px;display:inline-block;flex:none}" });
  await page.waitForSelector('[data-role="content"] [data-role="list"], [data-role="content"] .kei-banner, [data-role="content"] [data-role="empty"], [data-block="list"]', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(150);
  return { page, errs, calls };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const ready = (page, sel) => page.waitForSelector(sel, { timeout: 8000 });
const pressed = (page, sel) => page.locator(sel).getAttribute("aria-pressed");
const rowIds = (page) => page.locator('[data-role="list"] .ks-row').evaluateAll((ns) => ns.map((n) => n.dataset.emp));
// 画面写真（判定には使わない）。KS_SHOTS を指定すると、そのフォルダへ
const shot = (page, name) => page.screenshot({ path: SHOTS ? join(SHOTS, name) : shotPath(`keieischedule-${name}`), fullPage: true });

console.log("\n=== 全員×日（1280px・初期表示） ===");
{
  reset();
  const { page, errs, calls } = await open();
  check((await page.locator("#kp-keiei-nav .kp-otab.on").getAttribute("data-ktab")) === "people", "1段目は人・組織");
  check(await pressed(page, '[data-scope="all"]') === "true" && await pressed(page, '[data-period="day"]') === "true", "初期は［全員］［日］");
  check(await page.locator('[data-period="month"]').isDisabled(), "全員では［月］は押せない（月はメンバー別）");
  check(calls[0]?.includes("view=schedule") && calls[0].includes("period=day") && calls[0].includes(`date=${FX.TODAY}`), `API は view=schedule・日・今日（${calls[0]}）`);
  const tile = async (k) => (await page.locator(`[data-tile="${k}"]`).innerText()).replace(/\s+/g, "");
  check((await tile("nippoMissing")).includes("今日の日報") && (await tile("nippoMissing")).includes("3/4人提出") && (await tile("nippoMissing")).includes("未提出1人"), `今日の日報（${await tile("nippoMissing")}）`);
  check((await tile("scheduleMissing")).includes("2/3人登録") && (await tile("scheduleMissing")).includes("10/13（火）") && (await tile("scheduleMissing")).includes("未登録1人"), `翌営業日の予定（${await tile("scheduleMissing")}）`);
  check((await tile("attention")).includes("1人") && (await tile("attention")).includes("日報未提出1") && (await tile("attention")).includes("予定未登録1"), `要対応（${await tile("attention")}）`);
  const ids = await rowIds(page);
  check(ids.length === 5 && ids[0] === "e2", `全員が見える・要対応が上（${ids.join(",")}）`);
  const fuji = (await page.locator('.ks-row[data-emp="e2"]').innerText()).replace(/\s+/g, " ");
  check(fuji.includes("未提出") && fuji.includes("未登録"), `藤本：日報未提出・予定未登録（${fuji}）`);
  const yama = (await page.locator('.ks-row[data-emp="e3"]').innerText()).replace(/\s+/g, " ");
  check(yama.includes("提出") && yama.includes("休暇"), `山内：翌営業日は休暇（${yama}）`);
  const ima = (await page.locator('.ks-row[data-emp="e4"]').innerText()).replace(/\s+/g, " ");
  check(ima.includes("対象外（入社前）") && ima.includes("1件"), `今福：今日は入社前（${ima}）`);
  const naka = (await page.locator('.ks-row[data-emp="e1"]').innerText()).replace(/\s+/g, " ");
  check(naka.includes("2件") && naka.includes("指摘あり") && naka.includes("重なり1件"), `中村：2件・重なり（${naka}）`);
  check(!(await page.locator("#kei-main").innerText()).includes("他社") && !(await page.locator("#kei-main").innerText()).includes("退職済み"), "他社・退職済みは出ない");
  await shot(page, "1280_all_day.png");

  console.log("\n— 集計カードで絞る・解除 —");
  await page.click('[data-tile="scheduleMissing"]');
  check(await pressed(page, '[data-tile="scheduleMissing"]') === "true", "押したカードが on（aria-pressed）");
  check((await rowIds(page)).join(",") === "e2", "翌営業日の予定が未登録の人だけ");
  check((await page.locator('[data-role="filter"]').innerText()).includes("翌営業日の予定が未登録の人"), "何で絞っているかを出す");
  await page.click('[data-tile="nippoMissing"]');
  check(await pressed(page, '[data-tile="nippoMissing"]') === "true" && await pressed(page, '[data-tile="scheduleMissing"]') === "false", "別のカードに切り替わる");
  await page.click('[data-role="clear"]');
  check((await rowIds(page)).length === 5 && await page.locator('.ks-tile[aria-pressed="true"]').count() === 0, "解除で全員に戻る");
  await page.click('[data-tile="attention"]');
  await page.click('[data-tile="attention"]');
  check((await rowIds(page)).length === 5, "同じカードをもう一度押しても解除");
  await page.fill("#ks-q", "山内");
  check((await rowIds(page)).join(",") === "e3", "名前で探す");
  check(await page.evaluate(() => document.activeElement?.id) === "ks-q", "入力中もカーソルが検索欄に残る");
  await page.fill("#ks-q", "");

  console.log("\n— ドロワー（その日の予定全体 → 予定1件） —");
  await page.click('.ks-row[data-emp="e1"]');
  await ready(page, '.ks-dr [data-sec="events"]');
  const box = await page.locator(".ks-dr").boundingBox();
  check(box && box.x > 600 && box.y === 0, `右から開く（x=${box?.x}）`);
  check((await page.locator('.ks-dr [data-role="scope"]').innerText()).includes("この日の予定全体（2件）"), "対象（その日全体・件数）を明示");
  const evs = await page.locator(".ks-dr .ks-ev").evaluateAll((ns) => ns.map((n) => n.dataset.ev));
  check(evs.join(",") === "ev-n1,ev-n2", `時刻順・業務予定だけ（${evs.join(",")}）`);
  check((await page.locator('.ks-dr [data-sec="check"]').innerText()).includes("重複"), "時間割チェック（自動計算）の指摘");
  const nip = await page.locator('.ks-dr [data-sec="nippo"]').innerText();
  check(nip.includes("10/9（金）") && nip.includes("提出"), `予定を入れた日の日報（${nip.replace(/\s+/g, " ")}）`);
  check(await page.locator('.ks-dr [data-slot="review-actions"]').count() === 1 && !(await page.locator(".ks-dr").innerText()).match(/問題なし|修正依頼/), "経営確認のボタンはまだ出さない（置き場所だけ）");
  await page.click('.ks-dr .ks-ev[data-ev="ev-n1"]');
  await ready(page, '.ks-dr [data-sec="gaps"]');
  const dr = await page.locator(".ks-dr").innerText();
  check(dr.includes("A社 企業訪問") && dr.includes("この予定1件") && dr.includes("大阪市") && dr.includes("訪問") && dr.includes("10:00〜11:00"), "予定1件の詳細");
  check(dr.includes("重なっている") && dr.includes("週次会議"), "前後：重なっている予定");
  check(!dr.includes(FX.SECRET) && !dr.includes("090-0000-0000"), "メモ（body）は出さない");
  await page.click('[data-role="back"]');
  await ready(page, '.ks-dr [data-sec="events"]');
  check(true, "← その日の予定一覧へ戻れる");
  await page.keyboard.press("Escape");
  check(await page.locator("#ks-drawer").count() === 0, "Esc で閉じる");
  check(await overflow(page) <= 0, "1280px：横にはみ出さない");

  console.log("\n— 全員×週 —");
  await page.click('[data-period="week"]');
  await ready(page, '[data-role="week"]');
  check((await page.locator('[data-role="period-label"]').innerText()).includes("10/5（月） 〜 10/11（日）"), "今週（月〜日）");
  const mark = (emp, d) => page.locator(`[data-role="week"] tr[data-emp="${emp}"] [data-date="${d}"]`).getAttribute("data-mark");
  check(await mark("e1", "2026-10-07") === "has" && (await page.locator('tr[data-emp="e1"] [data-date="2026-10-07"]').innerText()).trim() === "1", "予定あり（件数）");
  check(await mark("e1", "2026-10-10") === "off", "土曜は対象外");
  await page.click('[data-nav="next"]');
  await page.waitForFunction(() => document.querySelector('[data-role="period-label"]')?.textContent.includes("10/12"));
  await ready(page, '[data-role="week"]');
  check(await mark("e3", "2026-10-13") === "leave" && await mark("e3", "2026-10-14") === "leave", "休暇（2日目も）");
  check(await mark("e2", "2026-10-13") === "none" && !(await page.locator('tr[data-emp="e2"] [data-date="2026-10-13"]').getAttribute("class")).includes("later"), "未登録（翌営業日までは目立たせる）");
  check((await page.locator('tr[data-emp="e2"] [data-date="2026-10-14"]').getAttribute("class")).includes("later"), "翌営業日より先の未登録は、期限前として控えめに");
  check(await mark("e5", "2026-10-13") === "off" && await mark("e2", "2026-10-12") === "off", "退職後・祝日は対象外");
  check(await page.locator('[data-role="legend"]').count() === 1, "印の説明がある");
  await shot(page, "1280_all_week.png");
  await page.click('[data-role="week"] tr[data-emp="e1"] [data-date="2026-10-13"]');
  await ready(page, '.ks-dr [data-sec="events"]');
  check((await page.locator(".ks-dr h2").innerText()).includes("中村") && (await page.locator(".ks-dr .ks-ev").count()) === 2, "セルを押すと、その人・その日の予定");
  await page.keyboard.press("Escape");
  await page.click('[data-nav="today"]');
  await page.waitForFunction(() => document.querySelector('[data-role="period-label"]')?.textContent.includes("10/5"));
  check(true, "今日へ");
  check(await overflow(page) <= 0, "1280px：週も横にはみ出さない");

  console.log("\n— メンバー別 —");
  await page.click('[data-scope="member"]');
  await ready(page, "#ks-emp");
  check(await pressed(page, '[data-scope="member"]') === "true" && !(await page.locator('[data-period="month"]').isDisabled()), "メンバー別では［月］も押せる");
  check(await page.locator("#ks-emp option").count() === 5, "メンバーを選べる（5人）");
  await page.selectOption("#ks-emp", "e1");
  await ready(page, '[data-role="member-week"]');
  check(await page.locator('[data-role="member-week"] .ks-wd').count() === 7, "メンバー別×週：曜日ごと");
  await page.click('[data-period="day"]');
  await ready(page, '[data-role="day"]');
  await page.click('[data-nav="next"]'); await page.waitForTimeout(100);
  await page.fill("#ks-date", FX.NEXT); await page.dispatchEvent("#ks-date", "change");
  await page.waitForFunction(() => document.querySelector('[data-role="period-label"]')?.textContent.includes("10/13"));
  await ready(page, '[data-role="day"] [data-role="events"]');
  const day = await page.locator('[data-role="day"] .ks-ev').evaluateAll((ns) => ns.map((n) => n.dataset.ev));
  check(day.join(",") === "ev-n1,ev-n2", `メンバー別×日：時刻順（${day.join(",")}）`);
  await page.click('[data-period="month"]');
  await ready(page, '[data-role="member-month"]');
  check(await page.locator('[data-role="member-month"] .ks-md').count() === 31, "メンバー別×月：31日");
  check((await page.locator('.ks-md[data-date="2026-10-13"]').innerText()).includes("2件") && (await page.locator('.ks-md[data-date="2026-10-07"]').innerText()).includes("1件"), "月：件数を小さく");
  await page.click('.ks-md[data-date="2026-10-13"]');
  await ready(page, '.ks-dr [data-sec="events"]');
  check(await page.locator(".ks-dr .ks-ev").count() === 2, "月：日付を押すとドロワーに予定一覧");
  await shot(page, "1280_member_month_drawer.png");
  await page.keyboard.press("Escape");
  await page.click('[data-scope="all"]');
  await ready(page, '[data-role="week"]');
  check(await pressed(page, '[data-period="week"]') === "true", "全員に戻ると月は週になる");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== メンバー実行状況から入れる ===");
{
  reset();
  const { page } = await open(1280, "#members");
  await page.waitForSelector('[data-role="to-schedule"]', { timeout: 8000 });
  await page.click('[data-role="to-schedule"]');
  await ready(page, '[data-role="list"]');
  check(page.url().endsWith("#schedule"), "メンバー実行状況 → 予定・日報確認");
  await page.close();
}

console.log("\n=== 390px ===");
{
  reset();
  const { page, errs } = await open(390);
  check(await overflow(page) <= 0, `全員×日：横スクロール0（${await overflow(page)}）`);
  await shot(page, "390_all_day.png");
  await page.click('[data-tile="nippoMissing"]');
  check((await rowIds(page)).join(",") === "e2", "390px：カードで絞れる");
  await page.click('[data-role="clear"]');
  await page.click('[data-period="week"]');
  await ready(page, '[data-role="week"]');
  check(await overflow(page) <= 0, `全員×週：横スクロール0（${await overflow(page)}）`);
  const cell = await page.locator('[data-role="week"] tr[data-emp="e1"] [data-date="2026-10-07"]').boundingBox();
  check(cell && cell.width >= 28 && cell.height >= 30, `週のセルが押せる大きさ（${Math.round(cell?.width)}×${Math.round(cell?.height)}）`);
  await shot(page, "390_all_week.png");
  await page.click('[data-scope="member"]');
  await ready(page, "#ks-emp");
  await page.selectOption("#ks-emp", "e1");
  await page.click('[data-period="month"]');
  await ready(page, '[data-role="member-month"]');
  check(await overflow(page) <= 0, `メンバー別×月：横スクロール0（${await overflow(page)}）`);
  await shot(page, "390_member_month.png");
  await page.click('.ks-md[data-date="2026-10-07"]');
  await ready(page, '.ks-dr [data-sec="events"]');
  const b = await page.locator(".ks-dr").boundingBox();
  check(b && b.x === 0 && b.y === 0 && b.width === 390, `ドロワーは全画面（${JSON.stringify(b)}）`);
  check(await overflow(page) <= 0, "ドロワーを開いても横にはみ出さない");
  await shot(page, "390_member_month_drawer.png");
  await page.click(".ks-dr .ks-ev");
  await ready(page, '.ks-dr [data-sec="gaps"]');
  check((await page.locator('.ks-dr [data-sec="gaps"]').innerText()).includes("最初の予定"), "前後の空き");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 読めないとき ===");
{
  reset();
  mem.state.missing = "tc_nippo";
  const { page, errs } = await open();
  const t = await page.locator("#kei-main").innerText();
  check(t.includes("取得できません") && (await page.locator('[data-role="unreadable"]').count()) === 1, "日報が読めない → 取得できません");
  check(!(await page.locator('[data-role="list"]').innerText()).includes("未提出"), "未提出とは出さない");
  check(await page.locator('[data-tile="nippoMissing"]').isDisabled(), "読めない集計では絞れない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  mem.state.missing = null;
  await page.close();
}

await br.close();
Date.now = realNow;
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
