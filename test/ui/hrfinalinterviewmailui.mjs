// 最終面談案内：実ブラウザと架空APIだけ。Gmail・本番DB・実メールには接続しない。
import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";
const browser = await launch();
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ME = { email: "recruit@example.test", appRole: "member", access: { recruit: true },
  gw: { employee: { id: "e1", display_name: "架空 採用担当" }, roles: ["recruiter"], tenantId: "t1" } };
const templates = [
  { id: "standard", name: "応募受付", purpose: "application", purposeLabel: "応募受付", isDefault: true, version: 1 },
  { id: "ceo", name: "社長面談案内", purpose: "ceo", purposeLabel: "社長面談案内", isDefault: true, version: 3 },
];
function fixture() {
  const applicants = [A, B].map((id, i) => ({ id, name: "架空 応募者" + (i + 1), email: "applicant" + (i + 1) + "@example.test",
    jobTitle: "営業", source: "架空媒体", stage: "ceo_interview", stageLabel: "社長面談", status: "interview_scheduled",
    statusLabel: "面談予定", nextAction: "面談を実施してください", nextActionCta: "面談を実施済みにする",
    nextActionKey: "conduct", nextInterviewId: "iv-" + id, nextInterviewKind: "ceo" }));
  const interviews = applicants.map((a) => ({ id: a.nextInterviewId, applicantId: a.id, kind: "ceo", kindLabel: "社長面談",
    scheduledAt: "2026-11-05T05:30:00Z", method: "online", meetingUrl: "https://meet.example.test/final-" + a.id,
    canceled: false, done: false, scores: {} }));
  return { applicants, interviews, templates: [...templates], posts: [], gets: [], hold: 0, release: null, errors: [] };
}
async function open(fx, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "synthetic", email: "recruit@example.test" })));
  page.on("pageerror", (e) => fx.errors.push(String(e)));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (req.method() !== "GET") { fx.posts.push({ path: url.pathname, body: JSON.parse(req.postData() || "{}") }); return send({ status: "sent" }); }
    if (url.pathname === "/api/me") return send(ME);
    if (url.pathname === "/api/hr/applicants/mail") {
      const a = fx.applicants.find((x) => x.id === url.searchParams.get("id"));
      const templateId = url.searchParams.get("templateId") || "standard";
      fx.gets.push({ id: a.id, templateId });
      if (fx.hold === fx.gets.length) await new Promise((resolve) => { fx.release = resolve; });
      return send({ applicant: a, templates: fx.templates, rendered: { templateId, templateVersion: templateId === "ceo" ? 3 : 1,
        subject: "既存ひな型", body: "既存本文 {{面談予約URL}}", missing: [{ key: "面談予約URL", reason: "予約URLが未設定" }], unknown: [] },
        mail: { configured: true, hasEmail: true, from: "recruit@example.test" }, sends: [] });
    }
    if (url.pathname === "/api/hr/applicants/detail") {
      const a = fx.applicants.find((x) => x.id === url.searchParams.get("id"));
      // 他の未完了面談が先頭でも、サーバ指定の nextInterviewId を案内する。
      const unrelated = { ...fx.interviews[0], id: "later", scheduledAt: "2026-12-01T01:00:00Z", meetingUrl: "https://meet.example.test/wrong" };
      return send({ applicant: a, interviews: [unrelated, ...fx.interviews.filter((i) => i.applicantId === a.id)], timeline: [], offers: [],
        evalItems: [], evalScale: [], ranks: [], rankLabel: {}, interviewKinds: [] });
    }
    if (url.pathname === "/api/hr/applicants") return send({ applicants: fx.applicants });
    return send({});
  });
  await page.goto(BASE + "/hr/applicants.html?id=" + A);
  await page.waitForSelector("#hr-final-interview-mail");
  return page;
}
async function done(page, fx) { assert.deepEqual(fx.errors, []); await page.close(); }
const waitGets = async (page, fx, count) => { await page.waitForFunction(() => document.querySelector("#hr-modal-root")?.textContent.includes("読み込み中"));
  for (let n = 0; n < 500 && fx.gets.length < count; n++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fx.gets.length >= count, "保留中の下書きリクエストが開始した"); };
try {
  for (const width of [1280, 390]) {
    const fx = fixture(), page = await open(fx, width);
    assert.match(await page.locator("#hr-final-interview-mail").getAttribute("class"), /btn-primary/);
    assert.match(await page.locator("#hr-detail-next").innerText(), /面談を実施済みにする/);
    await page.click("#hr-final-interview-mail");
    await page.waitForSelector("#mail-body");
    assert.equal(await page.locator("#mail-tpl").inputValue(), "ceo");
    assert.equal(await page.locator("#mail-to-email").innerText(), "<applicant1@example.test>");
    const body = await page.locator("#mail-body").inputValue();
    assert.match(body, /架空 応募者1 様/); assert.ok(body.includes("日時：2026/11/5 14:30（日本時間）"));
    assert.match(body, /オンライン/); assert.ok(body.includes(fx.interviews[0].meetingUrl));
    assert.ok(!body.includes("wrong")); assert.equal(await page.locator("#mail-missing").count(), 0);
    assert.equal(fx.posts.length, 0, "開いただけでは送信・面談実施をしない");
    await page.fill("#mail-body", body + "\n個別追記");
    await page.evaluate(() => { openFinalInterviewMail(); openFinalInterviewMail(); });
    assert.equal(await page.locator("#mail-body").inputValue(), body + "\n個別追記");
    assert.equal(fx.gets.length, 2, "繰り返し操作で再読込しない");
    page.once("dialog", (d) => d.dismiss());
    await page.click("#mail-send");
    assert.equal(fx.posts.length, 0, "送信確認キャンセルは送らない");
    page.once("dialog", (d) => d.accept());
    await page.click("#mail-send");
    await page.waitForSelector("#mail-result-banner");
    assert.equal(fx.posts.length, 1); assert.equal(fx.posts[0].path, "/api/hr/applicants/mail");
    assert.equal(fx.posts[0].body.id, A); assert.equal(fx.posts[0].body.templateId, "ceo");
    assert.equal(fx.posts[0].body.templateVersion, 3); assert.equal(fx.posts[0].body.body, body + "\n個別追記");
    await done(page, fx);
  }
  for (const held of [1, 2]) {
    const fx = fixture(); fx.hold = held;
    const page = await open(fx); await page.click("#hr-final-interview-mail"); await waitGets(page, fx, held);
    await page.getByRole("button", { name: "送らずに閉じる", exact: true }).click();
    fx.release(); await page.waitForTimeout(100);
    assert.equal(await page.locator("#hr-modal-root .hr-modal").count(), 0, "閉じた後の遅延応答で復活しない");
    assert.equal(fx.posts.length, 0); await done(page, fx);
  }
  {
    const fx = fixture(); fx.hold = 1;
    const page = await open(fx); await page.click("#hr-final-interview-mail"); await waitGets(page, fx, 1);
    await page.evaluate(async (id) => { closeHrModal(); await openDetail(id); await openMailForm(); }, B);
    await page.fill("#mail-body", "別の応募者の編集済み本文");
    fx.release(); await page.waitForTimeout(100);
    assert.match(await page.locator("#mail-to-name").innerText(), /架空 応募者2/);
    assert.equal(await page.locator("#mail-body").inputValue(), "別の応募者の編集済み本文");
    assert.equal(fx.gets.length, 2, "古い最終面談フローが新しい応募者の下書きを作らない");
    assert.equal(fx.posts.length, 0); await done(page, fx);
  }
  for (const field of ["scheduledAt", "meetingUrl"]) {
    const fx = fixture(); fx.interviews[0][field] = null;
    const page = await open(fx); await page.click("#hr-final-interview-mail");
    assert.match(await page.locator("#hr-modal-root").innerText(), /未登録です/);
    assert.equal(fx.gets.length, 0); assert.equal(fx.posts.length, 0); await done(page, fx);
  }
  {
    const fx = fixture(); fx.templates = fx.templates.filter((t) => t.purpose !== "ceo");
    const page = await open(fx); await page.click("#hr-final-interview-mail");
    await page.waitForSelector('#hr-modal-root a[href="/hr/templates.html"]');
    assert.match(await page.locator("#hr-modal-root").innerText(), /ひな型がありません/);
    assert.equal(fx.posts.length, 0); await done(page, fx);
  }
  console.log("Final interview invite: primary action, correct interview, preview/confirm, repeat/Close/navigation races PASS");
} finally { await browser.close(); }
