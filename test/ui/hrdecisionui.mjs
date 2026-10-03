// 採用HR：社長面談の評価 → STEP 1 採用判断 → STEP 2 本人へ連絡 と、本人への連絡状況のバッジを、
// 実際のブラウザで通す（hr/ceo-review.html・hr/applicants.html）。
//
// ■ 何を守るテストか（PR #73 の仕上げ：今どの状態か・次に何をすればいいかが一目で分かる）
//   1. 判断はセグメント。選んだものだけ色＋チェック。説明の帯・確定ボタンも同じ色に切り替わる（内定・保留・見送り）
//   2. モーダルの順番：社長面談の評価 → 社長の所感 → 採用判断 → 補足 → 保存 → 本人へ連絡（別のカード）
//   3. 評価は ◎○△× のボタン。選んだものだけ色（◎○＝緑・△＝黄・×＝赤）。評価 → 判断の順に保存
//   4. 保存すると STEP 1「完了」・STEP 2「未完了」。送ると STEP 2「連絡済み」
//   5. メールを送れるときは「メールで送る」がメイン、送れないときは「メールソフトで開く」がメイン
//   6. 一覧・詳細・CEO REVIEW で「本人へ未連絡」「連絡済み」が判断とは別のバッジで出る
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
const COLORS = { hired: "rgb(47, 111, 58)", hold: "rgb(183, 121, 31)", rejected: "rgb(179, 38, 30)" };

function routes(page, state) {
  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/hr\/ceo-review/.test(url)) return send({ todayMeetings: [], recommended: [], decisionPending: state.pending, contactPending: state.contactPending || [] });
    if (/\/api\/hr\/interviews/.test(url) && req.method() === "PATCH") { state.posted.push({ interview: body() }); return send({ interview: {} }); }
    if (/\/api\/hr\/applicants\/message/.test(url)) {
      if (req.method() === "POST") { state.posted.push({ message: body() }); return send({ ok: true }); }
      const kind = new URL(url).searchParams.get("kind");
      return send({ kind, label: { hired: "内定のご連絡", hold: "選考状況のご連絡", rejected: "選考結果のご連絡" }[kind],
        to: "taro@example.jp", subject: `【株式会社エイト】選考結果のご連絡`, body: `山田 太郎 様\n\nこのたびは…`,
        mail: { configured: state.mailConfigured, reason: state.mailConfigured ? null : "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています" } });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") { state.posted.push({ applicant: body() }); return send({ applicant: state.applicant }); }
      return send({ applicant: state.applicant, interviews: state.interviews, timeline: [], offers: [], interviewers: [],
        evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: ["A", "B", "C", "D"], rankLabel: {}, statusOptions: [] });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: state.list || [state.applicant], employees: [], meEmployeeId: "emp-ceo" });
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
}

const baseApplicant = (over = {}) => ({ id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "Wantedly", stage: "ceo_interview",
  stageLabel: "社長面談", status: "ceo_decision_pending", statusLabel: "社長判断待ち", rank: "A", decision: null,
  nextAction: "社長判断をしてください", nextActionCta: "採用判断", nextActionKey: "decide", email: "taro@example.jp",
  contact: { state: "none" }, ...over });
const ceoInterview = () => ({ id: "iv-ceo", kind: "ceo", kindLabel: "社長面談", done: true, canceled: false,
  scheduledAt: "2026-10-02T05:00:00Z", conductedAt: "2026-10-02T06:00:00Z", scores: { communication: "good" }, notes: "" });

async function newPage(state) {
  const page = await br.newPage({ viewport: { width: 1280, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })));
  page.errs = []; page.on("pageerror", (e) => page.errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await routes(page, state);
  return page;
}
const segOn = (page) => page.locator("#dc-tabs button[aria-checked='true']").allInnerTexts();
const bgOf = (page, sel) => page.locator(sel).evaluate((b) => getComputedStyle(b).backgroundColor);

console.log("\n=== 判断の選択（内定・保留・見送り）：選んだものだけ色＋チェック。帯・確定ボタンも同じ色 ===");
{
  const state = { posted: [], applicant: baseApplicant(), interviews: [ceoInterview()], pending: [baseApplicant()], mailConfigured: true };
  const page = await newPage(state);
  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(900);
  await page.locator("#dec button", { hasText: "評価・採用判断" }).click();
  await page.waitForTimeout(600);

  // 並び：評価 → STEP 1 採用判断 → STEP 2 本人へ連絡（別のカード）
  const order = await page.locator("#action-root .hr-modal section").evaluateAll((ss) => ss.map((s) => s.id));
  check(order.join() === "dc-eval,dc-step1,dc-step2", `カードの並び（${order.join()}）`);
  const evalText = await page.locator("#dc-eval").innerText();
  check(evalText.indexOf("社長面談の評価") < evalText.indexOf("社長の所感"), "評価 → 所感の順");
  check((await page.locator("#dc-step2").innerText()).includes("未完了"), "STEP 2 は最初「未完了」（判断と連絡は別の操作）");

  for (const kind of ["hired", "hold", "rejected"]) {
    const label = { hired: "内定", hold: "保留", rejected: "見送り" }[kind];
    await page.locator(`#dc-tabs button[data-kind="${kind}"]`).click();
    await page.waitForTimeout(150);
    const on = await segOn(page);
    check(on.length === 1 && on[0].includes(label), `${label}を選ぶと${label}だけが選ばれる（${on.join()}）`);
    check((await page.locator(`#dc-tabs button[data-kind="${kind}"] .material-symbols-outlined`).count()) === 1, `${label}にチェックのアイコン`);
    check(await bgOf(page, `#dc-tabs button[data-kind="${kind}"]`) === COLORS[kind], `${label}のセグメントは${label}の色`);
    const others = ["hired", "hold", "rejected"].filter((k) => k !== kind);
    for (const o of others) check(await bgOf(page, `#dc-tabs button[data-kind="${o}"]`) === "rgb(255, 255, 255)", `　選んでいない${o}は白`);
    check(await page.locator(`.hr-dk-banner[data-kind="${kind}"]`).isVisible(), `説明の帯も${label}`);
    check(await bgOf(page, `.hr-dk-save[data-kind="${kind}"]`) === COLORS[kind], `確定ボタンも${label}の色`);
  }
  check(!page.errs.length, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n=== 評価保存 → 判断保存（保留）→ STEP 2 → 送付済み記録（メール未設定） ===");
{
  const state = { posted: [], applicant: baseApplicant(), interviews: [ceoInterview()], pending: [baseApplicant()], mailConfigured: false };
  const page = await newPage(state);
  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(900);
  await page.locator("#dec button", { hasText: "評価・採用判断" }).click();
  await page.waitForTimeout(600);

  check(await page.locator('#dc-eval .hr-score-row[data-item="communication"] .hr-score.on[data-v="good"]').count() === 1, "入っている評価（○）が最初から選ばれている");
  await page.locator('#dc-eval .hr-score-row[data-item="communication"] .hr-score[data-v="great"]').click();
  await page.locator('#dc-eval .hr-score-row[data-item="potential"] .hr-score[data-v="bad"]').click();
  check(await bgOf(page, '#dc-eval .hr-score-row[data-item="communication"] .hr-score[data-v="great"]') === "rgb(47, 111, 58)", "◎ は緑");
  check(await bgOf(page, '#dc-eval .hr-score-row[data-item="potential"] .hr-score[data-v="bad"]') === "rgb(253, 236, 234)", "× は赤系（懸念が分かる）");
  check(await page.locator('#dc-eval .hr-score-row[data-item="communication"] .hr-score.on').count() === 1, "1項目で選ばれるのは1つだけ");
  await page.fill("#dc-ceo-notes", "技術は十分。報酬条件だけ確認したい");

  await page.locator('#dc-tabs button[data-kind="hold"]').click();
  await page.fill("#dc-reason", "報酬条件を確認したい");
  await page.fill("#dc-next", "人事に給与レンジを確認");
  await page.fill("#dc-due", "2026-10-20");
  await page.locator("#action-root .hr-modal button", { hasText: "保留にする" }).click();
  await page.waitForTimeout(900);

  const ev = state.posted.find((p) => p.interview)?.interview;
  check(ev && ev.action === "update" && ev.id === "iv-ceo" && ev.scores.communication === "great" && ev.scores.potential === "bad"
    && ev.notes === "技術は十分。報酬条件だけ確認したい", "評価保存：面談の update に 5項目と所感");
  const ap = state.posted.find((p) => p.applicant)?.applicant;
  check(ap && ap.decision === "hold" && ap.holdNextStep === "人事に給与レンジを確認" && ap.decisionDueOn === "2026-10-20", "判断保存：保留・次の確認・期限");
  check(state.posted.findIndex((p) => p.interview) < state.posted.findIndex((p) => p.applicant), "評価を先に保存してから判断");

  check(await page.locator("#action-root .hr-modal").isVisible(), "保存してもモーダルは閉じない（そのまま STEP 2 へ）");
  const s1 = await page.locator("#dc-step1").innerText();
  check(s1.includes("STEP 1") && s1.includes("完了") && s1.includes("保留") && s1.includes("人事に給与レンジを確認"), "STEP 1 採用判断 ✓ 完了（保留の内容つき）");
  const s2 = await page.locator("#dc-step2").innerText();
  check(s2.includes("STEP 2") && s2.includes("未完了") && s2.includes("選考状況のご連絡"), "STEP 2 本人へ連絡 未完了（保留の文面）");
  check(await page.locator("#dc-eval .hr-score:disabled").count() > 0, "判断を保存したあとの評価は読むだけ");
  check(!(await page.locator("#dc-step2 button", { hasText: "メールで送る" }).count()), "メール未設定なら「メールで送る」は出さない");
  check(await page.locator("#dc-step2 button.btn-primary", { hasText: "メールソフトで開く" }).count() === 1, "メール未設定なら「メールソフトで開く」がメイン");
  check(await page.locator("#dc-step2 button.btn-secondary", { hasText: "コピー" }).count() === 1, "コピーは補助");

  await page.fill("#msg-body", "山田 太郎 様\n\n直した本文");
  await page.locator("#dc-step2 button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(700);
  const m = state.posted.find((p) => p.message)?.message;
  check(m && m.channel === "manual" && m.kind === "hold" && m.body.includes("直した本文"), "送付済み記録：直した文面で manual");
  check((await page.locator("#dc-step2").innerText()).includes("連絡済み"), "STEP 2 本人へ連絡 ✓ 連絡済み");
  check(!page.errs.length, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n=== 内定 → 本人へのメール（メール設定あり） ===");
{
  const state = { posted: [], applicant: baseApplicant(), interviews: [ceoInterview()], pending: [baseApplicant()], mailConfigured: true };
  const page = await newPage(state);
  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(900);
  await page.locator("#dec button", { hasText: "評価・採用判断" }).click();
  await page.waitForTimeout(600);
  await page.locator("#action-root .hr-modal button", { hasText: "内定にする" }).click();
  await page.waitForTimeout(800);
  check(!state.posted.some((p) => p.interview), "評価を変えていなければ、面談は保存しない");
  check(state.posted.find((p) => p.applicant)?.applicant.decision === "hired", "内定が保存される");
  check(await page.locator("#dc-step2 button.btn-primary", { hasText: "メールで送る" }).count() === 1, "メールを送れるときは「メールで送る」がメイン");
  await page.locator("#dc-step2 button", { hasText: "メールで送る" }).click();
  await page.waitForTimeout(700);
  const m = state.posted.find((p) => p.message)?.message;
  check(m && m.channel === "email" && m.kind === "hired", "本人へのメール：email・内定");
  check((await page.locator("#dc-step2").innerText()).includes("メールで送りました"), "送ったら連絡済みになる");
  await page.close();
}

console.log("\n=== CEO REVIEW：未連絡・連絡済みのバッジと「判断済み・本人へ未連絡」 ===");
{
  const holdPending = baseApplicant({ decision: "hold", holdReason: "報酬条件", holdNextStep: "人事に給与レンジを確認", decisionDueOn: "2026-10-20",
    contact: { state: "pending" } });
  const rejected = baseApplicant({ id: "a2", name: "鈴木 花子", decision: "rejected", status: "passed", contact: { state: "pending" } });
  const state = { posted: [], applicant: rejected, interviews: [ceoInterview()], pending: [holdPending], contactPending: [rejected], mailConfigured: false };
  const page = await newPage(state);
  await page.goto(`${BASE}/hr/ceo-review.html`);
  await page.waitForTimeout(900);
  const dec = await page.locator("#dec .hr-cv-card").innerText();
  check(dec.includes("保留") && dec.includes("本人へ未連絡") && dec.includes("人事に給与レンジを確認") && dec.includes("2026-10-20"),
    "社長判断待ちのカード：保留｜本人へ未連絡・保留理由・次の確認・期限");
  check(await page.locator('#dec [data-contact="pending"]').count() === 1, "未連絡のバッジ（オレンジ）");
  const pendingBg = await bgOf(page, '#dec [data-contact="pending"]');
  check(pendingBg === "rgb(255, 237, 213)", `未連絡はオレンジ系（${pendingBg}）`);
  const c = await page.locator("#contact .hr-cv-card").innerText();
  check(c.includes("鈴木 花子") && c.includes("見送り") && c.includes("本人へ未連絡"), "判断済み・本人へ未連絡：見送り｜本人へ未連絡");
  await page.locator("#contact button", { hasText: "本人へ連絡" }).click();
  await page.waitForTimeout(700);
  check((await page.locator("#dc-step1").innerText()).includes("完了"), "あとから連絡：STEP 1 は完了のまま");
  check((await page.locator("#dc-step2").innerText()).includes("選考結果のご連絡"), "STEP 2 に見送りの文面");
  await page.close();
}

console.log("\n=== 応募者一覧・詳細：判断とは別に連絡状況。未連絡は NEXT ACTION に出る ===");
{
  const rejectedPending = baseApplicant({ id: "a1", decision: "rejected", status: "passed", statusLabel: "見送り",
    nextAction: "対応は不要です", nextActionCta: null, nextActionKey: null, contact: { state: "pending" } });
  const hiredDone = baseApplicant({ id: "a2", name: "鈴木 花子", stage: "offer", stageLabel: "内定", decision: "hired",
    status: "offer_draft_pending", statusLabel: "合格通知作成待ち", nextAction: "合格通知を作成してください", contact: { state: "done" } });
  const state = { posted: [], applicant: rejectedPending, list: [rejectedPending, hiredDone], interviews: [ceoInterview()], pending: [], mailConfigured: false };
  const page = await newPage(state);
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForTimeout(1000);
  const rows = await page.locator("#rows tr").allInnerTexts();
  const r1 = rows.find((t) => t.includes("山田 太郎")) || "";
  const r2 = rows.find((t) => t.includes("鈴木 花子")) || "";
  check(r1.includes("見送り") && r1.includes("本人へ未連絡"), "一覧：見送り｜本人へ未連絡");
  check(r1.includes("本人へ見送りを伝えてください"), "一覧の NEXT：本人へ見送りを伝えてください");
  check(r2.includes("内定") && r2.includes("連絡済み") && !r2.includes("未連絡"), "一覧：内定｜連絡済み");

  await page.locator("#rows tr", { hasText: "山田 太郎" }).click();
  await page.waitForTimeout(700);
  const next = await page.locator(".hr-next").innerText();
  check(next.includes("本人へ見送りを伝えてください") && next.includes("本人へ未連絡"), "詳細の NEXT ACTION：本人へ連絡（未連絡のバッジつき）");
  check(await page.locator("[data-ceo-eval]").count() === 1, "詳細に社長面談の評価（モーダルと同じ見た目）");
  await page.locator(".hr-next button", { hasText: "本人へ連絡" }).click();
  await page.waitForTimeout(700);
  check((await page.locator("#dc-step2").innerText()).includes("選考結果のご連絡"), "詳細から本人へ連絡を開ける");
  check(!page.errs.length, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n=== 応募者詳細：保留・未連絡は「採用判断を更新」が主、「本人へ連絡」を並べて出す ===");
{
  const holdPending = baseApplicant({ decision: "hold", holdReason: "報酬条件", holdNextStep: "人事に給与レンジを確認", decisionDueOn: "2026-10-20",
    nextAction: "人事に給与レンジを確認", nextActionCta: "採用判断を更新", nextActionKey: "decide", contact: { state: "pending" } });
  const state = { posted: [], applicant: holdPending, interviews: [ceoInterview()], pending: [], mailConfigured: false };
  const page = await newPage(state);
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1200);
  check(await page.locator(".hr-next > button.btn-primary", { hasText: "採用判断を更新" }).count() === 1, "主の操作は「採用判断を更新」");
  check(await page.locator(".hr-contact-row [data-contact='pending']").count() === 1, "判断の行に「本人へ未連絡」");
  await page.locator(".hr-contact-row button", { hasText: "本人へ連絡" }).click();
  await page.waitForTimeout(700);
  check((await page.locator("#dc-step2").innerText()).includes("選考状況のご連絡"), "並べた「本人へ連絡」から保留の連絡を開ける");
  await page.close();
}

await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\nすべて通過");
