// /office/ が、実際のブラウザで最後まで立ち上がるか（PR #75 の Preview で止まった件の再発防止）。
//
// ■ 何が起きたか
//   layout.js・office-layout.js・layout.css を変えたのに ?v= を上げず（20261003ux1 のまま）、
//   1年キャッシュの古い layout.js と新しい HTML の組み合わせで KPLayout.warm が無く、
//   共通ヘッダー・Office のタブが出ないまま「読み込み中…」で止まった。
//
// ■ ここで見ること（初回と、キャッシュのある再訪問の両方）
//   1. /office/ を開く
//   2. 共通ヘッダー（.topbar と、ヘッダーの Office）が出る
//   3. Office のカテゴリタブ（ホーム／人・組織／請求・支払／契約・書類／端末・貸与品）が出る
//   4. 「読み込み中…」が消える
//   5. サマリー（件数のカード）か「この条件の項目はありません」が出る
//   6. JS のエラー（pageerror・console.error）が無い
//   あわせて、/office/ が読む js・css の ?v= が、いまの版（api/health.js の assetVersion）にそろっていること
import { readFileSync } from "node:fs";
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const { accessOf } = await import("../../lib/gw.js");
const O = await import("../../lib/office.js");
const VER = readFileSync(new URL("../../api/health.js", import.meta.url), "utf8").match(/assetVersion:\s*"([^"]+)"/)[1];

const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const deadline = O.timesheetDeadline(MONTH);
const row = (i) => O.deriveRow({
  siteContractId: `s${i}`, progressId: null, employeeId: `e${i}`, employeeName: `要員 ${i}`, department: null, employeeKind: "proper",
  partnerName: null, engagementKind: "pp", siteCompany: `顧客${i}社`, primeCompany: null, periodFrom: "2026-04-01", periodTo: null,
  renewalStatus: "confirmed", submissions: [],
  marks: { timesheet_received: i % 2 === 0, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
}, { today: TODAY, deadline });
const officeOf = (rows) => ({ month: MONTH, today: TODAY, deadline, rows: O.sortRows(rows), summary: O.summarize(rows),
  stages: O.STAGES, filters: O.FILTERS, phase4: { ready: true }, close: { closed: false } });

/** 1つのブラウザ（キャッシュ・localStorage・sessionStorage を持ち越す）で /office/ を開く */
async function newCtx({ roles = ["owner"], empty = false, failTasks = false } = {}) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem("kp_session")) {
      localStorage.setItem("kp_session", JSON.stringify({ access_token: "h.eyJzdWIiOiJ1LTEifQ.s", email: "a@b.c" }));
    }
  });
  const me = { email: "a@b.c", appRole: roles.includes("owner") ? "owner" : "member", isAdmin: false, roles: [],
    gw: { employee: { id: "me", display_name: "森田", status: "active" }, roles, tenantId: "t1", stage: null },
    access: accessOf({ isAdmin: false, roles }) };
  await ctx.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send(me);
    if (u.pathname === "/api/office") return send(officeOf(empty ? [] : [row(1), row(2), row(3)]));
    if (u.pathname === "/api/badges") return send({ badges: empty ? {} : { timecard: 2, expenses: 1 } });
    if (u.pathname === "/api/hr") return send({ tabs: [], onboarding: [], offboarding: [] });
    if (u.pathname === "/api/tasks") return failTasks
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture_unavailable" }) })
      : send({ tasks: [], templates: [], requested: [] });
    if (u.pathname === "/api/requests") return send({ requests: [] });
    if (u.pathname === "/api/office-tasks/calendar") return send({ today: TODAY, events: [], overdue: [], categories: [] });
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  return ctx;
}

async function visit(page, label) {
  const errs = [];
  const onErr = (e) => errs.push(`pageerror: ${e.message}`);
  const onCon = (m) => { if (m.type() === "error" && !/fonts\.googleapis|fonts\.gstatic|net::ERR|Failed to load resource|manifest/.test(m.text())) errs.push(`console: ${m.text()}`); };
  page.on("pageerror", onErr); page.on("console", onCon);
  await page.goto(`${BASE}/office/`);
  const ok = await page.waitForFunction(() => {
    const t = document.body.innerText;
    return !t.includes("読み込み中") && (document.querySelector("#cards .oh-card") || t.includes("この条件の項目はありません"));
  }, null, { timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(400);
  check(ok, `${label}：「読み込み中…」が消え、本文が出る`);
  check(await page.locator(".topbar").count() === 1 && await page.locator('.topbar [data-shortcut="office"]').count() === 1, `${label}：共通ヘッダー（Office の入口つき）が出る`);
  const cats = (await page.locator("#kp-office-nav .kp-otab > span").allInnerTexts()).map((x) => x.trim());
  check(cats.join("|") === "ホーム|人・組織|請求・支払|契約・書類|端末・貸与品", `${label}：Office のカテゴリタブが出る（${cats.join("|")}）`);
  check(await page.locator("#kp-office-nav .kp-otab.on").innerText().then((x) => x.trim() === "ホーム"), `${label}：ホームが選ばれている`);
  const body = await page.locator(".wrap").innerText();
  check(!body.includes("読み込み中"), `${label}：「読み込み中…」は残っていない`);
  check(await page.locator("#cards .oh-card").count() > 0 || body.includes("この条件の項目はありません"), `${label}：サマリーか「この条件の項目はありません」が出る`);
  check(errs.length === 0, `${label}：JS のエラーが無い${errs.length ? `（${errs.join(" / ").slice(0, 200)}）` : ""}`);
  page.off("pageerror", onErr); page.off("console", onCon);
}

console.log("— /office/ が読む js・css は、いまの版 —");
{
  const html = readFileSync(new URL("../../office/index.html", import.meta.url), "utf8");
  // 共通assetの版は維持。独立更新したOffice専用2本は新しい版を必須にする。
  const versions = { "office-actions.js": "20261023actions1", "office-people-pulse.js": "20261023actions1" };
  const assets = [...html.matchAll(/(?:src|href)="[^"?]*\/([^/"?]+\.(?:js|css))\?v=([^"&]+)"/g)];
  check(assets.length >= 8 && assets.every((m) => m[2] === (versions[m[1]] || VER)),
    "共通assetとOffice専用assetが、それぞれ検証済みの版を読む");
  for (const name of Object.keys(versions)) check(assets.some((m) => m[1] === name), `${name} を実際に読み込む`);
}

console.log("\n— 経営者：初回 → キャッシュのある再訪問 → 別の画面を経由して戻る —");
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await visit(page, "初回");
  await visit(page, "再訪問（キャッシュあり）");
  await page.goto(`${BASE}/office/monthly.html`);
  await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
  await page.locator('#kp-office-nav .kp-otab:has-text("ホーム")').click();
  await page.waitForURL(/\/office\/$/);
  await visit(page, "月次業務からタブで戻る");
  await ctx.close();
}

console.log("\n— 対応が要るものが無い人：「この条件の項目はありません」—");
{
  const ctx = await newCtx({ empty: true });
  const page = await ctx.newPage();
  await visit(page, "空（初回）");
  check((await page.locator("#todo").innerText()).includes("この条件の項目はありません"), "今日やることに「この条件の項目はありません」");
  check((await page.locator("#actionWarnings").innerText()) === "", "取得成功の空状態に未確認警告がない");
  await visit(page, "空（再訪問）");
  await ctx.close();
}

console.log("\n— 人事（担当の分だけ）：初回 → 再訪問 —");
{
  const ctx = await newCtx({ roles: ["hr"] });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  for (const label of ["人事・初回", "人事・再訪問"]) {
    await page.goto(`${BASE}/office/`);
    const ok = await page.waitForFunction(() => !document.body.innerText.includes("読み込み中") && document.querySelector("#cards .oh-card"), null, { timeout: 8000 }).then(() => true, () => false);
    check(ok && (await page.locator("#kp-office-nav .kp-otab").allInnerTexts()).map((x) => x.trim()).join("|") === "ホーム|人・組織|契約・書類|端末・貸与品", `${label}：本文とタブ（ホーム／人・組織／契約・書類／端末・貸与品）が出る`);
  }
  check(errs.length === 0, `人事：JS のエラーが無い${errs.length ? `（${errs.join(" / ")}）` : ""}`);
  await ctx.close();
}

// 取得失敗は空件数ではない。成功時の文言変更だけで失敗を隠していないこと。
{
  const ctx = await newCtx({ empty: true, failTasks: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/office/`);
  await page.waitForFunction(() => document.querySelector("#actionWarnings")?.textContent.includes("自分のタスク"));
  check((await page.locator("#actionWarnings").innerText()).includes("0件とは限りません"), "タスク取得失敗を未確認として表示");
  check((await page.locator("#todo").innerText()).includes("未確認の情報が残っています"), "取得失敗時は対応なしと断定しない");
  await ctx.close();
}
await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
