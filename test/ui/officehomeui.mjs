// Office ホーム（/office/）を、実際のブラウザで通す。
//
// ■ 何を守りたいのか（Office UI/UX 再設計 2026-10-03）
//   ・Office ホームは全員同じ画面。違うのは、見える数字・行・左メニューだけ（担当＝/api/me の access）
//   ・サマリーカード（勤怠要確認・経費承認待ち・月次残件・入社準備・契約期限・請求未完了）は担当の分だけ。押すと一覧へ
//   ・今日やることは 要確認 → 期限超過 → 今日期限 → 今週対応 の順。優先度は色だけでなく文字でも出す
//   ・月次進捗（勤務表回収・稼働確認・売上請求・仕入請求・支払・月次完了）は、月末月初業務を使える人だけ
//   ・担当でない API は呼ばない（403 の行を作らない）。1つ取れなくても、ほかは出す（「—」）
//   ・旧URL（/office/?month=…&id=…、admin-dashboard.html）は、新しい場所へ送る
//   ・狭い画面では、左メニューはドロワー（「Office メニュー」で開く）
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
  n: n.querySelector(".oh-n").childNodes[0].textContent.trim(), href: n.getAttribute("href"),
})));
const groups = (page) => page.locator(".kp-side-group .lb").allInnerTexts().then((a) => a.map((x) => x.trim()));
const sideItems = (page) => page.locator(".kp-sidebar .kp-side-item").evaluateAll((ns) => ns.map((n) => ({
  label: n.querySelector("span:not(.material-symbols-outlined)").textContent.trim(), href: n.getAttribute("href"),
})));
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
  check(await p.locator('#cards .oh-card.hot .lb').first().evaluate((n) => getComputedStyle(n, "::after").content.includes("対応あり")),
    "件数のあるカードは、色だけでなく「対応あり」の文字も出す");

  const t = await todo(p);
  const order = ["要確認", "期限超過", "今日期限", "今週対応"];
  check(t.length > 0 && t.every((x, i) => i === 0 || order.indexOf(t[i - 1].pri) <= order.indexOf(x.pri)), `今日やることは 要確認→期限超過→今日期限→今週対応 の順（いま ${t.map((x) => x.pri).join(",")}）`);
  check(t.some((x) => x.label === "稼働確認待ち" && x.pri === "要確認" && x.href.startsWith("/office/monthly.html?month=")), "稼働確認待ち（要確認）→ 月次業務の絞り込み");
  check(t.some((x) => x.label === "経費精算の承認" && x.n === "4"), "経費精算の承認 4件");
  check(t.some((x) => x.label === "勤怠の修正申請" && x.pri === "要確認"), "勤怠の修正申請（要確認）");
  check(t.some((x) => x.label === "入社準備" && x.n === "2"), "入社準備 2件");
  check(t.some((x) => x.label === "契約期限の確認" && x.n === "1"), "契約期限の確認 1件");
  check(t.some((x) => x.label === "支払の登録・確認" && x.n === "1"), "支払の登録・確認 1件（BP）");

  check(await p.locator("#progBox").isVisible(), "月次進捗が出る");
  const prog = await p.locator("#prog .row span:first-child").allInnerTexts();
  check(prog.join("|") === "勤務表回収|稼働確認|売上請求（送付）|仕入請求（受領）|支払|月次完了", `月次進捗：勤務表回収〜支払〜月次完了（いま ${prog.join("|")}）`);
  check((await p.locator("#closeNote").innerText()).includes("月次完了：未完了"), "月次完了の状態（未完了）を文字で出す");

  check((await groups(p)).join("|") === "人事・労務|経理・事務|社内管理", `左メニューは 人事・労務／経理・事務／社内管理（いま ${(await groups(p)).join("|")}）`);
  const items = await sideItems(p);
  const lbl = items.map((x) => x.label);
  for (const x of ["ホーム", "メンバー", "入退社", "勤怠管理", "雇用契約", "評価・キャリア", "経費精算", "月次業務", "請求・支払", "会計", "社内文書", "お知らせ配信"]) {
    check(lbl.includes(x), `左メニューに「${x}」`);
  }
  check(items.find((x) => x.label === "ホーム")?.href === "/office/", "ホーム → /office/");
  check(items.find((x) => x.label === "月次業務")?.href === "/office/monthly.html", "月次業務 → /office/monthly.html");
  check(items.find((x) => x.label === "メンバー")?.href === "/admin-members.html", "下の階層の画面からも、管理画面へはルートから開く（/admin-members.html）");
  check(await p.locator(".kp-sidebar .kp-side-item.on span:not(.material-symbols-outlined)").first().innerText().then((x) => x.trim() === "ホーム"), "ホームが選ばれた状態");
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
  check((await groups(p)).join("|") === "人事・労務", `左メニューは 人事・労務 だけ（いま ${(await groups(p)).join("|")}）`);
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
  check((await groups(p)).join("|") === "経理・事務|社内管理", `左メニューは 経理・事務／社内管理（いま ${(await groups(p)).join("|")}）`);
  const lbl = (await sideItems(p)).map((x) => x.label);
  check(["経費精算", "月次業務", "請求・支払", "社内文書"].every((x) => lbl.includes(x)) && !lbl.includes("メンバー"), `経理・事務の項目（${lbl.join("|")}）`);
  await p.close();
}

console.log("\n— 責任者（manager）: 月末月初業務だけ —");
{
  const p = await open("office/", { roles: ["manager"] });
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "月次残件|契約期限|請求未完了", `カードは 月次残件・契約期限・請求未完了（いま ${c.map((x) => x.label).join("|")}）`);
  check(!called(p, /\/api\/hr\b/) && !called(p, /\/api\/closing/), "人事・労務、経理・事務の API は呼ばない");
  check((await groups(p)).join("|") === "経理・事務", `左メニューは 経理・事務 だけ（いま ${(await groups(p)).join("|")}）`);
  const items = await sideItems(p);
  check(items.map((x) => x.label).join("|") === "ホーム|月次業務|請求・支払", `月次業務・請求・支払だけ（いま ${items.map((x) => x.label).join("|")}）`);
  await p.close();
}

console.log("\n— 管理者（admin。月末月初業務の権限なし）: 月次は月次締めから —");
{
  const p = await open("office/", { isAdmin: true, roles: [] });
  const c = await cards(p);
  check(c.map((x) => x.label).join("|") === "勤怠要確認|経費承認待ち|月次残件|入社準備", `カード（いま ${c.map((x) => x.label).join("|")}）`);
  check(card(c, "月次残件")?.href === "/admin-closing.html" && card(c, "月次残件")?.v === "1", "月次残件は 前月の月次締め → 月次締め");
  check(!called(p, /\/api\/office(\?|$)/) && called(p, /\/api\/closing/), "/api/office は呼ばない（入れない）。/api/closing を読む");
  const items = await sideItems(p);
  check(items.find((x) => x.label === "月次業務")?.href === "/admin-closing.html", "左メニューの月次業務 → 月次締め（入れるタブの先頭）");
  check(!items.some((x) => x.label === "請求・支払"), "請求・支払は出ない（月末月初業務の権限なし）");
  await p.close();
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

console.log("\n— 狭い画面：左メニューはドロワー —");
{
  const p = await open("office/", { roles: ["owner"], width: 390 });
  const nav = p.locator("#kp-office-nav");
  const toggle = p.locator(".kp-side-toggle");
  check(await toggle.isVisible(), "「Office メニュー」ボタンが出る");
  check(!(await nav.isVisible()), "最初は閉じている（本文を押し下げない）");
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= 391, `横スクロールしない（scrollWidth ${sw}）`);
  await toggle.click();
  await p.waitForTimeout(300);
  check(await nav.isVisible(), "押すと開く");
  await p.locator('#kp-office-nav .kp-side-group[data-group="office-ops"]').click();
  check(await p.locator('#kp-office-nav .kp-side-item:has-text("月次業務")').isVisible(), "開いたメニューで経理・事務を開き、月次業務を押せる");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  check(!(await nav.isVisible()), "Esc で閉じる");
  await p.close();
  const w = await open("office/", { roles: ["owner"] });
  check(!(await w.locator(".kp-side-toggle").isVisible()), "広い画面ではボタンは出ない");
  check(await w.locator("#kp-office-nav").isVisible(), "広い画面では左メニューがいつも出る");
  await w.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
