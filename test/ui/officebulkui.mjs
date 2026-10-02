// /office の案件一覧の、複数選択・一括更新・一括削除を、実際のブラウザで通す。
//
// ■ 通すもの（依頼のUIテスト）
//   1件選択 ／ 複数選択 ／ 全選択 ／ 更新 ／ 削除キャンセル ／ 削除実行
//   ＋ チェックを押してもドロワーが開かない（行を押せば開く）、請求済みは消せない、Storage の失敗、スマホ幅
//
// ■ 何を通しているか
//   ブラウザの通信は、本物の api/office/{index,timesheet,file,terms,contracts}.js のハンドラにつなぐ（DB は偽：test/_memdb.mjs。
//   外部キー（cascade）と Storage の削除も真似ている）。権限は経営者（MFA 未登録・aal1）。
import "../_officeharness.mjs";
import { mem, ctl, ai, call, atRoot, OWNER, uid, T1 } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));
const { default: contractsApi } = await import(atRoot("api/office/contracts.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const TAG = "【Office Phase3 TEST】";
const BUCKET = "billing-submissions";
const P = [
  { n: 1, emp: "田中 太郎", co: "顧客A社", kind: "pp" },
  { n: 2, emp: "鈴木 花子", co: "顧客B社", kind: "bp" },
  { n: 3, emp: "佐藤 次郎", co: "顧客C社", kind: "pp" },
  { n: 4, emp: "高橋 三郎", co: "顧客D社", kind: "pp" },
  { n: 5, emp: "伊藤 四郎", co: "顧客E社（請求済み）", kind: "pp" },
].map((p) => ({ ...p, eid: uid(100 + p.n), cid: uid(200 + p.n), file: `${T1}/${uid(100 + p.n)}/${uid(300 + p.n)}.pdf` }));
const [P1, P2, P3, P4, P5] = P;

function seed() {
  mem.reset();
  ctl.who = { ...OWNER, factors: [] }; ctl.aal = "aal1"; ai.reply = null; ai.calls.length = 0;
  mem.rows.gw_employees = P.map((p) => ({ id: p.eid, tenant_id: T1, display_name: p.emp, department: null, status: "active", employee_kind: p.kind === "bp" ? "bp" : "proper", partner_company_id: null }));
  mem.rows.gw_site_contracts = P.map((p) => ({ id: p.cid, tenant_id: T1, employee_id: p.eid, engagement_kind: p.kind, site_company: p.co, prime_company: null,
    period_from: "2026-10-01", period_to: null, unit_price: 500000 + p.n, unit_price_type: "月額", renewal_status: "pending", note: null }));
  mem.rows.gw_site_contract_terms = P.map((p) => ({ id: uid(400 + p.n), tenant_id: T1, site_contract_id: p.cid, valid_from: "2026-10-01", valid_to: null, pricing_type: "monthly",
    sales_unit_price: 700000, purchase_unit_price: null, settlement_mode: "range", settle_min_minutes: 8400, settle_max_minutes: 10800,
    settle_unit_minutes: null, rounding_mode: null, rounding_scope: null, over_rate_per_hour: 4000, under_rate_per_hour: 3500, prorate: false, amount_rounding: "floor" }));
  mem.rows.gw_billing_progress = P.map((p) => ({ id: uid(500 + p.n), tenant_id: T1, employee_id: p.eid, site_contract_id: p.cid, billing_month: "2026-10", note: null,
    timesheet_received: false, work_confirmed: false, board_created: p.n === 5, sent: false, bp_invoice_received: false }));
  // 田中さんと佐藤さんは、勤務表のファイルが Storage にある
  mem.rows.gw_submissions = [P1, P3].map((p) => ({ id: uid(600 + p.n), tenant_id: T1, employee_id: p.eid, site_contract_id: p.cid, target_month: "2026-10", kind: "timesheet",
    file_name: `${p.emp}_10月.pdf`, mime_type: "application/pdf", storage_path: p.file, submitted_at: "2026-10-31T01:00:00Z", source: "office" }));
  for (const p of [P1, P3]) mem.put(BUCKET, p.file, "%PDF-1.4");
  mem.rows.gw_timesheets = [{ id: uid(700), tenant_id: T1, employee_id: P1.eid, site_contract_id: P1.cid, target_month: "2026-10", status: "draft", read_state: "ok" }];
  mem.rows.gw_timesheet_days = [{ id: uid(701), tenant_id: T1, timesheet_id: uid(700), work_date: "2026-10-01", kind: "work", start_min: 540, end_min: 1080, break_min: 60 }];
  mem.rows.gw_office_events = [];
}

const seen = [];        // 画面が呼んだ /api/office/contracts（本文と応答）
async function open(url = "/office/index.html?month=2026-10", viewport = { width: 1440, height: 1000 }) {
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.example|status of 4|status of 5/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => d.dismiss());
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@8grp.co.jp" })); });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({ email: "owner@8grp.co.jp", appRole: "owner", isAdmin: false, shows: {}, roles: [], access: { recruit: true, sell: true, office: true },
        mfa: { required: true, enrolled: false, verified: false, enforced: false, blocked: false },
        gw: { employee: { id: "e-owner", display_name: "経営 一郎", status: "active" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    const h = { "/api/office": indexApi, "/api/office/timesheet": sheetApi, "/api/office/file": fileApi, "/api/office/terms": termsApi, "/api/office/contracts": contractsApi }[u.pathname];
    if (h) {
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
      if (u.pathname === "/api/office/contracts") seen.push({ body, status: r.statusCode, res: r.body });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
  return { page, errs };
}

const tr = (page, name) => page.locator("#rows tr[data-id]", { hasText: name });
const box = (page, name) => tr(page, name).locator("[data-sel]");
const names = (page) => page.locator('#rows tr[data-id] [data-label="要員"] .of-nm').allInnerTexts();
const barText = async (page) => (await page.locator("#bulkN").innerText()).replace(/\s+/g, "");
const barShown = (page) => page.locator("#bulkbar").isVisible();
const rowsOf = (t) => mem.rows[t] || [];
const events = (kind) => rowsOf("gw_office_events").filter((e) => e.kind === kind);
const drawerOpen = (page) => page.locator(".of-drawer").count().then((n) => n > 0);

// ============================================================================================
console.log("\n=== 一覧：左端にチェック列・見出しに全選択。選択前は、操作バーが出ない ===");
{
  seed();
  const { page, errs } = await open();
  const heads = await page.locator(".of-table thead th").allInnerTexts();
  check(heads[0] === "" && heads.slice(1).join("|") === "客先|案件|要員|勤務表|稼働時間|売上請求|仕入請求|支払|現在工程|次にやること", `見出し：左端がチェック列（いま ${heads.join("|")}）`);
  check(await page.locator("#selAll").count() === 1, "見出しに、全選択のチェックがある");
  check((await names(page)).length === 5, "案件が5件出ている");
  check(await page.locator("#rows tr[data-id] td.of-sel [data-sel]").count() === 5, "各行の左端に、チェックがある");
  const firstCol = await page.locator("#rows tr[data-id]").first().locator("td").first().getAttribute("class");
  check(/of-sel/.test(firstCol), "チェックは、行の最初の列");
  check(!(await barShown(page)), "1件も選んでいないうちは、操作バーは出ない");
  check(await page.locator("#selAll").isChecked() === false, "全選択は外れている");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 1件選択 ===");
{
  seed();
  const { page, errs } = await open();
  await box(page, P1.emp).click();
  check(await box(page, P1.emp).isChecked(), "田中さんの行にチェックが付く");
  check(await barShown(page), "操作バーが出る");
  check(await barText(page) === "1件選択中", `「1件選択中」（いま ${await barText(page)}）`);
  const barLabels = await page.locator("#bulkbar button").evaluateAll((bs) => bs.map((b) => [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
  check(barLabels.join("|") === "更新|削除|選択解除", `操作バー：更新・削除・選択解除（いま ${barLabels.join("|")}）`);
  check(/^\s*1件選択中\s*$/.test((await page.locator("#bulkbar .n").innerText())), "バーの文言は「N件選択中」");
  const pos = await page.locator("#bulkbar").evaluate((e) => { const r = e.getBoundingClientRect(); return { bottom: innerHeight - r.bottom, pos: getComputedStyle(e).position, inView: r.top >= 0 && r.bottom <= innerHeight }; });
  check(pos.pos === "fixed" && pos.inView && pos.bottom < 40, `操作バーは画面の下に固定（bottom ${Math.round(pos.bottom)}px）`);
  check(await tr(page, P1.emp).evaluate((e) => e.classList.contains("sel")), "選んだ行は、色が変わる");
  check(await page.locator("#selAll").evaluate((e) => e.indeterminate), "見出しのチェックは「一部だけ選択」の状態");

  // チェックを押しても、ドロワーは開かない
  check(!(await drawerOpen(page)), "チェックを押しても、ドロワーは開かない");
  check(!/[?&]id=/.test(page.url()), "URL に ?id= も付かない");
  // 行のチェックの外（セルの余白）を押しても、開かない
  await tr(page, P2.emp).locator("td.of-sel").click({ position: { x: 3, y: 3 } });
  check(!(await drawerOpen(page)), "チェック列の余白を押しても、ドロワーは開かない");
  check(await box(page, P2.emp).isChecked() && await barText(page) === "2件選択中", "（余白もチェックの当たり判定なので、2件選択になる）");
  await box(page, P2.emp).click();
  check(await barText(page) === "1件選択中", "もう一度押すと外れる");

  // 行をクリックすると、ドロワーが開く（従来どおり）
  await tr(page, P3.emp).locator('[data-label="要員"]').click();
  await page.waitForSelector(".of-drawer");
  check(await drawerOpen(page), "行をクリックすると、ドロワーが開く（従来どおり）");
  check(await box(page, P3.emp).isChecked() === false, "行を開いても、チェックは付かない");
  check(await barText(page) === "1件選択中", "ドロワーを開いても、選択は変わらない");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".of-drawer"));
  check(true, "Esc でドロワーが閉じる");

  // キーボード：チェックにフォーカスして Space
  await box(page, P4.emp).focus();
  await page.keyboard.press("Space");
  check(await box(page, P4.emp).isChecked() && !(await drawerOpen(page)), "キーボード（Space）でもチェックできて、ドロワーは開かない");

  // 選択解除
  await page.click("#bulkClear");
  check(!(await barShown(page)) && (await page.locator("[data-sel]:checked").count()) === 0, "「選択解除」で、すべて外れて、バーが消える");
  check(await page.locator("#selAll").evaluate((e) => !e.checked && !e.indeterminate), "見出しのチェックも外れる");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 複数選択・全選択 ===");
{
  seed();
  const { page, errs } = await open();
  for (const p of [P1, P3, P4]) await box(page, p.emp).click();
  check(await barText(page) === "3件選択中", `「3件選択中」（いま ${await barText(page)}）`);
  check(!(await drawerOpen(page)), "3件選んでも、ドロワーは開かない");
  await page.screenshot({ path: shotPath("office-bulk-select-3.png") });

  // 全選択
  await page.locator("#selAll").click();
  check(await barText(page) === "5件選択中", `見出しのチェックで全選択：「5件選択中」（いま ${await barText(page)}）`);
  check(await page.locator("[data-sel]:checked").count() === 5, "5行すべてにチェックが付く");
  check(await page.locator("#selAll").evaluate((e) => e.checked && !e.indeterminate), "見出しのチェックは「すべて選択」の状態");
  await page.screenshot({ path: shotPath("office-bulk-select-all.png") });
  // 1件外すと、一部選択
  await box(page, P5.emp).click();
  check(await barText(page) === "4件選択中" && await page.locator("#selAll").evaluate((e) => !e.checked && e.indeterminate), "1件外すと「4件選択中」・見出しは一部選択");
  // 全選択をもう一度押すと、（一部選択から）すべて選択になり、さらに押すと全解除
  await page.locator("#selAll").click();
  check(await barText(page) === "5件選択中", "一部選択から見出しを押すと、すべて選択");
  await page.locator("#selAll").click();
  check(!(await barShown(page)) && await page.locator("[data-sel]:checked").count() === 0, "もう一度押すと、すべて解除（バーが消える）");

  // 絞り込み：全選択は「いま見えている案件」だけ。見えなくなった案件は、選択から外れる
  await page.fill("#q", "田中");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 1);
  await page.locator("#selAll").click();
  check(await barText(page) === "1件選択中", "検索で1件に絞って全選択すると、見えている1件だけ");
  await page.fill("#q", "");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 5);
  check(await barText(page) === "1件選択中" && await box(page, P1.emp).isChecked(), "絞り込みを戻しても、選んだ1件のまま（ほかの案件は選ばれない）");
  await page.fill("#q", "鈴木");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 1);
  check(!(await barShown(page)), "選んでいた案件が絞り込みで見えなくなったら、選択から外れる（見えないまま操作しない）");
  await page.fill("#q", "");

  // 月を替えたら、選択は持ち越さない
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 5);
  await box(page, P2.emp).click();
  await page.click("#prev");
  await page.waitForFunction(() => document.querySelector("#month").value === "2026-09");
  check(!(await barShown(page)), "月を替えると、選択は解除される");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 更新 ===");
{
  seed(); seen.length = 0;
  const { page, errs } = await open();
  await box(page, P2.emp).click(); await box(page, P3.emp).click();
  await page.click("#bulkUpdate");
  await page.waitForSelector(".of-modal");
  check(/選択した2件を更新/.test(await page.locator(".of-modal h2").innerText()), "更新のモーダルが開く（選択した2件を更新）");
  const mt = await page.locator(".of-modal").innerText();
  check(mt.includes(P2.emp) && mt.includes(P3.emp) && !mt.includes(P1.emp), "対象の案件（要員名）が出る");
  check(mt.includes("更新確認状況") && mt.includes("契約終了予定") && mt.includes("契約期間"), "変えられる項目：更新確認状況・契約終了予定・契約期間");
  check(/単価・精算条件・勤務時間は.*一括では変更できません/.test(mt), "単価・精算条件・勤務時間は、一括では変えられないと書いてある");
  check(await page.locator(".of-modal input[type=number], .of-modal input[type=text], .of-modal textarea").count() === 0, "単価・時間などを入れる欄は無い（日付と選択だけ）");
  check(await page.locator("#mdOk").isDisabled(), "何も選ばないうちは、更新ボタンは押せない");
  check(await page.locator("#uf-renewal").isDisabled() && await page.locator("#uf-to").isDisabled() && await page.locator("#uf-from").isDisabled(), "項目にチェックを入れるまで、入力欄は使えない");

  // 期間の食い違い：終了予定が開始日（2026-10-01）より前 → 押せない（画面で止まる）
  await page.check("#uf-to-use");
  await page.fill("#uf-to", "2026-09-01");
  check(await page.locator("#mdOk").isEnabled(), "（終了予定だけなら、画面では判定しない＝サーバが案件ごとに判定する）");
  await page.click("#mdOk");
  await page.waitForFunction(() => /開始日（2026-10-01）より前/.test(document.querySelector("#mdErr")?.textContent || ""));
  check(await page.locator(".of-modal").count() === 1, "期間の食い違いは、サーバが断る。モーダルは開いたまま、理由が出る");
  check(/鈴木 花子（顧客B社）/.test(await page.locator("#mdErr").innerText()) && /1件も変更していません/.test(await page.locator("#mdErr").innerText()), "どの案件が、なぜ合わないかが出る（1件も変更していない）");
  check(rowsOf("gw_site_contracts").every((c) => c.period_to == null && c.renewal_status === "pending"), "DB は何も変わっていない");
  check(events("contract.update").length === 0, "履歴も残っていない");

  // 正しい値にして更新
  await page.fill("#uf-to", "2027-03-31");
  await page.check("#uf-renewal-use");
  await page.selectOption("#uf-renewal", "ending");
  check(await page.locator("#mdOk").isEnabled(), "項目を選ぶと、更新ボタンが押せる");
  check((await page.locator("#mdOk").innerText()).trim() === "選択した2件を更新", "ボタンは「選択した2件を更新」");
  await page.screenshot({ path: shotPath("office-bulk-update-modal.png") });
  await page.click("#mdOk");
  await page.waitForFunction(() => !document.querySelector(".of-modal"));
  await page.waitForSelector("#banner .of-banner");
  const ban = await page.locator("#banner").innerText();
  check(/2件の案件を更新しました/.test(ban) && /更新確認状況/.test(ban) && /契約終了予定/.test(ban), `完了のお知らせ：${ban.trim().replace(/\s+/g, " ")}`);
  check(!(await barShown(page)), "更新したら、選択は解除される");
  const cs = Object.fromEntries(rowsOf("gw_site_contracts").map((c) => [c.id, c]));
  check([P2, P3].every((p) => cs[p.cid].renewal_status === "ending" && cs[p.cid].period_to === "2027-03-31"), "選んだ2件：更新確認状況＝終了予定・終了予定日＝2027-03-31");
  check([P1, P4, P5].every((p) => cs[p.cid].renewal_status === "pending" && cs[p.cid].period_to == null), "選ばなかった案件は、変わらない");
  check(P.every((p) => cs[p.cid].unit_price === 500000 + p.n), "単価は、だれも変わらない");
  const ev = events("contract.update");
  check(ev.length === 2 && ev.every((e) => e.actor_id && e.billing_month === "2026-10" && e.detail.count === 2), "履歴（gw_office_events）：案件ごとに contract.update が1行（2行）");
  const post = seen.filter((s) => s.body.action === "update");
  check(post.length === 2 && post[1].status === 200 && post[1].body.ids.length === 2 && !("unitPrice" in post[1].body.fields), "送った内容：ids 2件・fields に単価は無い");
  // ドロワーの契約期間にも出る
  await tr(page, P2.emp).locator('[data-label="要員"]').click();
  await page.waitForSelector(".of-drawer");
  check(/終了予定/.test(await page.locator(".of-drawer #dr-contract").innerText()), "ドロワーの「契約」にも、更新後の状態が出る");
  await page.keyboard.press("Escape");

  // 終了予定を「未定」に戻す
  await box(page, P2.emp).click();
  await page.click("#bulkUpdate");
  await page.waitForSelector(".of-modal");
  await page.check("#uf-to-use"); await page.check("#uf-to-none");
  check(await page.locator("#uf-to").isDisabled() && await page.locator("#mdOk").isEnabled(), "「未定にする」で、日付の入力は不要になる");
  await page.click("#mdCancel");
  await page.waitForFunction(() => !document.querySelector(".of-modal"));
  check(await barText(page) === "1件選択中" && rowsOf("gw_site_contracts").find((c) => c.id === P2.cid).period_to === "2027-03-31", "キャンセルすると何も変わらず、選択は残る");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 削除キャンセル ===");
{
  seed(); seen.length = 0;
  const { page, errs } = await open();
  await box(page, P1.emp).click(); await box(page, P4.emp).click();
  await page.click("#bulkDelete");
  await page.waitForSelector(".of-modal");
  await page.waitForFunction(() => /勤務表のファイル/.test(document.querySelector("#mdRel")?.textContent || ""));
  const t = await page.locator(".of-modal").innerText();
  check(/選択件数：2件/.test(t), "確認モーダルに、選択件数（2件）");
  check(t.includes(P1.emp) && t.includes(P4.emp) && !t.includes(P2.emp), "要員名が出る（選んだ2人だけ）");
  check(t.includes(P1.co) && t.includes(P4.co), "客先名が出る");
  check(/関連する、勤務表・月次進捗・契約条件も、あわせて削除されます/.test(t), "関連する勤務表・月次進捗・契約条件も削除対象になると明示");
  check(/勤務表のファイル 1件/.test(t) && /勤務表 1件/.test(t) && /月次進捗 2件/.test(t) && /契約条件 2件/.test(t), `削除される件数が出る（${(await page.locator("#mdRel").innerText()).trim()}）`);
  check(/元に戻せません/.test(t), "元に戻せないと書いてある");
  check(/要員（社員名簿）は、削除されません/.test(t), "要員は消えないと書いてある");
  check((await page.locator("#mdOk").innerText()).trim() === "選択した2件を削除", "確認文言：「選択した2件を削除」");
  check(await page.locator("#mdOk").isDisabled(), "即削除はできない：確認のチェックを入れるまで、削除ボタンは押せない");
  await page.locator("#mdOk").click({ force: true });
  await page.waitForTimeout(200);
  check(seen.filter((s) => s.body.action === "delete").length === 0, "押せない状態で押しても、削除の要求は送られない");
  await page.screenshot({ path: shotPath("office-bulk-delete-modal.png") });

  // キャンセル
  await page.click("#mdCancel");
  await page.waitForFunction(() => !document.querySelector(".of-modal"));
  check(true, "キャンセルで、モーダルが閉じる");
  check(rowsOf("gw_site_contracts").length === 5 && rowsOf("gw_submissions").length === 2 && rowsOf("gw_billing_progress").length === 5, "DB は何も消えていない");
  check(mem.storageFiles.size === 2 && mem.removed.length === 0, "Storage のファイルも消えていない");
  check(seen.filter((s) => s.body.action === "delete").length === 0, "削除の要求は、1回も送られていない");
  check(events("contract.delete").length === 0, "履歴も残っていない");
  check(await barText(page) === "2件選択中" && (await names(page)).length === 5, "選択は残り、一覧も5件のまま");

  // Esc でも、確認のチェックを入れた後でも、キャンセルできる
  await page.click("#bulkDelete");
  await page.waitForFunction(() => /勤務表のファイル/.test(document.querySelector("#mdRel")?.textContent || ""));
  await page.check("#mdConfirm");
  check(await page.locator("#mdOk").isEnabled(), "確認のチェックを入れると、削除ボタンが押せる");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".of-modal"));
  check(rowsOf("gw_site_contracts").length === 5 && seen.filter((s) => s.body.action === "delete").length === 0, "Esc でも、何も削除せず閉じる");
  // 開き直すと、確認のチェックは外れている
  await page.click("#bulkDelete");
  await page.waitForFunction(() => /勤務表のファイル/.test(document.querySelector("#mdRel")?.textContent || ""));
  check(!(await page.locator("#mdConfirm").isChecked()) && await page.locator("#mdOk").isDisabled(), "開き直すと、確認のチェックは外れていて、削除は押せない");
  await page.click("#mdCancel");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 削除実行 ===");
{
  seed(); seen.length = 0;
  const { page, errs } = await open();
  await box(page, P1.emp).click(); await box(page, P4.emp).click();
  await page.click("#bulkDelete");
  await page.waitForFunction(() => /勤務表のファイル/.test(document.querySelector("#mdRel")?.textContent || ""));
  await page.check("#mdConfirm");
  await page.click("#mdOk");
  await page.waitForFunction(() => !document.querySelector(".of-modal"));
  await page.waitForSelector("#banner .of-banner");
  const ban = await page.locator("#banner").innerText();
  check(/2件の案件を削除しました/.test(ban) && /ファイル 1件も削除/.test(ban), `完了のお知らせ：${ban.trim().replace(/\s+/g, " ")}`);
  check(!(await barShown(page)), "削除したら、選択は解除される");
  const left = await names(page);
  check(left.length === 3 && !left.includes(P1.emp) && !left.includes(P4.emp), `一覧から消える（残り ${left.join("・")}）`);
  check(rowsOf("gw_site_contracts").map((c) => c.id).sort().join() === [P2, P3, P5].map((p) => p.cid).sort().join(), "DB：案件は、選んだ2件だけ消える");
  check(rowsOf("gw_billing_progress").length === 3 && rowsOf("gw_site_contract_terms").length === 3, "月次進捗・契約条件も、一緒に消える");
  check(rowsOf("gw_timesheets").length === 0 && rowsOf("gw_timesheet_days").length === 0, "勤務表・日別データも、一緒に消える");
  check(rowsOf("gw_employees").length === 5, "要員（社員名簿）は消えない");
  // Storage
  check(!mem.storageFiles.has(`${BUCKET}/${P1.file}`), "Storage の勤務表ファイル（田中さん）が消えている");
  check(mem.storageFiles.has(`${BUCKET}/${P3.file}`), "選ばなかった案件のファイル（佐藤さん）は残っている");
  check(rowsOf("gw_submissions").every((s) => mem.storageFiles.has(`${BUCKET}/${s.storage_path}`)), "提出の行が残っていて、ファイルだけ無い（孤児）という状態は無い");
  check([...mem.storageFiles.keys()].every((k) => rowsOf("gw_submissions").some((s) => k === `${BUCKET}/${s.storage_path}`)), "行の無いファイル（孤児）も残らない");
  // 履歴
  const ev = events("contract.delete");
  check(ev.length === 2 && ev.every((e) => e.site_contract_id === null && e.detail.contractId && e.actor_id), "履歴（gw_office_events）：案件ごとに contract.delete が1行（契約の id は detail に残る）");
  check(ev.some((e) => e.detail.siteCompany === P1.co && e.detail.deleted.files === 1 && e.detail.deleted.sheets === 1 && e.detail.storageRemoved === 1), "履歴に、消した関連データの件数が入る");
  const del = seen.find((s) => s.body.action === "delete");
  check(del && del.body.confirm === true && del.body.confirmCount === 2 && del.status === 200, "送った内容：confirm: true・confirmCount: 2");
  // 月を読み直しても出ない
  await page.reload();
  await page.waitForSelector("#rows tr[data-id]");
  check((await names(page)).length === 3, "読み込み直しても、消えたまま");
  await page.screenshot({ path: shotPath("office-bulk-after-delete.png") });
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 請求済み・Storage の失敗：消せない（何も消えない） ===");
{
  seed(); seen.length = 0;
  const { page, errs } = await open();
  // 請求書の作成の印が付いた案件（伊藤さん）：画面で確認した時点で、削除できない
  await box(page, P3.emp).click(); await box(page, P5.emp).click();
  await page.click("#bulkDelete");
  await page.waitForFunction(() => /削除できません/.test(document.querySelector("#mdErr")?.textContent || ""));
  check(/伊藤 四郎（顧客E社（請求済み））/.test(await page.locator("#mdErr").innerText()) && !/佐藤/.test(await page.locator("#mdErr").innerText()), "請求済みの案件が、名前つきで「削除できません」と出る");
  check(await page.locator("#mdConfirm").isDisabled() && await page.locator("#mdOk").isDisabled(), "確認のチェックも削除ボタンも、押せない");
  await page.click("#mdCancel");
  // 請求済みを外して、Storage を失敗させる
  await box(page, P5.emp).click();
  mem.state.storageFail = "storage down";
  await page.click("#bulkDelete");
  await page.waitForFunction(() => /勤務表のファイル/.test(document.querySelector("#mdRel")?.textContent || ""));
  await page.check("#mdConfirm");
  await page.click("#mdOk");
  await page.waitForFunction(() => /削除していません/.test(document.querySelector("#mdErr")?.textContent || ""));
  check(await page.locator(".of-modal").count() === 1, "Storage のファイルを消せないと、モーダルは開いたまま、理由が出る");
  check(rowsOf("gw_site_contracts").length === 5 && rowsOf("gw_submissions").length === 2 && mem.storageFiles.has(`${BUCKET}/${P3.file}`), "DB の行も、ファイルも、消えていない（孤児ができない）");
  check(await barText(page) === "1件選択中" && (await names(page)).length === 5, "選択も一覧も、そのまま");
  check(await page.locator("#mdOk").isEnabled() && (await page.locator("#mdOk").innerText()).trim() === "選択した1件を削除", "やり直せる（ボタンが戻る）");
  // 直ったら、やり直せる
  mem.state.storageFail = null;
  await page.click("#mdOk");
  await page.waitForFunction(() => !document.querySelector(".of-modal"));
  check(rowsOf("gw_site_contracts").length === 4 && !mem.storageFiles.has(`${BUCKET}/${P3.file}`), "やり直すと、案件もファイルも消える");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== スマホ幅：カードでも選べる。横スクロールなし。操作バーが画面に収まる ===");
{
  seed();
  const { page, errs } = await open("/office/index.html?month=2026-10", { width: 390, height: 800 });
  check(await page.locator("#selAllM").isVisible(), "表示中をすべて選択（スマホ用）が出る");
  check(await page.locator("#selAll").isVisible() === false, "表の見出し（PC用）は出ない");
  check(await box(page, P1.emp).isVisible(), "各カードに、選択のチェックがある");
  await box(page, P1.emp).click();
  check(await barText(page) === "1件選択中" && !(await drawerOpen(page)), "カードのチェックで選べる。ドロワーは開かない");
  await page.locator("#selAllM").click();
  check(await barText(page) === "5件選択中", "スマホ用の全選択で、5件選択");
  const fit = await page.evaluate(() => {
    const r = document.querySelector("#bulkbar").getBoundingClientRect();
    return { noHScroll: document.documentElement.scrollWidth <= innerWidth + 1, inX: r.left >= 0 && r.right <= innerWidth, inY: r.bottom <= innerHeight && r.top >= 0 };
  });
  check(fit.noHScroll, "横スクロールが要らない");
  check(fit.inX && fit.inY, "操作バーが、画面に収まる");
  const btn = await page.locator("#bulkbar button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return r.height >= 32 && r.width >= 60; }));
  check(btn.every(Boolean), "操作バーのボタンが、押せる大きさ");
  await page.screenshot({ path: shotPath("office-bulk-mobile.png") });
  await page.click("#bulkDelete");
  await page.waitForFunction(() => /勤務表のファイル/.test(document.querySelector("#mdRel")?.textContent || ""));
  const m = await page.locator(".of-modal").evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  check(m, "確認モーダルが、スマホの画面に収まる");
  await page.click("#mdCancel");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
