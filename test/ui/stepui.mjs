// 入社手続きの共通ページ（onboarding.html）と、社労士の一覧（advisor.html）を、
// 実際のブラウザで通す。
//
// ■ 何を守りたいのか
//
//   ・同じ onboarding.html を、本人・管理者・社労士がそれぞれの役割で開ける
//   ・STEP は6つ、いまどこで止まっているかが1つの帯で分かる
//   ・本人は、契約（STEP2）が済むまで入社情報・書類を見せられない
//   ・管理者は、会社側の準備（STEP5）をこの画面でチェックできる
//   ・社労士は、給与などの労働条件を見せられず、労働条件の承認・発行がこの画面でできる
//   ・社労士の一覧（advisor.html）から、確認 → 修正 → 承認・発行 が1画面で終わる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const STEP_DEFS = [
  { key: "advisor_check", n: 1, label: "社労士確認", actor: "advisor", actorLabel: "社労士",
    todo: "労働条件通知書を確認して、承認・発行する" },
  { key: "contract", n: 2, label: "本人契約", actor: "employee", actorLabel: "本人",
    todo: "労働条件通知書を確認して締結し、誓約書等に同意する" },
  { key: "profile", n: 3, label: "入社情報", actor: "employee", actorLabel: "本人",
    todo: "住所・連絡先・振込口座などを入力して提出する" },
  { key: "documents", n: 4, label: "必要書類", actor: "employee", actorLabel: "本人",
    todo: "手元の書類を出し、オリエンテーションを確認する" },
  { key: "company", n: 5, label: "会社確認", actor: "admin", actorLabel: "管理者",
    todo: "PC・アカウント・勤怠などの社内準備を終える" },
  { key: "complete", n: 6, label: "完了", actor: null, actorLabel: "—", todo: "" },
];
// テストの中で使う分だけ、6STEPを組み立てる。done の並びから current を出すのは
// lib/onboard-steps.js の仕事なので、ここでは「どこまで済んだか」だけを渡す
function steps(doneUpTo, items = {}) {
  const order = STEP_DEFS.map((s) => s.key);
  const doneIdx = order.indexOf(doneUpTo);
  const list = STEP_DEFS.map((def, i) => ({
    ...def, done: i <= doneIdx, items: items[def.key] || [],
  }));
  const current = list.slice(0, 4).find((s) => !s.done)?.key || list.find((s) => !s.done)?.key || null;
  const out = list.map((s) => ({ ...s, state: s.done ? "done" : s.key === current ? "current" : "todo" }));
  const done = out.filter((s) => s.done).length;
  return { steps: out, current, pct: Math.round((done / out.length) * 100), allMine: doneIdx >= 3 };
}

const KNOWN = {
  name: "山田 太郎", email: "yamada@8grp.co.jp", department: "営業", position: "担当",
  employmentType: "正社員", joinedOn: "2026-10-01", targetOn: "2026-10-01",
  wage: "月給 300,000円", contractPeriod: "無期", probation: "3か月", weeklyHours: 40,
};

// ---------------------------------------------------------------------------
// 本人：社労士確認待ち（STEP1）のあいだは、契約より先を見せない
// ---------------------------------------------------------------------------
console.log("\n=== 本人の画面：社労士確認待ち ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "yamada@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: "member", name: "山田", shows: {},
      stage: { key: "preparing", allowed: ["home", "tasks", "onboarding", "contracts", "mypage"],
               preparingOnly: ["onboarding"] } }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/onboarding\/status/.test(url)) {
      return send({
        role: "self", roleLabel: "本人", employeeId: "e1", known: KNOWN,
        procedureId: "p1", status: "in_progress", stage: "advisor_review",
        mynumber: "未提出", mynumberStatus: "not_submitted",
        steps: steps(null),
      });
    }
    if (/\/api\/onboarding\/me/.test(url)) {
      return send({
        fields: [], groups: [], dependentFields: [], maxDependents: 10,
        known: KNOWN, companyDocuments: [], consents: [], consentHistory: [],
        documents: [], docsProblem: null, drive: { ready: false, manual: false, note: null },
        allDone: false, procedureId: "p1", status: "in_progress", targetOn: "2026-10-01",
        profile: {}, profileStatus: "draft", missing: [], myItems: [], progress: { done: 0, total: 0 },
        contracts: [], orientation: [], stage: "advisor_review", steps: steps(null),
      });
    }
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "yamada@8grp.co.jp", appRole: "member", shows: {}, isAdmin: false,
        roles: [], memberships: [],
        gw: { employee: { id: "e1", display_name: "山田 太郎", status: "invited" },
              roles: [], tenantId: "t1", stage: { key: "preparing", allowed: ["onboarding", "home", "mypage"] } } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/onboarding.html`);
  await page.waitForTimeout(900);

  console.log("\n— STEP が6つ、この順で出る —");
  const stepTexts = await page.locator(".ob-step").allInnerTexts();
  check(stepTexts.length === 6, `6つある（${stepTexts.length}）`);
  check(/社労士確認/.test(stepTexts[0]) && /本人契約/.test(stepTexts[1]) && /入社情報/.test(stepTexts[2])
     && /必要書類/.test(stepTexts[3]) && /会社確認/.test(stepTexts[4]) && /完了/.test(stepTexts[5]),
    "1社労士確認 → 2本人契約 → 3入社情報 → 4必要書類 → 5会社確認 → 6完了");
  check(await page.locator(".ob-step.current").count() === 1, "現在地が1つだけ強調される");

  console.log("\n— いまどこで止まっているかが、1つの帯で分かる —");
  const now = await page.locator(".ob-now").innerText();
  check(/社労士確認待ち/.test(now), "「社労士確認待ち」と出る");
  check(/社労士が確認しています/.test(now), "何が起きているか書いてある");
  check(await page.locator(".ob-now.wait").count() === 1, "自分の番ではないとき、控えめな見た目になる");

  console.log("\n— 契約より先は、まだ見せない —");
  check(await page.locator("#step-3").isVisible() === false, "STEP3（入社情報）は隠れている");
  check(await page.locator("#step-4").isVisible() === false, "STEP4（必要書類）は隠れている");
  check(await page.locator("#submit-card").isVisible() === false, "提出カードも隠れている");
  const c = await page.locator("#contracts").innerText();
  check(/社労士が確認中/.test(c), "契約カードには「社労士が確認中」とだけ出る");

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 本人：契約が済んだあと（入社情報が今の番）
// ---------------------------------------------------------------------------
console.log("\n=== 本人の画面：契約後（入社情報が今の番） ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "yamada@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: "member", name: "山田", shows: {},
      stage: { key: "preparing", allowed: ["home", "tasks", "onboarding", "contracts", "mypage"],
               preparingOnly: ["onboarding"] } }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  const ME = {
    fields: [
      { group: "本人のこと", key: "name_kana", label: "氏名（カナ）", required: true },
      { group: "本人のこと", key: "address", label: "住所", required: true, wide: true },
    ],
    groups: ["本人のこと"], dependentFields: [], maxDependents: 10,
    known: KNOWN, profile: {}, profileStatus: "draft",
    missing: [{ key: "address", label: "住所" }],
    consents: [
      { key: "pledge", title: "誓約書", version: "1.0", summary: "…", body: "本文", agreed: true },
    ],
    consentHistory: [], companyDocuments: [],
    documents: [
      { key: "doc_resume", itemId: "i1", title: "履歴書・職務経歴書", desc: "", required: true,
        sensitive: false, status: "todo", files: [] },
      { key: "doc_mynumber", itemId: "i2", title: "マイナンバー確認書類", desc: "受け取りません",
        required: false, sensitive: true, status: "todo", files: [] },
    ],
    myItems: [], docsProblem: null, drive: { ready: false, manual: false, note: null },
    allDone: false, procedureId: "p1", status: "in_progress", targetOn: "2026-10-01",
    progress: { done: 3, total: 6 },
    contracts: [{ id: "s1", title: "労働条件通知書 兼 雇用契約書", kind: "employment",
      status: "signed", view: "signed", dueOn: "2026-09-25", signedAt: "2026-09-05T00:00:00Z" }],
    orientation: [
      { id: "o1", title: "会社説明", kind: "video", kindLabel: "動画",
        url: "https://example.jp/v", required: true, confirmed: false },
    ],
    stage: "intake",
    steps: steps("contract"),
  };

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/onboarding\/orientation/.test(url)) return send({ ok: true });
    if (/\/api\/onboarding\/status/.test(url)) {
      return send({
        role: "self", roleLabel: "本人", employeeId: "e1", known: KNOWN,
        procedureId: "p1", status: "in_progress", stage: "intake",
        mynumber: "未提出", mynumberStatus: "not_submitted", steps: steps("contract"),
      });
    }
    if (/\/api\/onboarding\/me/.test(url)) return send(ME);
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "yamada@8grp.co.jp", appRole: "member", shows: {}, isAdmin: false,
        roles: [], memberships: [],
        gw: { employee: { id: "e1", display_name: "山田 太郎", status: "invited" },
              roles: [], tenantId: "t1", stage: { key: "preparing", allowed: ["onboarding", "home", "mypage"] } } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/onboarding.html`);
  await page.waitForTimeout(900);

  console.log("\n— 契約が済むと、先のSTEPが見える —");
  check(await page.locator("#step-3").isVisible(), "STEP3（入社情報）が見える");
  check(await page.locator("#step-4").isVisible(), "STEP4（必要書類）が見える");
  check(await page.locator("#submit-card").isVisible(), "提出カードが見える");

  console.log("\n— いま やること —");
  const now = await page.locator(".ob-now").innerText();
  check(/あなたの確認が必要です/.test(now), "自分の番だと分かる");
  check(await page.locator(".ob-now.wait").count() === 0, "自分の番のときは控えめ表示にならない");

  console.log("\n— 受け取らない書類は、出す口を出さない —");
  const docs = await page.locator("#docs").innerText();
  check(/マイナンバー確認書類/.test(docs), "項目そのものは出す");
  check(/社労士から直接/.test(docs), "どうすればよいか書いてある");

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 管理者：会社側の準備（STEP5）をこの画面でチェックできる
// ---------------------------------------------------------------------------
console.log("\n=== 管理者の画面：会社側の準備 ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  const patched = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/onboarding\/items/.test(url) && req.method() === "PATCH") {
      patched.push(JSON.parse(req.postData() || "{}"));
      return send({ item: { id: "it1", status: "done" } });
    }
    if (/\/api\/onboarding\/status/.test(url)) {
      return send({
        role: "admin", roleLabel: "管理者", employeeId: "e1", known: KNOWN,
        procedureId: "p1", status: "in_progress", stage: "intake",
        mynumber: "未提出", mynumberStatus: "not_submitted",
        steps: steps("documents", {
          company: [{ id: "it1", label: "PC準備", done: false, note: "準備中" },
                    { id: "it2", label: "Slack発行", done: true, note: "準備済み" }],
        }),
      });
    }
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@8grp.co.jp", appRole: "admin", shows: {}, isAdmin: true,
        roles: [], memberships: [],
        gw: { employee: { id: "e-hr", display_name: "事務 花子", status: "active" },
              roles: ["hr"], tenantId: "t1", stage: null } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/onboarding.html?employeeId=e1`);
  await page.waitForTimeout(900);

  console.log("\n— 役割と、対象者が分かる —");
  const role = await page.locator("#role-card").innerText();
  check(/管理者/.test(role), "役割バナーに「管理者」と出る");
  check(/山田 太郎/.test(role), "誰の手続きかが分かる");

  console.log("\n— 会社側の準備を、この画面でチェックできる —");
  check(await page.locator("#admin-wrap").isVisible(), "会社側の準備カードが見える");
  const rows = await page.locator("#admin-internal .ob-final-row").allInnerTexts();
  check(rows.some((r) => /PC準備/.test(r)), "PC準備が並ぶ");
  check(rows.some((r) => /Slack発行/.test(r) && /準備済み/.test(r)), "済んだものは済んだと分かる");
  await page.locator("#admin-internal .ob-final-row", { hasText: "PC準備" }).locator("input").check();
  await page.waitForTimeout(400);
  check(patched.some((p) => p.id === "it1" && p.status === "done"), "チェックすると保存される");

  console.log("\n— 本人には見えない管理を、リンクで導く —");
  check((await page.locator("#admin-esign-link").getAttribute("href")).includes("employeeId=e1"),
    "労働条件・電子契約の管理へ、対象者付きで飛べる");
  check((await page.locator("#admin-hr-link").getAttribute("href")).includes("id=p1"),
    "詳しい管理（入退社の管理画面）へ、手続きID付きで飛べる");

  console.log("\n— 給与など、本人以外に出さない情報は隠さない（管理者は見てよい）—");
  const known = await page.locator("#known").innerText();
  check(/300,000円/.test(known), "管理者には給与が見える");

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 社労士：この画面で労働条件の承認・発行までできる。給与などは見えない
// ---------------------------------------------------------------------------
console.log("\n=== 社労士の画面（onboarding.html）：確認・発行と、見えないもの ===");
{
  const posted = [];
  const ORDERS = {
    orders: [{
      id: "o1", employeeId: "e1",
      employee: { id: "e1", display_name: "山田 太郎" },
      docKind: "employment", title: "労働条件通知書 兼 雇用契約書",
      conditions: { 雇用区分: "正社員", 賃金: "月給 300,000円" },
      missing: [], note: null, advisorNote: null,
      status: "requested", statusLabel: "依頼中", fileName: null, approvedAt: null,
    }],
    fields: [
      { key: "雇用区分", placeholder: "正社員／契約社員", required: true },
      { key: "賃金", placeholder: "月給 300,000円", required: true },
    ],
  };

  const page = await br.newPage({ viewport: { width: 1200, height: 950 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sr@example.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "sr", name: "社労士", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  const mnUpdates = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/sign\/orders/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        if (b.action === "preview") return send({ title: "t", text: "…", missing: [], pdfBase64: "JVBERi0xLjQK" });
        return send({ ok: true });
      }
      return send(ORDERS);
    }
    if (/\/api\/hr\b/.test(url) && req.method() === "PATCH") {
      mnUpdates.push(JSON.parse(req.postData() || "{}"));
      return send({ ok: true });
    }
    if (/\/api\/onboarding\/status/.test(url)) {
      return send({
        role: "advisor", roleLabel: "社労士", employeeId: "e1",
        known: { ...KNOWN, email: null, wage: null, contractPeriod: null, probation: null, weeklyHours: null },
        procedureId: "p1", status: "in_progress", stage: "advisor_review",
        mynumber: "未提出", mynumberStatus: "not_submitted", steps: steps(null),
      });
    }
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "sr@example.jp", appRole: "sr", shows: {}, isAdmin: false,
        roles: [], memberships: [],
        gw: { employee: { id: "emp-sr", display_name: "社労士", status: "active" },
              roles: ["labor_advisor"], tenantId: "t1", stage: null } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/onboarding.html?employeeId=e1`);
  await page.waitForTimeout(900);

  console.log("\n— 給与・メールなど、社労士には渡さない情報が出ない —");
  const known = await page.locator("#known").innerText();
  check(!/300,000円/.test(known), "給与が出ない");
  check(!/yamada@8grp\.co\.jp/.test(known), "メールが出ない");
  check(/社労士には表示していません/.test(await page.locator("#known-note").innerText()), "出していない理由が書いてある");

  console.log("\n— 労働条件の確認・発行が、この画面でできる —");
  check(await page.locator("#advisor-wrap").isVisible(), "労働条件カードが見える");
  await page.locator("#advisor-order button", { hasText: "内容を確認する" }).click();
  await page.waitForTimeout(300);
  await page.locator("[id^='c-o1-']").first().fill("正社員（変更なし）");
  await page.locator("#advisor-order button", { hasText: "承認・発行" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "approve"), "承認・発行を送る");

  console.log("\n— マイナンバーの進み具合も、この画面から変えられる —");
  await page.locator("#advisor-mn select").selectOption("submitted_to_advisor");
  await page.waitForTimeout(400);
  check(mnUpdates.some((m) => m.mynumber === "submitted_to_advisor"), "選ぶと保存される");

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 社労士の一覧（advisor.html）：確認 → 修正 → 承認・発行 が1画面で終わる
// ---------------------------------------------------------------------------
console.log("\n=== 社労士の一覧（advisor.html） ===");
{
  const posted = [];
  const ORDERS = {
    orders: [{
      id: "o1", employeeId: "emp-new",
      employee: { id: "emp-new", display_name: "山田 太郎", department: "営業",
                  employment_type: "正社員", joined_on: "2026-10-01" },
      docKind: "employment", kindLabel: "労働条件通知書・雇用契約書",
      title: "労働条件通知書 兼 雇用契約書",
      conditions: { 雇用区分: "正社員", 賃金: "月給 300,000円" },
      missing: ["就業場所", "業務内容"],
      note: "10月入社の方です", advisorNote: null,
      status: "requested", statusLabel: "依頼中",
      fileName: null, approvedAt: null,
    }],
    counts: { requested: 1, uploaded: 0, sent: 0, signed: 0 },
    fields: [
      { key: "雇用区分", placeholder: "正社員／契約社員", required: true },
      { key: "就業場所", placeholder: "本社", required: true },
      { key: "業務内容", placeholder: "Web制作", required: true },
      { key: "賃金", placeholder: "月給 300,000円", required: true },
    ],
    statuses: [], kinds: [], advisor: true,
  };

  const page = await br.newPage({ viewport: { width: 1280, height: 950 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sr@example.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: "sr", name: "社労士", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/sign\/orders/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        if (b.action === "preview") {
          return send({ title: "労働条件通知書", text: "第1条（雇用区分）正社員",
                        missing: [], pdfBase64: "JVBERi0xLjQK" });
        }
        return send({ ok: true, signRequestId: "s1", dueOn: "2026-09-30" });
      }
      return send(ORDERS);
    }
    if (/\/api\/onboarding\b/.test(url)) {
      return send({ procedures: [], mynumberStates: [] });
    }
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "sr@example.jp", appRole: "sr", shows: {}, isAdmin: false,
        roles: [], memberships: [],
        gw: { employee: { id: "emp-sr", display_name: "社労士", status: "active" },
              roles: ["labor_advisor"], tenantId: "t1", stage: null } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/advisor.html`);
  await page.waitForTimeout(900);

  console.log("\n— 会社が入れた労働条件が、そのまま見える —");
  const card = await page.locator(".ord").first().innerText();
  check(/山田 太郎/.test(card), "誰のぶんか");
  check(/2026年10月1日/.test(card), "入社日");
  check(/正社員/.test(card), "雇用形態");
  check(/10月入社の方です/.test(card), "会社からの申し送り");
  check(/就業場所・業務内容 が空欄/.test(card), "空欄がどれか、先に分かる");

  console.log("\n— 開くと、その場で直せる —");
  await page.locator(".ord button", { hasText: "内容を確認する" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("#c-o1-賃金").inputValue() === "月給 300,000円", "いまの条件が入っている");
  check(await page.locator("#c-o1-就業場所").isVisible(), "空欄の欄も出る");
  await page.locator("#c-o1-就業場所").fill("本社（変更の範囲：会社の定める事業所）");
  await page.locator("#c-o1-業務内容").fill("Web制作・ディレクション");
  await page.locator("#n-o1").fill("就業場所を補いました");

  console.log("\n— 通知書を、その場で見られる —");
  await page.locator(".ord-act button", { hasText: "通知書を見る" }).click();
  await page.waitForTimeout(500);
  const prev = posted.find((p) => p.action === "preview");
  check(Boolean(prev), "プレビューを求める");
  check(prev?.conditions?.["就業場所"] === "本社（変更の範囲：会社の定める事業所）",
    "画面で直した内容で作る");
  check(await page.locator(".ord-prev iframe").count() === 1, "通知書が画面に出る");

  console.log("\n— 承認・発行の1回で、本人へ届くところまで —");
  await page.locator(".ord-act button", { hasText: "承認・発行" }).click();
  await page.waitForTimeout(700);
  const ap = posted.find((p) => p.action === "approve");
  check(Boolean(ap), "承認を送る");
  check(ap?.conditions?.["業務内容"] === "Web制作・ディレクション", "直した条件のまま発行する");
  check(ap?.advisorNote === "就業場所を補いました", "申し送りも一緒に送る");
  check(!posted.some((p) => p.action === "send"), "会社の「送る」を待たない");

  console.log("\n— 同じ進み具合の共有ページへ、対象者付きで飛べる —");
  check((await page.locator(".ord a", { hasText: "本人・管理者と同じ進み具合を見る" }).first()
    .getAttribute("href")).includes("employeeId=emp-new"), "onboarding.htmlへ、対象者付きで飛べる");

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
