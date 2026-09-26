// 採用HR：面談の「日時を変更」「面談をキャンセル」を、実際のブラウザで通す。
//
// ■ 何を守るテストか（採用HR応募者一覧・ドロワーUI改善指示書 §3・§4・§5）
//
//   1. 予定中の面談カードに「日時を変更」「面談をキャンセル」が出る
//   2. どちらもモーダルで実行する。応募者詳細ドロワーは閉じない（二重ドロワーにしない）
//   3. キャンセルすると、応募者はNEXT ACTION「カジュアル面談の日程を再調整してください」へ戻る
//   4. キャンセル済みの面談はそう分かる表示になり、参加・実施・変更・再キャンセルはできない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

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
  await page.locator(".hr-tabs button", { hasText: "面談" }).click();
  await page.waitForTimeout(300);

  console.log("\n— 予定中の面談には、日時変更・キャンセルのボタンが出る —");
  check(await page.locator("button", { hasText: "日時を変更" }).count() === 1, "日時を変更ボタン");
  check(await page.locator("button", { hasText: "面談をキャンセル" }).count() === 1, "面談をキャンセルボタン");

  console.log("\n— 日時を変更（モーダル。ドロワーは閉じない） —");
  await page.locator("button", { hasText: "日時を変更" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "モーダルで開く");
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細ドロワーは開いたまま（README §4）");
  const whenVal = await page.locator("#rs-when").inputValue();
  check(whenVal.startsWith("2026-10-01"), `現在の日時が入っている（${whenVal}）`);
  await page.fill("#rs-when", "2026-10-02T09:00");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(700);
  const upd = patched.find((p) => p.action === "update");
  check(Boolean(upd) && upd.id === "iv1", "updateアクションが送られる");
  check(upd && upd.scheduledAt?.startsWith("2026-10-02"), `新しい日時が送られる（${upd?.scheduledAt}）`);
  check(await page.locator(".hr-modal").count() === 0, "モーダルが閉じる");

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
  await page.locator(".hr-tabs button", { hasText: "面談" }).click();
  await page.waitForTimeout(300);

  console.log("\n— キャンセル確認モーダルが開く（ドロワーは閉じない） —");
  await page.locator("button", { hasText: "面談をキャンセル" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "確認モーダルが開く");
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細ドロワーは開いたまま");

  console.log("\n— 「閉じる（キャンセルしない）」では何も起きない —");
  await page.locator(".hr-modal button", { hasText: "閉じる（キャンセルしない）" }).click();
  await page.waitForTimeout(200);
  check(await page.locator(".hr-modal").count() === 0, "モーダルが閉じる");
  check(patched.length === 0, "APIは呼ばれていない");

  console.log("\n— キャンセルを確定する —");
  await page.locator("button", { hasText: "面談をキャンセル" }).click();
  await page.waitForTimeout(300);
  await page.locator(".hr-modal button", { hasText: "面談をキャンセルする" }).click();
  await page.waitForTimeout(700);
  check(patched.some((p) => p.action === "cancel" && p.id === "iv1"), "cancelアクションが送られる");
  check((await page.locator(".hr-next").innerText()).includes("カジュアル面談の日程を再調整してください"),
    "NEXT ACTIONが「再調整してください」へ戻る");

  console.log("\n— キャンセル済みの面談は、そう分かる表示になる —");
  const card = await page.locator(".hr-detail-body .card").first();
  check((await card.innerText()).includes("キャンセル済み"), "キャンセル済みの印が出る");
  check(await card.locator("button", { hasText: "面談に参加" }).count()
    + await card.locator("a", { hasText: "面談に参加" }).count() === 0, "参加ボタンは出ない");
  check(await card.locator("button", { hasText: "実施済みにする" }).count() === 0, "実施済みにするボタンは出ない");
  check(await card.locator("button", { hasText: "日時を変更" }).count() === 0, "日時変更ボタンは出ない");
  check(await card.locator("button", { hasText: "面談をキャンセル" }).count() === 0, "再キャンセルはできない");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
