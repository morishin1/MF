// 入社手続きの2つの画面を、実際のブラウザで通す。
//
// ■ 本人の画面（onboarding.html）
//   「いまどこにいて、次に何をすればよいか」が、開いた瞬間に1つだけ分かること。
//   下のカードを行き来しないと分からない状態にしない。
//
// ■ 社労士の画面（advisor.html）
//   確認 → 修正 → 承認・発行 が、1画面で終わること。
//   会社に「送ってください」と頼み直す手が要らないこと。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---------------------------------------------------------------------------
// 本人の画面
// ---------------------------------------------------------------------------
const ME = {
  fields: [
    { group: "本人のこと", key: "name_kana", label: "氏名（カナ）", required: true },
    { group: "本人のこと", key: "address", label: "住所", required: true, wide: true },
  ],
  groups: ["本人のこと"],
  dependentFields: [], maxDependents: 10,
  known: { name: "山田 太郎", email: "y@8grp.co.jp", joinedOn: "2026-10-01" },
  profile: {}, profileStatus: "draft",
  missing: [{ key: "address", label: "住所" }],
  consents: [
    { key: "pledge", title: "誓約書", version: "1.0", summary: "…", body: "本文", agreed: true },
    { key: "rules", title: "社内ルール確認書", version: "1.0", summary: "…", body: "本文", agreed: true },
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
  progress: { done: 1, total: 6, pct: 16, byOwner: { employee: { done: 1, total: 4 } } },
  contracts: [
    { id: "s1", title: "労働条件通知書 兼 雇用契約書", kind: "employment",
      status: "sent", view: "sent", dueOn: "2026-09-25", signedAt: null },
  ],
  orientation: [
    { id: "o1", title: "会社説明", kind: "video", kindLabel: "動画",
      url: "https://example.jp/v", required: true, confirmed: false },
    { id: "o2", title: "社内ルール", kind: "text", kindLabel: "本文（社内ルール等）",
      body: "ルールの本文です", required: true, confirmed: true, confirmedAt: "2026-09-10T00:00:00Z" },
  ],
  stage: "signing",
  steps: {
    pct: 0, current: "contract", allMine: false,
    steps: [
      { key: "contract", n: 1, label: "契約書確認・同意", state: "current", done: false,
        todo: "労働条件通知書を確認して締結し、3つの書類にチェックを入れる",
        items: [{ label: "労働条件通知書 兼 雇用契約書", done: false, note: "締結してください（期限 2026-09-25）" }] },
      { key: "orientation", n: 2, label: "オリエンテーション", state: "todo", done: false,
        todo: "会社説明・社内ルールを読んで、確認済みにする", items: [] },
      { key: "profile", n: 3, label: "入社情報入力", state: "todo", done: false,
        todo: "住所・連絡先・振込口座などを入力して提出する", items: [] },
      { key: "documents", n: 4, label: "必要書類提出", state: "todo", done: false,
        todo: "手元の書類を出す", items: [] },
      { key: "complete", n: 5, label: "完了", state: "todo", done: false, todo: "", items: [] },
    ],
  },
};

const confirmed = [];

console.log("\n=== 本人の画面（STEP） ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "y@8grp.co.jp" }));
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
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/onboarding\/orientation/.test(url)) {
      if (req.method() === "POST") {
        confirmed.push(JSON.parse(req.postData() || "{}").confirm);
        return send({ ok: true });
      }
      return send({ items: ME.orientation, kinds: [], done: false });
    }
    if (/\/api\/onboarding\/me/.test(url)) return send(ME);
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "y@8grp.co.jp", appRole: "member", shows: {}, isAdmin: false,
        roles: [], memberships: [],
        gw: { employee: { id: "e1", display_name: "山田 太郎", status: "invited" },
              roles: [], tenantId: "t1", stage: { key: "preparing", allowed: ["onboarding", "home", "mypage"] } } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/onboarding.html`);
  await page.waitForTimeout(900);

  console.log("\n— STEP が5つ、順番に出る —");
  const steps = await page.locator(".ob-step").allInnerTexts();
  check(steps.length === 5, `5つある（${steps.length}）`);
  check(/契約書/.test(steps[0]) && /オリエンテーション/.test(steps[1])
     && /入社情報/.test(steps[2]) && /書類/.test(steps[3]) && /完了/.test(steps[4]),
    "1契約書 → 2オリエン → 3情報 → 4書類 → 5完了");

  console.log("\n— いま やること が1つだけ、大きく出る —");
  const now = await page.locator(".ob-now").innerText();
  check(/いま やること/.test(now), "見出しがある");
  check(/契約書確認・同意/.test(now), "いまの STEP の名前が出る");
  check(/締結/.test(now), "何をすればよいかが書いてある");
  check((await page.locator(".ob-now").count()) === 1, "1つだけ");
  check(await page.locator(".ob-step.current").count() === 1, "現在地が1つだけ光る");

  console.log("\n— 押すと、その STEP のカードへ飛ぶ —");
  await page.locator(".ob-now button").click();
  await page.waitForTimeout(500);
  const y = await page.evaluate(() => document.getElementById("step-1").getBoundingClientRect().top);
  check(y < 400, `STEP 1 が画面の上のほうに来る（${Math.round(y)}px）`);

  console.log("\n— STEP 1：契約書 —");
  const c = await page.locator("#contracts").innerText();
  check(/労働条件通知書/.test(c), "届いている契約書が出る");
  check(/未締結/.test(c), "まだ締結していないと分かる");
  check(/2026-09-25/.test(c), "期限が出る");
  check(await page.locator("#contracts a[href='contracts.html']").count() > 0, "締結の画面へ行ける");

  console.log("\n— STEP 2：オリエンテーション —");
  const o = await page.locator("#step-2").innerText();
  check(/会社説明/.test(o) && /社内ルール/.test(o), "教材が並ぶ");
  check(/ルールの本文です/.test(o), "本文はその場で読める");
  check(/確認済み/.test(o), "済んだものは、済んだと分かる");
  check(await page.locator("#step-2 a[href='https://example.jp/v']").count() > 0, "動画へ行ける");
  await page.locator("#orientation button", { hasText: "確認しました" }).first().click();
  await page.waitForTimeout(600);
  check(confirmed.includes("o1"), `確認をサーバへ送る（${confirmed.join(",")}）`);

  console.log("\n— 受け取らない書類は、出す口を出さない —");
  const docs = await page.locator("#docs").innerText();
  check(/マイナンバー確認書類/.test(docs), "項目そのものは出す");
  check(/社労士から直接/.test(docs), "どうすればよいか書いてある");
  const boxes = await page.locator("#docs .ob-doc").nth(1).locator("input[type=checkbox]").count();
  check(boxes === 0, "出す口（チェック・受け口）は出さない");

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
// 社労士の画面
// ---------------------------------------------------------------------------
console.log("\n=== 社労士の画面（確認 → 修正 → 承認・発行） ===");
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

  console.log("\n— 画面のエラー —");
  check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
