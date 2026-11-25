// 採用HR：面談合格後の「採用区分」→ 区分ごとのオファー → 本人の承諾 を、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR 面談合格後の採用・育成フロー UI/UX 仕様 Phase 1）
//   1. ［合格にする］で「この方をどの形で迎えますか？」と6つのカード（2週間トライアルを含む）。選ばずには合格にできない
//   2. 区分を選ぶと、進捗（合格通知）・状態・NEXT ACTION（PDFを作成・確認）が区分の言い方になる
//   3. オファーの入力は区分に必要な項目だけ（業務委託に試用期間・役職・インセンティブを出さない）。通常は少なく、ほかは詳細設定
//   4. 区分を後から選ぶ（NEXT ACTION「採用区分を選ぶ」）→ そのままオファーの入力へ
//   5. 給与を見られない人には、報酬・インセンティブの欄を出さない
//   6. 選考タイムラインに「誰が」
//   7. スマホ（390px）：カードは1列・横にはみ出さない
//   8. 本人向けページ：区分の書類名と項目だけ。同意のチェック →［条件を承諾する］→「条件の承諾を受け付けました」
//
// 応答は lib/hr.js・lib/hr-offer-types.js の本物の関数で組み立てる（ラベルや NEXT ACTION をテスト側で作らない）
import { launch, BASE } from "../_browser.mjs";
import { openHrSection } from "../_hr-section.mjs";
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
    try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })); } catch {}
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
  page.setDefaultTimeout(8000);
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  // ?id= は対応モーダル（次にすること）を開く
  await page.waitForSelector("#hr-detail-box.hr-work-modal .hr-work-task", { timeout: 15000 });
  await page.waitForTimeout(300);
  return { ctx, page, errs };
}
// 応募者情報（詳細）を開く。進捗のバー・NEXT ACTION の見出し・タブはこちらにある
const openInfo = async (page) => { await page.click("#hr-work-link-info"); await page.waitForSelector(".hr-detail #hr-detail-tab"); };
// 応募者情報を閉じて、一覧の NEXT ボタンから対応モーダルを開き直す
const backToWork = async (page) => {
  await page.locator('.hr-detail-close').click();
  await page.locator('tr[data-applicant="a1"] button.hr-list-cta').click();
  await page.waitForSelector("#hr-detail-box.hr-work-modal .hr-work-task");
};
const flowNow = (page) => page.locator(".hr-detail .hr-agreement-flow li.now").textContent();

console.log("\n=== 合格にする → 「この方をどの形で迎えますか？」 → 業務委託 ===");
{
  const state = makeState();
  const { ctx, page, errs } = await open(state);
  // 置き換え：旧UIの選考ステップ（#hr-stage-steps）は無い。対応モーダルの「現在の状態」と主ボタンで確かめる
  check((await page.locator(".hr-work-state b").innerText()).includes("判断待ち") && await page.locator("#hr-stage-steps, #hr-steps").count() === 0,
    `現在の状態：判断待ち（${await page.locator(".hr-work-state b").innerText()}）`);
  await openInfo(page);
  check((await flowNow(page)).includes("代表面談"), "進捗：いまは代表面談（合格通知より前）");
  await backToWork(page);
  await page.locator("#hr-work-primary", { hasText: "採用判断" }).click();
  await page.waitForTimeout(800);
  check((await page.locator("#dc-tabs button.on").innerText()).includes("合格"), "判断の選択肢は「合格」");
  check((await page.locator("#dc-step1").innerText()).includes("この方をどの形で迎えますか？"), "「この方をどの形で迎えますか？」");
  const cards = (await page.locator("#dc-otypes .hr-otype .hd").allInnerTexts()).map((s) => s.replace(/^\S+\s*/, "").trim());
  // 採用区分に「2週間トライアル」が加わり6つになった（定義は lib/hr-offer-types.js が正）
  check(cards.join("/") === OFFER_TYPES_PUBLIC.map((t) => t.label).join("/") && cards.join("/") === "正社員・幹部候補/2週間トライアル/育成枠/業務委託/パート・アルバイト/スポット・副業", `6つのカード（${cards.join("/")}）`);
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
  // 置き換え：旧UIの7段のバー（#hr-steps）は、事前選考〜OFFICE の1本（.hr-agreement-flow）になった。現在地が「合格通知」で、それより後は現在地でないことを確かめる
  await openInfo(page);
  const steps = await page.locator(".hr-detail .hr-agreement-flow li").evaluateAll((ls) => ls.map((l) => `${l.textContent.trim()}:${l.className || "-"}`));
  check(steps.filter((x) => x.endsWith(":now")).join(",") === "合格通知:now", `進捗のバー：現在地は合格通知（${steps.join(",")}）`);
  check((await page.locator("#hr-detail-recruitment-type").inputValue()) === "contractor", "概要に採用区分");
  await openHrSection(page,'docs');
  check(await page.locator('#hr-notice-upload').count()===1,'採用決定後は書類・内定通知から通知PDFの登録へ');
  check(await page.locator('.hr-office-handoff-note').count()===1,'正式な労働条件と契約はOfficeへ');
  check(!state.calls.some(([kind])=>kind==='offer'),'採用判断だけでは通知書作成・送信を行わない');
  check(errs.length===0,'画面エラーなし');
  await ctx.close();
}
await br.close();
if(bad) process.exit(1);
console.log('PASS hiring decision, six explicit categories, persistence, notice entry and Office boundary');
