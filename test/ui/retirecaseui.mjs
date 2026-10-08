// 退職手続きの1画面（入退社管理 ＞ 退社の詳細）を、実際のブラウザで通す。
//
// ■ どこまで本物か
//   画面（admin-hr.html）は本物。退職手続きの通信は、本物のハンドラ（api/employees/retire-case.js・retire.js）につなぐ。
//   DB・ログインだけが偽物（test/_retireharness.mjs）。入退社の一覧・チェックリスト（/api/hr）は固定の応答。
//
// ■ 守ること
//   ・並び：上の操作［退職日を変更］［本人へ案内］［再通知］［手続き履歴］→ 基本情報 → 次にやること → 本人対応 → 書類 →
//     アカウント → 貸与品 → 連絡 → 履歴。これまでのチェックリスト（人事・社労士・本人）は消さずに、その下
//   ・次にやることを押すと、その欄へ移る
//   ・退職日の保存：保存できる・在籍状態は変わらない／ほかの担当者の更新は上書きしない／すぐ止まる日付は確認してから
//   ・返却の確認・サービスの停止の記録（担当者による停止確認）
//   ・案内文のコピーは送信ではない（送信済みと出さない）。再通知は未完了だけ
//   ・履歴は本人と管理者を分ける
//   ・db/123 が未適用でも開く（その操作だけ使えない）
//   ・PC 幅と 390px で、主要なボタンが押せる・長い氏名や書類名でも横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { db, current, api, retireApi, setup, NEXTWEEK, YESTERDAY, ymdOffset } from "../_retireharness.mjs";

const { accessOf } = await import("../../lib/gw.js");
const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const LIST = () => ({
  tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
  onboarding: [], offboarding: [{ id: "p-soon", kind: "offboarding", name: db.rows.gw_employees.find((e) => e.id === "e-soon").display_name, department: "開発",
    targetOn: NEXTWEEK, days: 7, due: "退社まで7日", phase: "prep", phaseLabel: "退社準備", progress: { done: 1, total: 3 }, urgency: "warn", next: { title: "PCの返却", role: "IT・管理", who: "情報 次郎" } }],
  done: [], people: [], roles: [], today: "2026-10-06",
});
const ONE = () => ({ procedure: { ...LIST().offboarding[0], employeeId: "e-soon", groups: [
  { role: "hr", label: "人事", done: 1, total: 2, items: [
    { id: "i1", title: "退職届の受領", owner: "hr", ownerLabel: "人事", phase: "prep", done: true, assignee: { id: "e-hr", name: "名前hr" }, href: null, completedAt: "2026-10-02T00:00:00Z" },
    { id: "i2", title: "離職票の手続き", owner: "hr", ownerLabel: "人事", phase: "prep", done: false, assignee: { id: "e-hr", name: "名前hr" }, href: null }] },
  { role: "labor_advisor", label: "社労士", done: 0, total: 1, items: [
    { id: "i3", title: "資格喪失届", owner: "labor_advisor", ownerLabel: "社労士", phase: "prep", done: false, assignee: null, href: null }] },
  { role: "employee", label: "本人", done: 0, total: 1, items: [
    { id: "i4", title: "退職届の提出", owner: "employee", ownerLabel: "本人", phase: "prep", done: false, assignee: null, href: null }] }],
  drive: null }, roles: [], people: [] });

async function handle(handler, route) {
  const req = route.request();
  const u = new URL(req.url());
  current.userId = "u-hr";
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  await handler({ method: req.method(), url: u.pathname + u.search, headers: { ...req.headers(), authorization: "Bearer x", host: "gw.example.com" },
    body: req.postData() ? JSON.parse(req.postData()) : undefined }, r);
  return route.fulfill({ status: r.statusCode || 200, contentType: "application/json", body: JSON.stringify(r.body ?? {}) });
}

async function open({ width = 1280 } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@example.com" }));
    for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k);
  });
  await ctx.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (path === "/api/employees/retire-case") return handle(api, route);
    if (path === "/api/employees/retire") return handle(retireApi, route);
    if (path === "/api/hr") return send(route.request().url().includes("id=") ? ONE() : LIST());
    if (/\/api\/hr\/retention/.test(path)) return send({ today: "2026-10-06", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/onboarding\/orientation/.test(path)) return send({ items: [], kinds: [], done: true });
    if (/\/api\/me\b/.test(path)) {
      return send({ email: "hr@example.com", appRole: "member", isAdmin: false, roles: [],
        gw: { employee: { id: "e-hr", display_name: "名前hr", status: "active" }, roles: ["hr"], tenantId: "t1", stage: null },
        access: accessOf({ isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"] }) });
    }
    if (/\/api\/notifications/.test(path)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(path)) return send({ badges: {} });
    return send({});
  });
  await ctx.route("https://storage.test/**", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: Buffer.from("%PDF-1.4") }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/admin-hr.html?id=p-soon`);
  await page.waitForSelector("#rc-basic", { state: "attached", timeout: 15000 });
  page.ctx = ctx;
  return page;
}
// 作業の場所は、チェックリストの項目の中（閉じている）。画面の関数で開いてから触る（人が項目を押すのと同じ）
const reveal = (page, sel) => page.evaluate((x) => { const n = document.querySelector(x); if (n) hxReveal(n); }, sel);
const text = (page, sel) => page.locator(sel).innerText();
const reload = async (page) => { await page.waitForTimeout(400); };

console.log("— 並び：警告 → ステップ → チェックリスト（いちばん上）→ 次にやること → タブ —");
setup();
{
  const page = await open();
  const order = await page.evaluate(() => ["hx-steps", "hr-checklist", "rc-next"].map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? -1)
    .concat([document.querySelector(".hx-tabs")?.getBoundingClientRect().top ?? -1]));
  check(order.every((y, i) => y >= 0 && (i === 0 || y > order[i - 1])), `ステップ → チェックリスト → 次にやること → タブ（${order.map(Math.round).join(",")}）`);
  check((await page.locator(".hx-band").innerText()).includes("退社手続き") && await page.locator(".hx.off").count() === 1, "退社手続きと分かる帯（退社の色）");
  const steps = (await page.locator(".hx-steps li").allInnerTexts()).map((x) => x.replace(/^\d+\.\s*/, "").trim());
  check(steps.join("|") === "退職合意|アカウント停止・貸与品回収|最終給与・精算|書類発行|完了", `ステップ（${steps.join("|")}）`);
  check(await page.locator(".hx-steps li.current").count() === 1, "いまの段階が1つ強調される");
  const tabs = (await page.locator(".hx-tabs button").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("|") === "基本情報|連絡|手続き履歴|書類の保管先", `タブ（${tabs.join("|")}）`);
  // この画面の項目（退職届の受領など）には、作業の場所が結びつかない → 「そのほかの作業」に全部出る（画面から消えない）
  const extras = await page.locator('[data-role="hx-extras"] .hx-item').evaluateAll((ns) => ns.map((n) => n.dataset.key));
  check(["x-basic", "x-docs", "x-assets", "x-acct-slack"].every((k) => extras.includes(k)), `そのほかの作業（${extras.join(",")}）`);
  check(await page.locator('.hx-item[data-key="x-assets"] .hx-panel').isHidden(), "作業の場所は、押すまで閉じている");
  await page.locator('.hx-item[data-key="x-assets"] .hx-t').click();
  check(await page.locator("#rc-assets").isVisible(), "押すと、その下に貸与品の欄が開く");
  await page.locator('.hx-item[data-key="x-assets"] .hx-t').click();
  check(await page.locator("#rc-assets").isHidden(), "もう一度押すと閉じる");
  const done = await page.locator(".hx-item", { hasText: "退職届の受領" }).locator('[data-role="done-at"]').innerText();
  check(/10\/2 完了/.test(done), `チェックした日を出す（${done}）`);
  const bar = (await page.locator('[data-role="rc-bar"] button').allInnerTexts()).map((x) => x.trim());
  check(bar.join("|") === "退職日を変更|本人へ案内|再通知|手続き履歴", `上の操作（${bar.join("|")}）`);
  check(await page.locator("#rc #hr-checklist").count() === 1, "チェックリスト（人事・社労士・本人）は、退職手続きの画面の中のいちばん上");
  check((await page.locator(".hr-grp .h b").allInnerTexts()).join("|") === "人事|社労士|本人", "チェックリストの3つの担当");
  check(await page.locator(".hr-now").count() === 0, "古いチェックリストから作った「次にやること」は出さない（実データの次にやることと食い違わない）");
  check((await text(page, "#rc-basic")).includes(NEXTWEEK.replace(/-/g, "/")), "基本情報に退職日");
  check((await text(page, "#rc-basic")).includes("自己都合"), "退職理由（分類）");
  for (const bad2 of ["db/", "gw_", "officeHr", "hr_flow"]) check(!(await page.locator("#rc").innerText()).includes(bad2), `画面に内部の名前（${bad2}）を出さない`);

  // 次にやること → その欄へ
  const nx = page.locator('#rc-next button', { hasText: "PC返却待ち" });
  check(await nx.count() === 1, "次にやること：PC返却待ち（MacBook 01）");
  await nx.click();
  await page.waitForTimeout(300);
  check(await page.locator("#rc-assets.hl").count() === 1, "押すと貸与品の欄へ移る");

  // 本人対応：受領・署名は記録なし（未対応・完了と決めつけない）
  const selfText = await text(page, "#rc-self");
  check(selfText.includes("記録なし（受領の確認はまだありません）") && selfText.includes("公開中"), "本人対応：公開・開いた・受領・署名を別々に");
  // 「送信済みにはなりません」という説明だけ。送信済みという状態は、どこにも出さない
  check(!/送信済(?!み」?にはなりません)/.test(await page.locator("#rc").innerText()), "どこにも「送信済」の状態を出さない");
  await page.screenshot({ path: shotPath("retire-case-pc.png"), fullPage: true });
  await page.ctx.close();
}

console.log("\n— 退職日の保存 —");
setup();
{
  const page = await open();
  await page.locator('[data-role="rc-bar"] button', { hasText: "退職日を変更" }).click();
  await page.fill("#rc-left", ymdOffset(12));
  await page.fill("#rc-last", ymdOffset(11));
  await page.selectOption("#rc-owner", "e-hr");
  await page.locator('[data-role="dates-form"] button', { hasText: "保存する" }).click();
  await page.waitForFunction(() => /保存しました/.test(document.getElementById("rc-basic-msg")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  const e = db.rows.gw_employees.find((x) => x.id === "e-soon");
  check(e.left_on === ymdOffset(12) && e.status === "leaving", `保存できる・在籍状態は変わらない（${e.left_on} / ${e.status}）`);
  const msg = await text(page, "#rc-basic-msg");
  check(/保存しました/.test(msg) && msg.includes("退職証明書") && msg.includes("書き換えていません"), `発行済みの書類は書き換えず、再発行を案内（${msg}）`);
  check((await text(page, "#rc-basic")).includes("名前hr"), "担当者が出る");

  // ほかの担当者が先に更新していた
  await page.locator('[data-role="rc-bar"] button', { hasText: "退職日を変更" }).click();
  db.rows.gw_employees.find((x) => x.id === "e-soon").updated_at = "2026-10-06T09:00:00.000009+00:00";
  await page.fill("#rc-left", ymdOffset(20));
  await page.locator('[data-role="dates-form"] button', { hasText: "保存する" }).click();
  await page.waitForTimeout(1200);
  check(/ほかの担当者が先に更新しました/.test(await text(page, "#rc-basic-msg")), "競合：上書きせず、読み直すよう出す");
  check(db.rows.gw_employees.find((x) => x.id === "e-soon").left_on === ymdOffset(12), "競合のときは保存しない");

  // すぐ止まる日付は、確認してから（やめたら保存しない）
  await page.locator('[data-role="rc-bar"] button', { hasText: "退職日を変更" }).click();
  await page.fill("#rc-left", YESTERDAY);
  await page.fill("#rc-last", "");
  const dialogs = [];
  page.once("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.locator('[data-role="dates-form"] button', { hasText: "保存する" }).click();
  await page.waitForTimeout(1000);
  check(dialogs.length === 1 && /すぐに通常業務/.test(dialogs[0]), "過去の日付は、すぐ止まることを確認する");
  check(db.rows.gw_employees.find((x) => x.id === "e-soon").left_on === ymdOffset(12), "確認でやめたら保存しない");
  await page.ctx.close();
}

console.log("\n— 貸与品・アカウント・書類 —");
setup();
{
  const page = await open();
  await reveal(page, "#rc-assets");
  const row = page.locator('#rc-assets tr[data-asset="a-pc"]');
  await row.locator("button", { hasText: "返却を確認" }).click();
  await page.waitForFunction(() => /返却を確認しました/.test(document.getElementById("rc-assets-msg")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  check((await page.locator('#rc-assets tr[data-asset="a-pc"]').innerText()).includes("返却確認済"), "返却を確認 → 返却確認済");
  check(db.rows.gw_assets.find((a) => a.id === "a-pc").assigned_to === null, "台帳の貸出先が外れる");
  check(await page.locator('#rc-next button', { hasText: "MacBook" }).count() === 0, "次にやることから消える");

  await reveal(page, '[data-acct="slack"]');
  const slack = page.locator('tr[data-acct="slack"]');
  check((await slack.innerText()).includes("未確認"), "Slack は記録が無ければ未確認");
  await slack.locator("select").selectOption("stopped");
  await slack.locator("button", { hasText: "記録" }).click();
  await page.waitForFunction(() => /記録しました/.test(document.getElementById("rc-accounts-msg-acct-slack")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  const st = await page.locator('tr[data-acct="slack"]').innerText();
  check(st.includes("停止済") && st.includes("担当者による停止確認") && st.includes("名前hr"), "停止済：担当者による停止確認・対応者");
  check(await page.locator('[data-accounts="acct-slack"] tr[data-acct]').count() === 1, "Slack の欄には Slack だけ（その項目で止めるサービスだけ）");
  await reveal(page, '[data-acct="groupware"]');
  const gw = await page.locator('tr[data-acct="groupware"]').innerText();
  check(gw.includes("停止予定") && gw.includes("自動停止予定"), "グループウェアは自動停止予定（退職日の翌日）");
  check(await page.locator('tr[data-acct="lms"] select').count() === 0, "自動のサービスは手で記録しない");

  await reveal(page, "#rc-docs");

  const doc = page.locator('#rc-docs tr[data-doc="withholding"]');
  check((await doc.innerText()).includes("発行済み・未公開"), "源泉徴収票：発行済み・未公開");
  await doc.locator("button", { hasText: "本人に公開" }).click();
  await page.waitForFunction(() => /本人に公開しました/.test(document.getElementById("rc-docs-msg")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  check((await page.locator('#rc-docs tr[data-doc="withholding"]').innerText()).includes("本人に公開中"), "本人に公開 → 公開中");
  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 8000 }).catch(() => null),
    page.locator('#rc-docs tr[data-doc="certificate"] button', { hasText: "PDFを見る" }).click()]);
  check(Boolean(popup), "PDF を別タブでプレビュー（権限を確かめた短時間の URL）");
  if (popup) await popup.close();

  // 履歴：本人と管理者を分ける
  await page.locator('[data-role="rc-bar"] button', { hasText: "手続き履歴" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("#rc-history").isVisible() && (await page.locator('.hx-tabs button[aria-selected="true"]').innerText()).trim() === "手続き履歴", "手続き履歴のタブが開く");
  const hist = await page.locator("#rc-history li").allInnerTexts();
  check(hist.some((h) => h.includes("返却を確認：MacBook 01") && h.includes("管理者")), "履歴：返却の確認（管理者）");
  check(hist.some((h) => h.includes("Slack") && h.includes("担当者による停止確認")), "履歴：Slack の停止の記録");
  await page.ctx.close();
}

console.log("\n— 連絡（コピーは送信ではない）—");
setup();
{
  const page = await open();
  await page.locator('[data-role="rc-bar"] button', { hasText: "本人へ案内" }).click();
  const mail = await page.locator("#rc-mail").inputValue();
  check(mail.includes("名前soon") && mail.includes("退職証明書") && mail.includes("PC：MacBook 01"), "メール文：氏名・公開中の書類・返却物");
  check(!mail.includes("家庭の事情") && !mail.includes("/admin") && !mail.includes("社内メモ"), "退職理由のメモ・管理者用 URL・社内メモを入れない");
  const btn = page.locator("#rc-contact button", { hasText: "メール文をコピー" });
  await btn.click();
  await page.waitForFunction(() => [...document.querySelectorAll("#rc-contact button")].some((b) => /送信はしていません/.test(b.textContent)), null, { timeout: 3000 }).catch(() => {});
  check(await page.locator("#rc-contact button", { hasText: "送信はしていません" }).count() === 1, "コピーしても「送信はしていません」と出す");
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  check(clip === null || clip === mail, "メール文がコピーされる");
  await page.locator('[data-role="rc-bar"] button', { hasText: "再通知" }).click();
  const rem = await page.locator("#rc-mail").inputValue();
  check(rem.includes("まだお済みでない") && !rem.includes("ご確認いただける書類"), "再通知：未完了の項目だけの文面");
  check((await text(page, "#rc-contact")).includes("実際には送りません"), "再通知は実送信しないと明示");
  await page.ctx.close();
}

console.log("\n— db/123 が未適用 —");
setup();
for (const t of ["gw_retire_events", "gw_retire_asset_returns", "gw_retire_accounts"]) db.absent.add(t);
{
  const page = await open();
  check(await page.locator('[data-role="not-ready-banner"]').count() === 1, "準備未完了の案内が出る");
  check(await page.locator('[data-role="rc-bar"] button', { hasText: "退職日を変更" }).isDisabled(), "退職日の変更は押せない");
  check(await page.locator("#rc-assets button", { hasText: "返却を確認" }).count() === 0, "返却の操作は出さない");
  check((await text(page, "#rc-docs")).includes("退職証明書"), "書類（db/121）は、そのまま使える");
  await page.ctx.close();
}

console.log("\n— スマホ幅（390px）・長い名前 —");
setup();
db.rows.gw_employees.find((e) => e.id === "e-soon").display_name = "とても長い氏名のテスト用の名前ですとても長い氏名のテスト用の名前です";
db.rows.gw_assets.find((a) => a.id === "a-pc").name = "MacBookPro16インチ2023年モデル開発部共用機材管理番号つき長い名前の貸与品";
{
  const page = await open({ width: 390 });
  for (const k of ["x-assets", "x-acct-slack"]) await page.locator(`.hx-item[data-key="${k}"] .hx-t`).click();
  const over = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll("#rc *")].filter((n) => n.getBoundingClientRect().width > 0)
      .map((n) => Math.round(n.getBoundingClientRect().right - W)).reduce((a, b) => Math.max(a, b), -999);
  });
  check(over <= 0, `退職手続きの中身が、画面の幅に収まる（はみ出し ${over}px）`);
  const sizes = await page.locator('[data-role="rc-bar"] button, #rc-assets button, [data-accounts="acct-slack"] button').evaluateAll((ns) =>
    ns.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check(sizes.length >= 6 && sizes.every(([w, h]) => w >= 44 && h >= 28), `主要なボタンが押せる大きさ（${sizes.map((s) => s.join("x")).join(" ")}）`);
  check((await text(page, ".hr-head .nm")).includes("とても長い氏名") && (await text(page, '[data-role="rc-basic-ro"]')).includes("とても長い氏名"), "長い氏名も読める（見出し・基本情報のタブ）");
  await page.locator('[data-role="rc-bar"] button', { hasText: "本人へ案内" }).click();
  check(await page.locator("#rc-contact button", { hasText: "メール文をコピー" }).isVisible(), "390px でもコピーできる");
  await page.screenshot({ path: shotPath("retire-case-sp.png"), fullPage: true });
  await page.ctx.close();
}

check(errs.length === 0, `画面のエラーなし（${errs.slice(0, 3).join(" / ")}）`);
await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
