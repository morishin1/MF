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
const { GUIDE_FIELDS, normalizeGuideInput } = await import("../../lib/onboard-guide.js");

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
const rowOf = (id, name, joinOn, f, career = null, guide = null) => {
  const six = mapSix({ facts: f, career, guide });
  for (const st of six.steps) {
    st.href = st.key === "guide" ? (["current", "na"].includes(st.state) ? `#onboarding/${id}` : null)
      : st.state === "current" ? `/admin-hr.html?id=p-${id}` : null;
  }
  if (six.after && six.after.actor) six.after.href = `/admin-career.html?employeeId=${id}`;
  return { employeeId: id, procedureId: `p-${id}`, name, department: "開発", position: "エンジニア", joinOn, daysToStart: 2, six,
    links: { hr: `/admin-hr.html?id=p-${id}`, onboarding: `/onboarding.html?employeeId=${id}`, detail: `#onboarding/${id}` } };
};
const CAREER_OK = { track_id: "t", current_level_id: "l", one_year_target_note: "a", three_year_target_note: "b",
  next_review_on: "2027-04-01", agreed_at: "2026-09-01T00:00:00Z" };
const onboardingRows = [
  rowOf("e10", "山田 依頼前", "2026-10-01", facts()),
  rowOf("e11", "佐藤 書類待ち", "2026-10-15", facts({ order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true }),
    null, { status: "issued", version: 1, confirmedVersion: null }),
  rowOf("e12", "鈴木 完了", "2026-09-01", facts({ procedure: { status: "done" } }), null,
    { status: "issued", version: 1, confirmedVersion: 1, confirmedAt: "2026-09-20T01:00:00Z" }),
];
const onboarding = {
  status: "exact", steps: SIX_STEPS, today: "2026-09-29", summary: summarizeSix(onboardingRows), rows: onboardingRows,
  hiddenComplete: 0, links: { start: "/admin-onboard.html", hr: "/admin-hr.html" },
};

// ---- 入社準備の詳細（/api/keiei/onboarding）の、画面確認用の代役 ----
// 本物のサーバの規則（金額の拒否・未設定でのメール送信の拒否）を、ここで再現する。画面が見るのは、その応答
function makeDetailServer({ configured = false, email = "hire@example.com" } = {}) {
  const st = { draft: {}, version: 0, confirmed: null, dirty: false, invites: [], history: [], posts: [], n: 0 };
  const cfg = configured
    ? { configured: true, provider: "resend", fromAddress: "hr@example.com", replyTo: null, reason: null }
    : { configured: false, provider: null, fromAddress: null, replyTo: null, reason: "MAIL_PROVIDER が設定されていません" };
  const guideFact = () => (st.version ? { status: "issued", version: st.version, confirmedVersion: st.confirmed, confirmedAt: st.confirmed ? "2026-09-20T01:00:00Z" : null } : (Object.keys(st.draft).length ? { status: "draft", version: 0 } : null));
  const body = () => ({
    employee: { id: "e10", name: "山田 依頼前", email, department: "開発", position: "エンジニア", status: "invited", joinOn: "2026-10-01" },
    procedureId: "p-e10",
    six: mapSix({ facts: facts(), guide: guideFact() }),
    guide: {
      linked: true, exists: Object.keys(st.draft).length > 0 || st.version > 0, fields: GUIDE_FIELDS,
      draft: Object.fromEntries(GUIDE_FIELDS.map((f) => [f.key, st.draft[f.key] ?? null])),
      autofill: { name: "山田 依頼前", joinOn: "2026-10-01", department: "開発", position: "エンジニア", role: "バックエンド" },
      missing: ["初日の集合時間", "勤務場所", "当日の連絡先"].filter((x, i) => !st.draft[["meeting_time", "location", "contact"][i]]),
      version: st.version, issuedAt: st.version ? "2026-09-29T01:00:00Z" : null, issued: st.version ? { version: st.version } : null,
      dirty: st.version ? st.dirty : Object.keys(st.draft).length > 0, confirmedVersion: st.confirmed, confirmedAt: st.confirmed ? "2026-09-20T01:00:00Z" : null,
    },
    invites: st.invites,
    mail: { config: cfg, canTest: configured, to: email || null, history: st.history },
    defaults: { inviteDays: 7 },
  });
  const handle = (method, url, post) => {
    if (method === "GET") {
      const mailId = new URL(url).searchParams.get("mailId");
      if (mailId) return { body: { mail: { id: mailId, subject: "【株式会社エイト】ご入社にあたってのご案内", body: "山田 依頼前 様\n\n▼ 入社準備を始める\nhttps://gw.example.com/onboarding/?t=SENT", to: email, at: "2026-09-29T02:00:00Z" } } };
      return { body: body() };
    }
    st.posts.push(post);
    switch (post.action) {
      case "save_guide": {
        const n = normalizeGuideInput(post.fields);
        if (n.error) return { status: 400, body: { error: n.error, field: n.field, hint: n.hint } };
        st.draft = { ...st.draft, ...Object.fromEntries(Object.entries(n.value).filter(([, v]) => v)) };
        if (st.version) st.dirty = true;
        return { body: body() };
      }
      case "issue_guide": st.version += 1; st.dirty = false; return { body: body() };
      case "create_invite": {
        st.n += 1;
        for (const i of st.invites) if (i.status === "active") i.status = "revoked";
        st.invites.unshift({ id: `inv${st.n}`, createdAt: "2026-09-29T03:00:00Z", expiresAt: "2026-10-06T03:00:00Z", revokedAt: null, status: "active", firstOpenedAt: null, lastOpenedAt: null, openCount: 0 });
        return { body: { ...body(), invite: { id: `inv${st.n}`, url: `https://gw.example.com/onboarding/?t=TOKEN${st.n}`, expiresAt: "2026-10-06T03:00:00Z" } } };
      }
      case "revoke_invite": for (const i of st.invites) if (i.id === post.inviteId) i.status = "revoked"; return { body: body() };
      case "preview_mail": return { body: { preview: { to: email, toValid: true, from: cfg.fromAddress ? `エイト 人事 <${cfg.fromAddress}>` : null, subject: "【株式会社エイト】ご入社にあたってのご案内",
        body: "山田 依頼前 様\n\n10月1日のご入社に向けて、\n▼ 入社準備を始める\n（送信時に、この人だけの期限つきURLが入ります）", configured, reason: cfg.reason } } };
      case "test_mail": case "send_mail": {
        if (!configured) return { status: 409, body: { error: "mail_not_configured", hint: "メール送信は使えません（未設定）。「案内URLを発行」から、URLをコピーして本人へお渡しください" } };
        st.history.unshift({ id: `m${++st.n}`, kind: post.action === "test_mail" ? "test" : "send", label: post.action === "test_mail" ? "テスト" : "送信", status: "sent",
          to: post.action === "test_mail" ? "owner@example.com" : email, subject: "【株式会社エイト】ご入社にあたってのご案内", at: "2026-09-29T02:00:00Z", by: "森田 経営", error: null });
        return { body: { ...body(), result: { status: "sent", to: post.action === "test_mail" ? "owner@example.com" : email } } };
      }
      default: return { status: 400, body: { error: "invalid_action" } };
    }
  };
  return { st, handle };
}
const expense = {
  status: "exact", month: "2026-09", prevMonth: "2026-08",
  confirmed: { thisMonth: 22000, prevMonth: 12000, diff: 10000, diffPct: 83.3 },
  pending: { thisMonth: 4000, count: 1 }, payable: { amount: 8000, count: 2 },
  byMethod: { personal: 15000, corporate_card: 7000 },
  byCategory: [{ category: "旅費交通費", amount: 13000 }, { category: "通信費", amount: 7000 }],
  monthly: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(10 + i > 12 ? i - 2 : 10 + i).padStart(2, "0")}`, confirmed: i * 1000, pending: i % 3 * 500 })),
  note: "確定＝承認済み＋支払済み。",
};

async function open(who, { width = 1280, detail = null, hash = "" } = {}) {
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
    if (/\/api\/keiei\/onboarding/.test(url)) {
      const req = route.request();
      const r = detail.handle(req.method(), url, req.method() === "POST" ? JSON.parse(req.postData() || "{}") : null);
      return send(r.body, r.status || 200);
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
  await page.goto(`${BASE}/keiei/index.html${hash}`);
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
    === "1. 入社案内確認|2. 雇用契約|3. 入社情報入力|4. 必要書類提出|5. 会社確認|6. 入社準備完了",
    `6ステップの並び（いま ${labels6.join("|")}）`);
  check((await first.locator('.kei-st[data-step="guide"]').getAttribute("data-state")) === "na", "① 入社案内確認は、案内が無ければ「対象外」");
  check((await first.locator('.kei-st[data-step="guide"]').innerText()).includes("案内は未作成です"), "① に「案内は未作成です」と出る");
  check((await first.locator('.kei-st[data-step="guide"] a').getAttribute("href")) === "#onboarding/e10", "① から、案内を作る画面へ");
  check((await first.locator('.kei-st[data-step="contract"]').getAttribute("data-state")) === "current", "② は要対応");
  check((await first.locator(".kei-next").innerText()).includes("労働条件の作成依頼待ち"), "次に何をするかが先に出る（作成依頼待ち・経営者）");
  check((await first.locator(".kei-next").innerText()).includes("経営者"), "誰の番かが出る");
  check((await page.locator('.kei-ob[data-employee="e12"] .kei-next').innerText()).includes("入社準備完了"), "完了した人は「入社準備完了」");
  check((await page.locator('.kei-ob[data-employee="e12"] .kei-st.done').count()) === 6, "完了した人は、案内も含めて6つが完了（案内は確認済み）");
  check((await page.locator('.kei-ob[data-employee="e12"] [data-role="after"]').innerText()).includes("キャリア設定待ち"), "完了した人には、次の一手（キャリア）が添わる");
  check(await page.locator('.kei-ob[data-employee="e11"] .kei-st.current').count() === 4, "案内の確認待ち・入力・書類・会社確認の4つが要対応（並行）");
  check(await page.locator('.kei-ob[data-employee="e11"] .kei-st[data-step="guide"] .who').count() === 1, "① の担当（本人）が出る");
  check(await page.locator('a[href="/admin-onboard.html"]').count() === 1, "新規メンバー登録への入口（既存の画面）");
  check(!/円/.test(await page.locator("#kei-main").innerText()), "給与・手当の金額は、この画面に出ない");
  const cardsTxt = await page.locator(".kei-grid .kei-card").allInnerTexts();
  check(cardsTxt.some((c) => c.includes("入社準備中") && c.includes("3")) === false
    && cardsTxt.some((c) => c.includes("入社準備中") && c.includes("2")), "入社準備中は完了を除いた2人");
  await page.close();
}

console.log("\n— 入社準備の詳細：入社案内を作り、案内URLを発行する（メール未設定）—");
{
  const detail = makeDetailServer({ configured: false });
  const page = await open({ appRole: "owner", roles: ["owner"] }, { detail, hash: "#onboarding/e10" });
  page.on("dialog", (d) => d.accept());
  let t = await bodyText(page);
  check(t.includes("山田 依頼前") && t.includes("2026/10/01 入社"), "詳細: 氏名と入社日");
  check(await page.locator(".kei-six .kei-st").count() === 6, "詳細: 6ステップ");
  check(await page.locator("#guide-form [name]").count() === 8, "詳細: 経営者が書く項目は8つ");
  check(t.includes("お名前") && t.includes("バックエンド"), "詳細: 名簿から入る値は、読み取りだけで出る");
  check(await page.locator('[data-section="invite"]').count() === 0 && await page.locator('[data-section="mail"]').count() === 0, "詳細: 発行前は、URL・メールの欄は出ない");
  check(t.includes("未発行"), "詳細: 未発行と出る");
  check((await page.locator("#kei-side a.on").getAttribute("data-view")) === "onboarding", "詳細: メニューは「入社準備」のまま");

  // 金額を書くと、保存を断られる。理由が、その項目の近くに出る
  await page.fill('#guide-form [name="message"]', "月給30万円からです");
  await page.click('[data-act="save"]');
  await page.waitForTimeout(400);
  check((await page.locator("#guide-err").innerText()).includes("金額"), "詳細: 金額を書くと、理由つきで断られる");
  check(detail.st.draft.message === undefined, "詳細: 断られた内容は保存されない");

  await page.fill('#guide-form [name="message"]', "ようこそ");
  await page.fill('#guide-form [name="location"]', "原宿オフィス");
  await page.fill('#guide-form [name="meeting_time"]', "9:45");
  await page.click('[data-act="save"]');
  await page.waitForTimeout(400);
  const last = detail.st.posts.at(-1);
  check(last.action === "save_guide" && last.fields.location === "原宿オフィス" && last.fields.meeting_time === "9:45", "詳細: 下書きを保存する");
  check(await page.locator('#guide-form [name="location"]').inputValue() === "原宿オフィス", "詳細: 保存した値が残っている");

  await page.click('[data-act="issue"]');
  await page.waitForTimeout(500);
  const acts = detail.st.posts.map((x) => x.action).join(",");
  check(/save_guide,issue_guide$/.test(acts), `詳細: 発行の前に、いまの入力を保存する（${acts}）`);
  t = await bodyText(page);
  check(t.includes("発行済み 版1"), "詳細: 発行済み 版1");
  check((await page.locator('[data-act="issue"]').isDisabled()) && t.includes("変わっていません"), "詳細: 変更が無ければ、発行し直せない");
  check((await page.locator('[data-act="issue"]').innerText()).includes("版2"), "詳細: 次の発行は版2");
  check(t.includes("確認待ち"), "詳細: 本人の確認待ちと出る");
  check((await page.locator('.kei-st[data-step="guide"]').getAttribute("data-state")) === "current", "詳細: ① が要対応（本人の確認待ち）");

  // 案内URL
  check(await page.locator('[data-section="invite"]').count() === 1, "詳細: 発行後に、案内URLの欄が出る");
  await page.click('[data-act="invite"]');
  await page.waitForTimeout(500);
  const url = await page.locator("#invite-url").inputValue();
  check(/^https:\/\/gw\.example\.com\/onboarding\/\?t=TOKEN1$/.test(url), `詳細: 案内URLが出る（${url}）`);
  check((await page.locator('[data-role="invite-url"]').innerText()).includes("あとから取り出せません"), "詳細: URLは今だけ見える、と伝える");
  check(await page.locator('[data-section="invite"] tbody tr').count() === 1, "詳細: 発行したURLが一覧に出る");
  await page.click('[data-act="invite"]');
  await page.waitForTimeout(500);
  check((await page.locator("#invite-url").inputValue()).endsWith("TOKEN2"), "詳細: 発行し直すと、新しいURL");
  const stt = await page.locator('[data-section="invite"] tbody tr').allInnerTexts();
  check(stt.length === 2 && stt[0].includes("有効") && stt[1].includes("失効"), "詳細: 前のURLは失効と出る");
  await page.click('[data-act="copy"]');
  await page.waitForTimeout(300);
  check((await page.locator('[data-act="copy"]').innerText()).includes("コピー"), "詳細: コピーの操作ができる");
  await page.click('[data-act="revoke"]');
  await page.waitForTimeout(400);
  check(detail.st.posts.at(-1).action === "revoke_invite" && !(await page.locator('[data-act="revoke"]').count()), "詳細: URLを失効させられる");

  // メール（未設定）
  const mail = page.locator('[data-section="mail"]');
  check((await mail.innerText()).includes("メール送信は使えません") && (await mail.innerText()).includes("案内URL"), "詳細: メール未設定なら、そう言って、URLのコピーへ案内する");
  check(await page.locator('[data-act="send"]').isDisabled() && await page.locator('[data-act="test"]').isDisabled(), "詳細: 未設定では、送信・テスト送信は押せない");
  await page.click('[data-act="preview"]');
  await page.waitForTimeout(400);
  const pv = await page.locator('[data-role="mail-preview"]').innerText();
  check(pv.includes("hire@example.com") && pv.includes("入社準備を始める") && pv.includes("この人だけの期限つきURL"), "詳細: 文面の確認ができる（宛先・件名・本文。URLは送信時）");
  check(!detail.st.posts.some((x) => x.action === "send_mail" || x.action === "test_mail"), "詳細: 未設定では、送信のAPIを呼んでいない");
  t = await bodyText(page);
  check(!/円/.test(t), "詳細: 金額（円）は、どこにも出ない");
  await page.close();
}

console.log("\n— 入社準備の詳細：メール送信（設定済み）—");
{
  const detail = makeDetailServer({ configured: true });
  const page = await open({ appRole: "owner", roles: ["owner"] }, { detail, hash: "#onboarding/e10" });
  const confirms = [];
  page.on("dialog", (d) => { confirms.push(d.message()); d.accept(); });
  await page.fill('#guide-form [name="location"]', "原宿オフィス");
  await page.click('[data-act="issue"]');
  await page.waitForTimeout(600);
  const mail = page.locator('[data-section="mail"]');
  const mt = await mail.innerText();
  check(mt.includes("hr@example.com") && mt.includes("resend"), "メール: 送信元と送信サービスが出る（設定済み）");
  check(!(await page.locator('[data-act="send"]').isDisabled()) && !(await page.locator('[data-act="test"]').isDisabled()), "メール: 設定済みなら、押せる");
  check((await page.locator('[data-act="send"]').innerText()).includes("本人へ送信"), "メール: 最初は「本人へ送信」");

  await page.click('[data-act="test"]');
  await page.waitForTimeout(500);
  check(detail.st.posts.at(-1).action === "test_mail", "メール: テスト送信");
  check((await page.locator('[data-role="msg"]').innerText()).includes("owner@example.com"), "メール: テスト送信の宛先（自分）を伝える");

  await page.click('[data-act="send"]');
  await page.waitForTimeout(500);
  check(confirms.some((c) => c.includes("hire@example.com") && c.includes("履歴に残ります")), "メール: 送る前に、宛先を見せて確認する");
  check(detail.st.posts.at(-1).action === "send_mail", "メール: 送信する");
  check((await page.locator('[data-role="msg"]').innerText()).includes("送信しました"), "メール: 送信したと出る");
  check((await page.locator('[data-act="send"]').innerText()).includes("再送する"), "メール: 送信したあとは「再送する」");
  const rows = await mail.locator("tbody tr").allInnerTexts();
  check(rows.length === 2 && rows[0].includes("送信") && rows[1].includes("テスト"), "メール: 履歴に、送信とテストが1通ずつ出る");
  check(rows[0].includes("森田 経営") && rows[0].includes("hire@example.com"), "メール: 履歴に、送信者と宛先が出る");

  await page.click('[data-act="body"]');
  await page.waitForTimeout(400);
  check((await page.locator('[data-role="mail-body"]').innerText()).includes("入社準備を始める"), "メール: 履歴から、送った本文（確定版）が見られる");

  await page.click('[data-act="send"]');
  await page.waitForTimeout(500);
  check(detail.st.posts.filter((x) => x.action === "send_mail").length === 2, "メール: 再送できる");
  check((await mail.locator("tbody tr").count()) === 3, "メール: 再送も1通ずつ履歴に残る");
  await page.close();
}

console.log("\n— 入社準備：一覧から詳細へ・戻る／スマホ幅 —");
{
  const detail = makeDetailServer({ configured: false });
  const page = await open({ appRole: "owner", roles: ["owner"] }, { detail });
  await page.click('#kei-side a[data-view="onboarding"]');
  await page.waitForTimeout(500);
  await page.click('.kei-ob[data-employee="e10"] [data-role="detail"]');
  await page.waitForTimeout(600);
  check(page.url().endsWith("#onboarding/e10"), "一覧の「案内・URL・メールを開く」から、詳細へ");
  check((await bodyText(page)).includes("入社案内（本人に見せる内容）"), "詳細が開く");
  await page.click(".kei-back2");
  await page.waitForTimeout(500);
  check(await page.locator(".kei-ob").count() === 3, "「入社準備の一覧へ」で、一覧に戻る");
  await page.close();

  for (const width of [390]) {
    const p2 = await open({ appRole: "owner", roles: ["owner"] }, { detail: makeDetailServer({ configured: true }), width, hash: "#onboarding/e10" });
    p2.on("dialog", (d) => d.accept());
    await p2.click('[data-act="issue"]');
    await p2.waitForTimeout(500);
    await p2.click('[data-act="invite"]');
    await p2.waitForTimeout(400);
    await p2.click('[data-act="preview"]');
    await p2.waitForTimeout(400);
    const of = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(of <= 0, `${width}px 入社準備の詳細: 横スクロールが出ない（はみ出し ${of}px）`);
    await p2.screenshot({ path: shotPath("keiei-onboarding-detail-sp.png"), fullPage: true });
    await p2.close();
  }
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
