// 日報・勤怠（admin-nippo.html）：本番の中村さんの条件で、管理側が「未提出」に見せない（2026-10-08）。
//
// ■ 何を守るテストか
//   材料は test/fixtures/nippo-nakamura.mjs（active・user_id 一致・今日の日報あり・AI評価 completed。氏名・ID は架空）。
//   画面に返す中身は、本物の api/nippo/admin.js を偽の DB で動かして作る（手で書いた応答ではない）。
//   1. 今週の表：今日（10/8）のセルがはっきり緑で「提出済み」、日報の列に「今日 提出済み」
//   2. KPI：「日報提出率（過去営業日）」と明記し、「今日の提出 1/2人」を別に出す
//   3. 今日の日報：提出の数・未提出の一覧・一覧の「提出」と参考点・提出された日報のカード（AI参考評価・AIの返信）
//   4. 390px：カードに「今日：提出済み」
//   5. 別の user_id で書いた人は、未提出のまま（名前では寄せない）
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";
import { createMemDb } from "../_memdb.mjs";
import * as NK from "../fixtures/nippo-nakamura.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const atRoot = (p) => join(ROOT, p);
process.env.ANTHROPIC_API_KEY ||= "test-only";   // AI採点の欄を出すため（AIは呼ばない）

const mem = createMemDb();
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-owner" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW,
  gwContext: async () => ({ tenantId: NK.TENANT, isAdmin: true, isHr: false, roles: ["owner"], employee: { id: "e-owner" } }) } });
const REAL_NIPPO = await import(atRoot("lib/nippo.js"));
mock.module(atRoot("lib/nippo.js"), { namedExports: { ...REAL_NIPPO, jstDate: () => NK.TODAY } });
const { default: api } = await import(atRoot("api/nippo/admin.js"));

async function callApi(query) {
  mem.reset();
  Object.assign(mem.rows, NK.nakamuraRows());
  const r = { statusCode: 0, setHeader() {}, end(b) { r.body = b; } };
  await api({ method: "GET", url: `/api/nippo/admin?${query}`, headers: {} }, r);
  if (r.statusCode !== 200) throw new Error(`admin API ${r.statusCode}: ${r.body}`);
  return r.body;
}

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(width = 1280) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date("2026-10-08T03:00:00Z"));   // 日本時間 2026-10-08（木）12:00
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" })); localStorage.removeItem("kp_layout"); });
  await page.route("**/api/**", async (r) => {
    const u = r.request().url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: typeof b === "string" ? b : JSON.stringify(b) });
    if (/\/api\/me\b/.test(u)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: true, roles: ["owner"],
        gw: { employee: { id: "e-owner", display_name: "経営 テスト", status: "active" }, roles: ["owner"], tenantId: NK.TENANT, isAdmin: true, stage: null },
        access: accessOf({ isAdmin: true, roles: ["owner"] }) });
    }
    if (/\/api\/nippo\/admin/.test(u)) return send(await callApi(new URL(u).search.slice(1)));
    return send({});
  });
  await page.goto(`${BASE}/admin-nippo.html`);
  await page.waitForSelector(".nw-c", { timeout: 8000 }).catch(() => {});
  await page.waitForSelector(`#dr-${NK.NIPPO_ID}`, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { page, errs };
}

const nk = NK.NAKAMURA.user_id;

console.log("\n=== 今週の提出・勤怠（中村さん：今日 10/8 に提出済み） ===");
{
  const { page, errs } = await open();
  const kpis = (await page.locator(".nw-kpi .lb").allInnerTexts()).map((x) => x.trim());
  check(kpis[0] === "日報提出率（過去営業日）", `提出率は「過去営業日」と明記（${kpis[0]}）`);
  check((await page.locator('[data-kpi="today"] .v').innerText()).replace(/\s/g, "") === "1/2人", "今日の提出 1/2人");
  const row = page.locator(`.nw-table tr[data-user="${nk}"]`);
  check(await row.count() === 1, "週の表に中村さんの行");
  const cell = row.locator("td.is-today");
  check(await cell.locator('.nw-c.s-ok.is-now[data-nippo="ok"]').count() === 1, "今日のセル：提出済み（is-now）");
  const bg = await cell.locator(".nw-c").evaluate((e) => getComputedStyle(e).backgroundColor);
  check(bg === "rgb(47, 111, 58)", `今日のセルははっきり緑（${bg}）`);
  check((await cell.innerText()).includes("提出済み"), "今日のセルに「提出済み」と書く");
  check((await row.locator('[data-today="ok"]').innerText()).trim() === "今日 提出済み", "日報の列に「今日 提出済み」");
  check((await row.locator(".nw-num").first().innerText()).startsWith("3/3"), "日報 3/3（過去営業日）はそのまま");
  check(/日報：提出済み/.test(await cell.locator(".nw-c").getAttribute("title")), "説明（title）も提出済み");
  check(await row.locator('[data-state="nippo"], [data-state="both"]').count() === 0, "どの日も「日報未提出」にならない");

  console.log("\n=== 今日の日報（一覧・未提出・カード） ===");
  check((await page.locator("#tiles").innerText()).replace(/\s/g, "").includes("提出1/2"), "提出の数は名簿の人だけ（1/2。名簿に紐づかない日報は数えない）");
  const yet = await page.locator("#not-submitted").innerText();
  const yetNames = (await page.locator("#not-submitted .kp-chip").allInnerTexts()).map((x) => x.trim());
  check(JSON.stringify(yetNames) === JSON.stringify(["別アカウント 太郎"]), `未提出の一覧は「別アカウント 太郎」だけ（${yetNames.join("・")}）`);
  check(!yet.includes(NK.NAKAMURA.display_name), "未提出の一覧に中村さんは出ない");
  check(yet.includes("別アカウント 太郎"), "別の user_id で書いた人は未提出のまま（名前では寄せない）");
  const ov = page.locator("#overview tr", { hasText: NK.NAKAMURA.display_name });
  check(await ov.count() === 1 && (await ov.innerText()).includes("提出") && !(await ov.innerText()).includes("未提出"), "一覧：提出（未提出ではない）");
  check((await ov.innerText()).includes("72"), "一覧：AIの参考点 72");
  const card = page.locator(`#dr-${NK.NIPPO_ID}`);
  check(await card.count() === 1, "提出された日報のカードが出る");
  check((await card.locator(".dr-name").innerText()).trim() === NK.NAKAMURA.display_name, "カードの名前");
  check((await card.innerText()).includes("AI参考評価 72 点"), "カードに AI参考評価（completed）");
  check((await card.innerText()).includes("AIからのフィードバック"), "カードに AI の返信");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 390px ===");
{
  const { page, errs } = await open(390);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `横にはみ出さない（${over}）`);
  const c = page.locator(`.nw-card[data-user="${nk}"]`);
  check((await c.locator(".nw-card-f").innerText()).includes("今日：提出済み"), "カードに「今日：提出済み」");
  check(await c.locator(".nw-cd.is-today .nw-c.is-now").count() === 1, "カードの今日も緑");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
