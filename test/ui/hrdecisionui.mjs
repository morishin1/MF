// 採用HR：評価・採用判断のモーダルと、本人への連絡（hr/ceo-review.html・hr/applicants.html）を実際のブラウザで通す。
//
// ■ 何を守るテストか（DX要望：保留が分かるモーダル・社長面談後の評価・判断後に本人へ連絡）
//   1. 選んだ判断のボタンだけが選ばれた見た目になる（保留を選んだら「内定」は選ばれていない）
//   2. 判断ごとの説明の帯が出て、色も変わる（内定＝緑・保留＝黄・見送り＝赤）
//   3. 社長面談の評価（5項目・社長の所感）を同じ画面で入れられ、面談の update で保存される
//   4. 判断を保存すると「本人へ伝える」が開き、文面を直して送れる（送付済みの記録・メール送信）
//   5. 保留中は一覧・CEO REVIEW のカードでも「保留中」と分かる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER_ME = { email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-ceo", display_name: "森田 社長", status: "active" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };
const EVAL_ITEMS = [
  { key: "communication", label: "コミュニケーション" }, { key: "experience", label: "経験・スキル" },
  { key: "orientation", label: "志向性" }, { key: "culture_fit", label: "カルチャーフィット" },
  { key: "potential", label: "期待値／ポテンシャル" },
];
const EVAL_SCALE = [{ key: "great", label: "◎" }, { key: "good", label: "○" }, { key: "fair", label: "△" }, { key: "bad", label: "×" }];

function routes(page, state) {
  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/hr\/ceo-review/.test(url)) return send({ todayMeetings: [], recommended: [], decisionPending: state.pending });
    if (/\/api\/hr\/interviews/.test(url) && req.method() === "PATCH") { state.posted.push({ interview: body() }); return send({ interview: {} }); }
    if (/\/api\/hr\/applicants\/message/.test(url)) {
      if (req.method() === "POST") { state.posted.push({ message: body() }); return send({ ok: true }); }
      const kind = new URL(url).searchParams.get("kind");
      return send({ kind, label: { hired: "内定のご連絡", hold: "選考状況のご連絡", rejected: "選考結果のご連絡" }[kind],
        to: "taro@example.jp", subject: `【株式会社エイト】${kind}の件名`, body: `山田 太郎 様\n\n${kind}の本文`,
        mail: { configured: state.mailConfigured, reason: state.mailConfigured ? null : "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています" } });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") { state.posted.push({ applicant: body() }); Object.assign(state.applicant, state.afterPatch || {}); return send({ applicant: state.applicant }); }
      return send({ applicant: state.applicant, interviews: state.interviews, timeline: [], offers: [], interviewers: [],
        evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: ["A", "B", "C", "D"], rankLabel: {}, statusOptions: [] });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [state.applicant], employees: [], meEmployeeId: "emp-ceo" });
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
}

const baseApplicant = () => ({ id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "Wantedly", stage: "ceo_interview",
  stageLabel: "社長面談", status: "ceo_decision_pending", statusLabel: "社長判断待ち", rank: "A", decision: null,
  nextAction: "社長判断をしてください", nextActionCta: "採用判断", nextActionKey: "decide", email: "taro@example.jp" });
const ceoInterview = () => ({ id: "iv-ceo", kind: "ceo", kindLabel: "社長面談", done: true, canceled: false,
  scheduledAt: "2026-10-02T05:00:00Z", conductedAt: "2026-10-02T06:00:00Z", scores: { communication: "good" }, notes: "" });

const pressed = async (page) => page.locator("#dc-tabs button[aria-pressed='true']").allInnerTexts();

console.log("\n=== CEO REVIEW：評価・採用判断（保留） ===");
{
  const state = { posted: [], applicant: baseApplicant(), interviews: [ceoInterview()], pending: [baseApplicant()], mailConfigured: false };
  const page = await br.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })));
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await routes(page, state);
  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(900);

  await page.locator("#dec button", { hasText: "評価・採用判断" }).click();
  await page.waitForTimeout(600);
  check((await pressed(page)).join() === "✓ 内定", `開いた時点では内定だけが選ばれている（${(await pressed(page)).join()}）`);
  check(await page.locator("#dc-eval .hr-dk-eval").isVisible(), "社長面談の評価欄が出る");
  check(await page.locator('input[name="dce-communication"][value="good"]').isChecked(), "入っている評価が最初から選ばれている");

  await page.locator("#dc-tabs button", { hasText: "保留" }).click();
  await page.waitForTimeout(200);
  check((await pressed(page)).join() === "✓ 保留", `保留を選ぶと、保留だけが選ばれている（${(await pressed(page)).join()}）`);
  check(await page.locator('#dc-tabs button[data-kind="hired"][aria-pressed="false"]').count() === 1, "内定は選ばれていない見た目に戻る");
  const bg = await page.locator('#dc-tabs button[data-kind="hold"]').evaluate((b) => getComputedStyle(b).backgroundColor);
  check(bg === "rgb(125, 90, 0)", `保留のボタンは保留の色（${bg}）`);
  const banner = page.locator('.hr-dk-banner[data-kind="hold"]');
  check(await banner.isVisible() && (await banner.innerText()).includes("保留にします"), "保留の説明の帯が出る");
  check(await page.locator("#action-root .hr-modal button", { hasText: "保留にする" }).isVisible(), "確定ボタンは「保留にする」");

  await page.locator('input[name="dce-communication"][value="great"]').check();
  await page.locator('input[name="dce-potential"][value="good"]').check();
  await page.fill("#dc-ceo-notes", "技術は十分。報酬条件だけ確認したい");
  await page.fill("#dc-reason", "報酬条件を確認したい");
  await page.fill("#dc-next", "人事に給与レンジを確認");
  await page.fill("#dc-due", "2026-10-20");
  await page.locator("#action-root .hr-modal button", { hasText: "保留にする" }).click();
  await page.waitForTimeout(900);

  const ev = state.posted.find((p) => p.interview)?.interview;
  check(ev && ev.action === "update" && ev.id === "iv-ceo" && ev.scores.communication === "great" && ev.scores.potential === "good"
    && ev.notes === "技術は十分。報酬条件だけ確認したい", "社長面談の評価が面談の update で保存される");
  const ap = state.posted.find((p) => p.applicant)?.applicant;
  check(ap && ap.decision === "hold" && ap.holdNextStep === "人事に給与レンジを確認" && ap.decisionDueOn === "2026-10-20", "保留が保存される");
  check(state.posted.findIndex((p) => p.interview) < state.posted.findIndex((p) => p.applicant), "評価を先に保存してから判断");

  const modal = await page.locator("#action-root .hr-modal").innerText();
  check(modal.includes("本人へ伝える") && modal.includes("選考状況のご連絡"), "判断のあと「本人へ伝える」が開く（保留の文面）");
  check(!(await page.locator("#action-root button", { hasText: "メールで送る" }).count()), "メールの設定が無ければ「メールで送る」は出さない");
  check(modal.includes("MAIL_SEND_ENABLED"), "送れない理由を出す");
  await page.fill("#msg-body", "山田 太郎 様\n\n直した本文");
  await page.locator("#action-root button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(600);
  const m = state.posted.find((p) => p.message)?.message;
  check(m && m.channel === "manual" && m.kind === "hold" && m.body.includes("直した本文"), "直した文面で「送付済み」が記録される");
  check(!(await page.locator("#action-root .hr-modal").count()), "記録したら閉じる");
  check(!errs.length, `画面のエラーなし（${errs.join(" / ")}）`);
  await page.close();
}

console.log("\n=== CEO REVIEW：保留中のカード・見送りの色・メールで送る ===");
{
  const holdA = { ...baseApplicant(), decision: "hold", holdNextStep: "人事に給与レンジを確認", decisionDueOn: "2026-10-20" };
  const state = { posted: [], applicant: holdA, interviews: [ceoInterview()], pending: [holdA], mailConfigured: true };
  const page = await br.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })));
  await routes(page, state);
  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(900);
  const card = await page.locator("#dec .hr-cv-card").innerText();
  check(card.includes("保留中") && card.includes("人事に給与レンジを確認") && card.includes("2026-10-20"), "保留中のカードに、次の確認と期限が出る");

  await page.locator("#dec button", { hasText: "評価・採用判断" }).click();
  await page.waitForTimeout(500);
  await page.locator("#dc-tabs button", { hasText: "見送り" }).click();
  const fg = await page.locator('#dc-tabs button[data-kind="rejected"]').evaluate((b) => getComputedStyle(b).backgroundColor);
  check(fg === "rgb(179, 38, 30)", `見送りは赤（${fg}）`);
  await page.locator("#action-root .hr-modal button", { hasText: "見送りを確定" }).click();
  await page.waitForTimeout(800);
  check(!state.posted.some((p) => p.interview), "評価を変えていなければ、面談は保存しない");
  await page.locator("#action-root button", { hasText: "メールで送る" }).click();
  await page.waitForTimeout(600);
  const m = state.posted.find((p) => p.message)?.message;
  check(m && m.channel === "email" && m.kind === "rejected", "メールの設定があれば「メールで送る」で送れる");
  await page.close();
}

console.log("\n=== 応募者一覧：保留中の表示・詳細からあとで本人へ連絡 ===");
{
  const holdA = { ...baseApplicant(), decision: "hold", holdReason: "報酬条件", holdNextStep: "人事に給与レンジを確認", decisionDueOn: "2026-10-20" };
  const state = { posted: [], applicant: holdA, interviews: [ceoInterview()], pending: [], mailConfigured: false };
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })));
  const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
  await routes(page, state);
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForTimeout(1000);
  check((await page.locator("#rows").innerText()).includes("保留中（社長判断）"), "一覧の状態が「保留中（社長判断）」");
  await page.locator(".hr-table tr.click").first().click();
  await page.waitForTimeout(600);
  const next = await page.locator(".hr-next").innerText();
  check(next.includes("保留中") && next.includes("人事に給与レンジを確認"), "詳細の NEXT ACTION に保留中と次の確認が出る");
  await page.locator(".hr-detail button", { hasText: "本人へ連絡" }).click();
  await page.waitForTimeout(600);
  check((await page.locator("#action-root .hr-modal").innerText()).includes("選考状況のご連絡"), "あとからでも、本人へ連絡の文面を開ける");
  await page.locator("#action-root button", { hasText: "あとで" }).click();

  // 採用HRの詳細からの採用判断も同じモーダル（保留を選ぶと保留だけが選ばれる）
  await page.locator(".hr-next button", { hasText: "採用判断" }).click();
  await page.waitForTimeout(600);
  await page.locator("#dc-tabs button", { hasText: "保留" }).click();
  check((await pressed(page)).join() === "✓ 保留", "採用HRの詳細でも、保留を選ぶと保留だけが選ばれる");
  check(!errs.length, `画面のエラーなし（${errs.join(" / ")}）`);
  await page.close();
}

await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\nすべて通過");
