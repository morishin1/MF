// Office ホーム（/office/）を、実際のブラウザで通す。
//
// ■ 何を守りたいのか（Office UI/UX 再設計 2026-10-03）
//   ・Office ホームは全員同じ画面。違うのは、見える数字・行・左メニューだけ（担当＝/api/me の access）
//   ・サマリーカード（勤怠要確認・経費承認待ち・月次残件・入社準備・契約期限・請求未完了）は担当の分だけ。押すと一覧へ
//   ・今日やることは 要確認 → 期限超過 → 今日期限 → 今週対応 の順。優先度は色だけでなく文字でも出す
//   ・月次進捗（勤務表回収・稼働確認・売上請求・仕入請求・支払・月次完了）は、月末月初業務を使える人だけ
//   ・担当でない API は呼ばない（403 の行を作らない）。1つ取れなくても、ほかは出す（「—」）
//   ・旧URL（/office/?month=…&id=…、admin-dashboard.html）は、新しい場所へ送る
//   ・ナビゲーションは共通ヘッダーの下の横タブ（1段目：ホーム／人・組織／請求・支払／契約・書類／端末・貸与品、2段目：カテゴリの中の画面）。
//     左サイドバー・ドロワーは無い。狭い画面でも同じタブ（横にスクロール）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// サーバ（lib/gw.js accessOf）と、月末月初業務の行・集計（lib/office.js）そのもの
const { accessOf: serverAccessOf } = await import("../../lib/gw.js");
const O = await import("../../lib/office.js");

const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const addDays = (n) => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const deadline = O.timesheetDeadline(MONTH);
const raw = (i, extra = {}) => ({
  siteContractId: `s${i}`, progressId: null, employeeId: `e${i}`, employeeName: `要員 ${i}`, department: null, employeeKind: "proper",
  partnerName: null, engagementKind: "pp", siteCompany: `顧客${i}社`, primeCompany: null, periodFrom: "2026-04-01", periodTo: null,
  renewalStatus: "confirmed", submissions: [],
  marks: { timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
  ...extra,
});
const ROWS = [
  // 勤務表待ち・契約期限が近い（更新未確認）
  O.deriveRow(raw(1, { periodTo: addDays(10), renewalStatus: "pending" }), { today: TODAY, deadline }),
  // 稼働確認待ち
  O.deriveRow(raw(2, { marks: { timesheet_received: true, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false } }), { today: TODAY, deadline }),
  // 完了（PP）
  O.deriveRow(raw(3, { marks: { timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: false } }), { today: TODAY, deadline }),
  // BP：請求書は受領、金額が未登録（支払：請求額 未登録）
  O.deriveRow(raw(4, { engagementKind: "bp", employeeKind: "bp", partnerName: "BP社", payable: null,
    marks: { timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true } }), { today: TODAY, deadline }),
];
const OFFICE = { month: MONTH, today: TODAY, deadline, rows: O.sortRows(ROWS), summary: O.summarize(ROWS), stages: O.STAGES, filters: O.FILTERS,
  phase4: { ready: true }, close: { closed: false } };

/**
 * @param {string} path
 * @param {{appRole?:string, isAdmin?:boolean, roles?:string[], width?:number, failHr?:boolean}} who
 */
async function open(path, who) {
  const page = await br.newPage({ viewport: { width: who.width || 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = [];
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
    sessionStorage.clear();
  });
  const isAdmin = Boolean(who.isAdmin);
  const roles = who.roles || [];
  const appRole = who.appRole || (roles.includes("owner") ? "owner" : isAdmin ? "admin" : "member");
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    calls.push(url);
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({
        email: "a@b.c", appRole, isAdmin, roles: [],
        gw: { employee: { id: "e1", display_name: "森田", status: "active" }, roles, tenantId: "t1", stage: null },
        access: serverAccessOf({ isAdmin, roles }),
      });
    }
    if (/\/api\/badges/.test(url)) return send({ badges: { esign: 2, timecard: 3, requests: 1, expenses: 4 } });
    if (/\/api\/hr\b/.test(url)) return who.failHr ? send({ error: "x" }, 500) : send({ tabs: [], onboarding: [{ id: "p1" }, { id: "p2" }], offboarding: [{ id: "p3" }] });
    if (/\/api\/closing/.test(url)) return send({ month: "2026-09", closing: { status: "open" }, canClose: false, blockers: [{}, {}], rows: [] });
    if (/\/api\/office(\?|$)/.test(url)) return send(OFFICE);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(1200);
  page.calls = calls;
  return page;
}

const pathOf = (page) => new URL(page.url()).pathname;
const called = (page, re) => page.calls.some((u) => re.test(u));
const cards = (page) => page.locator("#cards .oh-card").evaluateAll((ns) => ns.map((n) => ({
  label: n.querySelector(".lb .t").textContent.trim(), v: n.querySelector(".v").childNodes[0].textContent.trim(), href: n.getAttribute("href"),
})));
const todo = (page) => page.locator("#todo .oh-row").evaluateAll((ns) => ns.map((n) => ({
  pri: n.querySelector(".oh-pri .t").textContent.trim(), label: n.querySelector(".oh-label .t").textContent.trim(),
  // 2026-10-04：行は採用HRの「今やること」と同じカード（左端の色＋右の操作ボタン）。行き先は右のボタン
  n: n.querySelector(".oh-n").childNodes[0].textContent.trim(), href: n.querySelector(".oh-go").getAttribute("href"),
  cta: n.querySelector(".oh-go").textContent.trim(),
})));
// Office の横タブ。1段目（カテゴリ）と2段目（カテゴリの中の画面）
const tabsOf = (page, sel) => page.locator(sel).evaluateAll((ns) => ns.map((n) => ({
  label: n.querySelector("span").textContent.trim(), href: n.getAttribute("href"), on: n.classList.contains("on"),
})));
const cats = (page) => tabsOf(page, "#kp-office-nav .kp-otab");
const subs = (page) => tabsOf(page, "#kp-office-nav .kp-ostab");
const groups = (page) => cats(page).then((a) => a.filter((x) => x.label !== "ホーム").map((x) => x.label));
const card = (list, label) => list.find((c) => c.label === label);

console.log("— 経営者（owner）: 全部の数字・全部のメニュー —");
{
  const p = await open("office/", { roles: ["owner"] });
  check(pathOf(p) === "/office/", `Office ホームを開ける（いま ${pathOf(p)}）`);
  check((await p.locator("h1").first().innerText()).trim() === "Office", "見出しは Office");
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "勤怠要確認|経費承認待ち|月次残件|入社準備|契約期限|請求未完了", `サマリーカード6つ（いま ${c.map((x) => x.label).join("|")}）`);
  check(card(c, "勤怠要確認")?.v === "3" && card(c, "勤怠要確認").href === "/admin-timecard.html", "勤怠要確認 3 → 勤怠管理");
  check(card(c, "経費承認待ち")?.v === "4" && card(c, "経費承認待ち").href === "/admin-expenses.html", "経費承認待ち 4 → 経費精算");
  check(card(c, "月次残件")?.v === "3" && card(c, "月次残件").href === "/office/monthly.html", `月次残件 3（4件中、完了1件。BPは支払まで）→ 月次業務（いま ${card(c, "月次残件")?.v}）`);
  check(card(c, "入社準備")?.v === "2" && card(c, "入社準備").href === "/admin-hr.html", "入社準備 2 → 入退社");
  check(card(c, "契約期限")?.v === "1" && card(c, "契約期限").href === "/office/monthly.html?tag=expiring", "契約期限 1（30日以内・更新未確認）→ 月次業務の絞り込み");
  check(card(c, "請求未完了")?.v === "3" && card(c, "請求未完了").href === "/office/billing.html", `請求未完了 3 → 請求・支払（いま ${card(c, "請求未完了")?.v}）`);
  check(await p.locator("#cards .oh-card").first().evaluate((n) => getComputedStyle(n).backgroundColor === "rgb(255, 255, 255)"),
    "件数のカードは白（色の面で埋めない。採用HR・Sales・経営と同じ）");

  const t = await todo(p);
  const order = ["要確認", "期限超過", "今日期限", "今週対応"];
  check(t.length > 0 && t.every((x, i) => i === 0 || order.indexOf(t[i - 1].pri) <= order.indexOf(x.pri)), `今日やることは 要確認→期限超過→今日期限→今週対応 の順（いま ${t.map((x) => x.pri).join(",")}）`);
  check(t.some((x) => x.label === "稼働確認待ち" && x.pri === "要確認" && x.href.startsWith("/office/monthly.html?month=")), "稼働確認待ち（要確認）→ 月次業務の絞り込み");
  check(t.some((x) => x.label === "経費精算の承認" && x.n === "4"), "経費精算の承認 4件");
  check(t.some((x) => x.label === "勤怠の修正申請" && x.pri === "要確認"), "勤怠の修正申請（要確認）");
  check(t.some((x) => x.label === "入社準備" && x.n === "2"), "入社準備 2件");
  check(t.some((x) => x.label === "契約期限の確認" && x.n === "1"), "契約期限の確認 1件");
  check(t.some((x) => x.label === "支払の登録・確認" && x.n === "1"), "支払の登録・確認 1件（BP）");
  check(t.find((x) => x.label === "経費精算の承認")?.cta === "経費を承認" && t.find((x) => x.label === "勤怠の修正申請")?.cta === "勤怠を確認",
    "右の操作ボタン：経費精算の承認 →「経費を承認」、勤怠の修正申請 →「勤怠を確認」");
  // 採用HRの .hr-today-row と同じ形：1件ずつ独立したカード（白・1px #e2e2dc・角丸9px）、状態は左端3pxの色、右に btn-primary
  const hrRow = await p.locator("#todo .oh-row").evaluateAll((ns) => ns.map((n) => {
    const c = getComputedStyle(n); const b = n.querySelector(".oh-go"); const br = b.getBoundingClientRect(); const nr = n.getBoundingClientRect();
    return { pri: n.querySelector(".oh-pri .t").textContent.trim(), bg: c.backgroundColor, border: c.borderTopColor, left: c.borderLeftColor, lw: c.borderLeftWidth,
      radius: c.borderRadius, btn: getComputedStyle(b).backgroundColor, right: Math.round(nr.right - br.right) };
  }));
  check(hrRow.every((r) => r.bg === "rgb(255, 255, 255)" && r.border === "rgb(226, 226, 220)" && r.lw === "3px" && r.radius === "9px"),
    "今日やることは1件ずつのカード（白・枠 #e2e2dc・左端3px・角丸9px。採用HRの .hr-today-row と同じ）");
  const leftOf = { 期限超過: "rgb(192, 57, 43)", 今日期限: "rgb(224, 161, 0)", 要確認: "rgb(230, 240, 80)", 今週対応: "rgb(230, 240, 80)" };
  check(hrRow.every((r) => r.left === leftOf[r.pri]), `左端の色で状態（期限超過 #c0392b・今日期限 #e0a100・ほか #e6f050）（いま ${[...new Set(hrRow.map((r) => `${r.pri}:${r.left}`))].join(" ")}）`);
  check(hrRow.every((r) => r.btn === "rgb(49, 130, 206)" && r.right <= 16), "操作ボタンは右端（btn btn-primary btn-sm。採用HRと同じ）");

  check(await p.locator("#progBox").isVisible(), "月次進捗が出る");
  const prog = await p.locator("#prog .row span:first-child").allInnerTexts();
  check(prog.join("|") === "勤務表回収|稼働確認|売上請求（送付）|仕入請求（受領）|支払|月次完了", `月次進捗：勤務表回収〜支払〜月次完了（いま ${prog.join("|")}）`);
  check((await p.locator("#closeNote").innerText()).includes("月次完了：未完了"), "月次完了の状態（未完了）を文字で出す");

  const c1 = await cats(p);
  check(c1.map((x) => x.label).join("|") === "ホーム|人・組織|請求・支払|契約・書類|端末・貸与品", `横タブ：ホーム／人・組織／請求・支払／契約・書類／端末・貸与品（いま ${c1.map((x) => x.label).join("|")}）`);
  check(c1.find((x) => x.label === "ホーム")?.on && c1.find((x) => x.label === "ホーム")?.href === "/office/", "ホーム（/office/）が選ばれた状態");
  check(c1.find((x) => x.label === "人・組織")?.href === "/admin-nippo.html", "人・組織 → 日報・勤怠（下の階層の画面からも、ルートから開く）");
  check(c1.find((x) => x.label === "請求・支払")?.href === "/office/billing.html", "請求・支払 → 請求・支払");
  check(c1.find((x) => x.label === "契約・書類")?.href === "/admin-contracts.html", "契約・書類 → 雇用契約");
  check(c1.find((x) => x.label === "端末・貸与品")?.href === "/admin-devices.html", "端末・貸与品 → 端末管理");
  check((await subs(p)).length === 0, "ホームでは2段目のタブは出ない");
  check(await p.locator(".kp-sidebar").count() === 0 && await p.locator(".kp-side-toggle, .kp-side-backdrop").count() === 0, "左サイドバー・ドロワーは無い");
  check(await p.locator('.topbar [data-shortcut="office"].on').count() === 1, "ヘッダーの Office が選ばれた状態");
  check(!(await p.locator("body").innerText()).includes("GWへ戻る"), "「GWへ戻る」は無い");
  check(called(p, /\/api\/office(\?|$)/) && called(p, /\/api\/hr\b/) && !called(p, /\/api\/closing/), "月末月初業務を使える人は /api/office から月次を読む（/api/closing は呼ばない）");
  await p.close();
}

console.log("\n— 人事（hr）: 人事・労務の数字・メニューだけ —");
{
  const p = await open("office/", { roles: ["hr"] });
  check(pathOf(p) === "/office/", `人事も Office ホームを開ける（いま ${pathOf(p)}）`);
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "勤怠要確認|入社準備", `カードは 勤怠要確認・入社準備 だけ（いま ${c.map((x) => x.label).join("|")}）`);
  const t = await todo(p);
  check(t.every((x) => !["経費精算の承認", "稼働確認待ち", "月次締め"].includes(x.label)), "経理・事務・月次業務の行は出ない");
  check(!(await p.locator("#progBox").isVisible()), "月次進捗は出ない（月末月初業務を使えない）");
  check(!called(p, /\/api\/office(\?|$)/) && !called(p, /\/api\/closing/), "経理・事務・月末月初業務の API は呼ばない");
  check((await groups(p)).join("|") === "人・組織|契約・書類|端末・貸与品", `タブは 人・組織／契約・書類／端末・貸与品（いま ${(await groups(p)).join("|")}）`);
  check(await p.locator('.topbar [data-shortcut="office"]').count() === 1, "ヘッダーに Office が出る（Office ホームに入れる）");
  await p.close();
}

console.log("\n— 経理（finance）: 経理・事務の数字・メニューだけ —");
{
  const p = await open("office/", { roles: ["finance"] });
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "経費承認待ち|月次残件|契約期限|請求未完了", `カードは 経費承認待ち・月次残件・契約期限・請求未完了（いま ${c.map((x) => x.label).join("|")}）`);
  check(!called(p, /\/api\/hr\b/), "人事・労務の API は呼ばない");
  check(await p.locator("#progBox").isVisible(), "月次進捗が出る");
  check((await groups(p)).join("|") === "請求・支払|契約・書類", `タブは 請求・支払／契約・書類（いま ${(await groups(p)).join("|")}）`);
  await p.close();
  const m = await open("office/monthly.html", { roles: ["finance"] });
  const s2 = await subs(m);
  check(s2.map((x) => x.label).join("|") === "請求・支払|経費精算|月次業務", `請求・支払の2段目（いま ${s2.map((x) => x.label).join("|")}）`);
  check(s2.find((x) => x.label === "月次業務")?.on && s2.find((x) => x.label === "月次業務")?.href === "/office/monthly.html", "月次業務が選ばれている（/office/monthly.html）");
  check((await cats(m)).find((x) => x.label === "請求・支払")?.on, "1段目は 請求・支払 が選ばれている");
  await m.close();
}

console.log("\n— 責任者（manager）: 月末月初業務だけ —");
{
  const p = await open("office/", { roles: ["manager"] });
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "月次残件|契約期限|請求未完了", `カードは 月次残件・契約期限・請求未完了（いま ${c.map((x) => x.label).join("|")}）`);
  check(!called(p, /\/api\/hr\b/) && !called(p, /\/api\/closing/), "人事・労務、経理・事務の API は呼ばない");
  check((await groups(p)).join("|") === "請求・支払", `タブは 請求・支払 だけ（いま ${(await groups(p)).join("|")}）`);
  check((await cats(p)).find((x) => x.label === "請求・支払")?.href === "/office/billing.html", "請求・支払 → 請求・支払（入れる先頭の画面）");
  await p.close();
  const m = await open("office/billing.html", { roles: ["manager"] });
  const s2 = await subs(m);
  check(s2.map((x) => x.label).join("|") === "請求・支払|月次業務", `請求・支払・月次業務だけ（いま ${s2.map((x) => x.label).join("|")}）`);
  await m.close();
}

console.log("\n— 管理者（admin。月末月初業務の権限なし）: 月次は月次締めから —");
{
  const p = await open("office/", { isAdmin: true, roles: [] });
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "勤怠要確認|経費承認待ち|月次残件|入社準備", `カード（いま ${c.map((x) => x.label).join("|")}）`);
  check(card(c, "月次残件")?.href === "/admin-closing.html" && card(c, "月次残件")?.v === "1", "月次残件は 前月の月次締め → 月次締め");
  check(!called(p, /\/api\/office(\?|$)/) && called(p, /\/api\/closing/), "/api/office は呼ばない（入れない）。/api/closing を読む");
  await p.close();
  const e = await open("admin-expenses.html", { isAdmin: true, roles: [] });
  const items = await subs(e);
  check(/(^|\/)admin-closing\.html$/.test(items.find((x) => x.label === "月次業務")?.href || ""), "2段目の月次業務 → 月次締め（入れるタブの先頭）");
  check(!items.some((x) => x.label === "請求・支払"), "請求・支払は出ない（月末月初業務の権限なし）");
  await e.close();
}

console.log("\n— 1つ取れなくても、ほかは出す —");
{
  const p = await open("office/", { roles: ["owner"], failHr: true });
  const c = await cards(p);
  check(card(c, "入社準備")?.v === "—", "取れなかったカードは「—」");
  check(card(c, "経費承認待ち")?.v === "4", "ほかのカードは出る");
  check((await p.locator("#banner").innerText()).includes("取得できなかった"), "取れなかったことが書いてある");
  await p.close();
}

console.log("\n— 権限の無い人は入れない —");
{
  const p = await open("office/", { roles: [] });
  check(pathOf(p) !== "/office/", `一般メンバーは Office ホームから送り返す（いま ${pathOf(p)}）`);
  await p.close();
}

console.log("\n— 旧URLの互換 —");
{
  const p = await open("office/?month=2026-09&id=s1", { roles: ["owner"] });
  const u = new URL(p.url());
  check(u.pathname === "/office/monthly.html" && u.searchParams.get("id") === "s1", `/office/?month=…&id=… → 月次業務（案件を開いたまま。いま ${u.pathname}${u.search}）`);
  check(await p.locator(".of-drawer").count() === 1, "旧URLの案件（id）がそのまま開く");
  await p.close();
  const q = await open("admin-dashboard.html", { roles: ["owner"] });
  check(pathOf(q) === "/office/", `admin-dashboard.html → /office/（いま ${pathOf(q)}）`);
  await q.close();
}

console.log("\n— 狭い画面：同じ横タブ（左メニュー・ドロワーは無い） —");
{
  const p = await open("office/monthly.html", { roles: ["owner"], width: 390 });
  check(await p.locator("#kp-office-nav .kp-otabs").isVisible() && await p.locator("#kp-office-nav .kp-ostabs").isVisible(), "1段目・2段目のタブが出る");
  check(await p.locator(".kp-sidebar, .kp-side-toggle, .kp-side-backdrop").count() === 0, "左サイドバー・ドロワーは無い");
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= 391, `ページは横スクロールしない（タブの帯の中だけ横に流れる。scrollWidth ${sw}）`);
  await Promise.all([p.waitForURL(/billing\.html/), p.locator('#kp-office-nav .kp-ostab:has-text("請求・支払")').click()]);
  check(pathOf(p) === "/office/billing.html", "2段目のタブで 請求・支払 へ移れる");
  await p.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
