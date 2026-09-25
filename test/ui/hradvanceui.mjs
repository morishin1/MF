// 採用HR Stage 8：本採用へ進める（hr-applicants.html → admin-onboard.html）を、
// 実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 承諾済みの応募者に「本採用へ進める」が出る（社長・管理者だけ）。
//      押すとクレームしてから admin-onboard.html?applicantId=… へ渡る
//      （給与・勤務条件そのものはURLに載せない）
//   2. admin-onboard.htmlは、渡されたapplicantIdでサーバから採用条件を取得し、
//      事前入力する（STEP1・STEP2は選ばれたままにしない＝引き続き人が選ぶ）
//   3. STEP1×STEP2を選んでテンプレートの初期値が入っても、実際に合意した
//      契約区分・試用期間・勤務時間はテンプレートに上書きされない
//   4. 社員ができたら、応募者側の確定（complete）が呼ばれる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER = { id: "emp-o1", display_name: "社長", status: "active" };
const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };

console.log("\n=== 承諾済みに「本採用へ進める」が出る。押すとadmin-onboardへ渡る ===");
{
  const applicant = {
    id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
    stage: "offer", stageLabel: "内定", status: "accepted", statusLabel: "承諾済み",
    nextAction: "本採用へ進めてください", nextActionCta: "本採用へ進める", nextActionKey: "advance",
    rank: "A", decision: "hired", decisionDueOn: null,
  };
  const posted = [];

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        gw: { employee: OWNER, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/applicants\/advance/.test(url) && req.method() === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      return send({ applicantId: b.applicantId, resumed: false });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) return send({ applicant, timeline: [], offers: [] });
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr-applicants.html?id=a1`);
  await page.waitForTimeout(1000);

  check((await page.locator(".hr-next").innerText()).includes("本採用へ進めてください"), "ラベルが出る");
  check(await page.locator(".hr-next button", { hasText: "本採用へ進める" }).count() === 1, "ボタンが出る（社長）");

  await Promise.all([
    page.waitForURL(/admin-onboard\.html/),
    page.locator(".hr-next button", { hasText: "本採用へ進める" }).click(),
  ]);
  check(posted.length === 1 && posted[0].applicantId === "a1", "クレームがサーバへ送られる（事前入力は含まない）");
  check(page.url().includes("admin-onboard.html?applicantId=a1"), "applicantIdだけを渡してadmin-onboard.htmlへ渡る");
  check(!page.url().includes("400000") && !page.url().includes("wage"), "給与などの条件はURLに載らない");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== recruiterには「本採用へ進める」ボタンが出ない ===");
{
  const applicant = {
    id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
    stage: "offer", stageLabel: "内定", status: "accepted", statusLabel: "承諾済み",
    nextAction: "本採用へ進めてください", nextActionCta: "本採用へ進める", nextActionKey: "advance",
    rank: "A", decision: "hired", decisionDueOn: null,
  };
  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) return send({ applicant, timeline: [], offers: [] });
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/hr-applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  check(await page.locator(".hr-next button", { hasText: "本採用へ進める" }).count() === 0, "recruiterにはボタンが出ない");
  check((await page.locator(".hr-next").innerText()).includes("社長・管理者が行います"), "案内文が出る");
  await page.close();
}

console.log("\n=== admin-onboard.html：採用条件が事前入力される ===");
{
  const page = await br.newPage({ viewport: { width: 1300, height: 1400 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const prefillCalls = [];

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "ceo@8grp.co.jp", appRole: "admin", isAdmin: false, shows: {},
        gw: { employee: OWNER, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/applicants\/advance\?applicantId=/.test(url)) {
      prefillCalls.push(url);
      return send({
        applicantId: "a1",
        prefill: {
          name: "山田 太郎", email: "yamada@example.com", joinDate: "2026-11-01",
          contractType: "無期", probationMonths: 3, weeklyHours: 40, wageAmount: 400000,
        },
      });
    }
    if (/\/api\/employees\/onboard\?mode=/.test(url)) {
      // 「働き方 × 担当業務」の一般的な初期値。実際に合意した条件（契約区分・
      // 試用期間・勤務時間）とは別物 — テストが確かめたいのはここが勝たないこと
      return send({
        values: {
          initial_role: "セールス担当", training_months: 3, probation_months: 6,
          weekly_hours: 20, contract_type: "有期", work_style: "", autonomy_level_start: 1,
          account_type: "standard", work_scope: [], training_programs: [],
        },
      });
    }
    if (/\/api\/employees\/onboard/.test(url)) {
      return send({
        levels: [{ level: 1, label: "見習い", summary: "基礎" }],
        managers: [{ email: "m@example.com", name: "上長 太郎", position: null }],
        wageTypes: ["月給", "年俸"],
        allowances: [],
        workModes: [{ code: "wm1", label: "正社員型", note: "" }],
        jobGroups: ["営業"],
        jobs: [{ code: "j1", group: "営業", label: "セールス", kgi: "受注" }],
      });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-onboard.html?applicantId=a1`);
  await page.waitForTimeout(1000);

  check(prefillCalls.length === 1, "サーバへ事前入力を取りに行く（GET）");
  check(await page.locator("#f-name").inputValue() === "山田 太郎", "氏名が事前入力される");
  check(await page.locator("#f-email").inputValue() === "yamada@example.com", "メールが事前入力される");
  check(await page.locator("#f-join").inputValue() === "2026-11-01", "入社日が事前入力される");
  check(await page.locator("#f-contract").inputValue() === "無期", "契約区分が事前入力される");
  check(await page.locator("#f-probation").inputValue() === "3", "試用期間が事前入力される");
  check(await page.locator("#f-hours").inputValue() === "40", "勤務時間が事前入力される");
  check(await page.locator("#f-wage").inputValue() === "400000", "給与額が事前入力される");
  check((await page.locator("#notice").innerText()).includes("採用HRから"), "採用HRからの案内が出る");

  console.log("\n— STEP1×STEP2を選んでも、実際の契約条件はテンプレートに上書きされない —");
  await page.locator("#m-wm1").click();
  await page.locator("#j-j1").click();
  await page.waitForTimeout(400);
  check(await page.locator("#f-contract").inputValue() === "無期", "契約区分は維持される（テンプレートに戻らない）");
  check(await page.locator("#f-probation").inputValue() === "3", "試用期間は維持される");
  check(await page.locator("#f-hours").inputValue() === "40", "勤務時間は維持される");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== admin-onboard.html：社員ができたら、応募者側の確定が呼ばれる ===");
{
  const page = await br.newPage({ viewport: { width: 1300, height: 1400 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const posted = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "ceo@8grp.co.jp", appRole: "admin", isAdmin: false, shows: {},
        gw: { employee: OWNER, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/applicants\/advance\?applicantId=/.test(url)) {
      return send({ applicantId: "a1", prefill: { name: "山田 太郎" } });
    }
    if (/\/api\/hr\/applicants\/advance/.test(url) && req.method() === "PATCH") {
      posted.push(JSON.parse(req.postData() || "{}"));
      return send({ ok: true, status: "done" });
    }
    if (/\/api\/employees\/onboard/.test(url)) {
      return send({ levels: [], managers: [], wageTypes: [], allowances: [], workModes: [], jobGroups: [], jobs: [] });
    }
    return send({});
  });

  await page.goto(`${BASE}/admin-onboard.html?applicantId=a1`);
  await page.waitForTimeout(800);

  // completeAdvanceIfPending は create() 成功後に呼ばれる内部関数。
  // preview/create本体（STEP1〜3か月KGI表示まで）はここでは対象にせず、
  // 「本採用へ進める」から渡した情報が、社員作成後にどう使われるかだけを見る
  await page.evaluate(async () => { await window.completeAdvanceIfPending("emp-new1"); });
  await page.waitForTimeout(300);

  check(posted.length === 1 && posted[0].applicantId === "a1" && posted[0].employeeId === "emp-new1" && posted[0].action === "complete",
    "応募者側の確定（complete）が正しい引数で呼ばれる");
  check(!page.url().includes("applicantId"), "使い終わったらURLからapplicantIdが消える");

  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
