// /office の右ドロワーから、請求の進み具合（作成済み・送付済み・BP請求書の受領）を記録する。
//
//   稼働確定済みの PP・BP の2件から始めて、
//     PP：作成済みにする → 送付済みにする → 一覧が「完了」
//     BP：作成済み → 送付済み → 請求書を受領済みにする → 一覧が「支払準備」
//     取消し：確認ダイアログのあと、送付済みを取り消す → 「請求送付待ち」に戻る
//     稼働未確定：作成済みのボタンは押せず、理由が出る
//
// ブラウザの通信は、本物の api/office/{index,timesheet}.js につなぐ（DB は偽：test/_memdb.mjs）
import "../_officeharness.mjs";
import { mem, ctl, call, atRoot, FINANCE, MANAGER, uid, T1, E_PP, E_BP, C_PP, C_BP, PC_1 } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: payablesApi } = await import(atRoot("api/office/payables.js"));
const { default: closeApi } = await import(atRoot("api/office/close.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const M = "2026-10";
const rows = (t) => mem.rows[t] || [];
const answers = [];         // prompt に答える文（順番に使う）
const progressOf = (emp) => rows("gw_billing_progress").find((r) => r.employee_id === emp && r.billing_month === M);

function seed({ confirmed = true } = {}) {
  mem.reset();
  ctl.who = FINANCE; ctl.aal = "aal1";
  mem.rows.gw_employees = [
    { id: E_PP, tenant_id: T1, display_name: "田中 太郎", department: "常駐部", employee_kind: "proper", partner_company_id: null, status: "active" },
    { id: E_BP, tenant_id: T1, display_name: "鈴木 花子", department: null, employee_kind: "bp", partner_company_id: PC_1, status: "active" },
  ];
  mem.rows.gw_partner_companies = [{ id: PC_1, tenant_id: T1, company_name: "パートナー甲社" }];
  mem.rows.gw_site_contracts = [
    { id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "顧客A社", period_from: "2026-04-01", period_to: null, renewal_status: "confirmed" },
    { id: C_BP, tenant_id: T1, employee_id: E_BP, engagement_kind: "bp", site_company: "顧客B社", period_from: "2026-04-01", period_to: null, renewal_status: "confirmed" },
  ];
  // 稼働確定まで済んだ状態（勤務表の行は無い＝これまでどおり印だけで管理している契約）
  mem.rows.gw_billing_progress = [E_PP, E_BP].map((emp, i) => ({
    id: uid(900 + i), tenant_id: T1, employee_id: emp, site_contract_id: emp === E_PP ? C_PP : C_BP, billing_month: M,
    timesheet_received: true, timesheet_received_at: "2026-11-02T00:00:00Z",
    work_confirmed: confirmed, work_confirmed_at: confirmed ? "2026-11-03T00:00:00Z" : null,
    board_created: false, sent: false, bp_invoice_received: false,
  }));
}

async function open(url) {
  const page = await br.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = []; const dialogs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => { dialogs.push(d.message()); d.type() === "prompt" ? d.accept(answers.shift() || "確認済み") : d.accept(); });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "keiri@8grp.co.jp" })); });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({ email: "keiri@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, access: { office: true },
        gw: { employee: { id: "e-me", display_name: "経理 花子", status: "active" }, roles: ["finance"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    const h = { "/api/office": indexApi, "/api/office/timesheet": sheetApi, "/api/office/payables": payablesApi, "/api/office/close": closeApi }[u.pathname];
    if (h) {
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector("#rows tr[data-id]");
  return { page, errs, dialogs };
}

const stageOf = (page, name) => page.locator(`#rows tr:has-text("${name}") [data-label="現在工程"]`).innerText();
const openRow = async (page, name) => {
  await page.locator(`#rows tr:has-text("${name}") td[data-label="要員"]`).click();
  await page.waitForSelector(".of-drawer #dr-sales");
};
// 押す → 一覧が読み直され、ドロワーが開き直されるのを待つ
const press = async (page, sel, waitFor) => {
  await page.locator(`.of-drawer ${sel}`).click();
  await page.waitForFunction(waitFor.fn, waitFor.arg);
};
const btnGone = (sel) => ({ fn: (s) => !document.querySelector(`.of-drawer ${s}`), arg: sel });

console.log("=== PP：作成済み → 送付済み → 完了 ===");
{
  seed();
  const { page, errs, dialogs } = await open(`/office/index.html?month=${M}`);
  check((await stageOf(page, "田中 太郎")).includes("請求作成待ち"), "はじめは請求作成待ち");
  await openRow(page, "田中 太郎");
  const created = '[data-progress="invoice_created"][data-done="1"]';
  check(await page.locator(`.of-drawer ${created}`).isEnabled(), "「請求書を作成済みにする」が押せる");
  check(await page.locator('.of-drawer [data-progress="vendor_received"]').count() === 0, "売上のみの契約には、BP請求書の受領ボタンが無い");
  await press(page, created, btnGone(created));
  check(progressOf(E_PP).board_created === true, "作成済みの印が立つ");
  check((await page.locator(".of-drawer #dr-sales").innerText()).includes("作成済み"), "ドロワー：作成済み");
  check((await stageOf(page, "田中 太郎")).includes("請求送付待ち"), "一覧：請求送付待ち");

  const sent = '[data-progress="invoice_sent"][data-done="1"]';
  await press(page, sent, btnGone(sent));
  check(progressOf(E_PP).sent === true, "送付済みの印が立つ");
  check(await page.locator('#rows tr:has-text("田中 太郎")').count() === 0, "一覧（未完了のみ）：完了したので一覧から消える");
  // ドロワーが開いたままなので、絞り込みは直接切り替える（「未完了のみ」を外す）
  await page.locator("#fopen").evaluate((el) => { el.checked = false; el.dispatchEvent(new Event("change", { bubbles: true })); });
  check((await stageOf(page, "田中 太郎")).includes("完了"), "一覧（完了も表示）：完了");

  // 取消し：確認ダイアログを出してから
  const undo = '[data-progress="invoice_sent"][data-done="0"]';
  await press(page, undo, btnGone(undo));
  check(dialogs.length === 1 && dialogs[0].includes("送付済みを取り消す"), `取消しは確認してから（${dialogs.join(" / ")}）`);
  check(progressOf(E_PP).sent === false && progressOf(E_PP).sent_at === null, "送付済みが外れる");
  check((await stageOf(page, "田中 太郎")).includes("請求送付待ち"), "一覧：請求送付待ちに戻る");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== BP：作成済み → 送付済み → 請求書を受領済み → 支払準備 ===");
{
  seed();
  const { page, errs } = await open(`/office/index.html?month=${M}`);
  await openRow(page, "鈴木 花子");
  for (const step of ["invoice_created", "invoice_sent"]) {
    const sel = `[data-progress="${step}"][data-done="1"]`;
    await press(page, sel, btnGone(sel));
  }
  check((await stageOf(page, "鈴木 花子")).includes("仕入請求待ち"), "送付後は、仕入請求待ち");
  const recv = '[data-progress="vendor_received"][data-done="1"]';
  check((await page.locator(".of-drawer #dr-vendor").innerText()).includes("パートナー甲社の請求書：未受領"), "ドロワー：BP会社の請求書は未受領");
  await press(page, recv, btnGone(recv));
  check(progressOf(E_BP).bp_invoice_received === true, "BP請求書受領の印が立つ");
  check((await page.locator(".of-drawer #dr-vendor").innerText()).includes("受領済み"), "ドロワー：受領済み");
  check((await stageOf(page, "鈴木 花子")).includes("支払準備"), "一覧：支払準備（支払の記録は未実装なので、完了にはしない）");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 稼働が未確定：作成済みにできない ===");
{
  seed({ confirmed: false });
  const { page, errs } = await open(`/office/index.html?month=${M}`);
  await openRow(page, "田中 太郎");
  const btn = page.locator('.of-drawer [data-progress="invoice_created"]');
  check(await btn.isDisabled(), "「請求書を作成済みにする」は押せない");
  check((await page.locator(".of-drawer #dr-sales").innerText()).includes("稼働を確定すると、押せるようになります"), "押せない理由が出る");
  check(progressOf(E_PP).board_created === false, "印は変わらない");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== BP：請求額の登録 → 照合 → 承認 → 支払予定 → 支払済 → 月次完了 ===");
{
  seed();
  for (const p of rows("gw_billing_progress")) Object.assign(p, { board_created: true, sent: true, bp_invoice_received: p.employee_id === E_BP });
  mem.rows.gw_site_contract_terms = [{ id: uid(710), tenant_id: T1, site_contract_id: C_BP, valid_from: "2026-04-01", valid_to: null,
    pricing_type: "monthly", sales_unit_price: 800000, purchase_unit_price: 550000, settlement_mode: "fixed", prorate: false }];
  const { page, errs, dialogs } = await open(`/office/index.html?month=${M}`);
  check((await page.locator("#closebar").innerText()).includes("残り 1 件"), "月次完了のバー：残り 1 件（BP の支払）");
  check(await page.locator('#closebar [data-close-month="close"]').isDisabled(), "まだ月次完了にできない");
  check((await stageOf(page, "鈴木 花子")).includes("支払準備"), "BP は支払準備");
  await openRow(page, "鈴木 花子");
  await page.waitForSelector('#payBody [data-pay="register"]');
  check((await page.locator("#payBody").innerText()).includes("契約どおりなら：550,000円"), "契約どおりの額（仕入単価）が出る");
  check(await page.locator("#pySub").inputValue() === "550000", "小計は、契約どおりの額を初期値にする");
  // 金額不一致で登録 → 理由を書いて承認
  await page.locator("#pySub").fill("600000");
  await page.locator("#pyTax").fill("60000");
  await page.locator('#payBody [data-pay="register"]').click();
  await page.waitForSelector('#payBody [data-pay="approve"]');
  const t1 = await page.locator("#payBody").innerText();
  check(t1.includes("金額不一致") && t1.includes("契約条件（仕入単価）から出した額と一致しません"), "登録 → 照合：金額不一致と理由が出る");
  check((await page.locator(".of-drawer .of-banner").innerText()).includes("BP請求書の金額が一致しません"), "ドロワー上部に要確認");
  answers.push("追加作業分。BP会社と合意済み");
  await page.locator('#payBody [data-pay="approve"]').click();
  await page.waitForSelector('#payBody [data-pay="schedule"]');
  check(rows("gw_vendor_invoices")[0].mismatch_note === "追加作業分。BP会社と合意済み", "承認の理由が残る");
  await page.locator("#pyDue").fill("2026-11-30");
  await page.locator('#payBody [data-pay="schedule"]').click();
  await page.waitForSelector('#payBody [data-pay="pay"]');
  check((await stageOf(page, "鈴木 花子")).includes("支払準備"), "支払予定のあいだは、まだ支払準備");
  check((await page.locator('#rows tr:has-text("鈴木 花子") [data-label="支払"]').innerText()).includes("支払予定 11/30"), "一覧の支払：支払予定 11/30");
  await page.locator('#payBody [data-pay="pay"]').click();
  await page.waitForFunction(() => !document.querySelector('#payBody [data-pay="pay"]') && document.querySelector("#payBody")?.textContent.includes("支払済"));
  check(rows("gw_office_payments")[0].status === "paid" && rows("gw_office_payments")[0].paid_on === "2026-11-30", "支払済（支払日 11/30）");
  check((await page.locator("#closebar").innerText()).includes("すべての案件が完了しました"), "全件完了 → 月次完了にできる");
  await page.locator('[data-close]').first().click();
  await page.locator('#closebar [data-close-month="close"]').click();
  await page.waitForFunction(() => document.querySelector("#closebar .of-closebar.done"));
  check(rows("gw_office_month_closes").length === 1, "月次完了の記録");
  check((await page.locator("#closebar").innerText()).includes("月次完了済み") && (await page.locator("#closebar").innerText()).includes("経理 花子"), "バー：月次完了済み・完了した人");
  check(dialogs.some((d) => d.includes("月次完了にします")), "月次完了は確認してから");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 責任者：支払のボタンは出ない ===");
{
  seed();
  for (const p of rows("gw_billing_progress")) Object.assign(p, { board_created: true, sent: true, bp_invoice_received: p.employee_id === E_BP });
  ctl.who = MANAGER;
  const { page, errs } = await open(`/office/index.html?month=${M}`);
  await openRow(page, "鈴木 花子");
  await page.waitForSelector('#payBody [data-pay="register"]');
  check((await page.locator("#payBody").innerText()).includes("契約条件が登録されていません"), "契約条件が無いと、契約どおりの額は出せない（理由を出す）");
  await page.locator("#pySub").fill("500000");
  await page.locator("#pyTax").fill("50000");
  await page.locator('#payBody [data-pay="register"]').click();
  await page.waitForSelector('#payBody [data-pay="approve"]');
  answers.push("契約条件は来月登録。金額は注文書で確認");
  await page.locator('#payBody [data-pay="approve"]').click();
  await page.waitForFunction(() => document.querySelector("#payBody")?.textContent.includes("経営者・経理が行います"));
  check(await page.locator('#payBody [data-pay="schedule"]').count() === 0, "責任者には、支払予定のボタンを出さない");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
