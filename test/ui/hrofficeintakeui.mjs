// 採用HR：社長合格 → 条件ヒアリング → ［Officeへ引き渡す］（早期引き渡し・新フロー）を、実際のブラウザで通す（機能フラグ ON の応答）。
//
// ■ 何を守るテストか（HR→Office 引き継ぎ 要件定義 2026-10-21 §3・§4、PR A）
//   1. 上のタブは 選考中／業務委託／無限道場／Officeへ移動済み／終了（サーバの listTabs のとおり）。
//      引き渡した人は「Officeへ移動済み」にだけ出る（採用区分・引き渡し日時・Office担当つき）。選考中には出ない
//   2. 社長合格直後は「社長合格／条件ヒアリング待ち」。既存の「内定」の言い方は変えない
//   3. 詳細ドロワー：上に主ボタンが1つだけ。条件ヒアリング・引き渡しの詳細は折りたたみ（閉じた状態）
//   4. ヒアリング：「未確定／Officeで確認」にした項目は入力が空になり送られない（推測値を送らない）。保存して内容を確認
//   5. ［Officeへ引き渡す］の確認：「引き渡す情報」「Office担当」「未確定項目」だけ。確認のチェックまで押せない。一度だけ送る
//   6. 一括のステータス変更に「承諾済み」「完了」「合格通知の段階」を出さない
//   7. PC（1280px）と 390px で横にはみ出さない・画面のエラーなし
// 応答は lib/hr.js shapeApplicant・lib/hr-office-intake.js の本物の関数で組み立てる（言い方をテスト側で作らない）
import { launch, BASE } from "../_browser.mjs";
import { shapeApplicant, LIST_TABS } from "../../lib/hr.js";
import { intakeStateOf, INTAKE_PUBLIC, REQUIRED_KEYS } from "../../lib/hr-office-intake.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "hr@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, access: { officeHr: true, recruit: true },
  gw: { employee: { id: "emp-h1", display_name: "人事 次郎" }, roles: ["hr"], isAdmin: false, tenantId: "t1", stage: null } };
const EMPLOYEES = [{ id: "e-hr", display_name: "人事 次郎" }, { id: "e-of", display_name: "労務 三子" }];
const DECIDED = "2026-10-20T01:00:00Z";
const FULL = { offer_type: "part_time", job_title: "エンジニア", duties: "社内システムの開発", desired_join_date: "2026-12-01",
  work_location: "東京本社", remote_policy: "週2日リモート", weekly_days: 3, weekly_hours: 24, contract_period: "期間の定めなし",
  allowances_note: null, other_note: null };

function freshState() {
  return {
    hearing: null, payEntered: false, calls: [],
    a2intake: { id: "i2", office_status: "not_started", handed_at: "2026-10-19T02:00:00Z", handed_by: "u-x", office_assignee_id: "e-of", unresolved_items: [] },
    a1intake: null,
  };
}
const row = (id, name, extra) => ({ id, tenant_id: "t1", name, email: `${id}@example.test`, job_title: "エンジニア", source: "Wantedly",
  rank: "A", recruiter_id: "e-hr", lead_category: "recruitment", employee_id: null, ...extra });
function factsOf(st) {
  return {
    a1: intakeStateOf({ decision: { id: "d1", decision: "pass", decided_at: DECIDED, decided_by: "u-owner" }, hasOffer: false,
      hearing: st.hearing, payEntered: st.payEntered, intake: st.a1intake }),
    a2: intakeStateOf({ decision: { id: "d2", decision: "pass", decided_at: DECIDED }, intake: st.a2intake }),
  };
}
function applicantsOf(st) {
  const f = factsOf(st);
  const rows = [
    row("a1", "新 一郎", { stage: "offer", status: "offer_draft_pending", decision: "hired", offer_type: null, office_intake: f.a1 }),
    row("a2", "移動 二郎", { stage: "offer", status: "offer_draft_pending", decision: "hired", offer_type: "part_time", office_intake: f.a2 }),
    // 既存の「内定」（旧フロー：合格記録なし・オファーの版あり）。言い方は変えない
    row("a3", "旧 三郎", { stage: "offer", status: "offer_review_pending", decision: "hired", offer_type: "part_time" }),
    row("a4", "応募 四郎", { stage: "applied", status: "todo" }),
  ];
  return rows.map((a) => ({ ...shapeApplicant(a), recruiterName: "人事 次郎", alerts: [], docs: null, contact: null }));
}
function viewOf(st) {
  const s = factsOf(st).a1;
  const h = st.hearing;
  const values = {};
  for (const f of INTAKE_PUBLIC.fields) if (f.kind !== "pay") values[f.key] = h?.[f.key] ?? null;
  return {
    enabled: true, ready: true, newFlow: true, ...INTAKE_PUBLIC, phase: s.phase, missing: s.missing || [], unresolved: h?.unresolved || [],
    decision: { decidedAt: DECIDED, decidedByName: "社長 一郎" },
    hearing: h ? { id: "h1", values, unresolved: h.unresolved || [], locked: Boolean(st.a1intake), recordedAt: DECIDED, recordedByName: "人事 次郎",
      confirmedAt: h.confirmed_at, confirmedByName: h.confirmed_at ? "人事 次郎" : null, exception: null } : null,
    pay: h ? { entered: st.payEntered, desired_wage_type: st.payEntered ? "時給" : null, desired_amount: st.payEntered ? 1800 : null,
      desired_note: null, approved_wage_type: null, approved_amount: null } : null,
    intake: st.a1intake ? { id: "i1", handedAt: st.a1intake.handed_at, handedByName: "人事 次郎", officeStatus: "not_started",
      officeStatusLabel: "未着手", officeAssigneeId: st.a1intake.office_assignee_id, officeAssigneeName: "労務 三子", unresolved: [] } : null,
    events: [],
    can: { editHearing: !st.a1intake, editPay: true, approvePay: false, approveException: false, handoff: s.phase === "ready" },
  };
}

async function open(st, width) {
  const ctx = await br.newContext({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    try { sessionStorage.clear(); } catch { /* なし */ }
  });
  const errs = [];
  await ctx.route("**/api/**", (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/applicants\/detail/.test(url) && m === "PATCH") {
      const b = body(); st.calls.push(b);
      if (b.action === "saveHearing") {
        st.hearing = { id: "h1", ...b.hearing, unresolved: b.unresolved || [], confirmed_at: null, locked_at: null };
        st.payEntered = b.pay?.desired_amount != null;
        return send({ officeIntake: viewOf(st) });
      }
      if (b.action === "confirmHearing") { st.hearing.confirmed_at = new Date().toISOString(); return send({ officeIntake: viewOf(st) }); }
      if (b.action === "officeHandoff") {
        if (st.a1intake) return send({ error: "already_handed_off", hint: "すでに Office へ引き渡し済みです" }, 409);
        st.a1intake = { id: "i1", office_status: "not_started", handed_at: new Date().toISOString(), office_assignee_id: b.officeAssigneeId, unresolved_items: [] };
        return send({ officeIntake: viewOf(st) });
      }
      return send({ error: "unknown" }, 400);
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id");
      const a = applicantsOf(st).find((x) => x.id === id);
      return send({ applicant: a, interviews: [], timeline: [], offers: [], interviewers: EMPLOYEES, evalItems: [], ranks: [],
        offerTypes: [{ key: "part_time", label: "パート・アルバイト", fields: [] }, { key: "executive_employee", label: "正社員", fields: [] }],
        offerTypeReady: true, contract: { ready: false, types: [] }, salaryVisible: true, statusOptions: [],
        officeIntake: id === "a1" ? viewOf(st) : { enabled: true, ready: true, newFlow: false } });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) {
      return send({ applicants: applicantsOf(st), employees: EMPLOYEES, listTabs: LIST_TABS.map(({ key, label }) => ({ key, label })),
        officeIntake: { enabled: true, ready: true }, leadReady: true, sources: { options: [], counts: [] } });
    }
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], types: [], limits: {} });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e.stack || e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForTimeout(1200);
  return { ctx, page, errs };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const rowIds = (page) => page.locator("#rows tr[onclick]").evaluateAll((trs) => trs.map((t) => (t.getAttribute("onclick").match(/'([^']+)'/) || [])[1]));

for (const width of [1280, 390]) {
  console.log(`\n— ${width}px —`);
  const st = freshState();
  const { ctx, page, errs } = await open(st, width);

  // 1. タブ
  const tabs = await page.locator("#cat-tabs button").evaluateAll((bs) => bs.map((b) => b.childNodes[0].textContent.trim()));
  check(JSON.stringify(tabs) === JSON.stringify(["選考中", "業務委託", "無限道場", "Officeへ移動済み", "終了"]), `タブは5つ（${tabs.join("／")}）`);
  check(await page.locator('#cat-tabs button[data-category="office"] .n').innerText() === "1", "Officeへ移動済み 1人");
  let ids = await rowIds(page);
  check(ids.includes("a1") && !ids.includes("a2"), `選考中に引き渡し済みの人は出ない（${ids.join(",")}）`);
  check(await overflow(page) <= 0, "一覧が横にはみ出さない");
  // 2. 言い方
  const a1Row = await page.locator("#rows tr", { hasText: "新 一郎" }).innerText();
  check(a1Row.includes("社長合格／条件ヒアリング待ち"), "合格直後は「社長合格／条件ヒアリング待ち」");
  const a3Row = await page.locator("#rows tr", { hasText: "旧 三郎" }).innerText();
  check(!a3Row.includes("社長合格／条件ヒアリング待ち") && !a3Row.includes("Office"), "既存の内定（旧フロー）の言い方は変えない");
  await page.click('#cat-tabs button[data-category="office"]');
  await page.waitForTimeout(200);
  ids = await rowIds(page);
  check(ids.length === 1 && ids[0] === "a2", `Officeへ移動済みには引き渡した人だけ（${ids.join(",")}）`);
  const meta = await page.locator("[data-intake-meta]").innerText();
  check(meta.includes("引き渡し") && meta.includes("労務 三子") && meta.includes("パート"), `採用区分・引き渡し日時・Office担当（${meta}）`);
  check((await page.locator("#rows tr").first().innerText()).includes("Officeへ移動済み（未着手）"), "Office の現在の状態を出す");
  check(await page.locator("#stage-tabs button").count() === 1, "Officeへ移動済みに選考段階の絞り込みは出さない（すべて だけ）");
  check(await overflow(page) <= 0, "Officeへ移動済みタブも横にはみ出さない");
  await page.click('#cat-tabs button[data-category="active"]');
  await page.waitForTimeout(200);

  // 6. 一括の選択肢
  if (width === 1280) {
    await page.locator("#rows tr", { hasText: "応募 四郎" }).locator('input[type="checkbox"]').check();
    await page.waitForTimeout(100);
    const bulkBtn = page.locator("button", { hasText: "ステータス変更" }).first();
    if (await bulkBtn.count()) {
      await bulkBtn.click();
      await page.waitForTimeout(200);
      const opts = await page.locator("#bs-status option").evaluateAll((os) => os.map((o) => o.value));
      check(opts.length > 0 && !opts.includes("accepted") && !opts.includes("done") && !opts.some((o) => o.startsWith("offer_")),
        `一括の選択肢に承諾済み・完了・合格通知の段階を出さない（${opts.length}件）`);
      check(opts.includes("passed") && opts.includes("declined"), "見送り・辞退は選べる");
      await page.evaluate(() => closeHrModal());
    } else check(false, "一括のステータス変更ボタンがある");
    await page.locator("#rows tr", { hasText: "応募 四郎" }).locator('input[type="checkbox"]').uncheck();
  }

  // 3. ドロワー
  await page.locator("#rows tr", { hasText: "新 一郎" }).click();
  await page.waitForTimeout(700);
  const primaries = page.locator("#hr-detail-next .btn-primary");
  check(await primaries.count() === 1, `主ボタンは1つ（${await primaries.count()}）`);
  check((await primaries.first().innerText()).includes("条件ヒアリングを記録"), "主ボタンは［条件ヒアリングを記録］");
  check(await page.locator("#hr-oi-card").count() === 1, "条件ヒアリング・引き渡しのカードがある");
  check(await page.locator("#hr-oi-card").evaluate((d) => !d.open), "詳細は折りたたみ（閉じた状態）");
  check(await overflow(page) <= 0, "ドロワーが横にはみ出さない");

  // 4. ヒアリング
  await primaries.first().click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-oi-row").count() === INTAKE_PUBLIC.fields.length, "ヒアリングの項目はサーバの定義どおり");
  await page.selectOption("#oi-f-offer_type", "part_time");
  for (const k of ["job_title", "duties", "work_location", "remote_policy", "contract_period"]) await page.fill(`#oi-f-${k}`, String(FULL[k]));
  await page.fill("#oi-f-weekly_days", "3");
  await page.fill("#oi-f-weekly_hours", "24");
  await page.fill("#oi-f-desired_join_date", "2026-12-01");
  await page.fill("#oi-pay-amount", "1800");
  // 希望入社日は「未確定／Officeで確認」にする → 入力は空・止まる
  await page.check("#oi-un-desired_join_date");
  check(await page.locator("#oi-f-desired_join_date").isDisabled() && await page.inputValue("#oi-f-desired_join_date") === "", "未確定にした項目は空になり入力できない");
  await page.uncheck("#oi-un-desired_join_date");
  await page.fill("#oi-f-desired_join_date", "2026-12-01");
  check(await overflow(page) <= 0, "ヒアリングのモーダルが横にはみ出さない");
  await page.click("#oi-save-confirm");
  await page.waitForTimeout(700);
  const save = st.calls.find((c) => c.action === "saveHearing");
  check(Boolean(save) && save.hearing.desired_join_date === "2026-12-01" && save.pay?.desired_amount === 1800 && save.unresolved.length === 0,
    `ヒアリングが送られる（${JSON.stringify(save?.unresolved)}）`);
  check(st.calls.some((c) => c.action === "confirmHearing"), "保存して内容を確認（confirmHearing）");
  const REQ = REQUIRED_KEYS.filter((k) => k !== "desired_pay");
  check(REQ.every((k) => save?.hearing[k] !== null && save?.hearing[k] !== undefined), "必須項目は全部送られる");

  // 5. 引き渡し
  const p2 = page.locator("#hr-detail-next .btn-primary");
  check((await p2.first().innerText()).includes("Officeへ引き渡す"), "内容確認のあと、主ボタンは［Officeへ引き渡す］");
  await p2.first().click();
  await page.waitForTimeout(300);
  const modal = await page.locator(".hr-modal").innerText();
  check(modal.includes("引き渡す情報") && modal.includes("Office担当") && modal.includes("未確定項目"), "確認は「引き渡す情報」「Office担当」「未確定項目」");
  check(modal.includes("本人の条件承諾・正式契約・社員登録ではありません"), "承諾・契約・社員登録ではないと明記");
  check(await page.locator("#oi-ho-go").isDisabled(), "確認のチェックまで押せない");
  check(await overflow(page) <= 0, "確認のモーダルが横にはみ出さない");
  await page.selectOption("#oi-ho-assignee", "e-of");
  await page.check("#oi-ho-check");
  await page.click("#oi-ho-go");
  await page.waitForTimeout(800);
  const ho = st.calls.filter((c) => c.action === "officeHandoff");
  check(ho.length === 1 && ho[0].confirm === true && ho[0].officeAssigneeId === "e-of" && String(ho[0].clientRequestId || "").length >= 8,
    `引き渡しは一度だけ送る（confirm・担当・送り直しの鍵つき。${ho.length}回）`);
  check(await page.locator("#hr-detail-next .btn-primary").count() === 0, "引き渡したあと主ボタンは無い（Office で手続き中）");
  check((await page.locator("#hr-detail-next").innerText()).includes("Office で手続き中"), "NEXT は「Office で手続き中」");
  // 一覧も「Officeへ移動済み」へ
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(500);
  check(await page.locator('#cat-tabs button[data-category="office"] .n').innerText() === "2", "一覧の Officeへ移動済み が 2人になる");
  check(!(await rowIds(page)).includes("a1"), "選考中から外れる");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 200)}` : ""}`);
  await ctx.close();
}

await br.close();
console.log(bad ? `\nNG ${bad} 件` : "\nすべて OK");
process.exit(bad ? 1 : 0);
