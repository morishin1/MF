// 採用HR：応募者管理（hr-applicants.html）を、実際のブラウザで通す。
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
      return send({
        applicant: { ...a, recruiterName: null },
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
          rank: null, decisionDueOn: null, overdue: false, recruiterName: null, interviewCount: 0,
          createdAt: new Date().toISOString(),
        };
        applicants = [...applicants, made];
        return send({ applicant: made });
      }
      return send({ applicants });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr-applicants.html`);
  await page.waitForTimeout(1000);

  console.log("— 専用ヘッダーが出る —");
  check((await page.locator(".hr-logo").innerText()).includes("HR"), "EIGHT/HR のロゴが出る");
  const navCount = await page.locator(".hr-nav a").count();
  check(navCount === 3, `ナビは3つだけ（いま ${navCount}）`);
  const navTexts = await page.locator(".hr-nav a").allInnerTexts();
  check(navTexts.some((t) => t.includes("ダッシュボード")) && navTexts.some((t) => t.includes("応募者"))
    && navTexts.some((t) => t.includes("CEO REVIEW")), `ダッシュボード／応募者／CEO REVIEW の3つ（いま ${navTexts.join(" / ")}）`);
  check((await page.locator(".hr-nav a.on").innerText()).includes("応募者"), "いま見ているタブが選ばれている");
  check(!(await page.locator(".kp-sidebar").count()), "通常のサイドメニューは出さない");

  console.log("— 応募者が0件のときの表示 —");
  check((await page.locator("#rows").innerText()).includes("対象がありません"), "空の一覧");

  console.log("— 応募者を追加する —");
  await page.locator("button", { hasText: "応募者追加" }).click();
  await page.waitForTimeout(400);
  await page.fill("#a-name", "田中 一郎");
  await page.fill("#a-job", "セールス");
  await page.locator('input[name="a-source"]').first().check();
  await page.locator("button", { hasText: "追加する" }).click();
  await page.waitForTimeout(700);

  check(posted.length === 1 && posted[0].name === "田中 一郎", "追加が送られる");
  check((await page.locator("#rows").innerText()).includes("田中 一郎"), "一覧に出る");
  check((await page.locator("#rows").innerText()).includes("セールス"), "職種も出る");

  console.log("— 詳細を右ドロワーで開く —");
  await page.locator(".hr-table tr.click").first().click();
  await page.waitForTimeout(500);
  check(await page.locator(".hr-detail").isVisible(), "右ドロワーが開く");
  check((await page.locator(".hr-detail").innerText()).includes("NEXT ACTION"), "NEXT ACTIONが最優先表示される");
  check((await page.locator(".hr-detail").innerText()).includes("田中 一郎"), "本人の名前が出る");
  check((await page.locator(".hr-detail").innerText()).includes("応募"), "選考タイムラインが出る");

  await page.locator(".hr-detail button", { hasText: "閉じる" }).click();
  await page.waitForTimeout(300);
  check(!(await page.locator(".hr-detail").count()), "閉じると消える");

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

  await page.goto(`${BASE}/hr-applicants.html`);
  await page.waitForTimeout(900);
  check(page.url().includes("home.html"), "権限が無いと home.html へ送り返される");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
