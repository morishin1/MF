// 採用HR Stage 5・6：合格通知の作成・確認・確定 → 本人へ送る・URLを再発行
// （hr-applicants.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   Stage 5：合格通知作成待ち → 合格通知を作成（応募者の採用条件で事前入力される）
//     → 社内確認待ち → 内容を確認して確定 → 本人送付待ち
//   Stage 6：本人送付待ち → URLを発行（コピーできる） → 送付済みにする
//     → 本人送付済みへ → URLを再発行 → 再送待ちへ
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
        state.applicant.nextAction = "合格通知を本人へ送ってください"; state.applicant.nextActionCta = "本人へ送る";
        state.applicant.nextActionKey = "sendOffer";
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
  check((await page.locator(".hr-next").innerText()).includes("合格通知を本人へ送ってください"), "本人送付待ちへ進む");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 本人送付待ち → URLを発行 → 送付済みにする → 再発行 ===");
{
  const state = {
    applicant: {
      id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "offer", stageLabel: "内定", status: "offer_send_pending", statusLabel: "本人送付待ち",
      nextAction: "合格通知を本人へ送ってください", nextActionCta: "本人へ送る", nextActionKey: "sendOffer",
      rank: "A", decision: "hired", decisionDueOn: null,
    },
    offers: [{
      id: "of1", version: 1, status: "draft", respondBy: "2026-10-15",
      messageToCandidate: "ご一緒できることを楽しみにしています。", sentAt: null, viewedAt: null,
    }],
  };
  const posted = [];
  let issuedCount = 0;

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async (v) => { window.__copied.push(v); } },
    });
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
      if (b.action === "issueLink") {
        issuedCount++;
        const o = state.offers[0];
        if (o.sentAt) {
          const made = { id: `of${issuedCount}`, version: o.version + 1, status: "draft",
            respondBy: o.respondBy, messageToCandidate: o.messageToCandidate, sentAt: null, viewedAt: null };
          state.offers.unshift(made);
          state.applicant.status = "offer_resend_pending"; state.applicant.statusLabel = "URL再送待ち";
          state.applicant.nextAction = "URLを再発行しました。本人へ再送してください";
          state.applicant.nextActionCta = "本人へ再送"; state.applicant.nextActionKey = "sendOffer";
          return send({ offer: made, token: `tok-${issuedCount}` });
        }
        return send({ offer: o, token: `tok-${issuedCount}` });
      }
      if (b.action === "markSent") {
        const o = state.offers.find((x) => x.id === b.id) || state.offers[0];
        o.sentAt = "2026-09-26T06:00:00Z";
        state.applicant.status = "offer_sent"; state.applicant.statusLabel = "本人送付済み";
        state.applicant.nextAction = "本人の確認を待っています　送付：9/26 15:00　閲覧：未確認";
        state.applicant.nextActionCta = "URLを再発行"; state.applicant.nextActionKey = "reissueOffer";
        return send({ offer: o, status: "offer_sent" });
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

  console.log("\n— NEXT ACTIONに「本人へ送る」が出る —");
  check((await page.locator(".hr-next").innerText()).includes("合格通知を本人へ送ってください"), "ラベルが出る");
  check(await page.locator(".hr-next button", { hasText: "本人へ送る" }).count() === 1, "ボタンが出る");

  console.log("\n— URLを発行する（メール送信の仕組みは無いので、コピーして手動で送る） —");
  await page.locator(".hr-next button", { hasText: "本人へ送る" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "ドロワーが開く");
  await page.locator(".hr-drawer button", { hasText: "URLを発行する" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "issueLink"), "URL発行がサーバへ送られる");
  const urlVal = await page.locator("#so-url").inputValue();
  check(urlVal.includes("hr-offer.html?token=tok-1"), "候補者専用URLが表示される");
  check((await page.locator("#so-mail").inputValue()).includes(urlVal), "メール文面にもURLが入っている");

  console.log("\n— URLをコピーできる —");
  await page.locator("button", { hasText: "URLをコピー" }).click();
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => window.__copied);
  check(copied.includes(urlVal), "クリップボードにURLがコピーされる");

  console.log("\n— 送付済みにする（本人送付済みへ） —");
  await page.locator(".hr-drawer button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "markSent"), "送付済みがサーバへ送られる");
  check((await page.locator(".hr-next").innerText()).includes("本人の確認を待っています"), "NEXT ACTIONが進む");
  check((await page.locator(".hr-detail").innerText()).includes("第1版"), "合格通知の版が概要に出る");

  console.log("\n— URLを再発行する（版が増え、旧URLは失効する想定） —");
  check(await page.locator(".hr-next button", { hasText: "URLを再発行" }).count() === 1, "再発行ボタンが出る");
  await page.locator(".hr-next button", { hasText: "URLを再発行" }).click();
  await page.waitForTimeout(400);
  check((await page.locator(".hr-drawer").innerText()).includes("現在のURLは使えなくなります"), "再発行の確認文が出る");
  await page.locator(".hr-drawer button", { hasText: "再発行する" }).click();
  await page.waitForTimeout(500);
  const urlVal2 = await page.locator("#so-url").inputValue();
  check(urlVal2.includes("tok-2") && urlVal2 !== urlVal, "新しいURLが発行される（前とは別のtoken）");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
