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
  page.setDefaultTimeout(8000);

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
          state.applicant.nextAction = "カジュアル面談の日程を再調整してください";
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
  // 現在のUI：?id= は対応モーダル（#hr-detail-box.hr-work-modal）を開く。「次にすること」と主ボタン1つ
  // （旧：詳細ドロワーの NEXT ACTION 欄。文言は「面談日程の案内を作成し…」に変わった）
  check((await page.locator(".hr-work-task").innerText()).includes("面談日程の案内を作成"), "次にすることが出る");
  check(await page.locator("#hr-work-primary").count() === 1
    && (await page.locator("#hr-work-primary").innerText()).includes("日程調整を送る"), "主ボタンが出る（1つだけ）");

  console.log("\n— 日程調整URLがモーダルで表示される（applicant_idつき、二重に重ならない） —");
  check(await page.locator("#hr-detail-box.hr-work-modal").isVisible(), "対応モーダルが開いている");
  await page.locator("#hr-work-primary").click();
  await page.waitForTimeout(400);
  check(await page.locator("#hr-modal-root .hr-modal").isVisible(), "日程調整のモーダルが開く");
  // 現在のUI：モーダルは同時に1枚だけ見える（js/hr-modal-ui.js）。対応モーダルは閉じずに下で保たれる
  check(await page.evaluate(() => Boolean(document.querySelector("#modal-root #hr-detail-box"))
    && document.getElementById("modal-root").hidden === true),
    "対応モーダルは閉じず、モーダルの下に保たれる（README §4）");
  const urlVal = await page.locator("#sc-url").inputValue();
  check(urlVal === "https://timerex.net/s/example/casual?applicant_id=a1", `URLにapplicant_idが付く（${urlVal}）`);
  check((await page.locator("#sc-mail").inputValue()).includes(urlVal), "メール文面にもURLが入っている");
  check(await page.locator(".hr-modal button", { hasText: "TimeRexを使わず、手動で面談を設定する" }).count() === 1,
    "手動設定への例外導線が残っている（README §21）");

  console.log("\n— URLをコピーできる —");
  await page.locator("button", { hasText: "URLをコピー" }).click();
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__copied)).includes(urlVal), "クリップボードにURLがコピーされる");

  console.log("\n— 送付済みにする（status=scheduling） —");
  await page.locator(".hr-modal button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(700);
  check(patched.some((p) => p.status === "scheduling"), "status=schedulingがサーバへ送られる");
  check(await page.locator("#hr-detail-box.hr-work-modal").isVisible(), "送付済みにすると対応モーダルへ戻る");
  check((await page.locator(".hr-work-task").innerText()).includes("カジュアル面談の日程を再調整してください"), "次にすることが進む");
  check(await page.locator("#hr-work-primary").count() === 1
    && (await page.locator("#hr-work-primary").innerText()).includes("手動で面談を設定"),
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
    // 面談ナビ（/hr/interviews.html）が読む応募者詳細。ダッシュボードの「面談を開始」の行き先
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({
        applicant: { id: "a1", name: "山田 太郎", jobTitle: "エンジニア", stage: "casual_interview",
          status: "interview_scheduled", statusLabel: "面談予定" },
        interviews: [{ id: "iv1", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談",
          scheduledAt: new Date().toISOString(), done: false, canceled: false,
          meetingUrl: "https://meet.google.com/abc-defg-hij" }],
        interviewers: [], timeline: [], offers: [],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  page.setDefaultTimeout(8000);

  // 現在のUI：HRダッシュボードは /hr/dashboard.html（/hr/ は応募分析）。今日の面談は #today-interviews の .hr-item
  await page.goto(`${BASE}/hr/dashboard.html`);
  await page.waitForTimeout(1000);

  const row = page.locator("#today-interviews a.hr-item");
  check((await row.innerText()).includes("山田 太郎"), "今日の面談に出る");
  check((await row.innerText()).includes("カジュアル面談"), "面談種別が出る（職種ではない）");
  // 現在のUI：ダッシュボードの行は「面談を開始」（その面談IDの面談ナビへ）。[面談に参加]（Meet）は面談ナビの中にある
  check((await row.innerText()).includes("面談を開始")
    && /\/hr\/interviews\.html\?applicantId=a1&interviewId=iv1$/.test(await row.getAttribute("href") || ""),
    "[面談を開始]で、この面談の面談ナビへ");
  await row.click();
  await page.waitForTimeout(1200);
  const join = page.locator("a", { hasText: "面談に参加" });
  check(await join.count() === 1, "面談ナビに[面談に参加]ボタンが出る");
  check(await join.getAttribute("href") === "https://meet.google.com/abc-defg-hij", "TimeRexが発行したMeet URLへ飛ぶ");

  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
