// 採用HR：オファー作成 → 内容を確認してメールで送信 → 本人の同意（契約完了）を、実際のブラウザで通す。
//
// ■ 何を守るテストか（オファー作成・メール送信・同意完結 UI/UX改善仕様 §25）
//   育成枠   … 通常表示は5項目前後／無限道場で期間が自動／報酬［なし］で金額を出さない・［時給］で出す／回答期限が自動
//   業務委託 … 報酬はボタン／標準の支払条件が入る／詳細設定は閉じている／業務内容は標準文から
//   パート   … 給与区分を選ばせない（時給だけ）
//   メール   … ［内容を確認してメールで送信］→ 本人に届く内容と件名・本文 →［メールでオファー送信］1回で送る
//              送れないとき（設定が無い・失敗）は URL を発行して手で送る → 送付済みにする
//   HR       … 同意後は「契約完了」。区分ごとに次のアクションが違う
//   候補者   … 重要条件が先／同意のチェックが無ければ押せない／同意で完了画面
//   画面     … PC・768px・390px（1列・横にはみ出さない）
//
// 応答は lib/hr.js・lib/hr-offer-types.js の本物の関数で組み立てる（ラベル・文面をテスト側で作らない）。
// 実在の応募者・実際のメール送信は使わない（宛先は example.test）
import { launch, BASE } from "../_browser.mjs";
import { shapeApplicant, shapePublicOffer, shapeOffer, normalizeOffer } from "../../lib/hr.js";
import { OFFER_TYPES_PUBLIC, publicOfferItems, offerMail, OFFER_URL_TAG, defaultRespondBy } from "../../lib/hr-offer-types.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER_ME = { email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "e-owner", display_name: "社長 一郎" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };

function makeState(offerType, over = {}) {
  return {
    row: {
      id: "a1", tenant_id: "t1", name: "テスト 候補者", email: "candidate@example.test", job_title: "エンジニア", source: "テスト",
      stage: "offer", status: "offer_draft_pending", rank: "A", decision: "hired", lead_category: "recruitment",
      employment_type: null, wage_type: null, wage_amount: null, offer_type: offerType, ...over,
    },
    offers: [], calls: [], mail: { configured: true, reason: null }, sendResult: "sent",
  };
}

async function open(state, { width = 1300 } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const errs = [];
  const shaped = () => ({ ...shapeApplicant(state.row), recruiterName: "採用 花子", contact: { state: "none" } });
  const offer = () => state.offers[0];
  await ctx.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({
        applicant: shaped(), interviews: [], interviewers: [], offers: state.offers.map((o) => shapeOffer(o)), timeline: [],
        evalItems: [], evalScale: [], ranks: [], rankLabel: {}, interviewKinds: [], statusOptions: [],
        offerTypes: OFFER_TYPES_PUBLIC, offerTypeReady: true, salaryVisible: true,
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [shaped()], employees: [] });
    if (/\/api\/hr\/offers\b/.test(url)) {
      const m = req.method();
      if (m === "POST") {
        const b = body(); state.calls.push(["create", b]);
        const r = normalizeOffer(b, state.row, { offerType: state.row.offer_type });
        if (r.error) return send(r, 400);
        state.offers = [{ id: "o1", version: 1, ...r.value, created_at: "2026-10-10T01:00:00Z" }];
        state.row.status = "offer_review_pending";
        return send({ offer: shapeOffer(offer()), status: "offer_review_pending" });
      }
      if (m === "GET") {
        state.calls.push(["draft"]);
        const o = offer();
        const mail = offerMail(o, { name: state.row.name, company: "株式会社エイト" });
        return send({ offer: shapeOffer(o), items: publicOfferItems(o), to: state.row.email, candidateName: state.row.name,
          subject: mail.subject, body: mail.body, urlTag: OFFER_URL_TAG, mail: state.mail,
          canSend: ["offer_review_pending", "offer_send_pending"].includes(state.row.status) && !o.sent_at });
      }
      const b = body(); state.calls.push([b.action, b]);
      const o = offer();
      if (b.action === "send") {
        if (state.sendResult === "failed") {
          state.row.status = "offer_send_pending";
          return send({ status: "failed", url: "https://gw.example.test/hr/offer.html?token=" + "f".repeat(43), token: "f".repeat(43),
            offer: shapeOffer(o), hint: "メールを送れませんでした（送信サービスが断りました）。下のURLと文面をコピーして手で送り、「送付済みにする」を押してください" }, 502);
        }
        o.sent_at = "2026-10-10T02:00:00Z";
        state.row.status = "offer_sent";
        return send({ status: "sent", offer: shapeOffer(o), send: { id: "s1", status: "sent" }, applicantStatus: "offer_sent" });
      }
      if (b.action === "confirm") { state.row.status = "offer_send_pending"; return send({ offer: shapeOffer(o) }); }
      if (b.action === "issueLink") return send({ offer: shapeOffer(o), token: "t".repeat(43) });
      if (b.action === "markSent") { o.sent_at = "2026-10-10T02:00:00Z"; state.row.status = "offer_sent"; return send({ offer: shapeOffer(o) }); }
      return send({ offer: shapeOffer(o) });
    }
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], types: [], limits: {} });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1100);
  return { ctx, page, errs };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// オファーの入力・確認の画面（モーダル）が、画面の幅に収まっているか（はみ出した分の px）。
// 一覧の上のヘッダーは、アイコンの字体が読めない環境で幅が変わるので、ここでは見ない
const modalOverflow = (page) => page.evaluate(() => {
  const m = document.querySelector("#action-root .hr-modal");
  if (!m) return 0;
  const r = m.getBoundingClientRect();
  const inner = [...m.querySelectorAll("*")].reduce((x, e) => Math.max(x, e.getBoundingClientRect().right), r.right);
  return Math.max(0, Math.round(Math.max(r.right, inner) - window.innerWidth), m.scrollWidth - m.clientWidth);
});
const modalOf = (page) => page.locator("#action-root .hr-modal");

console.log("\n=== 育成枠（PC）：入力を減らす → 内容を確認 → メールで送信 ===");
{
  const state = makeState("training");
  const { ctx, page, errs } = await open(state);
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  const modal = modalOf(page);
  check((await modal.locator("h2").innerText()).includes("育成参加決定通知を作成"), "見出し：育成参加決定通知を作成");
  const basic = await modal.locator("#of-fields > [data-field]").evaluateAll((ds) => ds.map((d) => d.dataset.field));
  check(basic.join(",") === "course,joinDate,pay,respondBy", `通常表示は4〜5項目（${basic.join(",")}）`);
  check(!(await modal.locator("#of-more").evaluate((d) => d.open)), "詳細設定は閉じている");
  const more = await modal.locator("#of-more-fields label").allTextContents();
  check(["育成期間", "担当講師", "中間評価日", "最終評価日", "実案件開始予定"].every((l) => more.some((x) => x.startsWith(l))), "講師・評価日・実案件開始予定は詳細設定");
  check(await modal.locator("#of-respondby").inputValue() === defaultRespondBy(), `回答期限は自動で送る日から3日後（${await modal.locator("#of-respondby").inputValue()}）`);

  await page.selectOption("#of-f-course-pick", "無限道場");
  await page.fill("#of-f-joinDate", "2026-11-01");
  await page.waitForTimeout(100);
  check(await modal.locator("#of-f-trainingPeriod").inputValue() === "3か月", "無限道場を選ぶと育成期間が3か月");
  const note = await modal.locator("#of-auto-note").innerText();
  check(note.includes("3か月") && note.includes("12/17") && note.includes("1/31"), `評価日も自動（${note}）`);
  check(await modal.locator("#of-f-finalReviewOn").inputValue() === "2027-01-31", "最終評価日が入る");

  const pays = await modal.locator('[data-field="pay"] .hr-opt button').allInnerTexts();
  check(pays.join("/") === "なし/時給/月額", `報酬は［なし］［時給］［月額］（${pays.join("/")}）`);
  await modal.locator('[data-field="pay"] .hr-opt button', { hasText: "なし" }).click();
  check(!(await modal.locator("#of-pay-amount").isVisible()), "［なし］なら金額欄を出さない");
  await modal.locator('[data-field="pay"] .hr-opt button', { hasText: "時給" }).click();
  check(await modal.locator("#of-pay-amount").isVisible() && (await modal.locator("#of-pay-unit").innerText()) === "時給", "［時給］で「時給 [ ] 円」");
  await page.fill("#of-f-wageAmount", "1500");
  check(await modal.locator("#of-draft").isVisible() && await modal.locator("#of-send").isVisible(), "［下書き保存］［内容を確認してメールで送信］");

  await modal.locator("#of-send").click();
  await page.waitForTimeout(900);
  const made = state.calls.find(([k]) => k === "create")?.[1];
  check(made?.offerTerms?.course === "無限道場" && made.offerTerms.trainingPeriod === "3か月" && made.offerTerms.paidDuringTraining === "あり",
    "コース・期間・報酬ありを送る");
  check(made?.wageType === "時給" && made.wageAmount === "1500" && made.joinDate === "2026-11-01", "時給 1500・開始日");
  const preview = await page.locator("#sm-preview").innerText();
  check(preview.includes("無限道場") && preview.includes("3か月") && preview.includes("時給 1,500円") && preview.includes("2026年11月1日"), "本人に届く重要条件を確認できる");
  check(await page.locator("#sm-subject").inputValue() === "【株式会社エイト】育成プログラムのご案内", "件名は区分ごと（直せる）");
  const mailBody = await page.locator("#sm-body").inputValue();
  check(mailBody.includes("テスト 候補者 様") && mailBody.includes(OFFER_URL_TAG) && mailBody.includes("同意して契約を完了する"), "本文（URLの場所つき・直せる）");
  check((await page.locator("#sm-to").innerText()).includes("candidate@example.test"), "宛先");
  await page.fill("#sm-subject", "【株式会社エイト】育成プログラムのご案内（テスト）");
  await page.locator("#sm-send").click();
  await page.waitForTimeout(900);
  const sent = state.calls.find(([k]) => k === "send")?.[1];
  check(sent?.subject === "【株式会社エイト】育成プログラムのご案内（テスト）" && sent.body.includes(OFFER_URL_TAG), "直した件名・本文で送る");
  check(/^[0-9a-f]{32}$/.test(sent?.requestKey || ""), "二重送信を防ぐ鍵を付ける");
  check(state.calls.filter(([k]) => k === "send").length === 1, "1回の操作で1回だけ送る");
  check((await page.locator("#sm-done").innerText()).includes("承諾待ち"), "送信しました（承諾待ち）");
  await page.locator("#action-root .hr-modal button", { hasText: "閉じる" }).click();
  await page.waitForTimeout(400);
  check((await page.locator("#hr-status").innerText()).includes("承諾待ち"), "状態：承諾待ち");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 業務委託（768px）：報酬はボタン・標準の支払条件・業務内容の標準文 ===");
{
  const state = makeState("contractor");
  const { ctx, page, errs } = await open(state, { width: 768 });
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  const modal = modalOf(page);
  const pays = await modal.locator('[data-field="pay"] .hr-opt button').allInnerTexts();
  check(pays.join("/") === "月額/時給/案件/成果報酬", `報酬は［月額］［時給］［案件］［成果報酬］（${pays.join("/")}）`);
  check(!(await modal.locator("#of-more").evaluate((d) => d.open)), "詳細設定は閉じている");
  check(await modal.locator("#of-f-paymentTerms").inputValue() === "月末締め翌月末払い", "支払条件：月末締め翌月末払い（既定）");
  check(await modal.locator("#of-f-renewal").inputValue() === "協議のうえ更新" && await modal.locator("#of-f-nda").inputValue() === "必要", "更新・NDA も既定");
  await modal.locator(".hr-tpl button", { hasText: "営業" }).click();
  check(await modal.locator("#of-f-duties").inputValue() === "法人への営業活動、商談対応、顧客フォローおよび関連業務", "業務内容：［営業］で標準文");
  await page.fill("#of-f-duties", "法人への営業活動（テスト）");
  check(await modal.locator("#of-f-duties").inputValue() === "法人への営業活動（テスト）", "標準文は直せる");
  await modal.locator('[data-field="pay"] .hr-opt button', { hasText: "案件" }).click();
  check((await modal.locator("#of-pay-unit").innerText()) === "案件", "［案件］で「案件 [ ] 円」");
  await modal.locator("#of-more summary").click();
  check(await modal.locator("#of-more").evaluate((d) => d.open) && (await modal.locator("#of-more summary").innerText()) === "詳細設定を閉じる", "［詳細設定を開く］で開く");
  const over = await modalOverflow(page);
  check(over <= 1, `768px：入力画面が横にはみ出さない（${over}px）`);
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== パート・アルバイト（390px）：時給だけ・1列・送信まで操作できる ===");
{
  const state = makeState("part_time", { wage_type: "月給", wage_amount: 300000 });
  const { ctx, page, errs } = await open(state, { width: 390 });
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  const modal = modalOf(page);
  check(await modal.locator("#of-f-wageType").count() === 0 && await modal.locator('[data-field="pay"] .hr-opt').count() === 0, "給与区分のプルダウン・ボタンが無い");
  check((await modal.locator('[data-field="pay"] label').innerText()).includes("時給"), "時給だけ入力する");
  check(await modal.locator("#of-f-wageAmount").inputValue() === "", "応募時の「月給 30万円」を時給に持ち込まない");
  const emp = await modal.locator('[data-field="employmentType"] .hr-opt button').allInnerTexts();
  check(emp.join("/") === "パート/アルバイト", "パート／アルバイトはボタン");
  const lefts = await modal.locator("#of-fields > [data-field]").evaluateAll((ds) => ds.map((d) => Math.round(d.getBoundingClientRect().left)));
  check(new Set(lefts).size === 1, "390px：1列");
  check(!(await modal.locator("#of-more").evaluate((d) => d.open)), "詳細設定は閉じている");
  await modal.locator('[data-field="employmentType"] .hr-opt button', { hasText: "アルバイト" }).click();
  await page.fill("#of-f-wageAmount", "1300");
  await page.fill("#of-f-workDays", "月・水");
  await page.fill("#of-f-workHours", "10:00〜15:00");
  await page.fill("#of-f-joinDate", "2026-11-01");
  const sendW = await modal.locator("#of-send").evaluate((b) => b.getBoundingClientRect().width);
  check(sendW > 300, `送信ボタンは横いっぱい（${Math.round(sendW)}px）`);
  const over = await modalOverflow(page);
  check(over <= 1, `390px：入力画面が横にはみ出さない（${over}px）`);
  await modal.locator("#of-send").click();
  await page.waitForTimeout(900);
  const made = state.calls.find(([k]) => k === "create")?.[1];
  check(made?.wageType === "時給" && made.wageAmount === "1300" && made.employmentType === "アルバイト", "時給 1300・アルバイト");
  check(await page.locator("#sm-send").isVisible(), "390px：確認画面から送れる");
  const over2 = await modalOverflow(page);
  check(over2 <= 1, `390px：確認画面も横にはみ出さない（${over2}px）`);
  await page.locator("#sm-send").click();
  await page.waitForTimeout(800);
  check(await page.locator("#sm-done").isVisible(), "390px：送信できた");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== メールで送れないとき：URLを発行して手で送る → 送付済みにする ===");
{
  const state = makeState("spot");
  state.mail = { configured: false, reason: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています" };
  const { ctx, page, errs } = await open(state);
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  await page.fill("#of-f-projectName", "テスト案件");
  await page.fill("#of-f-joinDate", "2026-11-05");
  await modalOf(page).locator("#of-send").click();
  await page.waitForTimeout(900);
  check(await page.locator("#sm-nomail").isVisible(), "送れない理由を出す");
  check(await page.locator("#sm-send").count() === 0 && await page.locator("#sm-manual").isVisible(), "［URLを発行して手で送る］");
  await page.locator("#sm-manual").click();
  await page.waitForTimeout(700);
  check(state.calls.some(([k]) => k === "confirm") && state.calls.some(([k]) => k === "issueLink"), "内容を確定して URL を発行");
  check((await page.locator("#so-url").inputValue()).includes("/hr/offer.html?token="), "本人専用URL");
  check((await page.locator("#so-mail").inputValue()).includes("/hr/offer.html?token=") && !(await page.locator("#so-mail").inputValue()).includes(OFFER_URL_TAG), "文面に URL が入る");
  await page.locator("#action-root .hr-modal button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(700);
  check(state.calls.some(([k]) => k === "markSent"), "送付済みにする");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 送れなかった（失敗）：送付済みにせず、URL と文面で手で送る ===");
{
  const state = makeState("training");
  state.sendResult = "failed";
  const { ctx, page, errs } = await open(state);
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  await page.selectOption("#of-f-course-pick", "無限道場");
  await page.fill("#of-f-joinDate", "2026-11-01");
  await modalOf(page).locator("#of-send").click();
  await page.waitForTimeout(900);
  await page.locator("#sm-send").click();
  await page.waitForTimeout(900);
  check((await page.locator("#sm-fallback").innerText()).includes("送れませんでした"), "失敗を伝える");
  check((await page.locator("#so-url").inputValue()).includes("token=fff"), "そのとき発行した URL を一度だけ出す");
  check(await page.locator("#action-root .hr-modal button", { hasText: "送付済みにする" }).isVisible(), "手で送ったら［送付済みにする］");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== HR：同意のあとは「契約完了」。次のアクションは区分ごと ===");
for (const [type, cta] of [["training", "育成開始手続きへ進む"], ["contractor", "稼働開始準備へ進む"], ["spot", "案件アサインへ進む"], ["part_time", "入社手続きへ進む"]]) {
  const state = makeState(type, { status: "accepted" });
  state.offers = [{ id: "o1", version: 1, offer_type: type, respond_by: "2026-10-13", sent_at: "2026-10-10T02:00:00Z",
    viewed_at: "2026-10-10T03:00:00Z", accepted_at: "2026-10-10T04:00:00Z", expires_at: "2026-10-13T14:59:59Z", offer_terms: {} }];
  const { ctx, page, errs } = await open(state);
  check((await page.locator("#hr-status").innerText()).includes("契約完了"), `[${type}] 状態：契約完了`);
  check(await page.locator(".hr-next button", { hasText: cta }).count() === 1, `[${type}] NEXT ACTION：${cta}`);
  const offerCard = await page.locator("#hr-detail-tab").innerText();
  check(offerCard.includes("契約完了") && offerCard.includes("同意："), `[${type}] オファーの版に「契約完了・同意：日時」`);
  check(!errs.length, `[${type}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 候補者：メールのURL → 内容確認 → 同意 → 契約完了 ===");
for (const width of [1100, 768, 390]) {
  const offer = {
    offer_type: "training", employment_type: "育成枠", join_date: "2026-11-01", wage_type: "時給", wage_amount: 1500,
    respond_by: "2026-10-13", offer_terms: { course: "無限道場", trainingPeriod: "3か月", paidDuringTraining: "あり",
      midReviewOn: "2026-12-17", finalReviewOn: "2027-01-31", note: "社内メモ：要フォロー" }, accepted_at: null, declined_at: null,
  };
  const pub = shapePublicOffer(offer, { name: "テスト 候補者" }, { name: "株式会社エイト" }, { display_name: "採用 花子", email: "hr@example.test" });
  const ctx = await br.newContext({ viewport: { width, height: 900 } });
  const posted = [];
  await ctx.route("**/api/**", (route) => {
    const req = route.request();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/hr\/offers\/public/.test(req.url())) {
      if (req.method() === "POST") { posted.push(JSON.parse(req.postData() || "{}")); return send({ ok: true, responseStatus: "accepted" }); }
      return send(pub);
    }
    return send({});
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/hr/offer.html?token=${"a".repeat(43)}`);
  await page.waitForTimeout(900);
  const key = await page.locator("#ho-key").innerText();
  check(["育成コース", "無限道場", "開始日", "2026年11月1日", "期間", "3か月", "報酬", "時給 1,500円", "回答期限"].every((x) => key.includes(x)),
    `[${width}px] 重要条件を先にコンパクトに（コース・開始日・期間・報酬・回答期限）`);
  check((await page.locator("#ho-type").innerText()) === "育成枠", `[${width}px] 区分：育成枠`);
  const text = await page.locator("#box").innerText();
  check(!/社内メモ|ランク|社長/.test(text), `[${width}px] 社内用語・社内用の項目を出さない`);
  check((await page.locator("#ho-agree-box").innerText()).includes("上記の内容を確認し、同意します"), `[${width}px] 「□ 上記の内容を確認し、同意します」`);
  const btn = page.locator("#ho-accept");
  check((await btn.innerText()) === "同意して契約を完了する" && await btn.isDisabled(), `[${width}px] チェックするまで［同意して契約を完了する］は押せない`);
  if (width === 390) {
    const bw = await btn.evaluate((b) => b.getBoundingClientRect().width);
    check(bw > 300, `[390px] 同意ボタンは横いっぱい（${Math.round(bw)}px）`);
    const over = await overflow(page);
    check(over <= 1, `[390px] 横にはみ出さない（${over}px）`);
  }
  await page.locator("#ho-agree").check();
  check(!(await btn.isDisabled()), `[${width}px] チェックすると押せる`);
  await btn.click();
  await page.waitForTimeout(500);
  check(posted.length === 1 && posted[0].action === "accept" && posted[0].agreed === true, `[${width}px] 同意（agreed: true）を送る`);
  const done = await page.locator("#ho-complete").innerText();
  check(done.includes("契約手続きが完了しました。") && done.includes("ご同意ありがとうございます。") && done.includes("株式会社エイトからご案内します"),
    `[${width}px] 完了画面`);
  check(!errs.length, `[${width}px] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
