// 採用HR Stage 5：合格通知作成（hr-applicants.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   内定（offer_draft_pending）→ 合格通知を作成 → 社内確認待ち →
//   内容を確認・確定 → 本人送付待ち、まで一続きで通す。
//   あわせて、作成フォームが応募者の現在の採用条件で事前入力されることも見る。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };

console.log("\n=== 合格通知を作成する → 社内確認待ち → 確定する → 本人送付待ち ===");
{
  const state = {
    applicant: {
      id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "offer", stageLabel: "内定", status: "offer_draft_pending", statusLabel: "合格通知作成待ち",
      nextAction: "合格通知を作成してください", nextActionCta: "合格通知を作成", nextActionKey: "createOffer",
      rank: "A", decision: "hired", decisionDueOn: null,
      employmentType: "正社員", joinDate: "2026-11-01", contractType: "無期", contractEndDate: null,
      probationMonths: 3, wageType: "月給", wageAmount: 400000, weeklyHours: 40, workLocation: "東京",
    },
    offers: [],
  };
  let nextOfferId = 1;
  const posted = [];

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
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
    if (/\/api\/hr\/offers/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      if (req.method() === "POST") {
        const o = {
          id: `of${nextOfferId++}`, version: state.offers.length + 1, status: "draft",
          employmentType: b.employmentType, joinDate: b.joinDate, contractType: b.contractType,
          contractEndDate: b.contractEndDate, probationMonths: b.probationMonths, wageType: b.wageType,
          wageAmount: b.wageAmount, weeklyHours: b.weeklyHours, workLocation: b.workLocation,
          messageToCandidate: b.messageToCandidate, respondBy: b.respondBy,
          sentAt: null, viewedAt: null,
        };
        state.offers = [o];
        state.applicant.status = "offer_review_pending"; state.applicant.statusLabel = "社内確認待ち";
        state.applicant.nextAction = "内容を確認してください"; state.applicant.nextActionCta = "内容を確認する";
        state.applicant.nextActionKey = "reviewOffer";
        return send({ offer: o, status: "offer_review_pending" });
      }
      if (b.action === "update") {
        Object.assign(state.offers[0], b);
        return send({ offer: state.offers[0] });
      }
      if (b.action === "confirm") {
        state.applicant.status = "offer_send_pending"; state.applicant.statusLabel = "本人送付待ち";
        state.applicant.nextAction = "本人へ送付してください"; state.applicant.nextActionCta = null;
        state.applicant.nextActionKey = null;
        return send({ offer: state.offers[0], status: "offer_send_pending" });
      }
      return send({ offer: {} });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({ applicant: state.applicant, timeline: [{ id: "t1", eventKey: "decision_hired", label: "内定", occurredAt: "2026-09-24T00:00:00Z" }], offers: state.offers });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [state.applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr-applicants.html?id=a1`);
  await page.waitForTimeout(1000);

  console.log("\n— NEXT ACTIONに「合格通知を作成」が出る —");
  check((await page.locator(".hr-next").innerText()).includes("合格通知を作成してください"), "ラベルが出る");
  check(await page.locator(".hr-next button", { hasText: "合格通知を作成" }).count() === 1, "ボタンが出る");

  console.log("\n— 合格通知を作成する（応募者の採用条件で事前入力される） —");
  await page.locator(".hr-next button", { hasText: "合格通知を作成" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "作成フォームが開く");
  check(await page.locator("#of-employment").inputValue() === "正社員", "雇用形態が事前入力される");
  check(await page.locator("#of-join").inputValue() === "2026-11-01", "入社予定日が事前入力される");
  check(await page.locator("#of-wage").inputValue() === "400000", "給与が事前入力される");

  console.log("\n— 回答期限を入れずに作成しようとすると断る —");
  await page.locator(".hr-drawer button", { hasText: "作成する" }).click();
  await page.waitForTimeout(300);
  check((await page.locator("#of-msg").innerText()).includes("回答期限"), "回答期限必須のエラーが出る");

  await page.fill("#of-respondby", "2026-10-15");
  await page.fill("#of-message", "皆様とご一緒できることを楽しみにしています。");
  await page.locator(".hr-drawer button", { hasText: "作成する" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.respondBy === "2026-10-15"), "作成がサーバへ送られる");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);

  console.log("\n— 社内確認待ちへ。合格通知の版が概要タブに出る —");
  check((await page.locator(".hr-next").innerText()).includes("内容を確認してください"), "NEXT ACTIONが進む");
  check((await page.locator(".hr-detail").innerText()).includes("第1版"), "版番号が出る");
  check((await page.locator(".hr-detail").innerText()).includes("2026-10-15"), "回答期限が出る");

  console.log("\n— 内容を確認して確定する（本人送付待ちへ） —");
  await page.locator(".hr-next button", { hasText: "内容を確認する" }).click();
  await page.waitForTimeout(400);
  check(await page.locator("#of-respondby").inputValue() === "2026-10-15", "既存の内容が事前入力される（確認フォーム）");
  await page.locator(".hr-drawer button", { hasText: "確定して送付待ちにする" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "confirm"), "確定がサーバへ送られる");
  check((await page.locator(".hr-next").innerText()).includes("本人へ送付してください"), "本人送付待ちへ進む");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
