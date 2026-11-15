// 採用HR：面談の「面談情報を編集」「面談をキャンセル」を、実際のブラウザで通す。
//
// ■ 何を守るテストか（採用HR応募者一覧・ドロワーUI改善指示書 §3・§4・§5）
//
//   1. 予定中の面談カードに「面談情報を編集」「面談をキャンセル」が出る
//   2. どちらもモーダルで実行する。応募者詳細ドロワーは閉じない（二重ドロワーにしない）
//   3. キャンセルすると、応募者はNEXT ACTION「カジュアル面談の日程を再調整してください」へ戻る
//   4. キャンセル済みの面談はそう分かる表示になり、参加・実施・変更・再キャンセルはできない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// 現在のUI：?id= は対応モーダルを開く。面談カードは「応募者情報」→「面談・評価」タブにある
const openInterviewsTab = async (page) => {
  await page.locator("#hr-work-link-info").click();
  await page.locator("#hr-tab-interviews").click();
  await page.waitForTimeout(300);
};
// 現在のUI：モーダルは同時に1枚だけ見える（js/hr-modal-ui.js）。操作モーダルの間、応募者詳細は
// 閉じずに下で保たれる（DOMに残り、hidden）。「開いたまま」はこの形で確かめる
const detailKept = (page) => page.evaluate(() => {
  const d = document.querySelector("#modal-root .hr-detail");
  return Boolean(d) && document.getElementById("modal-root").hidden === true;
});

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

console.log("\n=== 面談日時の変更 ===");
{
  const state = {
    applicant: {
      id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "casual_interview", status: "interview_scheduled", statusLabel: "面談予定",
      nextAction: "面談を実施してください", nextActionCta: "面談を実施済みにする", nextActionKey: "conduct",
      rank: null, decision: null, decisionDueOn: null,
    },
    interview: {
      id: "iv1", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談",
      scheduledAt: "2026-10-01T05:00:00Z", conductedAt: null, canceled: false, canceledAt: null,
      done: false, interviewerId: "e2", meetingUrl: "https://meet.example.com/x", recordingUrl: null,
      scores: {}, rank: null, recommendReason: null, notes: null,
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
      if (b.action === "update") {
        Object.assign(state.interview, {
          scheduledAt: b.scheduledAt ?? state.interview.scheduledAt,
          interviewerId: b.interviewerId ?? state.interview.interviewerId,
          meetingUrl: b.meetingUrl ?? state.interview.meetingUrl,
        });
        return send({ interview: state.interview });
      }
      return send({ interview: state.interview });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({
        applicant: state.applicant, interviews: [state.interview],
        interviewers: [{ id: "e2", display_name: "面接 一郎" }],
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
  page.setDefaultTimeout(8000);
  await openInterviewsTab(page);

  console.log("\n— 予定中の面談には、日時変更・キャンセルのボタンが出る —");
  check(await page.locator("button", { hasText: "面談情報を編集" }).count() === 1, "面談情報を編集ボタン");
  check(await page.locator("button", { hasText: "面談をキャンセル" }).count() === 1, "面談をキャンセルボタン");

  console.log("\n— 面談情報を編集（モーダル。ドロワーは閉じない） —");
  await page.locator("button", { hasText: "面談情報を編集" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "モーダルで開く");
  check(await detailKept(page), "応募者詳細は閉じず、モーダルの下に保たれる（README §4）");
  const whenVal = await page.locator("#rs-when").inputValue();
  check(whenVal.startsWith("2026-10-01"), `現在の日時が入っている（${whenVal}）`);
  await page.fill("#rs-when", "2026-10-02T09:00");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(700);
  const upd = patched.find((p) => p.action === "update");
  check(Boolean(upd) && upd.id === "iv1", "updateアクションが送られる");
  check(upd && upd.scheduledAt?.startsWith("2026-10-02"), `新しい日時が送られる（${upd?.scheduledAt}）`);
  check(await page.locator(".hr-modal").count() === 0, "モーダルが閉じる");
  check(await page.locator(".hr-detail").isVisible() && await page.locator("#hr-tab-interviews.on").count() === 1,
    "保存後は応募者詳細（面談・評価タブ）へ戻る");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

console.log("\n=== 面談キャンセル ===");
{
  const state = {
    applicant: {
      id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "casual_interview", status: "interview_scheduled", statusLabel: "面談予定",
      nextAction: "面談を実施してください", nextActionCta: "面談を実施済みにする", nextActionKey: "conduct",
      rank: null, decision: null, decisionDueOn: null,
    },
    interview: {
      id: "iv1", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談",
      scheduledAt: "2026-10-01T05:00:00Z", conductedAt: null, canceled: false, canceledAt: null,
      done: false, interviewerId: null, meetingUrl: "https://meet.example.com/x", recordingUrl: null,
      scores: {}, rank: null, recommendReason: null, notes: null,
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
      if (b.action === "cancel") {
        state.interview.canceled = true;
        state.interview.canceledAt = "2026-09-26T10:00:00Z";
        state.applicant.status = "scheduling"; state.applicant.statusLabel = "日程調整中";
        state.applicant.nextAction = "カジュアル面談の日程を再調整してください";
        state.applicant.nextActionCta = "手動で面談を設定"; state.applicant.nextActionKey = "schedule";
        return send({ interview: state.interview, status: "scheduling" });
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
  page.setDefaultTimeout(8000);
  await openInterviewsTab(page);

  console.log("\n— キャンセル確認モーダルが開く（ドロワーは閉じない） —");
  await page.locator("button", { hasText: "面談をキャンセル" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "確認モーダルが開く");
  check(await detailKept(page), "応募者詳細は閉じず、モーダルの下に保たれる");

  console.log("\n— 「閉じる（キャンセルしない）」では何も起きない —");
  await page.locator(".hr-modal button", { hasText: "閉じる（キャンセルしない）" }).click();
  await page.waitForTimeout(200);
  check(await page.locator(".hr-modal").count() === 0, "モーダルが閉じる");
  check(await page.locator(".hr-detail").isVisible(), "閉じると応募者詳細へ戻る");
  check(patched.length === 0, "APIは呼ばれていない");

  console.log("\n— キャンセルを確定する —");
  await page.locator("button", { hasText: "面談をキャンセル" }).click();
  await page.waitForTimeout(300);
  await page.locator(".hr-modal button", { hasText: "面談をキャンセルする" }).click();
  await page.waitForTimeout(700);
  check(patched.some((p) => p.action === "cancel" && p.id === "iv1"), "cancelアクションが送られる");
  check(await page.locator(".hr-detail").isVisible(), "保存後も応募者詳細ドロワーは開いたまま");
  // NEXT ACTION は「応募者情報」タブの中（旧：タブの外）
  await page.locator("#hr-tab-overview").click();
  check((await page.locator(".hr-next").innerText()).includes("カジュアル面談の日程を再調整してください"),
    "NEXT ACTIONが「再調整してください」へ戻る");
  await page.locator("#hr-tab-interviews").click();

  console.log("\n— キャンセル済みの面談は、そう分かる表示になる —");
  const card = await page.locator(".hr-detail-body .card").first();
  check((await card.innerText()).includes("キャンセル済み"), "キャンセル済みの印が出る");
  check(await card.locator("button", { hasText: "面談に参加" }).count()
    + await card.locator("a", { hasText: "面談に参加" }).count() === 0, "参加ボタンは出ない");
  // 現在のUIでは参加・開始の導線は「Google Meetを開く」「面談を開始する」。キャンセル済みには出ない
  check(await card.locator("a", { hasText: "Google Meetを開く" }).count()
    + await card.locator("a", { hasText: "面談を開始する" }).count() === 0, "Google Meetを開く・面談を開始するも出ない");
  check(await card.locator("button", { hasText: "実施済みにする" }).count() === 0, "実施済みにするボタンは出ない");
  check(await card.locator("button", { hasText: "面談情報を編集" }).count() === 0, "面談情報の編集ボタンは出ない");
  check(await card.locator("button", { hasText: "面談をキャンセル" }).count() === 0, "再キャンセルはできない");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
