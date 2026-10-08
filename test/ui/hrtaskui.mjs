// 入退社の1人ぶんを、タスク指向の並びで見る（2026-10-08 UI/UX 改善指示書）。入社・退社で同じ作り。
//
// ■ 何を守りたいのか
//   ・いちばん上は、期限超過の赤い帯 → 全体の進み具合（ステップ。いまの段階を強調）→ チェックリスト
//   ・チェックリストの項目を押すと、その下に作業の場所が開く（下の欄までスクロールしない）
//     退社：退職日→基本情報・必要書類→書類と本人対応・PC→貸与品・メール/Slack/グループウェア/権限→そのサービスのアカウントだけ
//     入社：労働条件・契約→労働条件通知書と契約書・必要書類→本人の提出とマイナンバー・給与→MF給与の取込
//   ・チェックした日と人を、項目の横に出す（予定日は出さない）
//   ・チェックすると、その項目を閉じて次の未完了の項目を開く。中の「完了にする」でも同じ
//   ・データから見た「次にやること」を押すと、その作業の場所が開く
//   ・基本情報・連絡・手続き履歴・書類の保管先はタブ
//   ・入社は青、退社は橙で、どちらを触っているかが分かる
//   ・390px で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const { accessOf } = await import("../../lib/gw.js");
const { onboardFlow } = await import("../../lib/onboard-flow.js");

const it = (id, key, title, owner, done = false, extra = {}) => ({ id, key, title, owner, ownerLabel: { hr: "人事", it: "IT・管理", manager: "上長", finance: "経理" }[owner],
  phase: "prep", done, completedAt: done ? "2026-10-07T01:00:00Z" : null, completedByName: done ? "人事 花子" : null, assignee: { id: "e-hr", name: "人事 花子" }, href: null, ...extra });
const grp = (role, label, items) => ({ role, label, done: items.filter((i) => i.done).length, total: items.length, items });

const OFF = () => ({ procedure: {
  id: "p-off", kind: "offboarding", name: "退職 太郎", employeeId: "e-off", department: "開発", targetOn: "2026-09-30", days: -8, due: "退社から8日",
  phase: "lastday", phaseLabel: "退社日対応", progress: { done: 2, total: 9 }, urgency: "late",
  groups: [
    grp("hr", "人事", [it("o1", "off_hr_date", "退職日の確認", "hr", true), it("o2", "off_hr_docs", "必要書類の受け渡し", "hr"), it("o3", "off_hr_handover", "引継ぎの確認", "hr", true),
      it("o10", "off_hr_cert", "退職証明書の交付", "hr")]),
    grp("it", "IT・管理", [it("o4", "off_it_pc", "PCの返却", "it"), it("o5", "off_it_mail", "メールの停止", "it"), it("o6", "off_it_slack", "Slack の停止", "it"),
      it("o7", "off_it_gw", "グループウェアの停止", "it", false, { href: "admin-members.html" }), it("o8", "off_it_perm", "システム権限の削除", "it", false, { href: "admin-members.html#roles" })]),
    grp("finance", "経理", [it("o9", "off_fin_pay", "最終給与等の確認", "finance")]),
  ], drive: null }, roles: [], people: [] });
const acct = (key, label, how, state, extra = {}) => ({ key, label, how, state, auto: how === "auto", warn: false, note: null, scheduledOn: null, stoppedAt: null, ...extra });
const RC = () => ({
  employee: { id: "e-off", name: "退職 太郎", statusLabel: "退職手続き中", leftOn: "2026-09-30", lastWorkOn: "2026-09-29", reasonLabel: "自己都合",
    owner: { id: "e-hr", name: "人事 花子" }, updatedAt: "x", caseUpdatedAt: "y" },
  ready: { case: true, docs: true, cert: true }, certRequest: null, canIssueCert: false, staff: [{ id: "e-hr", name: "人事 花子" }],
  next: [{ key: "asset:a-pc", text: "PC返却待ち（MacBook 01）", target: "rc-assets" },
         { key: "acct:slack", text: "Slackの停止が未確認", target: "rc-accounts", late: true },
         { key: "doc:certificate", text: "退職証明書未公開", target: "rc-docs" }],
  self: [{ kind: "certificate", label: "退職証明書", published: false, publishedAt: null, openedAt: null }],
  docs: [{ kind: "certificate", label: "退職証明書", adminState: "issued", current: { id: "d1", version: 1, state: "issued", issuedOn: "2026-10-01" }, history: [] }],
  accounts: [acct("google", "Google Workspace（Gmail・ドライブ・カレンダー）", "manual", "active"), acct("slack", "Slack", "manual", "unknown"),
    acct("groupware", "グループウェア", "auto", "stopped"), acct("lms", "無限道場", "auto", "stopped"), acct("github", "GitHub", "manual", "unknown")],
  accountStates: [{ key: "active", label: "利用中" }, { key: "stopped", label: "停止済" }, { key: "unknown", label: "未確認" }],
  assets: [{ assetId: "a-pc", kindLabel: "PC", name: "MacBook 01", identifier: "PC-01", state: "assigned" }],
  guide: { email: "メール", slack: "slack", url: "https://x", urlNote: "本人用" }, remind: { email: "再", slack: "再", url: "https://x", urlNote: "本人用" },
  history: [{ at: "2026-10-07T01:00:00Z", whoKind: "admin", who: "人事 花子", text: "退職日を確認" }],
});
const ON = () => {
  const items = [it("n1", "on_hr_terms", "労働条件・契約の確認", "hr"), it("n2", "on_hr_docs", "必要書類の回収", "hr"),
    it("n3", "on_it_pc", "会社PCの準備", "it", true), it("n4", "on_it_agent", "EIGHT Agent の設定", "it", false, { href: "admin-devices.html" }),
    it("n5", "on_fin_pay", "給与・振込情報の確認", "finance")];
  const flow = onboardFlow({ facts: { procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null, items: [] },
    employee: { user_id: "u-new" }, targetOn: "2026-10-20", items: [], today: "2026-10-08" });
  return { procedure: { id: "p-on", kind: "onboarding", name: "入社 花子", employeeId: "e-on", department: "営業", targetOn: "2026-10-20", days: 12, due: "入社まで12日",
    phase: "prep", phaseLabel: "入社準備", progress: { done: 1, total: 5 }, urgency: "ok", mynumber: "requested", flow,
    groups: [grp("hr", "人事", items.slice(0, 2)), grp("it", "IT・管理", items.slice(2, 4)), grp("finance", "経理", items.slice(4))], drive: null }, roles: [], people: [] };
};
const LIST = () => ({ tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
  onboarding: [], offboarding: [], done: [], people: [], roles: [], today: "2026-10-08", kpi: {} });

async function open(id, { width = 1280 } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@example.com" }));
    for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k);
  });
  const sent = [];
  const state = { off: OFF(), on: ON() };
  await ctx.route("**/api/**", async (route) => {
    const req = route.request(), u = new URL(req.url());
    const send = (b, st = 200) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/hr" && req.method() === "PATCH") {
      const b = JSON.parse(req.postData() || "{}"); sent.push(b);
      const p = b.id === "p-off" ? state.off.procedure : state.on.procedure;
      for (const g of p.groups) for (const i of g.items) if (i.id === b.itemId) Object.assign(i, { done: b.done, completedAt: b.done ? "2026-10-08T02:00:00Z" : null, completedByName: b.done ? "人事 花子" : null });
      return send({ ok: true });
    }
    if (u.pathname === "/api/hr") {
      const qid = u.searchParams.get("id");
      return send(qid === "p-off" ? state.off : qid === "p-on" ? state.on : LIST());
    }
    if (u.pathname === "/api/employees/retire-case") return send(RC());
    if (u.pathname === "/api/onboarding/notice") return send({ error: "forbidden" }, 403);
    if (/\/api\/hr\/retention/.test(u.pathname)) return send({ today: "2026-10-08", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/onboarding\/orientation/.test(u.pathname)) return send({ items: [], kinds: [], done: true });
    if (/\/api\/me\b/.test(u.pathname)) {
      return send({ email: "hr@example.com", appRole: "member", isAdmin: false, roles: [],
        gw: { employee: { id: "e-hr", display_name: "人事 花子", status: "active" }, roles: ["hr"], tenantId: "t1", stage: null },
        access: accessOf({ isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"] }) });
    }
    if (/\/api\/notifications/.test(u.pathname)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(u.pathname)) return send({ badges: {} });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/admin-hr.html?id=${id}`);
  await page.waitForSelector("#hr-checklist", { timeout: 15000 });
  await page.waitForTimeout(700);
  return { page, ctx, sent, errs };
}
const item = (page, key) => page.locator(`.hx-item[data-key="${key}"]`);
const isOpen = async (page, key) => (await item(page, key).getAttribute("class")).includes("open");

console.log("— 退社：上から 警告 → ステップ → チェックリスト —");
{
  const { page, ctx, sent, errs } = await open("p-off");
  await page.screenshot({ path: shotPath("hr-task-off.png"), fullPage: true });
  const alert = page.locator('[data-role="hx-alert"]');
  check(await alert.isVisible(), "期限超過の赤い帯が出る");
  const at = await alert.innerText();
  check(at.includes("退社日を過ぎていますが、未完了の作業が 7 件") && at.includes("退社から8日") && at.includes("Slackの停止が未確認"), `帯の中身（${at.replace(/\s+/g, " ")}）`);
  check(await alert.evaluate((n) => getComputedStyle(n).backgroundColor) === "rgb(253, 236, 236)", "帯は薄い赤");
  const tops = await page.evaluate(() => ["[data-role=hx-alert]", "#hx-steps", "#hr-checklist", "[data-role=hx-next]", ".hx-tabs"]
    .map((s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1));
  check(tops.every((y, i) => y >= 0 && (i === 0 || y > tops[i - 1])), `警告 → ステップ → チェックリスト → 次にやること → タブ（${tops.map(Math.round).join(",")}）`);
  const steps = await page.locator(".hx-steps li").evaluateAll((ns) => ns.map((n) => `${n.innerText.replace(/^\d+\.\s*/, "").trim()}:${n.className}`));
  check(steps.join("|") === "退職合意:done|アカウント停止・貸与品回収:current|最終給与・精算:todo|書類発行:todo|完了:todo", `ステップ（${steps.join("|")}）`);
  check(await page.locator(".hx").evaluate((n) => getComputedStyle(n).borderTopColor) === "rgb(194, 112, 42)", "退社は橙の線");
  check((await page.locator(".hx-band").innerText()).includes("退社手続き"), "「退社手続き」の札");

  console.log("\n— 退社：チェックリストの項目の中で作業する —");
  check(await page.locator('[data-role="hx-extras"]').count() === 0, "作業の場所は、すべてチェックリストの項目に入る（そのほかの作業は無い）");
  check(await isOpen(page, "off_hr_docs"), "初めは、上から最初の未完了（必要書類の受け渡し）が開いている");
  check(await item(page, "off_hr_docs").locator("#rc-docs").isVisible() && await item(page, "off_hr_docs").locator("#rc-self").isVisible(), "必要書類の受け渡し：書類と本人対応");
  check(await item(page, "off_hr_date").locator("#rc-basic").count() === 1, "退職日の確認：退職日・担当者");
  check(await item(page, "off_it_pc").locator("#rc-assets").count() === 1, "PCの返却：貸与品");
  const svc = async (key) => item(page, key).locator("tr[data-acct]").evaluateAll((ns) => ns.map((n) => n.dataset.acct).join(","));
  check(await svc("off_it_mail") === "google" && await svc("off_it_slack") === "slack" && await svc("off_it_gw") === "groupware,lms" && await svc("off_it_perm") === "github",
    "アカウントは、その項目で止めるサービスだけ（メール→Google・Slack→Slack・グループウェア→自動の3つ・権限→GitHub）");
  const done = await item(page, "off_hr_date").locator('[data-role="done-at"]').innerText();
  check(done.includes("10/7 完了") && done.includes("人事 花子"), `チェックした日と人（${done}）`);
  check(!(await item(page, "off_hr_docs").innerText()).includes("退社日") , "予定の札（退社日）は出さない");

  await item(page, "off_it_pc").locator(".hx-t").click();
  check(await item(page, "off_it_pc").locator("#rc-assets").isVisible(), "押すと、その下に貸与品の欄が開く");
  check(await page.locator(".hx-item.open").count() === 2, "ほかの開いている項目はそのまま");
  await item(page, "off_it_pc").locator(".hx-t").click();
  check(!(await isOpen(page, "off_it_pc")), "もう一度押すと閉じる");

  console.log("\n— 退社：チェックすると、閉じて次へ —");
  await item(page, "off_hr_docs").locator('input[type="checkbox"]').check();
  await page.waitForTimeout(900);
  check(sent.some((b) => b.itemId === "o2" && b.done === true), "サーバへ送る（必要書類の受け渡し）");
  check(!(await isOpen(page, "off_hr_docs")) && await isOpen(page, "off_hr_cert"), "その項目を閉じて、次の未完了（退職証明書の交付）を開く");
  await item(page, "off_it_pc").locator(".hx-t").click();
  check((await item(page, "off_hr_docs").locator('[data-role="done-at"]').innerText()).includes("10/8 完了"), "チェックした日（10/8 完了）が出る");
  await item(page, "off_it_pc").locator('button[data-act="done"]').click();
  await page.waitForTimeout(900);
  check(sent.some((b) => b.itemId === "o4" && b.done === true) && await isOpen(page, "off_it_mail"), "中の「完了にする」でも同じ（次はメールの停止）");

  console.log("\n— 退社：次にやること・タブ —");
  await page.locator('#rc-next button[data-next="acct:slack"]').click();
  await page.waitForTimeout(300);
  check(await isOpen(page, "off_it_slack") && await item(page, "off_it_slack").locator('tr[data-acct="slack"]').isVisible(), "次にやること（Slack）を押すと、Slack の停止の項目が開く");
  const tabs = (await page.locator(".hx-tabs button").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("|") === "基本情報|連絡|手続き履歴|書類の保管先", `タブ（${tabs.join("|")}）`);
  check(await page.locator('[data-role="rc-basic-ro"]').isVisible(), "初めは基本情報");
  await page.locator(".hx-tabs button", { hasText: "連絡" }).click();
  check(await page.locator("#rc-contact").isVisible() && await page.locator('[data-role="rc-basic-ro"]').isHidden(), "連絡に切り替わる");
  await page.locator('[data-role="rc-bar"] button', { hasText: "手続き履歴" }).click();
  check(await page.locator("#rc-history").isVisible(), "上の「手続き履歴」で履歴のタブ");
  await page.locator('[data-role="rc-bar"] button', { hasText: "退職日を変更" }).click();
  await page.waitForTimeout(200);
  check(await isOpen(page, "off_hr_date") && await page.locator("#rc-left").isVisible(), "「退職日を変更」で、退職日の確認の項目が開いて入力できる");
  check(errs.length === 0, `画面のエラーなし（${errs.join(" / ")}）`);
  await ctx.close();
}

console.log("\n— 入社：同じ並び・青 —");
{
  const { page, ctx, sent, errs } = await open("p-on");
  await page.screenshot({ path: shotPath("hr-task-on.png"), fullPage: true });
  check(await page.locator('[data-role="hx-alert"]').count() === 0, "期限内なら赤い帯は出ない");
  check(await page.locator(".hx").evaluate((n) => getComputedStyle(n).borderTopColor) === "rgb(47, 111, 214)", "入社は青の線");
  check((await page.locator(".hx-band").innerText()).includes("入社手続き"), "「入社手続き」の札");
  const steps = (await page.locator(".hx-steps li").allInnerTexts()).map((x) => x.replace(/^\d+\.\s*/, "").trim());
  check(steps.length === 6 && steps[1] === "契約書の準備", `ステップは6つの段階（${steps.join("|")}）`);
  const tops = await page.evaluate(() => ["#hx-steps", "#hr-checklist", "#ob-next", ".hx-tabs"].map((s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1));
  check(tops.every((y, i) => y >= 0 && (i === 0 || y > tops[i - 1])), `ステップ → チェックリスト → 次にすること → タブ（${tops.map(Math.round).join(",")}）`);
  check(await isOpen(page, "on_hr_terms") && await item(page, "on_hr_terms").locator("#ob-contract").isVisible(), "労働条件・契約の確認：契約書の作り方が、その項目の中に");
  await item(page, "on_hr_docs").locator(".hx-t").click();
  check(await item(page, "on_hr_docs").locator("select").inputValue() === "requested", "必要書類の回収：マイナンバーの進み具合");
  await item(page, "on_fin_pay").locator(".hx-t").click();
  check(await item(page, "on_fin_pay").locator("button", { hasText: "MF給与の取込CSV" }).isVisible(), "給与・振込情報の確認：MF給与の取込");
  await item(page, "on_it_agent").locator(".hx-t").click();
  check(await item(page, "on_it_agent").locator("a", { hasText: "端末管理を開く" }).getAttribute("href") === "admin-devices.html", "別の画面でやる作業は、その画面を開くボタン");
  check((await item(page, "on_it_pc").locator('[data-role="done-at"]').innerText()).includes("10/7 完了"), "終わった項目は、チェックした日");
  const tabs = (await page.locator(".hx-tabs button").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("|") === "基本情報|手続きの進み具合|書類の保管先", `タブ（${tabs.join("|")}）`);
  await page.locator(".hx-tabs button", { hasText: "手続きの進み具合" }).click();
  check(await page.locator("#ob-flow").isVisible(), "手続きの進み具合（6つの段階の表）はタブ");
  await item(page, "on_hr_terms").locator('input[type="checkbox"]').check();
  await page.waitForTimeout(900);
  check(sent.some((b) => b.itemId === "n1" && b.done === true) && await isOpen(page, "on_hr_docs"), "チェックすると、次の未完了（必要書類の回収）が開く");
  check(errs.length === 0, `画面のエラーなし（${errs.join(" / ")}）`);
  await ctx.close();
}

console.log("\n— 390px —");
for (const id of ["p-off", "p-on"]) {
  const { page, ctx } = await open(id, { width: 390 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${id}：横にはみ出さない（${over}px）`);
  await page.screenshot({ path: shotPath(`hr-task-${id}-390.png`), fullPage: true });
  const cb = await page.locator('.hx-item input[type="checkbox"]').first().boundingBox();
  const tt = await page.locator(".hx-item .hx-t").first().boundingBox();
  check(cb && cb.width >= 18 && tt && tt.height >= 28, `${id}：チェックと項目が押せる大きさ`);
  await ctx.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
