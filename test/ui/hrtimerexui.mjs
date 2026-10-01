// 採用HR：TimeRex 連携済みの面談の表示とボタンを、実際のブラウザで通す。
//
// ■ 何を守るテストか
//   1. TimeRex 連携済みの面談には「TimeRex連携済み」「Google Meet」「面談に参加」「日程変更」「取消」が出る
//   2. 手動の「面談をキャンセル」は出ない。「面談情報を編集」は出るが、日時・面談URLは読み取り専用
//      （日時は TimeRex が正。HR から直接書き換えない。面談担当・面談方法・メモは HR で直せる）
//   3. 「日程変更」「取消」は TimeRex のリンクを新しいタブで開くだけ。HR の API は呼ばない
//   4. 手動で登録した面談は、これまでどおり「面談情報を編集」（旧「日時を変更」）「面談をキャンセル」が出る
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

async function openWith(interview) {
  const applicant = {
    id: "a1", name: "テスト 応募者", jobTitle: "エンジニア", source: "リファラル",
    stage: "ceo_interview", status: "interview_scheduled", statusLabel: "面談予定",
    nextAction: "面談を実施してください", nextActionCta: "面談を実施済みにする", nextActionKey: "conduct",
    rank: null, decision: null, decisionDueOn: null,
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
      patched.push(JSON.parse(req.postData() || "{}"));
      return send({ interview });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({ applicant, interviews: [interview], interviewers: [], timeline: [], offers: [],
        evalItems: [], evalScale: [], ranks: [], rankLabel: {}, interviewKinds: [] });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  await page.locator(".hr-tabs button", { hasText: "面談" }).click();
  await page.waitForTimeout(300);
  return { page, patched, errs };
}

const base = {
  id: "iv1", applicantId: "a1", kind: "ceo", kindLabel: "社長面談",
  scheduledAt: "2026-10-01T07:15:00Z", conductedAt: null, canceled: false, canceledAt: null,
  done: false, interviewerId: null, meetingUrl: "https://meet.google.com/abc-defg-hij", recordingUrl: null,
  scores: {}, rank: null, recommendReason: null, notes: null,
};

console.log("\n=== TimeRex 連携済みの社長面談 ===");
{
  const { page, patched, errs } = await openWith({ ...base, timerex: {
    linked: true, syncedAt: "2026-09-30T01:00:00Z",
    rescheduleUrl: "https://timerex.example.test/reschedule/ANON", cancelUrl: "https://timerex.example.test/cancel/ANON",
  } });
  const card = page.locator(".hr-detail-body .card").first();
  const text = await card.innerText();
  check(text.includes("社長面談"), "面談の種類（社長面談）");
  check(text.includes("TimeRex連携済み"), "「TimeRex連携済み」が出る");
  check(text.includes("Google Meet"), "Google Meet の表示");
  check(await card.locator("a, button", { hasText: "面談に参加" }).count() >= 1, "面談に参加");
  check(await card.locator('button[data-timerex="reschedule"]', { hasText: "日程変更" }).count() === 1, "日程変更ボタン");
  check(await card.locator('button[data-timerex="cancel"]', { hasText: "取消" }).count() === 1, "取消ボタン");
  check(await card.locator("button", { hasText: "日時を変更" }).count() === 0, "手動の「日時を変更」は出ない");
  check(await card.locator("button", { hasText: "面談情報を編集" }).count() === 1, "「面談情報を編集」は出る（日時・URLは読み取り専用）");
  check(await card.locator("button", { hasText: "面談をキャンセル" }).count() === 0, "手動の「面談をキャンセル」は出ない");

  await card.locator('button[data-timerex="reschedule"]').click();
  await page.waitForTimeout(300);
  const a = page.locator(".hr-modal #tr-open");
  check(await a.count() === 1, "日程変更モーダルに TimeRex のリンク");
  check(await a.getAttribute("target") === "_blank" && /noopener/.test(await a.getAttribute("rel") || ""), "新しいタブで開く（noopener）");
  check(await a.getAttribute("href") === "https://timerex.example.test/reschedule/ANON", "日程変更のリンク先");
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細ドロワーは開いたまま");
  await page.keyboard.press("Escape");
  await page.evaluate(() => typeof closeAction === "function" && closeAction());
  await page.waitForTimeout(200);

  await card.locator('button[data-timerex="cancel"]').click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal #tr-open").getAttribute("href") === "https://timerex.example.test/cancel/ANON", "取消のリンク先");
  check(patched.length === 0, "HR の API（日時変更・キャンセル）は呼ばれない");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

console.log("\n=== TimeRex 連携済み・リンク未受信 ===");
{
  const { page, errs } = await openWith({ ...base, timerex: { linked: true, syncedAt: null, rescheduleUrl: null, cancelUrl: null } });
  await page.locator('button[data-timerex="cancel"]').click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "モーダルは開く");
  check(await page.locator(".hr-modal #tr-open").count() === 0, "リンクが無ければリンクボタンは出さない");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

console.log("\n=== 手動で登録した面談 ===");
{
  const { page, errs } = await openWith({ ...base, kind: "casual", kindLabel: "カジュアル面談", timerex: null });
  const card = page.locator(".hr-detail-body .card").first();
  check(!(await card.innerText()).includes("TimeRex連携済み"), "「TimeRex連携済み」は出ない");
  check(await card.locator("button", { hasText: "面談情報を編集" }).count() === 1, "面談情報を編集ボタン（旧「日時を変更」）");
  check(await card.locator("button", { hasText: "面談をキャンセル" }).count() === 1, "面談をキャンセルボタン（従来どおり）");
  check(await card.locator("button[data-timerex]").count() === 0, "TimeRex 用のボタンは出ない");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
