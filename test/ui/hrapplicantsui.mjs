// 採用HR：応募者管理（/hr/applicants.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 採用担当（recruiter）としてログインすると、専用ヘッダー
//      （EIGHT/HR・3ナビ）が出て、一覧が見える
//   2. 「応募者追加」から追加すると、一覧に出る
//   3. 行をクリックすると右ドロワーで詳細が開く（NEXT ACTIONが出る）
//   4. 権限の無い人は home.html へ送り返される
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const EMPLOYEES = [{ id: "emp-r1", display_name: "採用 花子" }, { id: "emp-2", display_name: "面接 次郎" }];

console.log("\n=== 採用担当：応募者一覧・追加・詳細 ===");
{
  const posted = [];
  let applicants = [];

  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id");
      const a = applicants.find((x) => x.id === id);
      if (req.method() === "PATCH") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push({ patch: true, ...b });
        const t = applicants.find((x) => x.id === b.id);
        if (t && "recruiterId" in b) { t.recruiterId = b.recruiterId; t.recruiterName = EMPLOYEES.find((e) => e.id === b.recruiterId)?.display_name || null; }
        return send({ applicant: t });
      }
      return send({
        applicant: { ...a },
        interviews: [], timeline: [{ id: "t1", eventKey: "applied", label: "応募", occurredAt: "2026-09-20T00:00:00Z" }],
        offers: [],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        const made = {
          id: `a${applicants.length + 1}`, name: b.name, jobTitle: b.jobTitle, source: b.source,
          stage: "applied", stageLabel: "新規応募", status: "todo", statusLabel: "未対応", nextAction: "対応を進めてください",
          rank: null, decisionDueOn: null, overdue: false, interviewCount: 0,
          recruiterId: b.recruiterId || null, recruiterName: EMPLOYEES.find((e) => e.id === b.recruiterId)?.display_name || null,
          createdAt: new Date().toISOString(),
        };
        applicants = [...applicants, made];
        return send({ applicant: made });
      }
      return send({ applicants, employees: EMPLOYEES, meEmployeeId: RECRUITER.id,
        sources: { options: ["Wantedly", "Green", "Indeed", "求人ボックス", "エージェント", "リファラル", "自社サイト", "SNS", "イベント・セミナー", "その他"],
          counts: [{ key: "Wantedly", label: "Wantedly", count: applicants.filter((a) => a.source === "Wantedly").length }] } });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForTimeout(1000);

  console.log("— 専用ヘッダーが出る —");
  check((await page.locator(".hr-logo").innerText()).includes("HR"), "EIGHT/HR のロゴが出る");
  const navCount = await page.locator(".hr-nav a").count();
  // 資料タブ（db/136・js/hr-materials-nav.js）が加わり5つ
  check(navCount === 5, `ナビは5つだけ（いま ${navCount}）`);
  const navTexts = await page.locator(".hr-nav a").allInnerTexts();
  check(navTexts.some((t) => t.includes("ダッシュボード")) && navTexts.some((t) => t.includes("応募分析"))
    && navTexts.some((t) => t.includes("CEO REVIEW")) && navTexts.some((t) => t.includes("資料"))
    && navTexts.some((t) => t.includes("メールひな型")),
    `ダッシュボード／応募分析／CEO REVIEW／資料／メールひな型 の5つ（いま ${navTexts.join(" / ")}）`);
  check((await page.locator(".hr-nav a.on").innerText()).includes("ダッシュボード"), "いま見ている採用ダッシュボードが選ばれている");
  check(!(await page.locator(".kp-sidebar").count()), "通常のサイドメニューは出さない");

  console.log("— 応募者が0件のときの表示 —");
  check((await page.locator("#rows").innerText()).includes("対象がありません"), "空の一覧");

  console.log("— 応募者を追加する —");
  await page.locator("button", { hasText: "応募者追加" }).click();
  await page.waitForTimeout(400);
  await page.fill("#a-name", "田中 一郎");
  await page.fill("#a-job", "セールス");
  const sourceLabels = await page.locator('#a-sources input[name="a-source"]').evaluateAll((xs) => xs.map((x) => x.value));
  check(sourceLabels.join("|") === "Wantedly|Green|Indeed|求人ボックス|エージェント|リファラル|自社サイト|SNS|イベント・セミナー|その他", "応募媒体は固定候補");
  await page.locator('input[name="a-source"]').first().check();
  check((await page.locator("#a-recruiter").inputValue()) === RECRUITER.id, "担当の初期値は登録する本人");
  await page.locator("button", { hasText: "追加する" }).click();
  await page.waitForTimeout(700);

  check(posted.length === 1 && posted[0].name === "田中 一郎", "追加が送られる");
  check(posted[0].recruiterId === RECRUITER.id, "担当も一緒に送られる");
  check((await page.locator("#rows").innerText()).includes("田中 一郎"), "一覧に出る");
  check((await page.locator("#rows").innerText()).includes("セールス"), "職種も出る");
  // 追加すると、その人の詳細が開く（HRフロー仕様 §1）。いったん閉じて、一覧から開き直す
  check(await page.locator(".hr-detail").isVisible(), "追加すると、その人の詳細ドロワーが開く");
  await page.locator(".hr-detail button", { hasText: "閉じる" }).first().click();
  await page.waitForTimeout(300);

  console.log("— 詳細を右ドロワーで開く —");
  await page.locator(".hr-table tr.click").first().click();
  await page.waitForTimeout(500);
  check(await page.locator(".hr-detail").isVisible(), "右ドロワーが開く");
  check(await page.locator(".hr-detail .hr-next").isVisible(), "NEXT ACTION（いまの状態と次の1つ）が概要の最初に出る");
  check((await page.locator(".hr-detail").innerText()).includes("田中 一郎"), "本人の名前が出る");
  check((await page.locator(".hr-detail").innerText()).includes("応募"), "選考タイムラインが出る");
  const detailTabs = await page.locator(".hr-detail .hr-tabs button").allInnerTexts();
  check(detailTabs.join("|") === "基本情報|選考|書類|メール|履歴", `詳細タブを5つに整理（${detailTabs.join("|")}）`);
  {
    // NEXT ACTION は「いまの状態」と「次に押すボタン1つ」だけ（応募者ドロワー改善 §3・§4：高さ 80〜110px 程度）
    const card = page.locator(".hr-next");
    check((await page.locator(".hr-next #hr-status").innerText()).trim().length > 0, "いまの状態が出る");
    check(await card.locator("button.btn-primary").count() <= 1, "主のボタンは1つだけ");
    const h = (await card.boundingBox()).height;
    check(h <= 130, `NEXT ACTION の枠は短い（${Math.round(h)}px）`);
    check(!(await card.innerText()).includes("どこまで進んでいるか"), "選考・状態の長い説明は出さない");
  }

  console.log("— 担当を詳細から変更できる —");
  check((await page.locator("#hr-recruiter").innerText()).includes(RECRUITER.display_name), "詳細に担当が出る");
  await page.locator("#hr-recruiter button", { hasText: "変更" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("#rc-select").isVisible(), "担当の変更は中央モーダル");
  await page.selectOption("#rc-select", "emp-2");
  await page.locator("#action-root button", { hasText: "保存" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.patch && p.recruiterId === "emp-2"), "担当の変更が送られる");
  check(await page.locator(".hr-detail").isVisible() && !(await page.locator("#rc-select").count()), "保存後もドロワーは開いたまま・モーダルは閉じる");
  check((await page.locator("#hr-recruiter").innerText()).includes("面接 次郎"), "ドロワーにすぐ反映");

  await page.locator(".hr-detail button", { hasText: "閉じる" }).first().click();
  await page.waitForTimeout(300);
  check(!(await page.locator(".hr-detail").count()), "閉じると消える");

  console.log("— 採用HRマニュアルへヘッダーから移動できる —");
  const manual = page.locator(".hr-manual");
  check(await manual.isVisible(), "採用HRヘッダーにマニュアルが表示される");
  check(await manual.getAttribute("href") === "/guide-hr-office.html#hr", "採用HRの章へ直接移動する");
  await manual.click();
  await page.waitForURL("**/guide-hr-office.html#hr");
  check((await page.title()).includes("採用HR・Office 操作マニュアル"), "新しい操作マニュアルが開く");
  check((await page.locator("body").innerText()).includes("応募者"), "採用HRの操作説明が載っている");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 権限の無い人は home.html へ送り返される ===");
{
  const page = await br.newPage({ viewport: { width: 1000, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "member@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "member@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        gw: { employee: { id: "emp-m1", display_name: "一般 次郎", status: "active" }, roles: [], isAdmin: false, tenantId: "t1", stage: null } });
    }
    return send({});
  });

  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForTimeout(900);
  check(page.url().includes("home.html"), "権限が無いと home.html へ送り返される");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
