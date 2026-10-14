// 採用HR：面談情報の編集・面談メモを、実際のブラウザで「再読み込みしても残る」まで通す（E2E）。
//
// ■ 何を守るテストか（db/109_hr_interview_edit.sql）
//
//   面談作成 → 面談日時変更 → 保存 → 再読み込み → 変更日時が残る →
//   面談メモ入力 → 保存 → 再読み込み → メモが残る → メモを編集 → 再読み込み → 編集後が残る
//
//   変更した日時は、応募者詳細（面談カード・NEXT ACTION）・応募者一覧（NEXT ACTION）・
//   ダッシュボードの「今日の面談」の3か所に出ること。
//   TimeRex同期済みの面談は、日時・面談URLが読み取り専用になり、送られないこと。
//
// ■ サーバ側の持ち方
//   APIはブラウザ内で横取りするが、保存先（state）はこのテストのプロセスに持ち、
//   再読み込みをまたいで残す。入力の正規化・画面へ返す形は本物（lib/hr.js の
//   normalizeInterview / shapeInterview / shapeApplicant）を使う。
//   テスト用に書き直すと、本番の形とずれても気づけないため
import { launch, BASE, jstToday } from "../_browser.mjs";
import { normalizeInterview, shapeInterview, shapeApplicant, pickNextInterview } from "../../lib/hr.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };
const INTERVIEWERS = [{ id: "e1", display_name: "面接 花子" }, { id: "e2", display_name: "面接 一郎" }];
const nameOf = (id) => INTERVIEWERS.find((e) => e.id === id)?.display_name || null;

function newState() {
  return {
    applicant: {
      id: "a1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", source: "リファラル",
      stage: "applied", status: "scheduling", rank: null, decision: null, decision_due_on: null,
    },
    interviews: [],
    patched: [],
  };
}

/** api/hr/applicants/detail.js・index.js と同じ NEXT ACTION が指す面談（pickNextInterview） */
const nextOf = (st) => pickNextInterview(st.applicant, st.interviews);
const applicantOut = (st) => {
  const n = nextOf(st);
  return { ...shapeApplicant(st.applicant, n && { id: n.id, scheduledAt: n.scheduled_at, kind: n.kind }), recruiterName: null };
};
const interviewOut = (i) => ({ ...shapeInterview(i), interviewerName: nameOf(i.interviewer_id) });

async function openPage(st, { width = 1300 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/interviews\/today/.test(url)) {
      const today = jstToday();
      const list = st.interviews.filter((i) => !i.canceled_at && i.scheduled_at
        && new Date(Date.parse(i.scheduled_at) + 9 * 3600000).toISOString().slice(0, 10) === today);
      return send({ interviews: list.map((i) => ({
        id: i.id, applicantId: i.applicant_id, kind: i.kind, kindLabel: shapeInterview(i).kindLabel,
        scheduledAt: i.scheduled_at, done: Boolean(i.conducted_at), meetingUrl: i.meeting_url,
        interviewerId: i.interviewer_id, interviewerName: nameOf(i.interviewer_id),
        name: st.applicant.name, jobTitle: st.applicant.job_title, status: st.applicant.status, statusLabel: "面談予定",
      })) });
    }
    if (/\/api\/hr\/interviews\b/.test(url) && req.method() === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      const row = normalizeInterview(b);
      if (row.error) return send(row, 400);
      const made = { id: `iv${st.interviews.length + 1}`, tenant_id: "t1", applicant_id: b.applicantId,
        created_at: new Date().toISOString(), conducted_at: null, canceled_at: null, ...row.value };
      st.interviews.push(made);
      Object.assign(st.applicant, { status: "interview_scheduled", stage: "casual_interview" });
      return send({ interview: shapeInterview(made) });
    }
    if (/\/api\/hr\/interviews\b/.test(url) && req.method() === "PATCH") {
      const b = JSON.parse(req.postData() || "{}");
      st.patched.push(b);
      const iv = st.interviews.find((i) => i.id === b.id);
      if (!iv) return send({ error: "not_found" }, 404);
      if (b.action === "update") {
        const row = normalizeInterview(b, { partial: true });
        if (row.error) return send(row, 400);
        // api/hr/interviews/index.js と同じ規則（TimeRex同期済みは日時・URLを断る）
        if (iv.timerex_event_id && (("scheduled_at" in row.value && row.value.scheduled_at !== iv.scheduled_at)
          || ("meeting_url" in row.value && row.value.meeting_url !== iv.meeting_url))) {
          return send({ error: "timerex_managed", hint: "TimeRex側で変更してください" }, 409);
        }
        Object.assign(iv, row.value);
        return send({ interview: shapeInterview(iv) });
      }
      if (b.action === "memo") {
        const text = String(b.memo ?? "").trim();
        Object.assign(iv, { memo: text || null, memo_updated_at: new Date().toISOString() });
        return send({ interview: shapeInterview(iv) });
      }
      return send({ interview: shapeInterview(iv) });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({
        applicant: applicantOut(st), interviews: [...st.interviews].reverse().map(interviewOut),
        interviewers: INTERVIEWERS, timeline: [], offers: [], evalItems: [], evalScale: [], ranks: [], rankLabel: {},
        interviewKinds: [{ key: "casual", label: "カジュアル面談" }, { key: "ceo", label: "社長面談" }],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) {
      const n = nextOf(st);
      return send({ applicants: [{ ...applicantOut(st), nextInterviewAt: n?.scheduled_at || null,
        interviewCount: st.interviews.length, docs: null }], employees: INTERVIEWERS });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  return { page, errs };
}

const openInterviewsTab = async (page) => {
  await page.waitForSelector(".hr-tabs button[data-tab='interviews']", { timeout: 8000 });
  await page.locator(".hr-tabs button[data-tab='interviews']").click();
  await page.waitForTimeout(250);
};
const reloadAndOpen = async (page) => {
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(900);
  await openInterviewsTab(page);
};
const card = (page) => page.locator(".hr-detail-body .card").first();

console.log("\n=== 面談作成 → 日時変更 → 再読み込み → メモ → 再読み込み ===");
{
  const st = newState();
  const { page, errs } = await openPage(st);
  const today = jstToday();

  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  await openInterviewsTab(page);

  console.log("\n— 1. 面談を作る（手入力） —");
  await page.locator("button", { hasText: "面談を予定する" }).click();
  await page.waitForTimeout(250);
  await page.fill("#iv-when", `${today}T14:00`);
  await page.selectOption("#iv-who", "e1");
  await page.selectOption("#iv-method", "online");
  await page.fill("#iv-url", "https://meet.example.com/first");
  await page.locator(".hr-modal button", { hasText: "予定する" }).click();
  await page.waitForTimeout(700);
  check(st.interviews.length === 1, "面談が1件できる");
  // 期待値も固定文字列にせず、今日（JST）14:00 を UTC に直したものと比べる
  const todayUtc1400 = new Date(`${today}T14:00:00+09:00`).toISOString();
  check(st.interviews[0]?.scheduled_at === todayUtc1400, `JST 14:00 がUTCで保存される（${st.interviews[0]?.scheduled_at}）`);
  check(st.interviews[0]?.method === "online", "面談方法も保存される");
  let txt = await card(page).innerText();
  // 日時の書き方は HR 共通（js/jst.js JST.when）：今日なら「本日 14:00」
  check(txt.includes("本日 14:00"), `面談カードに予定日時（${txt.split("\n")[1]?.trim()}）`);
  check(txt.includes("面談方法：オンライン"), "面談カードに面談方法");

  console.log("\n— 2. 面談日時を変更して保存 —");
  await page.locator("button", { hasText: "面談情報を編集" }).click();
  await page.waitForTimeout(250);
  check(await page.locator(".hr-modal").isVisible(), "編集モーダルが開く");
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細ドロワーは開いたまま");
  const before = await page.locator("#rs-when").inputValue();
  check(before === `${today}T14:00`, `いまの日時がローカル時刻（JST）で入っている（${before}）`);
  check(await page.locator("#rs-method").inputValue() === "online", "いまの面談方法が選ばれている");
  await page.fill("#rs-when", `${today}T16:30`);
  await page.selectOption("#rs-who", "e2");
  await page.selectOption("#rs-method", "onsite");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(700);
  const upd = st.patched.find((p) => p.action === "update");
  check(upd && upd.interviewerId === "e2" && upd.method === "onsite", "面談担当・面談方法も送られる");
  check(await page.locator(".hr-modal").count() === 0, "保存するとモーダルが閉じる");

  console.log("\n— 3. 再読み込みしても、変更後の日時が残る —");
  await reloadAndOpen(page);
  txt = await card(page).innerText();
  const [m, d] = today.slice(5).split("-").map(Number);
  // 日時の書き方は HR 共通（js/jst.js JST.when）：今日なら「本日 16:30」
  check(txt.includes("本日 16:30"), `面談カードが新しい日時（本日 16:30）`);
  check(!txt.includes("本日 14:00"), "古い日時は出ない");
  check(txt.includes("面談担当：面接 一郎") && txt.includes("面談方法：対面"), "面談担当・面談方法も残る");
  await page.locator("button", { hasText: "面談情報を編集" }).click();
  await page.waitForTimeout(250);
  check(await page.locator("#rs-when").inputValue() === `${today}T16:30`, "編集モーダルを開き直しても新しい日時");
  await page.locator(".hr-modal button", { hasText: "閉じる" }).click();
  await page.locator('.hr-tabs button[data-tab="overview"]').click();
  await page.waitForTimeout(200);
  check((await page.locator(".hr-next").innerText()).includes("本日 16:30 カジュアル面談"), "応募者詳細のNEXT ACTIONも新しい日時");
  const row = await page.locator("#rows tr").first().innerText();
  check(row.includes("本日 16:30 カジュアル面談"), `応募者一覧のNEXT ACTIONも新しい日時（${row.replace(/\s+/g, " ").slice(0, 80)}）`);

  console.log("\n— 4. 面談メモを入力して保存 —");
  await openInterviewsTab(page);
  check((await card(page).innerText()).includes("まだメモはありません"), "最初はメモが空");
  await page.locator(".hr-iv-memo button", { hasText: "メモを書く" }).click();
  await page.waitForTimeout(250);
  await page.fill("#ivm-text", "志望動機が明確。\n次回は希望年収を確認する");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(700);
  check(st.patched.some((p) => p.action === "memo" && p.id === "iv1"), "memoアクションが、この面談のidで送られる");
  check(await page.locator(".hr-detail").isVisible(), "保存後も応募者詳細ドロワーは開いたまま");
  check((await page.locator(".hr-iv-memo-body").first().innerText()).includes("志望動機が明確。"), "保存直後にメモが出る");

  console.log("\n— 5. 再読み込みしても、メモが残る —");
  await reloadAndOpen(page);
  const memoTxt = await page.locator(".hr-iv-memo-body").first().innerText();
  check(memoTxt.includes("志望動機が明確。") && memoTxt.includes("次回は希望年収を確認する"), "メモが残る（改行も保つ）");
  check(await page.locator(".hr-iv-memo button", { hasText: "メモを編集" }).count() === 1, "ボタンが「メモを編集」になる");

  console.log("\n— 6. メモを編集 → 再読み込み → 編集後が残る —");
  await page.locator(".hr-iv-memo button", { hasText: "メモを編集" }).click();
  await page.waitForTimeout(250);
  check((await page.locator("#ivm-text").inputValue()).startsWith("志望動機が明確。"), "編集モーダルに今のメモが入っている");
  await page.fill("#ivm-text", "年収は希望どおりで合意");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(600);
  await reloadAndOpen(page);
  const memo2 = await page.locator(".hr-iv-memo-body").first().innerText();
  check(memo2.includes("年収は希望どおりで合意") && !memo2.includes("志望動機"), "編集後のメモだけが残る");
  txt = await card(page).innerText();
  check(txt.includes("本日 16:30"), "メモ保存で日時は変わらない");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);

  console.log("\n— 7. 面談予定表示（ダッシュボードの今日の面談）にも新しい時刻 —");
  await page.goto(`${BASE}/hr/index.html`);
  await page.waitForTimeout(1200);
  const todayIv = await page.locator("#todayiv").innerText();
  check(todayIv.includes("16:30") && todayIv.includes("山田 太郎"), `今日の面談に 16:30 で出る（${todayIv.replace(/\s+/g, " ").slice(0, 60)}）`);
  check(todayIv.includes("面接 一郎"), "面談担当も変更後の人");
  await page.close();
}

console.log("\n=== TimeRex同期済みの面談 ===");
{
  const st = newState();
  Object.assign(st.applicant, { status: "interview_scheduled", stage: "casual_interview" });
  st.interviews.push({
    id: "iv-tx", tenant_id: "t1", applicant_id: "a1", kind: "casual", scheduled_at: "2026-10-06T01:00:00Z",
    meeting_url: "https://meet.google.com/abc-defg-hij", interviewer_id: null, conducted_at: null, canceled_at: null,
    timerex_event_id: "ev1", timerex_synced_at: "2026-09-30T00:00:00Z", created_at: "2026-09-30T00:00:00Z",
  });
  const { page, errs } = await openPage(st);
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  await openInterviewsTab(page);

  check((await card(page).innerText()).includes("TimeRex"), "TimeRexの印が出る");
  await page.locator("button", { hasText: "面談情報を編集" }).click();
  await page.waitForTimeout(250);
  check(await page.locator("#rs-timerex").isVisible(), "「日時・面談URLはTimeRex側で変更」の案内が出る");
  check(await page.locator("#rs-when").isDisabled(), "日時は読み取り専用");
  check(await page.locator("#rs-url").isDisabled(), "面談URLは読み取り専用");
  check(await page.locator("#rs-when").inputValue() === "2026-10-06T10:00", "日時はJSTで見える");
  check(await page.locator("#rs-who").isEnabled() && await page.locator("#rs-method").isEnabled(), "面談担当・面談方法は変えられる");
  await page.selectOption("#rs-who", "e1");
  await page.selectOption("#rs-method", "online");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(600);
  const upd = st.patched.find((p) => p.action === "update");
  check(upd && !("scheduledAt" in upd) && !("meetingUrl" in upd), "日時・面談URLは送らない");
  check(await page.locator(".hr-modal").count() === 0, "保存できてモーダルが閉じる");
  check(st.interviews[0].scheduled_at === "2026-10-06T01:00:00Z", "日時はTimeRexの値のまま");

  await page.locator(".hr-iv-memo button", { hasText: "メモを書く" }).click();
  await page.waitForTimeout(200);
  await page.fill("#ivm-text", "TimeRex経由の面談のメモ");
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(500);
  await reloadAndOpen(page);
  check((await page.locator(".hr-iv-memo-body").first().innerText()).includes("TimeRex経由の面談のメモ"), "TimeRexの面談でもメモが残る");
  check((await card(page).innerText()).includes("面談担当：面接 花子"), "面談担当の変更も残る");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

console.log("\n=== スマホ幅でも面談メモ・編集が使える ===");
{
  const st = newState();
  Object.assign(st.applicant, { status: "interview_scheduled", stage: "casual_interview" });
  st.interviews.push({ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual", scheduled_at: "2026-10-06T01:00:00Z",
    meeting_url: null, interviewer_id: null, conducted_at: null, canceled_at: null, memo: "長い".repeat(80), created_at: "2026-09-30T00:00:00Z" });
  const { page, errs } = await openPage(st, { width: 390 });
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  await openInterviewsTab(page);
  const overflow = await page.evaluate(() => {
    const b = document.querySelector(".hr-detail");
    return b ? b.scrollWidth - b.clientWidth : 0;
  });
  check(overflow <= 1, `長いメモでもドロワーが横にはみ出さない（${overflow}px）`);
  await page.locator(".hr-iv-memo button", { hasText: "メモを編集" }).click();
  await page.waitForTimeout(200);
  check(await page.locator("#ivm-text").isVisible(), "メモ編集モーダルが開く");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
