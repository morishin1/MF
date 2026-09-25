// 採用HR Stage 4：CEO REVIEW（hr-ceo-review.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   社長推薦 → CEO REVIEWへ表示 → 社長面談設定 → 今日会う人へ表示
//   → 面談実施 → 社長判断待ち → 内定（stage=offer, status=offer_draft_pending）
//   まで一続きで通す。あわせて保留・見送り・owner以外は開けないことも見る。
import { launch, BASE, jstToday } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER_ME = { email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-o1", display_name: "社長" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };
const RECRUITER_ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-r1", display_name: "採用 花子" }, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

console.log("\n=== 社長推薦 → 社長面談設定 → 今日会う人 → 実施 → 判断待ち → 内定 ===");
{
  const state = {
    applicant: { id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "ceo_recommend", status: "ceo_interview_pending", rank: "A", decision: null,
      recommendNote: "営業経験が強く、事業立ち上げ経験あり。", decisionDueOn: null },
    interviews: [],
  };
  let nextIvId = 1;
  const posted = [];

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  const bucketOf = () => {
    const iv = state.interviews.find((i) => i.kind === "ceo") || null;
    const today = iv && !iv.done && iv.scheduledAt && iv.scheduledAt.slice(0, 10) === jstToday();
    const card = {
      id: state.applicant.id, name: state.applicant.name, jobTitle: state.applicant.jobTitle,
      rank: state.applicant.rank, recommendNote: state.applicant.recommendNote,
      goodPoints: "行動力が高い", concerns: "報酬条件のみ確認したい",
      ceoInterview: iv ? { id: iv.id, scheduledAt: iv.scheduledAt, meetingUrl: iv.meetingUrl, done: iv.done } : null,
    };
    if (today) return { todayMeetings: [card], recommended: [], decisionPending: [] };
    if (state.applicant.status === "ceo_decision_pending") return { todayMeetings: [], recommended: [], decisionPending: [card] };
    return { todayMeetings: [], recommended: [card], decisionPending: [] };
  };

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/hr\/ceo-review/.test(url)) return send(bucketOf());
    if (/\/api\/hr\/interviews\/today/.test(url)) return send({ interviews: [] });
    if (/\/api\/hr\/interviews\b/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      if (req.method() === "POST") {
        const iv = { id: `iv${nextIvId++}`, kind: b.kind, scheduledAt: b.scheduledAt, done: false, meetingUrl: b.meetingUrl || null };
        state.interviews.push(iv);
        state.applicant.status = "interview_scheduled";
        return send({ interview: iv });
      }
      if (b.action === "conduct") {
        const iv = state.interviews.find((x) => x.id === b.id);
        iv.done = true;
        state.applicant.status = "ceo_decision_pending";
        return send({ interview: iv, status: "ceo_decision_pending" });
      }
      return send({ interview: {} });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        Object.assign(state.applicant, b);
        return send({ applicant: {} });
      }
      return send({ applicant: state.applicant, timeline: [{ id: "t1", eventKey: "applied", label: "応募", occurredAt: "2026-09-20T00:00:00Z" }] });
    }
    if (/\/api\/employees/.test(url)) return send({ employees: [{ id: "e1", display_name: "社長", status: "active" }] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr-ceo-review.html`);
  await page.waitForTimeout(1000);

  console.log("\n— 社長に会ってほしい人へ表示 —");
  check((await page.locator("#rec").innerText()).includes("山田 太郎"), "推薦された候補者が出る");
  check((await page.locator("#rec").innerText()).includes("営業経験が強く"), "推薦理由が出る");
  check((await page.locator("#rec").innerText()).includes("行動力が高い"), "良かった点が出る");
  check(await page.locator("#today .hr-cv-card").count() === 0, "まだ今日会う人には出ない");

  console.log("\n— 社長面談を設定 —");
  await page.locator("#rec button", { hasText: "社長面談を設定" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "予定フォームが開く");
  const when = `${jstToday()}T14:00`;
  await page.fill("#iv-when", when);
  await page.fill("#iv-url", "https://meet.google.com/xyz");
  await page.locator(".hr-drawer button", { hasText: "設定する" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.kind === "ceo"), "社長面談の予定がサーバへ送られる");

  console.log("\n— 今日会う人へ表示 —");
  check((await page.locator("#today").innerText()).includes("山田 太郎"), "今日会う人に出る");
  check((await page.locator("#today").innerText()).includes("14:00"), "時刻が出る");
  check(await page.locator("#today a", { hasText: "面談を開く" }).count() === 1, "面談を開くリンクが出る");

  console.log("\n— 面談を実施済みにする —");
  await page.locator("#today button", { hasText: "実施済みにする" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "conduct"), "実施済みがサーバへ送られる");

  console.log("\n— 社長判断待ちへ —");
  check((await page.locator("#dec").innerText()).includes("山田 太郎"), "社長判断待ちに出る");
  check(await page.locator("#today .hr-cv-card").count() === 0, "今日会う人からは消える");

  console.log("\n— 内定にする —");
  await page.locator("#dec button", { hasText: "採用判断" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "採用判断フォームが開く");
  await page.locator(".hr-drawer button", { hasText: "内定にする" }).click();
  await page.waitForTimeout(700);
  const hired = posted.find((p) => p.decision === "hired");
  check(Boolean(hired), "内定がサーバへ送られる");
  check(hired?.stage === "offer", "stage = offer（内定）");
  check(hired?.status === "offer_draft_pending", "status = 合格通知作成待ち（Stage 5へ渡す）");

  console.log("\n— 詳細は右ドロワーで（事務処理は出さない） —");
  await page.locator(".hd").first().click();
  await page.waitForTimeout(500);
  check(await page.locator(".hr-detail").isVisible(), "右ドロワーが開く");
  const detailText = await page.locator(".hr-detail").innerText();
  for (const x of ["合格通知作成", "通知書送付", "承諾期限", "onboarding", "契約書作成", "試用期間"]) {
    check(!detailText.includes(x), `事務処理は出さない：${x}`);
  }

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 保留・見送り ===");
{
  async function decideAs(kind, extra, wantPosted) {
    const applicant = { id: "a2", name: "鈴木 花子", jobTitle: "デザイナー", source: "Wantedly",
      stage: "ceo_interview", status: "ceo_decision_pending", rank: "B", decision: null };
    const posted = [];
    const page = await br.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Asia/Tokyo" });
    await page.addInitScript(() => {
      localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
    });
    await page.route("**/api/**", (route) => {
      const req = route.request();
      const url = req.url();
      const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
      if (/\/api\/hr\/ceo-review/.test(url)) return send({ todayMeetings: [], recommended: [], decisionPending: [applicant] });
      if (/\/api\/hr\/applicants\/detail/.test(url) && req.method() === "PATCH") {
        posted.push(JSON.parse(req.postData() || "{}"));
        return send({ applicant: {} });
      }
      if (/\/api\/employees/.test(url)) return send({ employees: [] });
      if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
      return send({});
    });
    await page.goto(`${BASE}/hr-ceo-review.html`);
    await page.waitForTimeout(900);
    await page.locator("#dec button", { hasText: "採用判断" }).click();
    await page.waitForTimeout(400);
    if (kind !== "hired") await page.locator(".hr-drawer button", { hasText: kind === "hold" ? "保留" : "見送り" }).click();
    await extra(page);
    await page.close();
    check(wantPosted(posted), `${kind} が正しく送られる`);
  }

  await decideAs("hold", async (page) => {
    await page.fill("#dc-reason", "報酬条件を確認したい");
    await page.fill("#dc-next", "人事に給与レンジを確認");
    await page.locator(".hr-drawer button", { hasText: "保留にする" }).click();
    await page.waitForTimeout(600);
  }, (posted) => posted.some((p) => p.decision === "hold" && p.holdNextStep === "人事に給与レンジを確認"));

  await decideAs("rejected", async (page) => {
    await page.locator(".hr-drawer button", { hasText: "見送りを確定" }).click();
    await page.waitForTimeout(600);
  }, (posted) => posted.some((p) => p.decision === "rejected" && p.status === "passed"));
}

console.log("\n=== recruiterはCEO REVIEWを開けない ===");
{
  const page = await br.newPage({ viewport: { width: 1000, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(RECRUITER_ME);
    return send({});
  });
  await page.goto(`${BASE}/hr-ceo-review.html`);
  await page.waitForTimeout(900);
  check(page.url().includes("hr-dashboard.html"), "権限が無いと、ダッシュボードへ送り返される");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
