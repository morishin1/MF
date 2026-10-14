// 退職証明書の本人申請・同意・承認（2026-10-08 入退社管理画面の改修 ４）を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   [本人] 退職者ポータル（退職者）・マイページ（退職手続き中）から申請できる。在籍中の人には欄を出さない。
//          記載してほしい項目をチェックボックスで選ぶ。誓約（NDA）にチェックしないと「発行を申請する」を押せない。
//          申請すると、申請中（日時・選んだ項目・誓約済の日時）を出す
//   [人事] 入退社の画面のチェックリスト「退職証明書の交付」に「申請あり」。開くと、選んだ項目・誓約の日時と証跡・印字される本文。
//          「承認して発行」は経営者・管理者だけ押せる（人事には理由を出す）。押すと、完了日・対応者が付いて項目が閉じる
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const { accessOf } = await import("../../lib/gw.js");
const L = await import("../../lib/retire-cert-request.js");
const OPTIONS = { items: L.CERT_ITEMS.map((i) => ({ key: i.key, label: i.label })), ndaText: L.NDA_TEXT, ndaVersion: L.NDA_VERSION };

async function ctxOf(width = 1280) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@example.com" }));
    for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k);
  });
  return ctx;
}
const send = (route, b, st = 200) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });

console.log("— 退職者ポータル：項目を選び、誓約にチェックして申請 —");
for (const width of [1280, 390]) {
  const ctx = await ctxOf(width);
  const posts = [];
  await ctx.route("**/api/**", async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (/\/api\/me\b/.test(u.pathname)) return send(route, { email: "left@example.com", appRole: "member", gw: { left: true, employee: { id: "e-left" } } });
    if (u.pathname === "/api/retiree" && req.method() === "POST") {
      const b = JSON.parse(req.postData() || "{}"); posts.push(b);
      return send(route, { ok: true, request: { id: "q1", status: "requested", items: b.items.map((k) => ({ key: k, label: OPTIONS.items.find((i) => i.key === k).label })),
        requestedAt: "2026-10-08T01:00:00Z", nda: { text: L.NDA_TEXT, version: L.NDA_VERSION, agreedAt: "2026-10-08T01:00:00Z" } } });
    }
    if (u.pathname === "/api/retiree") return send(route, { name: "退職 太郎", leftOn: "2026-09-30", docs: [{ kind: "certificate", label: "退職証明書", state: "preparing" }], certRequest: { options: OPTIONS, request: null } });
    return send(route, {});
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/retiree/`);
  await page.waitForSelector("[data-cq-box]", { timeout: 10000 });
  const labels = (await page.locator('[data-cq-box] label.it').allInnerTexts()).map((x) => x.trim());
  check(labels.join("|") === "在籍期間（使用期間）|業務の種類|役職（その事業における地位）|賃金|退職事由（解雇の場合はその理由を含む）", `${width}：記載項目をチェックボックスで選ぶ（${labels.join("|")}）`);
  const go = page.locator("#cq-go");
  check(await go.isDisabled(), `${width}：初めは押せない`);
  await page.locator('input[name="cq-item"][value="period"]').check();
  check(await go.isDisabled(), `${width}：項目を選んでも、誓約にチェックしないと押せない`);
  await page.locator("#cq-nda").check();
  check(!(await go.isDisabled()), `${width}：項目＋誓約で押せる`);
  await page.locator('input[name="cq-item"][value="period"]').uncheck();
  check(await go.isDisabled(), `${width}：項目が0なら押せない`);
  await page.locator('input[name="cq-item"][value="period"]').check();
  await page.locator('input[name="cq-item"][value="cause"]').check();
  await page.screenshot({ path: shotPath(`cert-request-${width}.png`), fullPage: true });
  const nda = await page.locator("label.nda").innerText();
  check(nda.includes("秘密保持契約（NDA）") && nda.includes("必須"), `${width}：誓約の文面（必須）は申請ボタンの直前`);
  const y = await page.evaluate(() => [document.querySelector("label.nda").getBoundingClientRect().bottom, document.getElementById("cq-go").getBoundingClientRect().top]);
  check(y[0] <= y[1], `${width}：誓約 → 申請ボタンの順`);
  await go.click();
  await page.waitForSelector('[data-cq="requested"]', { timeout: 5000 }).catch(() => {});
  check(posts.length === 1 && posts[0].action === "cert_request" && posts[0].ndaAgreed === true && posts[0].items.join(",") === "period,cause", `${width}：申請を送る（${JSON.stringify(posts[0])}）`);
  const st = await page.locator('[data-cq="requested"]').innerText().catch(() => "");
  check(st.includes("申請しました") && st.includes("在籍期間") && st.includes("誓約済"), `${width}：申請中（日時・項目・誓約済）`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${width}：横にはみ出さない（${over}px）`);
  check(errs.length === 0, `${width}：画面のエラーなし（${errs.join(" / ")}）`);
  await ctx.close();
}

console.log("\n— マイページ：退職手続き中の人だけ —");
for (const [label, canRequest] of [["退職手続き中", true], ["在籍中", false]]) {
  const ctx = await ctxOf();
  await ctx.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    if (/\/api\/me\b/.test(u.pathname)) return send(route, { email: "a@example.com", appRole: "member", isAdmin: false,
      gw: { employee: { id: "e1", display_name: "本人", status: canRequest ? "leaving" : "active" }, roles: [], tenantId: "t1", stage: { key: canRequest ? "leaving" : "member" } }, access: accessOf({ roles: [] }) });
    if (u.pathname === "/api/employees/cert-request") return send(route, { canRequest, options: OPTIONS, request: null });
    if (/notifications/.test(u.pathname)) return send(route, { notifications: [], unread: 0 });
    return send(route, {});
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/mypage.html`);
  await page.waitForTimeout(1500);
  const shown = await page.locator("#cert-card").isVisible();
  check(shown === canRequest, `${label}：退職証明書の申請の欄を${canRequest ? "出す" : "出さない"}`);
  await ctx.close();
}

console.log("\n— 人事・経営者：入退社の画面で受け取り、承認して発行 —");
const PROC = (done = false) => ({ procedure: {
  id: "p-off", kind: "offboarding", name: "退職 太郎", employeeId: "e-off", department: "開発", targetOn: "2026-10-31", days: 23, due: "退社まで23日",
  phase: "prep", phaseLabel: "退社準備", progress: { done: done ? 2 : 1, total: 2 }, urgency: "ok",
  groups: [{ role: "hr", label: "人事", done: done ? 2 : 1, total: 2, items: [
    { id: "o1", key: "off_hr_date", title: "退職日の確認", owner: "hr", ownerLabel: "人事", phase: "prep", done: true, completedAt: "2026-10-07T01:00:00Z", completedByName: "人事 花子", assignee: null, href: null },
    { id: "o2", key: "off_hr_cert", title: "退職証明書の交付", owner: "hr", ownerLabel: "人事", phase: "lastday", done, completedAt: done ? "2026-10-08T03:00:00Z" : null, completedByName: done ? "経営 太郎" : null, assignee: null, href: null },
  ] }], drive: null }, roles: [], people: [] });
const CASE = (canIssueCert, issued = false) => ({
  employee: { id: "e-off", name: "退職 太郎", statusLabel: "退職手続き中", status: "leaving", leftOn: "2026-10-31", lastWorkOn: null, reasonLabel: "自己都合", owner: null, updatedAt: "x", caseUpdatedAt: null },
  ready: { case: true, docs: true, cert: true }, canIssueCert, staff: [],
  certRequest: issued
    ? { id: "q1", status: "issued", items: [{ key: "period", label: "在籍期間（使用期間）" }], requestedAt: "2026-10-08T01:00:00Z", decidedAt: "2026-10-08T03:00:00Z", decidedByName: "経営 太郎",
        nda: { text: L.NDA_TEXT, version: L.NDA_VERSION, agreedAt: "2026-10-08T01:00:00Z" } }
    : { id: "q1", status: "requested", items: [{ key: "period", label: "在籍期間（使用期間）" }, { key: "cause", label: "退職事由（解雇の場合はその理由を含む）" }],
        requestedAt: "2026-10-08T01:00:00Z", nda: { text: L.NDA_TEXT, version: L.NDA_VERSION, agreedAt: "2026-10-08T01:00:00Z", ip: "203.0.113.9" },
        preview: "退職 太郎 殿\n\n下記の事項について、相違ないことを証明します。\n\n使用期間：2025年4月1日から2026年10月31日まで\n退職の事由：自己都合", missing: [] },
  next: [], self: [], docs: [], accounts: [], accountStates: [], assets: [],
  guide: { email: "", slack: "", url: "https://x", urlNote: "" }, remind: { email: "", slack: "", url: "https://x", urlNote: "" }, history: [],
});
for (const [who, canIssue] of [["人事", false], ["経営者", true]]) {
  const ctx = await ctxOf();
  const posts = [];
  let issued = false;
  await ctx.route("**/api/**", async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.pathname === "/api/employees/cert-request" && req.method() === "POST") { posts.push(JSON.parse(req.postData() || "{}")); issued = true; return send(route, { ok: true }); }
    if (u.pathname === "/api/employees/retire-case") return send(route, CASE(canIssue, issued));
    if (u.pathname === "/api/hr") return send(route, u.searchParams.get("id") ? PROC(issued) : { tabs: [], onboarding: [], offboarding: [], done: [], kpi: {} });
    if (/\/api\/hr\/retention/.test(u.pathname)) return send(route, { today: "2026-10-08", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/onboarding\/orientation/.test(u.pathname)) return send(route, { items: [], kinds: [], done: true });
    if (/\/api\/me\b/.test(u.pathname)) return send(route, { email: "a@example.com", appRole: canIssue ? "owner" : "member", isAdmin: false, roles: [],
      gw: { employee: { id: "e-me", display_name: who, status: "active" }, roles: [canIssue ? "owner" : "hr"], tenantId: "t1", stage: null },
      access: accessOf({ isAdmin: false, isHr: true, roles: [canIssue ? "owner" : "hr"], apps: ["hr", "office"] }) });
    if (/notifications/.test(u.pathname)) return send(route, { notifications: [], unread: 0 });
    return send(route, {});
  });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/admin-hr.html?id=p-off`);
  await page.waitForSelector('[data-role="cert-badge"]', { timeout: 10000 }).catch(() => {});
  const item = page.locator('.hx-item[data-key="off_hr_cert"]');
  check(await item.locator('[data-role="cert-badge"]').innerText().catch(() => "") === "申請あり", `${who}：チェックリストの「退職証明書の交付」に「申請あり」`);
  check((await item.getAttribute("class")).includes("open"), `${who}：上から最初の未完了なので、開いている`);
  check((await item.locator('[data-role="cert-items"]').innerText()).includes("在籍期間") && (await item.locator('[data-role="cert-items"]').innerText()).includes("退職事由"), `${who}：本人が選んだ記載項目`);
  check(/2026\/10\/8 10:00 誓約済/.test(await item.locator('[data-role="cert-nda"]').innerText()), `${who}：誓約の同意日時と証跡（2026/10/8 10:00 誓約済）`);
  check((await item.locator('[data-role="cert-preview"]').innerText()).includes("使用期間："), `${who}：証明書に印字される内容`);
  await item.screenshot({ path: shotPath(`cert-approve-${canIssue ? "owner" : "hr"}.png`) });
  check(await item.locator('.hx-row input[type="checkbox"]').isDisabled(), `${who}：申請中は、チェックを付けられない`);
  check(await item.locator('.hx-foot button[data-act="done"]').isHidden(), `${who}：申請中は、汎用の［完了にする］を出さない`);
  check((await item.locator('[data-role="cert-lock"]').innerText()).includes("承認して発行"), `${who}：理由（承認して発行で自動で完了）`);
  const btn = item.locator('button[data-act="cert-approve"]');
  if (!canIssue) {
    check(await btn.isDisabled() && (await item.locator('[data-role="cert-who"]').innerText()).includes("経営者・管理者だけ"), "人事：「承認して発行」は押せない（経営者・管理者に依頼）");
  } else {
    check(!(await btn.isDisabled()), "経営者：「承認して発行」を押せる");
    await btn.click();
    await page.waitForTimeout(1200);
    check(posts.length === 1 && posts[0].action === "approve" && posts[0].requestId === "q1" && posts[0].employeeId === "e-off", `承認して発行を送る（${JSON.stringify(posts[0])}）`);
    check(!(await item.getAttribute("class")).includes("open") && (await item.getAttribute("class")).includes("done"), "完了になって、アコーディオンが閉じる");
    check((await item.locator('[data-role="done-at"]').innerText()).includes("10/8 完了・経営 太郎"), "完了日・対応者が付く");
    check(await item.locator('[data-role="cert-badge"]').count() === 0, "「申請あり」は消える");
    check(await item.locator('.hx-row input[type="checkbox"]').isDisabled(), "発行済み：完了のまま（チェックを外せない）");
  }
  await ctx.close();
}

console.log("\n— 申請なし：これまでどおり手で完了にできる（紙で別に発行する場合）—");
{
  const ctx = await ctxOf();
  await ctx.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/employees/retire-case") return send(route, { ...CASE(false), certRequest: null });
    if (u.pathname === "/api/hr") return send(route, u.searchParams.get("id") ? PROC(false) : { tabs: [], onboarding: [], offboarding: [], done: [], kpi: {} });
    if (/\/api\/hr\/retention/.test(u.pathname)) return send(route, { today: "2026-10-08", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/me\b/.test(u.pathname)) return send(route, { email: "a@example.com", appRole: "member", gw: { employee: { id: "e-me", display_name: "人事", status: "active" }, roles: ["hr"], tenantId: "t1", stage: null },
      access: accessOf({ isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"] }) });
    return send(route, {});
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin-hr.html?id=p-off`);
  await page.waitForSelector("#rc-cert", { state: "attached", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  const item = page.locator('.hx-item[data-key="off_hr_cert"]');
  check(!(await item.locator('.hx-row input[type="checkbox"]').isDisabled()) && await item.locator('.hx-foot button[data-act="done"]').isVisible(), "申請なし：チェック・［完了にする］が使える");
  check(await item.locator('[data-role="cert-lock"]').count() === 0, "申請なし：止める理由は出ない");
  await ctx.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
