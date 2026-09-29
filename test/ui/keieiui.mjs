// 経営（/keiei/）を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・経営者（owner）だけが開ける。それ以外は、ホームへ送り返される（画面には何も出ない）
//   ・サイドメニューは、ダッシュボード・入社準備・売上・利益・入金・支払・人件費・経費・会計
//   ・取れないデータは「データ未連携」と出し、0円とは出さない。条件つきの数字は「暫定」と出る
//   ・画面を切り替えても、最後に押した画面だけが出る
//   ・二段階認証が済んでいない経営者には、案内が出る（画面の中身は出ない）
//   ・スマホ幅で横スクロールしない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const { accessOf: serverAccessOf } = await import("../../lib/gw.js");
const { mapSix, summarizeSix, SIX_STEPS } = await import("../../lib/onboard-six.js");

const cards = [
  { key: "revenue", group: "money", label: "今月売上", status: "missing", reason: "請求データが未連携です", view: "revenue" },
  { key: "gross", group: "money", label: "今月粗利・粗利率", status: "missing", reason: "売上と仕入が未連携のため出せません", view: "revenue" },
  { key: "expense", group: "money", label: "今月経費（確定）", status: "exact", unit: "yen", value: 1234567, sub: "前月比 +10%", view: "expenses" },
  { key: "payroll", group: "money", label: "今月人件費", status: "provisional", unit: "yen", value: 800000, sub: "契約ベース（暫定）・2/4人分", view: "payroll" },
  { key: "cash", group: "money", label: "キャッシュ残高", status: "missing", reason: "会計・銀行の残高が未連携です", view: "cash" },
  { key: "headcount", group: "ops", label: "在籍", status: "exact", unit: "count", suffix: "人", value: 5, sub: "プロパー 4・BP 1", view: "onboarding" },
];
// 入社準備は、実物の写像（lib/onboard-six.js）で作る。画面が見るのはその結果そのもの
const it = (owner, status = "todo", required = true) => ({ owner, status, required });
const facts = (o = {}) => ({ procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null,
  items: [it("employee"), it("hr")], ...o });
const rowOf = (id, name, joinOn, f, career = null) => {
  const six = mapSix({ facts: f, career });
  for (const st of six.steps) st.href = st.state === "current" && st.key !== "guide" ? `/admin-hr.html?id=p-${id}` : null;
  return { employeeId: id, procedureId: `p-${id}`, name, department: "開発", position: "エンジニア", joinOn, daysToStart: 2, six,
    links: { hr: `/admin-hr.html?id=p-${id}`, onboarding: `/onboarding.html?employeeId=${id}` } };
};
const CAREER_OK = { track_id: "t", current_level_id: "l", one_year_target_note: "a", three_year_target_note: "b",
  next_review_on: "2027-04-01", agreed_at: "2026-09-01T00:00:00Z" };
const onboardingRows = [
  rowOf("e10", "山田 依頼前", "2026-10-01", facts()),
  rowOf("e11", "佐藤 書類待ち", "2026-10-15", facts({ order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true })),
  rowOf("e12", "鈴木 完了", "2026-09-01", facts({ procedure: { status: "done" } }), CAREER_OK),
];
const onboarding = {
  status: "exact", steps: SIX_STEPS, today: "2026-09-29", summary: summarizeSix(onboardingRows), rows: onboardingRows,
  hiddenComplete: 0, unlinked: ["guide"], links: { start: "/admin-onboard.html", hr: "/admin-hr.html" },
};
const expense = {
  status: "exact", month: "2026-09", prevMonth: "2026-08",
  confirmed: { thisMonth: 22000, prevMonth: 12000, diff: 10000, diffPct: 83.3 },
  pending: { thisMonth: 4000, count: 1 }, payable: { amount: 8000, count: 2 },
  byMethod: { personal: 15000, corporate_card: 7000 },
  byCategory: [{ category: "旅費交通費", amount: 13000 }, { category: "通信費", amount: 7000 }],
  monthly: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(10 + i > 12 ? i - 2 : 10 + i).padStart(2, "0")}`, confirmed: i * 1000, pending: i % 3 * 500 })),
  note: "確定＝承認済み＋支払済み。",
};

async function open(who, { width = 1280 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = [];
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me");
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({
        email: "a@b.c", appRole: who.appRole || "member", isAdmin: Boolean(who.isAdmin), roles: [],
        gw: { employee: { id: "e1", display_name: "森田 経営", status: "active" }, roles: who.roles || [], tenantId: "t1", stage: null },
        access: serverAccessOf({ isAdmin: Boolean(who.isAdmin), roles: who.roles || [] }),
      });
    }
    if (/\/api\/keiei/.test(url)) {
      const view = new URL(url).searchParams.get("view");
      calls.push(view);
      if (who.mfa === "required") return send({ error: "mfa_required", hint: "経営の画面を開くには、二段階認証の登録が必要です。", enrolled: false }, 403);
      if (view === "dashboard") return send({ month: "2026-09", cards, missingLabel: "データ未連携" });
      if (view === "expenses") return send({ month: "2026-09", expense });
      if (view === "payroll") {
        return send({ month: "2026-09", payroll: { status: "provisional", monthlyTotal: 800000, counted: 2, employeeCount: 4, excludedCount: 2,
          rows: [{ name: "月給 太郎", wageType: "月給", wageAmount: 300000, monthly: 300000, included: true, reason: null },
                 { name: "時給 次郎", wageType: "時給", wageAmount: 2000, monthly: null, included: false, reason: "時給は実稼働が未確定のため含めていません" }],
          note: "契約に登録された基本給ベースの暫定値です。" } });
      }
      if (view === "revenue") {
        return send({ month: "2026-09", missingLabel: "データ未連携", reason: "売上・仕入の金額を持つデータがまだありません。",
          money: [{ key: "revenue", label: "売上（請求額）", status: "missing" }, { key: "gross", label: "粗利・粗利率", status: "missing" }],
          billing: { total: 2, complete: 1, notStarted: 0, byStage: [{ key: "sent", label: "送付", done: 1 }] },
          renewals: { days: 45, count: 1, active: 3, upcoming: [{ id: "s1", periodTo: "2026-10-10", kind: "bp", renewalStatus: "pending" }] },
          sales: { won: 2, negotiating: 2 } });
      }
      if (view === "cash") {
        return send({ month: "2026-09", missingLabel: "データ未連携", reason: "請求・入金・BP支払の元データがまだありません。",
          payable: { status: "exact", amount: 8000, count: 2, note: "立替経費のうち…" },
          items: [{ key: "receivable", label: "入金予定", status: "missing" }, { key: "cash", label: "キャッシュ残高", status: "missing" }] });
      }
      if (view === "accounting") {
        return send({ status: "provisional", note: "このアプリで承認した仕訳だけです。", links: { accounting: "/admin.html", documents: "/app.html" },
          journals: { total: 3, approved: 2, draft: 1, sent: 0, latestApprovedOn: "2026-09-10" } });
      }
      if (view === "onboarding") return send(onboarding);
      return send({});
    }
    return send({});
  });
  await page.goto(`${BASE}/keiei/index.html`);
  await page.waitForTimeout(1000);
  page.calls = calls;
  return page;
}

const pathOf = (page) => new URL(page.url()).pathname;
const bodyText = (page) => page.locator("body").innerText();

console.log("— 経営者は開ける —");
{
  const page = await open({ appRole: "owner", roles: ["owner"] });
  check(pathOf(page) === "/keiei/index.html", "経営者は /keiei/ にとどまる");
  const menu = await page.locator("#kei-side a").allInnerTexts();
  check(menu.map((t) => t.replace(/^\S+\s*/, "").trim()).join("|").includes("ダッシュボード")
        && menu.length === 7, `サイドメニューは7つ（いま ${menu.length}）`);
  const labels = (await page.locator("#kei-side a").evaluateAll((ns) => ns.map((n) => n.dataset.view))).join(",");
  check(labels === "dashboard,onboarding,revenue,cash,payroll,expenses,accounting",
    `メニューの並び: ダッシュボード・入社準備・売上・利益・入金・支払・人件費・経費・会計（いま ${labels}）`);
  check(await page.locator(".kei-bar").isVisible(), "専用ヘッダーが出る");
  check((await page.locator("#kei-side a.on").getAttribute("data-view")) === "dashboard", "初期はダッシュボード");
  const t = await bodyText(page);
  check(t.includes("今月売上") && t.includes("データ未連携"), "売上は「データ未連携」と出る");
  check(t.includes("1,234,567円"), "取れている経費は金額で出る");
  check(t.includes("暫定"), "契約ベースの人件費には「暫定」が付く");
  // 取れないカードに、金額や 0円 を出さない
  const missCards = await page.locator(".kei-card.miss").evaluateAll((ns) => ns.map((n) => n.innerText));
  check(missCards.length === 3, `「データ未連携」のカードは3つ（いま ${missCards.length}）`);
  check(missCards.every((t) => /データ未連携/.test(t) && !/円/.test(t) && !/\b0\b/.test(t.replace(/\D*データ未連携/, ""))),
    "未連携のカードには、金額・0円を出さない");
  await page.screenshot({ path: shotPath("keiei-dashboard-pc.png") });
  await page.close();
}

console.log("\n— メニューで画面を切り替える —");
{
  const page = await open({ appRole: "owner", roles: ["owner"] });
  await page.click('#kei-side a[data-view="expenses"]');
  await page.waitForTimeout(500);
  let t = await bodyText(page);
  check(page.url().endsWith("#expenses"), "URL に #expenses が付く（戻る・共有ができる）");
  check(t.includes("22,000円") && t.includes("前月比 +83.3%"), "経費：今月の確定と前月比");
  check(t.includes("旅費交通費") && t.includes("13,000円"), "経費：科目別");
  check(await page.locator(".kei-bar-col").count() === 12, "経費：12か月の推移");
  check((await page.locator("#kei-side a.on").getAttribute("data-view")) === "expenses", "メニューの強調が移る");

  await page.click('#kei-side a[data-view="payroll"]');
  await page.waitForTimeout(500);
  t = await bodyText(page);
  check(t.includes("暫定") && t.includes("800,000円") && t.includes("時給は実稼働が未確定"), "人件費：暫定・含めない人の理由");

  await page.click('#kei-side a[data-view="revenue"]');
  await page.waitForTimeout(500);
  t = await bodyText(page);
  check(t.includes("データ未連携") && t.includes("請求進捗") && t.includes("2026-10-10"), "売上・利益：未連携＋請求進捗・更新期限");
  check(await page.locator(".kei-card.miss").count() === 2, "売上・利益：金額は未連携のカードだけ");

  await page.click('#kei-side a[data-view="cash"]');
  await page.waitForTimeout(500);
  t = await bodyText(page);
  check(t.includes("支払予定（立替経費）") && t.includes("8,000円") && t.includes("キャッシュ残高"), "入金・支払：立替の支払待ちだけ数字、ほかは未連携");

  await page.click('#kei-side a[data-view="accounting"]');
  await page.waitForTimeout(500);
  t = await bodyText(page);
  check(t.includes("このアプリで承認した仕訳だけ"), "会計：暫定の注記");
  check(await page.locator('a[href="/admin.html"]').count() === 1, "会計：既存の会計画面への入口（admin.html は残す）");

  await page.click('#kei-side a[data-view="onboarding"]');
  await page.waitForTimeout(500);
  t = await bodyText(page);
  check(t.includes("入社準備"), "入社準備の画面がある");
  check(await page.locator(".kei-ob").count() === 3, "入社予定者が3人並ぶ");
  const first = page.locator('.kei-ob[data-employee="e10"]');
  const labels6 = await first.locator(".kei-st .t").allInnerTexts();
  check(labels6.map((x) => x.replace(/^\S+\s*/, "").trim()).join("|")
    === "1. 入社案内|2. 労働条件・契約|3. 本人情報・必要書類|4. アカウント準備|5. キャリア設計|6. 最終確認",
    `6ステップの並び（いま ${labels6.join("|")}）`);
  check((await first.locator('.kei-st[data-step="guide"]').getAttribute("data-state")) === "unlinked", "① 入社案内は「データ未連携」の状態");
  check((await first.locator('.kei-st[data-step="guide"]').innerText()).includes("データ未連携"), "① に「データ未連携」と出る");
  check((await first.locator('.kei-st[data-step="contract"]').getAttribute("data-state")) === "current", "② は要対応");
  check((await first.locator(".kei-next").innerText()).includes("労働条件の作成依頼待ち"), "次に何をするかが先に出る（作成依頼待ち・経営者）");
  check((await first.locator(".kei-next").innerText()).includes("経営者"), "誰の番かが出る");
  check((await page.locator('.kei-ob[data-employee="e12"] .kei-next').innerText()).includes("入社準備完了"), "完了した人は「入社準備完了」");
  check((await page.locator('.kei-ob[data-employee="e12"] .kei-st.done').count()) === 5, "完了した人は、案内を除く5つが完了");
  check(await page.locator('.kei-ob[data-employee="e11"] .kei-st.current').count() === 2, "書類待ちの人は、本人の作業と社内準備の2つが要対応（並行）");
  check(await page.locator('a[href="/admin-onboard.html"]').count() === 1, "新規メンバー登録への入口（既存の画面）");
  check(!/円/.test(await page.locator("#kei-main").innerText()), "給与・手当の金額は、この画面に出ない");
  const cardsTxt = await page.locator(".kei-grid .kei-card").allInnerTexts();
  check(cardsTxt.some((c) => c.includes("入社準備中") && c.includes("3")) === false
    && cardsTxt.some((c) => c.includes("入社準備中") && c.includes("2")), "入社準備中は完了を除いた2人");
  await page.close();
}

console.log("\n— 速く切り替えても、最後に押した画面だけが出る —");
{
  const page = await open({ appRole: "owner", roles: ["owner"] });
  await page.evaluate(() => { location.hash = "#expenses"; location.hash = "#payroll"; location.hash = "#cash"; });
  await page.waitForTimeout(900);
  const t = await bodyText(page);
  check(t.includes("入金・支払") && !t.includes("科目別"), "最後の #cash だけが出る");
  await page.close();
}

console.log("\n— 経営者以外は開けない（ホームへ送り返される） —");
for (const [label, who] of [
  ["会計の管理者だけ", { appRole: "admin", isAdmin: true, roles: [] }],
  ["人事", { appRole: "member", roles: ["hr"] }],
  ["責任者", { appRole: "member", roles: ["manager"] }],
  ["採用担当", { appRole: "member", roles: ["recruiter"] }],
  ["経理", { appRole: "member", roles: ["finance"] }],
  ["営業", { appRole: "member", roles: ["sales"] }],
  ["IT・管理", { appRole: "member", roles: ["it"] }],
  ["一般メンバー", { appRole: "member", roles: [] }],
  ["経営者以外の権限を全部＋管理者", { appRole: "admin", isAdmin: true, roles: ["hr", "manager", "recruiter", "sales", "finance", "it"] }],
]) {
  const page = await open(who);
  check(pathOf(page) === "/home.html", `${label}: ホームへ送り返される（いま ${pathOf(page)}）`);
  check(page.calls.length === 0, `${label}: 経営の API を呼んでいない`);
  await page.close();
}

console.log("\n— 二段階認証が済んでいない経営者には、案内が出る —");
{
  const page = await open({ appRole: "owner", roles: ["owner"], mfa: "required" });
  await page.waitForTimeout(500);
  // api-client が mfa_required を受けて、マイページの登録へ送る（絶対パス）。テストでは遷移先の有無で見る
  const at = pathOf(page);
  const t = await bodyText(page);
  check(at === "/mypage.html" || t.includes("二段階認証"), `二段階認証の登録へ案内される（いま ${at}）`);
  check(!t.includes("1,234,567円"), "案内が出ているとき、経営の数字は出ていない");
  await page.close();
}

console.log("\n— スマホ幅：横スクロールしない・メニューが使える —");
for (const width of [390, 360]) {
  const page = await open({ appRole: "owner", roles: ["owner"] }, { width });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${width}px: 横スクロールが出ない（はみ出し ${overflow}px）`);
  check(await page.locator("#kei-side a").count() === 7, `${width}px: メニューが7つある`);
  await page.click('#kei-side a[data-view="expenses"]');
  await page.waitForTimeout(500);
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow2 <= 0, `${width}px 経費: 横スクロールが出ない（はみ出し ${overflow2}px）`);
  if (width === 390) await page.screenshot({ path: shotPath("keiei-expenses-sp.png") });
  await page.click('#kei-side a[data-view="onboarding"]');
  await page.waitForTimeout(500);
  const overflow3 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow3 <= 0, `${width}px 入社準備: 横スクロールが出ない（はみ出し ${overflow3}px）`);
  if (width === 390) await page.screenshot({ path: shotPath("keiei-onboarding-sp.png"), fullPage: true });
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
