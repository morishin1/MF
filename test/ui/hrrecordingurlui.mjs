// 採用HR：面談録画URLの手動登録・変更を、実際のブラウザで通す。
//
// ■ 何を守るテストか（採用HR録画URL手動登録UI 追加指示）
//
//   1. 実施済み面談にrecordingUrlが無ければ「録画：未登録」＋「録画URLを登録」
//   2. 登録はモーダルで行う。応募者詳細ドロワーは閉じない（二重ドロワーにしない）
//   3. 保存に成功すると「録画を見る」「録画URLを変更」に切り替わる
//   4. CEO REVIEWにも「面談録画を見る」が出る（録画が無ければ何も出ない）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

console.log("\n=== 応募者詳細：録画URLの登録・変更 ===");
{
  const state = {
    applicant: {
      id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "casual_interview", status: "eval_pending", statusLabel: "評価入力待ち",
      nextAction: "面談結果を入力してください", nextActionCta: "評価を入力", nextActionKey: "evaluate",
      rank: null, decision: null, decisionDueOn: null,
    },
    interview: {
      id: "iv1", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談",
      scheduledAt: "2026-09-30T05:00:00Z", conductedAt: "2026-09-30T05:30:00Z",
      canceled: false, canceledAt: null, done: true, interviewerId: null,
      meetingUrl: "https://meet.example.com/x", recordingUrl: null,
      scores: {}, rank: "A", recommendReason: null, notes: null,
    },
  };
  const patched = [];

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

    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/interviews\b/.test(url) && req.method() === "PATCH") {
      const b = JSON.parse(req.postData() || "{}");
      patched.push(b);
      if (b.action === "update" && b.recordingUrl !== undefined) {
        state.interview.recordingUrl = b.recordingUrl || null;
      }
      return send({ interview: state.interview });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({
        applicant: state.applicant, interviews: [state.interview], interviewers: [],
        timeline: [], offers: [], evalItems: [], evalScale: [], ranks: [], rankLabel: {}, interviewKinds: [],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [state.applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  await page.locator(".hr-tabs button", { hasText: "面談" }).click();
  await page.waitForTimeout(300);

  console.log("\n— 録画が無い実施済み面談は「未登録」＋登録ボタン —");
  const card = page.locator(".hr-detail-body .card").first();
  check((await card.innerText()).includes("録画：未登録"), "未登録の表示が出る");
  check(await card.locator("button", { hasText: "録画URLを登録" }).count() === 1, "登録ボタンが出る");
  check(await card.locator("a", { hasText: "録画を見る" }).count() === 0, "見るボタンはまだ出ない");

  console.log("\n— 登録はモーダル。ドロワーは閉じない —");
  await card.locator("button", { hasText: "録画URLを登録" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "モーダルが開く");
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細ドロワーは開いたまま");

  console.log("\n— http(s)以外は保存させない —");
  await page.fill("#rec-url", "javascript:alert(1)");
  await page.locator(".hr-modal button", { hasText: "保存" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "保存できず、モーダルは開いたまま");
  check((await page.locator("#rec-msg").innerText()).length > 0, "エラーメッセージが出る");
  check(!patched.some((p) => p.recordingUrl === "javascript:alert(1)"), "サーバへは送られていない");

  console.log("\n— 正しいURLで保存すると、「録画を見る」に切り替わる —");
  await page.fill("#rec-url", "https://drive.google.com/file/d/abc123/view");
  await page.locator(".hr-modal button", { hasText: "保存" }).click();
  await page.waitForTimeout(700);
  check(patched.some((p) => p.recordingUrl === "https://drive.google.com/file/d/abc123/view"), "録画URLが送られる");
  check(await page.locator(".hr-modal").count() === 0, "モーダルが閉じる");
  const card2 = page.locator(".hr-detail-body .card").first();
  check(await card2.locator("a", { hasText: "録画を見る" }).count() === 1, "「録画を見る」ボタンが出る");
  check(await card2.locator("button", { hasText: "録画URLを変更" }).count() === 1, "「録画URLを変更」ボタンが出る");
  check(await card2.locator("a", { hasText: "録画を見る" }).getAttribute("href")
    === "https://drive.google.com/file/d/abc123/view", "保存したURLへリンクする");

  console.log("\n— 変更モーダルには、現在のURLが入っている —");
  await card2.locator("button", { hasText: "録画URLを変更" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("#rec-url").inputValue() === "https://drive.google.com/file/d/abc123/view",
    "現在のURLが初期値になっている");
  check(await page.locator(".hr-modal button", { hasText: "録画URLを削除" }).count() === 1,
    "削除ボタンも出る");

  console.log("\n— 削除は確認モーダル —");
  await page.locator(".hr-modal button", { hasText: "録画URLを削除" }).click();
  await page.waitForTimeout(300);
  check((await page.locator(".hr-modal").innerText()).includes("削除しますか"), "削除確認モーダルが開く");
  await page.locator(".hr-modal button", { hasText: "削除する" }).click();
  await page.waitForTimeout(700);
  check(patched.some((p) => p.recordingUrl === ""), "空文字で削除が送られる");
  const card3 = page.locator(".hr-detail-body .card").first();
  check((await card3.innerText()).includes("録画：未登録"), "削除後は「未登録」に戻る");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

console.log("\n=== CEO REVIEW：録画リンク ===");
{
  const withRecording = {
    id: "a1", name: "山田 太郎", jobTitle: "エンジニア", stage: "ceo_recommend", status: "ceo_interview_pending",
    statusLabel: "社長面談設定待ち", nextAction: "社長面談を設定してください", nextActionCta: "社長面談を設定",
    nextActionKey: "schedule", rank: "A", recommendNote: "行動力が高い", goodPoints: null, concerns: null,
    recordingUrl: "https://drive.google.com/file/d/abc123/view", ceoInterview: null, decisionDueOn: null,
  };
  const withoutRecording = { ...withRecording, id: "a2", name: "佐藤 花子", recordingUrl: null };

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@8grp.co.jp" }));
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "owner@8grp.co.jp", appRole: "owner", isAdmin: false, shows: {},
        gw: { employee: { id: "emp-o1", display_name: "社長" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/ceo-review/.test(url)) {
      return send({ todayMeetings: [], recommended: [withRecording, withoutRecording], decisionPending: [] });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(1000);

  const cards = page.locator(".hr-cv-card");
  check(await cards.locator("a", { hasText: "面談録画を見る" }).count() === 1,
    "録画があるカードにだけ「面談録画を見る」が出る");
  const withCard = cards.filter({ hasText: "山田 太郎" });
  check(await withCard.locator("a", { hasText: "面談録画を見る" }).getAttribute("href")
    === "https://drive.google.com/file/d/abc123/view", "保存したURLへリンクする");
  const withoutCard = cards.filter({ hasText: "佐藤 花子" });
  check(await withoutCard.locator("a", { hasText: "面談録画を見る" }).count() === 0,
    "録画が無ければ何も出ない");

  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
