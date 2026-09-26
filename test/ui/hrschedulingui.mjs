// 採用HR × TimeRex：日程調整URLの送付フローを、実際のブラウザで通す。
//
// ■ 何を守るテストか（README「TimeRex連携」指示書）
//
//   新規応募者のNEXT ACTIONは「日程調整を送る」（TimeRexへ日程調整を任せる）。
//   独自の日程調整UIは作らないので、ここではTimeRexのURL表示・コピー・
//   「送付済みにする」（status=scheduling）だけを見る。
//   Webhookでの自動反映（予約確定→scheduled_at/meeting_url自動反映）は
//   実TimeRex payload確認後の別実装なので、このテストの対象外。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

console.log("\n=== TimeRex設定あり：日程調整URLを送る → 送付済みにする ===");
{
  const state = {
    applicant: {
      id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "applied", stageLabel: "新規応募", status: "todo", statusLabel: "未対応",
      nextAction: "カジュアル面談の日程を調整してください", nextActionCta: "日程調整を送る",
      nextActionKey: "sendSchedulingLink", rank: null, decision: null, decisionDueOn: null,
    },
  };
  const patched = [];

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

    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = JSON.parse(req.postData() || "{}");
        patched.push(b);
        if (b.status === "scheduling") {
          state.applicant.status = "scheduling"; state.applicant.statusLabel = "日程調整中";
          state.applicant.nextAction = "候補者の日程調整を待っています";
          state.applicant.nextActionCta = "手動で面談を設定"; state.applicant.nextActionKey = "schedule";
        }
        return send({ applicant: state.applicant });
      }
      // applicant_idをクエリパラメータで付与したTimeRex URL（README §11）
      return send({
        applicant: state.applicant, interviews: [], interviewers: [],
        timeline: [{ id: "t1", eventKey: "applied", label: "応募", occurredAt: "2026-09-20T00:00:00Z" }],
        offers: [], evalItems: [], evalScale: [], ranks: [], rankLabel: {}, interviewKinds: [],
        schedulingUrl: "https://timerex.net/s/example/casual?applicant_id=a1",
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [state.applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);

  console.log("\n— 新規応募のNEXT ACTIONは「日程調整を送る」 —");
  check((await page.locator(".hr-next").innerText()).includes("カジュアル面談の日程を調整してください"), "ラベルが出る");
  check(await page.locator(".hr-next button", { hasText: "日程調整を送る" }).count() === 1, "ボタンが出る");

  console.log("\n— 日程調整URLが表示される（applicant_idつき） —");
  await page.locator(".hr-next button", { hasText: "日程調整を送る" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "ドロワーが開く");
  const urlVal = await page.locator("#sc-url").inputValue();
  check(urlVal === "https://timerex.net/s/example/casual?applicant_id=a1", `URLにapplicant_idが付く（${urlVal}）`);
  check((await page.locator("#sc-mail").inputValue()).includes(urlVal), "メール文面にもURLが入っている");
  check(await page.locator(".hr-drawer button", { hasText: "TimeRexを使わず、手動で面談を設定する" }).count() === 1,
    "手動設定への例外導線が残っている（README §21）");

  console.log("\n— URLをコピーできる —");
  await page.locator("button", { hasText: "URLをコピー" }).click();
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__copied)).includes(urlVal), "クリップボードにURLがコピーされる");

  console.log("\n— 送付済みにする（status=scheduling） —");
  await page.locator(".hr-drawer button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(700);
  check(patched.some((p) => p.status === "scheduling"), "status=schedulingがサーバへ送られる");
  check((await page.locator(".hr-next").innerText()).includes("候補者の日程調整を待っています"), "NEXT ACTIONが進む");
  check(await page.locator(".hr-next button", { hasText: "手動で面談を設定" }).count() === 1,
    "候補者の予約待ちの間も、手動設定は例外導線として残る");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

console.log("\n=== ダッシュボード「今日の面談」：Google Meet URLがあれば[面談に参加]を出す ===");
{
  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/interviews\/today/.test(url)) {
      return send({
        interviews: [{
          id: "iv1", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談",
          scheduledAt: new Date().toISOString(), done: false,
          interviewerId: "e2", interviewerName: "面接 一郎",
          name: "山田 太郎", jobTitle: "エンジニア", status: "interview_scheduled", statusLabel: "面談予定",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
        }],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/`);
  await page.waitForTimeout(1000);

  const row = page.locator("#todayiv .hr-iv-row");
  check((await row.innerText()).includes("山田 太郎"), "今日の面談に出る");
  check((await row.innerText()).includes("カジュアル面談"), "面談種別が出る（職種ではない）");
  const join = row.locator("a", { hasText: "面談に参加" });
  check(await join.count() === 1, "[面談に参加]ボタンが出る");
  check(await join.getAttribute("href") === "https://meet.google.com/abc-defg-hij", "TimeRexが発行したMeet URLへ飛ぶ");

  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
