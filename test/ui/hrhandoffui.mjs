// 入退社（Office）：「HRから引き渡し」— HR が承諾内容を確認して引き渡した人だけが載る入社準備のキュー（HR → Office 切替ルール）。
//
// ■ 何を守るテストか
//   1. 「HRから引き渡し」には、引き渡された人（API が handoff_at の入った人だけを返す）が載る。承諾しただけの人は載らない。
//      氏名・区分・職種・条件承諾日・入社予定日・労働条件通知書の確認・引き渡した日時と人、
//      「HRで正式契約まで完了」の印（正式契約：署名済み／不要）と、Office の入社の流れ（4つ）と NEXT ACTION：
//      HRで正式契約まで完了 → 入社書類 → アカウント・端末 → オリエンテーション → 入社完了
//   2. Office に LegalSign の操作は無い（URL 登録・案内・正式契約済みは HR で終えている）。［社員登録へ］はいつでも出る
//   3. 採用時書類（HRから引き渡し・閲覧専用）：履歴書・職務経歴書・スキルシート・内定通知書・労働条件通知書・承諾済みPDF は見るだけ
//      （再アップロード・差し替え・削除の入口を出さない）。見られない（引き渡し前など）ときは理由を出す
//   4. 入社予定の一覧：「HRから引き渡し」の印と、［入社書類］などの段階を先頭に添えた NEXT ACTION。
//      詳細に「HRから引き渡し」タブ（引き渡された情報 / 採用時書類 / 入社・契約書類）。HR を通らない人には出さない
//   5. 390px でも横にはみ出さない
//
// 応答は lib/hire-flow.js・lib/hire-handoff.js・lib/onboard-flow.js の本物の関数で組み立てる（文言をテスト側で作らない）
import { launch, BASE } from "../_browser.mjs";
import { hireFlowOf } from "../../lib/hire-flow.js";
import { handoffFactsOf } from "../../lib/hire-handoff.js";
import { onboardFlow } from "../../lib/onboard-flow.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "hr@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, access: { officeApp: true, officeHr: true },
  gw: { employee: { id: "emp-h1", display_name: "人事 次郎" }, roles: ["hr"], isAdmin: false, tenantId: "t1", stage: null } };

const NULLS = { notice_title: "労働条件通知書", notice_pdf_path: "t1/n.pdf", accepted_pdf_path: "t1/a.pdf" };
// 引き渡した版（DB の行）と応募者。サーバ（api/hr/index.js handoffQueue）と同じ作り方で応答を組む
const state = () => ({
  apps: [
    { id: "a1", name: "高木 沙綾", status: "accepted", employee_id: null, advance_claimed_at: null, job_title: "エンジニア", employment_type: "正社員" },
    { id: "a2", name: "佐藤 一", status: "accepted", employee_id: null, advance_claimed_at: null, job_title: "デザイナー", employment_type: "業務委託" },
    { id: "a3", name: "鈴木 花", status: "accepted", employee_id: null, advance_claimed_at: new Date().toISOString(), job_title: null, employment_type: "業務委託" },
  ],
  offers: [
    { id: "o1", applicant_id: "a1", version: 1, offer_type: "executive_employee", join_date: "2026-11-01", accepted_at: "2026-10-10T01:00:00Z", viewed_at: "2026-10-10T00:30:00Z",
      formal_contract_required: true, formal_signed_at: "2026-10-11T05:00:00Z", handoff_at: "2026-10-12T01:32:00Z", ...NULLS },
    { id: "o2", applicant_id: "a2", version: 2, offer_type: "contractor", join_date: "2026-11-15", accepted_at: "2026-10-11T01:00:00Z", viewed_at: "2026-10-11T00:30:00Z",
      formal_contract_required: false, formal_signed_at: null, handoff_at: "2026-10-12T02:00:00Z", ...NULLS },
    { id: "o3", applicant_id: "a3", version: 1, offer_type: "spot", join_date: null, accepted_at: "2026-10-12T01:00:00Z",
      formal_contract_required: false, formal_signed_at: null, handoff_at: "2026-10-12T03:00:00Z", ...NULLS },
  ],
  calls: [], claimed: [], docs403: false,
});

const queueOf = (st) => ({
  ready: true,
  rows: st.offers.map((o) => {
    const a = st.apps.find((x) => x.id === o.applicant_id);
    const f = handoffFactsOf(o, a, { byName: "人事 花子" });
    const flow = hireFlowOf({ handoff: f });
    return { ...f, claimed: Boolean(a.advance_claimed_at), hire: { hr: flow.hr, steps: flow.steps, next: flow.next } };
  }),
});

const docsOf = () => ({
  applicant: { id: "a1", name: "高木 沙綾" }, readOnly: true, salaryVisible: true, offerId: "o1",
  conditionDocs: { offerId: "o1", version: 1, offerType: "executive_employee", docsReady: true, progress: "accepted", rows: [
    { key: "offer", label: "内定通知書", state: "accepted", stateLabel: "承諾済み", at: "2026-10-10T01:00:00Z", file: null, note: null, applicable: true },
    { key: "notice", label: "労働条件通知書", state: "accepted", stateLabel: "承諾済み", at: "2026-10-10T01:00:00Z", file: "notice", note: null, applicable: true },
    { key: "accepted", label: "承諾済みPDF", state: "accepted", stateLabel: "承諾済み", at: "2026-10-10T01:00:00Z", file: "accepted", note: null, applicable: true },
  ] },
  documents: [
    { docType: "resume", label: "履歴書", icon: "description", latest: { id: "d1", docType: "resume", filename: "高木_履歴書.pdf", uploadedAt: "2026-10-01T01:00:00Z" }, history: [] },
    { docType: "work_history", label: "職務経歴書", icon: "work", latest: { id: "d2", docType: "work_history", filename: "高木_職務経歴書.pdf", uploadedAt: "2026-10-01T02:00:00Z" }, history: [] },
    { docType: "skill_sheet", label: "スキルシート", icon: "assignment_ind", latest: null, history: [] },
    { docType: "other", label: "その他", icon: "attach_file", latest: null, history: [] },
  ],
  types: [], limits: {},
});

async function open(st, { width = 1300, list = null } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1400 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" })));
  const errs = [];
  await ctx.route("**/api/**", (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const u = new URL(url);
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/applicants\/advance/.test(url) && m === "POST") { st.claimed.push(body()); return send({ applicantId: body().applicantId }); }
    if (/\/api\/hr\/documents/.test(url)) {
      st.calls.push(["documents", m, u.search]);
      if (m !== "GET") return send({ error: "read_only" }, 403);
      if (st.docs403) return send({ error: "not_handed_off", hint: "Office へ引き渡された方の書類だけ、Office から見られます（採用HRで引き渡しを済ませてください）" }, 403);
      if (u.searchParams.get("id")) return send({ url: "https://storage.test/doc.pdf?token=t", filename: "x.pdf", docType: "resume" });
      return send(docsOf());
    }
    if (/\/api\/hr\/offers\b/.test(url)) {
      st.calls.push(["offers", m, u.search]);
      if (m === "GET" && u.searchParams.get("file")) {
        return route.fulfill({ status: 200, contentType: "application/pdf", body: Buffer.from("%PDF-1.7\n"),
          headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("労働条件通知書_第1版.pdf")}` } });
      }
      return send({ error: "forbidden" }, 403);
    }
    if (/\/api\/hr(\?|$)/.test(url)) {
      if (u.searchParams.get("id") && st.detail) return send(st.detail(u.searchParams.get("id")));
      return send(list ? { ...list, handoffs: queueOf(st) } : {
        tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
        onboarding: [], offboarding: [], done: [], kpi: null, people: [], roles: [], today: "2026-10-14", handoffs: queueOf(st) });
    }
    if (/\/api\/hr\/retention/.test(url)) return send({ today: "2026-10-14", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/onboarding\/orientation/.test(url)) return send({ items: [], kinds: [], done: true });
    if (/\/api\/onboarding\/notice/.test(url)) return send({ versions: [], employee: { id: "e-new" } });
    return send({});
  });
  await ctx.route("https://storage.test/**", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.7\n" }));
  // 社員登録の画面（admin-onboard.html）は別のテストで通す。ここでは遷移先の URL だけ確かめる
  await ctx.route("**/admin-onboard.html*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>onboard</body></html>" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e.stack || e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/admin-hr.html`);
  await page.waitForTimeout(1300);
  return { ctx, page, errs };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const width of [1300, 390]) {
  console.log(`\n=== HRから引き渡し（${width}px）：引き渡された人だけ・HRで正式契約まで完了・入社の流れ（4つ）・NEXT ACTION ===`);
  const st = state();
  const { ctx, page, errs } = await open(st, { width });
  const card = await page.locator("#hr-handoff-card").innerText();
  check(card.includes("HRから引き渡し") && card.includes("3名"), `[${width}] 「HRから引き渡し 3名」`);
  check(card.includes("HR で条件の承諾・正式契約まで終え") && card.includes("引き渡された人"), `[${width}] 説明：HR で承諾・正式契約まで終えて引き渡された人`);
  check(!card.includes("自動でここに載ります") && !card.includes("登録の操作は要りません"), `[${width}] 承諾しただけで自動で載る、とは書かない`);
  const r1 = page.locator('[data-handoff="a1"]');
  const t1 = await r1.innerText();
  check(t1.includes("高木 沙綾") && t1.includes("正社員・幹部候補") && t1.includes("エンジニア"), `[${width}] 氏名・区分・職種`);
  check((await r1.locator('[data-fact="accepted"]').innerText()).includes("✓ 条件承諾") && (await r1.locator('[data-fact="accepted"]').innerText()).includes("2026/10/10"), `[${width}] 条件承諾日`);
  check((await r1.locator('[data-fact="join"]').innerText()).includes("2026/11/01"), `[${width}] 入社予定日`);
  check((await r1.locator('[data-fact="notice"]').innerText()).includes("労働条件通知書") && (await r1.locator('[data-fact="notice"]').innerText()).includes("確認済み"), `[${width}] 労働条件通知書：確認済み`);
  const hand = await r1.locator('[data-fact="handoff"]').innerText();
  check(hand.includes("引き渡し：2026/10/12 10:32") && hand.includes("人事 花子"), `[${width}] 引き渡した日時（日本時間）と人`);
  check((await r1.locator('[data-role="hr-done"]').innerText()).includes("HRで正式契約まで完了") && (await r1.locator('[data-role="hr-done"]').innerText()).includes("正式契約：署名済み"), `[${width}] 「HRで正式契約まで完了（正式契約：署名済み）」`);
  const r2 = page.locator('[data-handoff="a2"]');
  check((await r2.locator('[data-role="hr-done"]').innerText()).includes("正式契約：不要"), `[${width}] 正式契約が不要だった人：「HRで正式契約まで完了（正式契約：不要）」`);
  const steps = (await r1.locator(".hx-steps li").allInnerTexts()).map((x) => x.replace(/\s+/g, ""));
  check(steps.join("|") === "1.入社書類|2.アカウント・端末|3.オリエンテーション|4.入社完了", `[${width}] Office の入社の流れは4つ（${steps.join("|")}）`);
  check(await r1.locator('.hx-steps li[data-step="docs"][data-state="current"]').count() === 1, `[${width}] いまは「入社書類」`);
  check(await r1.locator('.hx-steps li[data-step="formal"]').count() === 0, `[${width}] 「正式契約」は Office のステップではない（HR で完了済み）`);
  const nx = await r1.locator('[data-role="next-action"]').innerText();
  check(nx.includes("NEXT ACTION") && nx.includes("入社書類を集める") && nx.includes("担当：人事・労務") && nx.includes("社員登録をして、入社書類の依頼を始めます"), `[${width}] NEXT ACTION：入社書類を集める（担当：人事・労務）`);
  check(!card.includes("LegalSign") && await page.locator('#hr-handoff-card input[type="url"], #hr-handoff-card [data-act="formal"]').count() === 0, `[${width}] Office に LegalSign の操作は無い`);
  check(await r1.locator('button[data-act="register"]', { hasText: "社員登録へ" }).count() === 1, `[${width}] ［社員登録へ］（正式契約は HR で完了済みなので、いつでも出る）`);
  check(await r2.locator('button[data-act="register"]', { hasText: "社員登録へ" }).count() === 1, `[${width}] 正式契約が不要だった人も［社員登録へ］`);
  const r3 = page.locator('[data-handoff="a3"]');
  check(await r3.locator('button[data-act="register"]', { hasText: "社員登録の続きを開く" }).count() === 1, `[${width}] 入力中の人は［社員登録の続きを開く］`);
  const over = await overflow(page);
  check(over <= 1, `[${width}] 横にはみ出さない（${over}px）`);
  await r2.locator('button[data-act="register"]').click();
  await page.waitForTimeout(800);
  check(st.claimed[0]?.applicantId === "a2" && page.url().includes("admin-onboard.html?applicantId=a2"), `[${width}] ［社員登録へ］で確保してから社員登録の画面へ`);
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 引き渡された人がいなければ、「HRから引き渡し」は出さない（承諾しただけの人は API が返さない） ===");
{
  const st = state(); st.offers = []; st.apps = [];
  const { ctx, page, errs } = await open(st);
  check(await page.locator("#hr-handoff-card").count() === 0, "引き渡された人がいない：カードを出さない");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

for (const width of [1300, 390]) {
  console.log(`\n=== 採用時書類（HRから引き渡し・閲覧専用）（${width}px）：見るだけ。再アップロードの入口は無い ===`);
  const st = state();
  const { ctx, page, errs } = await open(st, { width });
  const r1 = page.locator('[data-handoff="a1"]');
  await r1.locator('button[data-act="docs"]').click();
  await page.waitForTimeout(700);
  const box = page.locator("#hd-a1");
  const text = await box.innerText();
  check(text.includes("採用時書類（HRから引き渡し・閲覧専用）"), `[${width}] 見出し`);
  for (const w of ["履歴書", "職務経歴書", "スキルシート", "その他", "内定通知書", "労働条件通知書", "承諾済みPDF"]) check(text.includes(w), `[${width}] ${w}`);
  check((await box.locator('[data-doc="resume"]').innerText()).includes("登録済み") && (await box.locator('[data-doc="skill_sheet"]').innerText()).includes("未登録"), `[${width}] 登録済み／未登録の状態`);
  check(await box.locator('[data-cond="notice"] button').count() === 1 && await box.locator('[data-cond="accepted"] button').count() === 1 && await box.locator('[data-cond="offer"] button').count() === 0,
    `[${width}] 条件通知書・承諾済みPDFは［開く］、内定通知書は状態だけ`);
  check(text.includes("再アップロードする必要はありません") && text.includes("閲覧専用") && await box.locator('input[type="file"], button:has-text("アップロード"), button:has-text("登録"), button:has-text("削除"), button:has-text("差し替え")').count() === 0,
    `[${width}] 再アップロード・削除・差し替えの入口は無い（登録・差し替えは採用HR）`);
  // 応募書類を開く：短時間の URL を取って別タブへ
  const popup = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await box.locator('[data-doc="resume"] button').click();
  const pop = await popup;
  await page.waitForTimeout(500);
  check(st.calls.some(([k, m, q]) => k === "documents" && m === "GET" && /id=d1/.test(q) && /applicantId=a1/.test(q)), `[${width}] 書類の URL は短時間のものを都度取る（applicantId つき・GET だけ）`);
  check(Boolean(pop), `[${width}] 別タブで開く`);
  await pop?.close();
  await box.locator('[data-cond="accepted"] button').click();
  await page.waitForTimeout(600);
  check(st.calls.some(([k, m, q]) => k === "offers" && m === "GET" && /id=o1/.test(q) && /file=accepted/.test(q)), `[${width}] 承諾済みPDFを開ける（引き渡した版 o1・GET だけ）`);
  check(!st.calls.some(([k, m]) => (k === "documents" || k === "offers") && m !== "GET"), `[${width}] 書き込みの呼び出しをしない`);
  // 閉じる
  await r1.locator('button[data-act="docs"]').click();
  check(await box.isHidden(), `[${width}] もう一度押すと閉じる`);
  const over = await overflow(page);
  check(over <= 1, `[${width}] 横にはみ出さない（${over}px）`);
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 採用時書類が見られないとき（API が 403）：理由を出す。画面は壊れない ===");
{
  const st = state(); st.docs403 = true;
  const { ctx, page, errs } = await open(st);
  await page.locator('[data-handoff="a1"] button[data-act="docs"]').click();
  await page.waitForTimeout(700);
  const text = await page.locator("#hd-a1").innerText();
  check(text.includes("Office へ引き渡された方の書類だけ"), "見られない理由（引き渡された方の書類だけ）を出す");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 入社予定の一覧・詳細：「HRから引き渡し」の印・段階を添えた NEXT ACTION・「HRから引き渡し」タブ ===");
{
  const FACTS = { procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null, items: [] };
  const FLOW = onboardFlow({ facts: FACTS, employee: { user_id: "u-new" }, targetOn: "2026-11-01", items: [], today: "2026-10-14" });
  const st0 = state();
  const handoff = handoffFactsOf(st0.offers[0], st0.apps[0], { byName: "人事 花子" });
  const hireOf = (h) => ({ fromHr: Boolean(h), handoff: h, salaryVisible: true, ...hireFlowOf({ handoff: h, facts: FACTS }) });
  const common = { kind: "onboarding", department: "開発", targetOn: "2026-11-01", days: 18, due: "入社まで18日", phase: "prep", phaseLabel: "入社準備",
    progress: { done: 0, total: 1 }, urgency: "ok", next: { title: "契約書の準備", role: "人事", who: "人事 花子" },
    stage: "conditions", stageN: 1, stageLabel: "作成依頼", nextActors: ["admin"], nextActorLabel: "管理者", blockers: ["契約書の準備がまだです"], pct: 0, daysLeft: 18 };
  const f = hireFlowOf({ facts: FACTS });
  const hireRow = (fromHr) => ({ fromHr, hirePhase: f.next.phase, hireKey: f.next.key, hireNext: f.next.label, hireActor: f.next.actorLabel });
  const LIST = {
    tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
    onboarding: [
      { id: "p-hr", employeeId: "e-hr", name: "高木 沙綾", employmentType: "正社員", ...common, ...hireRow(true) },
      { id: "p-direct", employeeId: "e-d", name: "直接 太郎", employmentType: "正社員", ...common, ...hireRow(false) },
    ],
    offboarding: [], done: [], people: [], roles: [], today: "2026-10-14",
  };
  const stX = state();
  stX.detail = (id) => ({ procedure: { ...LIST.onboarding.find((x) => x.id === id), flow: FLOW, hire: hireOf(id === "p-hr" ? handoff : null), drive: null, groups: [
    { role: "hr", label: "人事", done: 0, total: 1, items: [{ id: "i1", title: "労働条件・契約の確認", owner: "hr", ownerLabel: "人事", phase: "prep", done: false, assignee: null, href: null }] }] },
    roles: [], people: [] });
  for (const width of [1300, 390]) {
    const { ctx, page, errs } = await open(stX, { width, list: LIST });
    const rowHr = page.locator('[data-row="p-hr"]');
    const rowDirect = page.locator('[data-row="p-direct"]');
    check(await rowHr.locator('[data-role="from-hr"]').count() === 1 && (await rowHr.locator('[data-role="from-hr"]').innerText()) === "HRから引き渡し", `[${width}] 一覧：HRから引き渡された人に印`);
    check(await rowDirect.locator('[data-role="from-hr"]').count() === 0, `[${width}] 一覧：HR を通らない人には印を付けない`);
    check((await rowHr.locator(".hr-next").innerText()).startsWith("［入社書類］"), `[${width}] 一覧：次にすること の先頭に段階（入社書類）`);
    check((await rowDirect.locator(".hr-next").innerText()).startsWith("［入社書類］"), `[${width}] 一覧：HR を通らない人も同じ言い方（入社書類）`);
    await rowHr.click();
    await page.waitForTimeout(900);
    const tabs = (await page.locator(".hx-tabs button").allInnerTexts()).map((x) => x.trim());
    check(tabs.join("|") === "基本情報|HRから引き渡し|手続きの進み具合|書類の保管先", `[${width}] 詳細のタブ（${tabs.join("|")}）`);
    await page.locator('.hx-tabs button[data-tab="hire"]').click();
    await page.waitForTimeout(800);
    const pane = page.locator("#hx-pane-hire");
    const pt = await pane.innerText();
    check(pt.includes("HRから引き渡された情報") && pt.includes("承諾内容を確認して引き渡されました"), `[${width}] 引き渡された情報`);
    const nx2 = await pane.locator('[data-role="hire-next"]').innerText();
    check(nx2.includes("NEXT ACTION") && nx2.includes("入社書類を集める"), `[${width}] NEXT ACTION：入社書類を集める`);
    const st4 = (await pane.locator(".hx-steps li").allInnerTexts()).map((x) => x.replace(/\s+/g, ""));
    check(st4.join("|") === "1.入社書類|2.アカウント・端末|3.オリエンテーション|4.入社完了", `[${width}] 入社の流れは4つ`);
    check((await pane.locator('[data-role="hr-done"]').innerText()).includes("HRで正式契約まで完了"), `[${width}] 「HRで正式契約まで完了」の印`);
    for (const w of ["高木 沙綾", "雇用区分", "入社予定日", "条件承諾日", "労働条件通知書", "確認済み", "正式契約（HRで完了）", "署名済み", "引き渡し", "人事 花子"]) check(pt.includes(w), `[${width}] ${w}`);
    check(await pane.locator('input[type="url"], button:has-text("正式契約"), button:has-text("LegalSign"), [data-act="formal"]').count() === 0, `[${width}] Office に LegalSign の操作（URL 登録・案内・正式契約済み）は無い`);
    check(nx2.includes("LegalSign の正式契約は HR で済んでいます"), `[${width}] 契約書類（雇用契約書など）の準備は、LegalSign の正式契約とは別だと分かる`);
    const docs = await pane.locator("#ob-hire-docs").innerText();
    check(docs.includes("採用時書類") && docs.includes("HRから引き渡し・閲覧専用") && docs.includes("履歴書") && docs.includes("承諾済みPDF"), `[${width}] 採用時書類（HRから引き渡し・閲覧専用）`);
    const cdocs = await pane.locator("#ob-contract-docs").innerText();
    check(cdocs.includes("入社・契約書類") && cdocs.includes("契約書の準備") && cdocs.includes("本人の確認・署名") && cdocs.includes("入社情報・必要書類"),
      `[${width}] 入社・契約書類（既存の段階の状態を、採用時書類と分けて表示）`);
    check(!docs.includes("契約書の準備") && !cdocs.includes("履歴書"), `[${width}] 採用時書類と入社・契約書類は混ぜない`);
    const over = await overflow(page);
    check(over <= 1, `[${width}] 横にはみ出さない（${over}px）`);
    // HR を通らない人には、タブを出さない
    await page.locator('[data-row="p-direct"]').click();
    await page.waitForTimeout(900);
    const tabs2 = (await page.locator(".hx-tabs button").allInnerTexts()).map((x) => x.trim());
    check(!tabs2.includes("HRから引き渡し"), `[${width}] HR を通らない人には「HRから引き渡し」タブを出さない`);
    check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
    await ctx.close();
  }
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
