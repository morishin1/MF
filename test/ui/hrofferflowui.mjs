// 採用HR：面談合格後の「採用区分」→ 区分ごとのオファー → 本人の承諾 を、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR 面談合格後の採用・育成フロー UI/UX 仕様 Phase 1）
//   1. ［合格にする］で「この方をどの形で迎えますか？」と5つのカード。選ばずには合格にできない
//   2. 区分を選ぶと、ステップバー（応募 → 面談 → 合格 → オファー → …）・状態・NEXT ACTION が区分の言い方になる
//   3. オファーの入力は区分に必要な項目だけ（業務委託に試用期間・役職・インセンティブを出さない）
//   4. 区分を後から選ぶ（NEXT ACTION「採用区分を選ぶ」）→ そのままオファーの入力へ
//   5. 給与を見られない人には、報酬・インセンティブの欄を出さない
//   6. 選考タイムラインに「誰が」
//   7. スマホ（390px）：カードは1列・横にはみ出さない
//   8. 本人向けページ：区分の書類名と項目だけ。［内容を確認して承諾する］→「次は契約手続きです」
//
// 応答は lib/hr.js・lib/hr-offer-types.js の本物の関数で組み立てる（ラベルや NEXT ACTION をテスト側で作らない）
import { launch, BASE } from "../_browser.mjs";
import { shapeApplicant, shapePublicOffer, shapeOffer } from "../../lib/hr.js";
import { OFFER_TYPES_PUBLIC } from "../../lib/hr-offer-types.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER_ME = { email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "e-owner", display_name: "社長 一郎" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };
const RECRUITER_ME = { email: "hr@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "e-hr", display_name: "採用 花子" }, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

function makeState(over = {}) {
  return {
    row: {
      id: "a1", tenant_id: "t1", name: "山田 太郎", email: "yamada@example.test", job_title: "エンジニア", source: "Wantedly",
      stage: "ceo_interview", status: "ceo_decision_pending", rank: "A", decision: null, lead_category: "recruitment",
      employment_type: "正社員", probation_months: 3, wage_type: "月給", wage_amount: 300000, work_location: "東京",
      offer_type: null, ...over,
    },
    offers: [],
    timeline: [{ id: "t1", event_key: "interview_done", label: "社長面談実施", occurred_at: "2026-10-08T05:00:00Z", created_by: "u-owner" }],
    calls: [],
    salaryVisible: true,
  };
}

async function open(state, { me = OWNER_ME, width = 1300 } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const errs = [];
  const shaped = () => {
    const a = { ...shapeApplicant(state.row), recruiterName: "採用 花子", contact: { state: "none" } };
    if (!state.salaryVisible) { delete a.wageAmount; delete a.wageType; }
    return a;
  };
  await ctx.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/hr\/applicants\/message/.test(url)) return send({});
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = body(); state.calls.push(["applicant", b]);
        if (b.decision) state.row.decision = b.decision;
        if (b.stage) state.row.stage = b.stage;
        if (b.status) state.row.status = b.status;
        if (b.offerType !== undefined) {
          state.row.offer_type = b.offerType;
          state.timeline.push({ id: `t${state.timeline.length + 1}`, event_key: "offer_type_selected",
            label: `採用区分：${OFFER_TYPES_PUBLIC.find((t) => t.key === b.offerType).label}を選択`,
            occurred_at: "2026-10-09T01:00:00Z", created_by: "u-owner" });
        }
        return send({ applicant: shaped() });
      }
      return send({
        applicant: shaped(), interviews: [], interviewers: [], offers: state.offers.map((o) => shapeOffer(o)),
        timeline: state.timeline.map((t) => ({ id: t.id, eventKey: t.event_key, label: t.label, detail: null, occurredAt: t.occurred_at,
          actorName: t.created_by === "u-owner" ? "社長 一郎" : null })),
        evalItems: [], evalScale: [], ranks: [], rankLabel: {}, interviewKinds: [], statusOptions: [],
        offerTypes: OFFER_TYPES_PUBLIC, offerTypeReady: true, salaryVisible: state.salaryVisible,
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [shaped()], employees: [] });
    if (/\/api\/hr\/offers\b/.test(url) && req.method() === "POST") {
      const b = body(); state.calls.push(["offer", b]);
      return send({ offer: { id: "o1" }, status: "offer_review_pending" });
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

console.log("\n=== 合格にする → 「この方をどの形で迎えますか？」 → 業務委託 ===");
{
  const state = makeState();
  const { ctx, page, errs } = await open(state);
  check((await page.locator("#hr-steps li.now").innerText()).includes("面談"), "ステップバー：いまは面談");
  await page.locator(".hr-next button", { hasText: "採用判断" }).click();
  await page.waitForTimeout(800);
  check((await page.locator("#dc-tabs button.on").innerText()).includes("合格"), "判断の選択肢は「合格」");
  check((await page.locator("#dc-step1").innerText()).includes("この方をどの形で迎えますか？"), "「この方をどの形で迎えますか？」");
  const cards = (await page.locator("#dc-otypes .hr-otype .hd").allInnerTexts()).map((s) => s.replace(/^\S+\s*/, "").trim());
  check(cards.join("/") === "正社員・幹部候補/育成枠/業務委託/パート・アルバイト/スポット・副業", `5つのカード（${cards.join("/")}）`);
  await page.locator("#action-root .hr-modal button", { hasText: "合格にする" }).click();
  await page.waitForTimeout(300);
  check((await page.locator("#dc-msg").innerText()).includes("採用区分"), "区分を選ばずには合格にできない");
  check(!state.calls.some(([k]) => k === "applicant"), "選んでいないうちは保存しない");
  await page.locator('#dc-otypes .hr-otype[data-otype="contractor"]').click();
  check(await page.locator('#dc-otypes .hr-otype[data-otype="contractor"].on').count() === 1, "選んだカードだけが選択中");
  await page.locator("#action-root .hr-modal button", { hasText: "合格にする" }).click();
  await page.waitForTimeout(1000);
  const saved = state.calls.find(([k, b]) => k === "applicant" && b.decision)?.[1];
  check(saved?.decision === "hired" && saved.offerType === "contractor" && saved.status === "offer_draft_pending", "合格＋業務委託が保存される");

  console.log("\n— 区分を選んだあと：ステップバー・状態・NEXT ACTION —");
  await page.evaluate(() => typeof closeDecisionModal === "function" && closeDecisionModal());
  await page.waitForTimeout(300);
  const steps = await page.locator("#hr-steps li").evaluateAll((ls) => ls.map((l) => `${l.querySelector(".l").textContent}:${l.className}`));
  check(steps.join(",") === "応募:done,面談:done,合格:done,オファー:now,承諾:todo,契約:todo,入社/稼働:todo", `ステップバー（${steps.join(",")}）`);
  check((await page.locator("#hr-otype").innerText()).includes("業務委託"), "概要に採用区分");
  check((await page.locator("#hr-status").innerText()).includes("業務委託オファーの作成待ち"), "状態：業務委託オファーの作成待ち");
  check(await page.locator(".hr-next button", { hasText: "オファーを作成" }).count() === 1, "NEXT ACTION：オファーを作成");

  console.log("\n— 業務委託オファー：必要な項目だけ —");
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  const modal = page.locator("#action-root .hr-modal");
  check((await modal.locator("h2").innerText()).includes("業務委託オファーを作成"), "見出し：業務委託オファーを作成");
  const labels = (await modal.locator("#of-fields label").allInnerTexts()).map((s) => s.replace(/\s*\*$/, "").trim());
  for (const l of ["委託業務", "報酬形態", "報酬（円）", "稼働時間", "稼働曜日", "契約開始日", "契約終了日", "成果物", "支払条件", "NDA"]) {
    check(labels.some((x) => x.startsWith(l)), `項目：${l}`);
  }
  for (const l of ["試用期間", "役職", "インセンティブ", "給与区分"]) check(!labels.some((x) => x.startsWith(l)), `正社員向けの「${l}」は出さない`);
  const wageOpts = await modal.locator("#of-f-wageType option").allInnerTexts();
  check(wageOpts.join("/") === "（選択）/月額固定/時間単価/案件単価/成果報酬", `報酬形態の選択肢（${wageOpts.join("/")}）`);
  check(await modal.locator("#of-f-wageType").inputValue() === "", "応募者の「月給」は持ち込まない");
  check((await modal.innerText()).includes("業務委託契約書") && (await modal.innerText()).includes("NDA"), "必要書類（業務委託契約書・NDA）");
  await page.fill("#of-f-duties", "AI/DX支援業務");
  await page.fill("#of-f-joinDate", "2026-11-01");
  await page.selectOption("#of-f-wageType", "月額固定");
  await page.fill("#of-f-wageAmount", "400000");
  await page.selectOption("#of-f-nda", "必要");
  await page.fill("#of-respondby", "2026-10-31");
  await modal.locator("button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(600);
  const made = state.calls.find(([k]) => k === "offer")?.[1];
  check(made?.offerTerms?.duties === "AI/DX支援業務" && made.offerTerms.nda === "必要", "区分の項目は offerTerms で送る");
  check(made?.joinDate === "2026-11-01" && made.wageType === "月額固定" && made.wageAmount === "400000", "契約開始日・報酬は既存の項目で送る");
  check(made && !("probationMonths" in made) && !("position" in (made.offerTerms || {})), "区分に無い項目は送らない");

  console.log("\n— 選考タイムラインに「誰が」 —");
  await page.locator('.hr-tabs button[data-tab="history"]').click();
  await page.waitForTimeout(300);
  const hist = await page.locator("#hr-detail-tab").innerText();
  check(hist.includes("採用区分：業務委託を選択") && hist.includes("社長 一郎"), "「採用区分：業務委託を選択・社長 一郎」");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

console.log("\n=== あとから採用区分を選ぶ（正社員・幹部候補）→ そのまま入力へ ===");
{
  const state = makeState({ stage: "offer", status: "offer_draft_pending", decision: "hired" });
  const { ctx, page, errs } = await open(state);
  check((await page.locator("#hr-steps li.now").innerText()).includes("合格"), "区分を選ぶ前は「合格」が現在地");
  check(await page.locator(".hr-next button", { hasText: "採用区分を選ぶ" }).count() === 1, "NEXT ACTION：採用区分を選ぶ");
  await page.locator(".hr-next button", { hasText: "採用区分を選ぶ" }).click();
  await page.waitForTimeout(300);
  check((await page.locator("#action-root .hr-modal h2").innerText()).includes("この方をどの形で迎えますか？"), "カードのモーダル");
  await page.locator('#ot-cards .hr-otype[data-otype="executive_employee"]').click();
  await page.locator("#ot-save").click();
  await page.waitForTimeout(1200);
  check(state.calls.some(([k, b]) => k === "applicant" && b.offerType === "executive_employee"), "区分が保存される");
  const modal = page.locator("#action-root .hr-modal");
  check((await modal.locator("h2").innerText()).includes("内定通知を作成"), "続けて「内定通知を作成」");
  const labels = (await modal.locator("#of-fields label").allInnerTexts()).join("/");
  for (const l of ["職種", "役職", "給与区分", "試用期間", "勤務時間", "入社予定日", "業務内容", "インセンティブ", "その他条件"]) {
    check(labels.includes(l), `正社員の項目：${l}`);
  }
  check(await modal.locator("#of-f-wageType").inputValue() === "月給", "応募者の「月給」は正社員ではそのまま使う");
  check(await modal.locator("#of-f-probationMonths").inputValue() === "3", "試用期間も応募者の値");
  check(await modal.locator("button", { hasText: "区分を変える" }).count() === 1, "送る前なら区分を変えられる");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 給与を見られない人（採用担当） ===");
{
  const state = makeState({ stage: "offer", status: "offer_draft_pending", decision: "hired", offer_type: "executive_employee" });
  state.salaryVisible = false;
  const { ctx, page, errs } = await open(state, { me: RECRUITER_ME });
  await page.locator(".hr-next button", { hasText: "オファーを作成" }).click();
  await page.waitForTimeout(400);
  const modal = page.locator("#action-root .hr-modal");
  const labels = (await modal.locator("#of-fields label").allInnerTexts()).join("/");
  check(!labels.includes("給与") && !labels.includes("インセンティブ"), "給与・インセンティブの欄を出さない");
  check((await modal.innerText()).includes("権限のある方が入力・確認します"), "誰が入れるかを案内");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

console.log("\n=== スマホ（390px）：カードは1列・横にはみ出さない ===");
{
  const state = makeState({ stage: "offer", status: "offer_draft_pending", decision: "hired" });
  const { ctx, page, errs } = await open(state, { width: 390 });
  check(await page.locator("#hr-steps").isVisible(), "ステップバーが見える");
  await page.locator(".hr-next button", { hasText: "採用区分を選ぶ" }).click();
  await page.waitForTimeout(300);
  const boxes = await page.locator("#ot-cards .hr-otype").evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()));
  check(new Set(boxes.map((b) => Math.round(b.left))).size === 1, "カードは縦1列");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `横にはみ出さない（${over}px）`);
  await page.locator('#ot-cards .hr-otype[data-otype="spot"]').click();
  check(await page.locator('#ot-cards .hr-otype[data-otype="spot"].on').count() === 1, "スマホでも選べる");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 本人向けページ（業務委託オファー） ===");
for (const width of [1100, 390]) {
  const offer = {
    offer_type: "contractor", employment_type: "業務委託", join_date: "2026-11-01", wage_type: "月額固定", wage_amount: 400000,
    work_location: "リモート", respond_by: "2026-10-31", message_to_candidate: "よろしくお願いします。",
    offer_terms: { duties: "AI/DX支援業務", workHours: "週20時間程度", nda: "必要" }, accepted_at: null, declined_at: null,
  };
  const pub = shapePublicOffer(offer, { name: "山田 太郎" }, { name: "株式会社エイト" }, { display_name: "採用 花子", email: "hr@example.test" });
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
  const text = await page.locator("#box").innerText();
  check(text.includes("株式会社エイトからのオファー"), `[${width}px] 見出し：株式会社エイトからのオファー`);
  check(text.includes("業務委託オファー") && text.includes("AI/DX支援業務") && text.includes("月額固定 400,000円"), `[${width}px] 書類名と条件`);
  check(!/試用期間|社長|ランク|評価/.test(text), `[${width}px] 社内用語・社内の項目を出さない`);
  const btn = page.locator("button", { hasText: "内容を確認して承諾する" });
  check(await btn.count() === 1, `[${width}px] ［内容を確認して承諾する］`);
  if (width === 390) {
    const bw = await btn.evaluate((b) => b.getBoundingClientRect().width);
    check(bw > 300, `[390px] 承諾ボタンは横いっぱい（${Math.round(bw)}px）`);
  }
  page.once("dialog", (d) => d.accept());
  await btn.click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "accept"), `[${width}px] 承諾が送られる`);
  check((await page.locator("#ho-actions").innerText()).includes("次は契約手続きです"), `[${width}px] 承諾後「次は契約手続きです」`);
  check(!errs.length, `[${width}px] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
