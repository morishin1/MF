// 採用HR：応募者管理（/hr/applicants.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 採用担当（recruiter）としてログインすると、専用ヘッダー
//      （EIGHT/HR・統一ナビ）が出て、一覧が見える
//   2. 「応募者追加」から追加すると、一覧に出る
//   3. 行をクリックすると対応モーダル（次にすること）が開き、「応募者情報」から詳細が開く（NEXT ACTIONが出る）
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
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" })); } catch { /* sandbox付きiframe */ }
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
  // 統一ナビ（js/hr-nav-v2.js）は7項目。「採用判断」は権限者（canDecide）だけなので、採用担当には6つ
  check(navCount === 6, `ナビは6つだけ（採用担当。いま ${navCount}）`);
  const navKeys = await page.locator(".hr-nav a").evaluateAll((xs) => xs.map((x) => x.dataset.nav));
  check(navKeys.join("|") === "home|applicants|analytics|materials|templates|manual", `ナビの並び（${navKeys.join("|")}）`);
  const navTexts = await page.locator(".hr-nav a").allInnerTexts();
  check(navTexts.some((t) => t.includes("ダッシュボード")) && navTexts.some((t) => t.includes("応募者管理"))
    && navTexts.some((t) => t.includes("応募分析")) && navTexts.some((t) => t.includes("採用資料"))
    && navTexts.some((t) => t.includes("メールひな型")) && navTexts.some((t) => t.includes("操作マニュアル")),
    `ダッシュボード／応募者管理／応募分析／採用資料／メールひな型／操作マニュアル（いま ${navTexts.join(" / ")}）`);
  // 旧ナビの「CEO REVIEW」は「採用判断」になり、権限の無い採用担当には出さない
  check(!navTexts.some((t) => t.includes("採用判断") || t.includes("CEO REVIEW")), "採用判断は権限者だけ（採用担当には出さない）");
  check((await page.locator(".hr-nav a.on").innerText()).includes("応募者管理"), "いま見ている応募者管理が選ばれている");
  check(!(await page.locator(".kp-sidebar").count()), "通常のサイドメニューは出さない");

  console.log("— 応募者が0件のときの表示 —");
  check((await page.locator("#rows").innerText()).includes("対象がありません"), "空の一覧");

  console.log("— 応募者を追加する —");
  await page.locator("button", { hasText: "応募者追加" }).click();
  await page.waitForTimeout(400);
  await page.fill("#a-name", "田中 一郎");
  // 応募職種は select（候補＋その他）。候補に無い職種は「その他」を選んで入力する
  check(await page.locator("#a-job-other").isHidden(), "職種名の入力欄は「その他」を選ぶまで出さない");
  await page.selectOption("#a-job", "__other");
  await page.fill("#a-job-other", "セールス");
  const sourceLabels = await page.locator('#a-sources input[name="a-source"]').evaluateAll((xs) => xs.map((x) => x.value));
  check(sourceLabels.join("|") === "Wantedly|Green|Indeed|求人ボックス|エージェント|リファラル|自社サイト|SNS|イベント・セミナー|その他", "応募媒体は固定候補");
  await page.locator('input[name="a-source"]').first().check();
  check((await page.locator("#a-recruiter").inputValue()) === RECRUITER.id, "担当の初期値は登録する本人");
  await page.locator("button", { hasText: "追加する" }).click();
  await page.waitForTimeout(700);

  check(posted.length === 1 && posted[0].name === "田中 一郎", "追加が送られる");
  check(posted[0].jobTitle === "セールス", "「その他」で入力した職種名が送られる");
  check(posted[0].recruiterId === RECRUITER.id, "担当も一緒に送られる");
  check((await page.locator("#rows").innerText()).includes("田中 一郎"), "一覧に出る");
  check((await page.locator("#rows").innerText()).includes("セールス"), "職種も出る");
  // 追加すると、その人の対応モーダル（次にすること）が開く（詳細ドロワーではない。#354/#357）。いったん閉じて、一覧から開き直す
  const work = page.locator("#hr-detail-box.hr-work-modal");
  check(await work.isVisible(), "追加すると、その人の対応モーダルが開く");
  check((await work.locator(".hr-work-heading h2").innerText()).includes("田中 一郎"), "対応モーダルに本人の名前が出る");
  await work.locator("button", { hasText: "閉じる" }).first().click();
  await page.waitForTimeout(300);
  check(!(await page.locator("#hr-detail-box").count()), "閉じると対応モーダルは消える");

  console.log("— 行クリックで対応モーダル → 「応募者情報」から詳細を開く —");
  await page.locator(".hr-table tr.click .hr-nm").first().click();
  await page.waitForTimeout(500);
  check(await work.isVisible(), "行を押すと対応モーダルが開く");
  check((await work.locator(".hr-work-state").innerText()).includes("現在の状態") && (await work.locator(".hr-work-task").innerText()).includes("次にすること"),
    "対応モーダルに「現在の状態」と「次にすること」が出る");
  check(await work.locator("#hr-work-primary").count() <= 1, "対応モーダルの主ボタンは1つだけ");
  await work.locator("#hr-work-link-info").click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-detail").isVisible(), "「応募者情報」から応募者詳細が開く");
  check(await page.locator(".hr-detail .hr-next").isVisible(), "NEXT ACTION（いまの状態と次の1つ）が概要の最初に出る");
  check((await page.locator(".hr-detail").innerText()).includes("田中 一郎"), "本人の名前が出る");
  // 詳細タブは4つ（メールと履歴は「連絡・履歴」に統合）
  const detailTabs = (await page.locator('.hr-detail .hr-detail-tabs [role="tab"]').evaluateAll((xs) => xs.map((x) => x.lastChild.textContent.trim())));
  check(detailTabs.join("|") === "応募者情報|面談・評価|書類・契約|連絡・履歴", `詳細タブを4つに整理（${detailTabs.join("|")}）`);
  // 選考タイムラインは「連絡・履歴」タブの中（選考・操作の履歴）
  await page.locator("#hr-tab-activity").click();
  await page.waitForTimeout(300);
  const tl = page.locator(".hr-detail details.hr-doc-fold");
  check((await tl.locator("summary").innerText()).includes("選考・操作の履歴（1件）"), "選考・操作の履歴が「連絡・履歴」に出る");
  await tl.locator("summary").click();
  check((await tl.locator(".hr-tl").innerText()).includes("応募"), "選考タイムラインが出る");
  await page.locator("#hr-tab-overview").click();
  await page.waitForTimeout(300);
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
  // 右側の .hr-manual ボタンは無くなり、ナビの「操作マニュアル」1つだけ（js/hr-nav-v2.js）
  check(!(await page.locator(".hr-actions .hr-manual").count()), "右側の重複したマニュアルボタンは出さない");
  const manual = page.locator('.hr-nav a[data-nav="manual"]');
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
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "member@8grp.co.jp" })); } catch { /* sandbox付きiframe */ }
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
