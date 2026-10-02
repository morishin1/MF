// Office の月次フローを、本物のハンドラと偽の Supabase（test/_memdb.mjs）で、最初から最後まで通す。
//
//   勤務表提出（外部フォーム）→ AI読取・修正 → 稼働時間確定 → 契約条件で請求金額を計算
//   → 請求書作成済み → 送付済み → BP請求書受領 → 請求額の登録・契約（仕入単価）との照合 → 承認
//   → 支払予定 → 支払済 → 月次完了
//
// ■ 何を守るテストか
//
//   1. 正常系：PP（売上のみ）は送付で「完了」、BP は支払済で「完了」。全件完了で月次完了。各段階で
//      /api/office の現在工程・数字カード・月次進捗・今日やることが変わり、操作履歴と監査ログが残る
//   2. 異常系：未提出・期限超過／要確認（印の順番違い・勤務表の合計の不一致・氏名違い）／契約情報不足（金額が出ない）
//      ／金額不一致（BP請求額と仕入単価・小計と明細）／BP請求書未提出／支払未完了／二重計上
//      ／順番違いの操作（確定前の請求作成・作成前の送付・承認前の支払予定 ほか）／月次完了後の書き込み
//   3. 権限：請求の記録・仕入請求は Office の権限（経営者・責任者・経理）だけ。支払・月次完了は経営者・経理だけ
//
// ■ 発注書（gw_purchase_orders）の発行はまだ無い。照合の相手は契約条件（仕入単価）（docs/office-migration-plan.md §5）
import assert from "node:assert/strict";
import {
  atRoot, mem, ctl, ai, call, logged, OWNER, MANAGER, FINANCE, DENIED,
  uid, T1, E_PP, E_BP, C_PP, C_BP, PC_1,
} from "./_officeharness.mjs";

const { default: officeApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));
const { default: publicApi } = await import(atRoot("api/billing-submission/public.js"));
const { default: payablesApi } = await import(atRoot("api/office/payables.js"));
const { default: closeApi } = await import(atRoot("api/office/close.js"));
const { sha256: tokenHash } = await import(atRoot("lib/billing-submission.js"));
const { jstDate } = await import(atRoot("lib/timecard.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const M = "2026-10";     // 10/1 は木曜。AI の返答は 1・2・5日に 8:00 ずつ（合計 24:00）
const BUCKET = "billing-submissions";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 7)]);
const PDF_BP = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 8)]);
const INVOICE = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 6)]);
const TOKEN_PP = "p".repeat(48), TOKEN_BP = "b".repeat(48);

const rows = (t) => mem.rows[t] || [];
const progressOf = (emp, month = M) => rows("gw_billing_progress").find((r) => r.employee_id === emp && r.billing_month === month);
const events = (kind) => rows("gw_office_events").filter((e) => e.kind === kind);

const office = async (month = M) => {
  const r = await call(officeApi, `/api/office?month=${month}`);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body;
};
const rowOf = (body, contract) => body.rows.find((r) => r.siteContractId === contract);
const card = (body, key) => body.summary.cards.find((c) => c.key === key).value;
const prog = (body, key) => body.summary.progress.find((p) => p.key === key);
const sheet = (action, contract, extra = {}, month = M) => call(sheetApi, "/api/office/timesheet", {
  method: "POST", body: { action, siteContractId: contract, month, ...extra },
});
const step = (contract, s, done = true, month = M) => sheet("progress", contract, { step: s, done }, month);
const payables = (action, extra = {}, month = M) => call(payablesApi, "/api/office/payables", { method: "POST", body: { action, month, ...extra } });
const close = (action, extra = {}, month = M) => call(closeApi, "/api/office/close", { method: "POST", body: { action, month, ...extra } });

function setup() {
  mem.reset();
  ctl.who = FINANCE; ctl.aal = "aal1";       // 経理・MFA 未登録（本番は MFA_ENABLED=false）
  ai.calls.length = 0; ai.reply = null; logged.length = 0;
  mem.rows.gw_employees = [
    { id: E_PP, tenant_id: T1, display_name: "田中 太郎", department: "常駐部", employee_kind: "proper", partner_company_id: null, status: "active" },
    { id: E_BP, tenant_id: T1, display_name: "鈴木 花子", department: null, employee_kind: "bp", partner_company_id: PC_1, status: "active" },
  ];
  mem.rows.gw_partner_companies = [{ id: PC_1, tenant_id: T1, company_name: "パートナー甲社" }];
  mem.rows.gw_site_contracts = [
    { id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "顧客A社", prime_company: null,
      period_from: "2026-04-01", period_to: null, renewal_status: "confirmed", unit_price: 999999, settlement_condition: "既存の条件" },
    { id: C_BP, tenant_id: T1, employee_id: E_BP, engagement_kind: "bp", site_company: "顧客B社", prime_company: null,
      period_from: "2026-04-01", period_to: null, renewal_status: "confirmed" },
  ];
  mem.rows.gw_submission_links = [
    { id: uid(801), tenant_id: T1, employee_id: E_PP, token_hash: tokenHash(TOKEN_PP), expires_at: "2099-01-01T00:00:00Z", revoked_at: null },
    { id: uid(802), tenant_id: T1, employee_id: E_BP, token_hash: tokenHash(TOKEN_BP), expires_at: "2099-01-01T00:00:00Z", revoked_at: null },
  ];
  mem.rows.tenants = [{ id: T1, name: "テスト株式会社" }];
}

// 外部提出フォーム（本物のハンドラ）から送り、署名付きURLへ PUT したものとする
async function submitForm(token, contract, kind, bytes, month = M) {
  const r = await call(publicApi, "/api/billing-submission/public", { method: "POST", body: {
    token, targetMonth: month, kind, siteContractId: contract,
    filename: kind === "invoice" ? "請求書.pdf" : "勤務表.pdf", mimeType: "application/pdf", sizeBytes: bytes.length,
  } });
  assert.equal(r.statusCode, 200, `外部フォーム ${JSON.stringify(r.body)}`);
  mem.put(BUCKET, mem.uploadUrls.at(-1).path, bytes);
  return r.body.submissionId;
}

// AI の返答（10月）：1・2・5日が 9:00〜18:00・休憩1:00・実働 8:00、ほかは公休
const aiDay = (d) => ([1, 2, 5].includes(d)
  ? { day: d, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high" }
  : { day: d, kind: "off", blank: false, note: "公休", confidence: "high" });
const aiSheet = (name, over = {}) => ({
  sheet_month: M, employee_name: name, total_worked: "24:00", break_column: "present",
  days: Array.from({ length: 31 }, (_, i) => aiDay(i + 1)), ...over,
});
const withAi = (input) => {
  ai.reply = { model: "claude-test-1", stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu1", name: "read_timesheet", input }], usage: { input_tokens: 1000, output_tokens: 700 } };
};

// 契約条件（画面と同じ API で登録）
async function addTerms(contract, over = {}) {
  const r = await call(termsApi, "/api/office/terms", { method: "POST", body: {
    siteContractId: contract, month: M, validFrom: "2026-04-01", validTo: null,
    pricingType: "monthly", settlementMode: "fixed", salesUnitPrice: 700000, purchaseUnitPrice: 550000, ...over,
  } });
  assert.equal(r.statusCode, 200, `契約条件 ${JSON.stringify(r.body)}`);
}

// 読取 → 1日を人が直す → 確定
async function readAndConfirm(contract, name, { aiInput, ack } = {}) {
  withAi(aiInput || aiSheet(name));
  const rd = await sheet("read", contract);
  assert.equal(rd.statusCode, 200, `read ${JSON.stringify(rd.body)}`);
  const sv = await sheet("save", contract, { days: [{ workDate: `${M}-02`, break: "1:00", note: "人が確認" }] });
  assert.equal(sv.statusCode, 200, `save ${JSON.stringify(sv.body)}`);
  const cf = await sheet("confirm", contract, ack ? { ack } : {});
  return cf;
}

console.log("— 正常系：PP は完了まで、BP は支払準備まで —");

await ok("月次の流れを、提出から完了（PP）・支払準備（BP）まで通す", async () => {
  setup();
  await addTerms(C_PP);
  await addTerms(C_BP, { salesUnitPrice: 800000 });

  // 0. 月初：何も届いていない
  let o = await office();
  assert.equal(o.rows.length, 2);
  assert.equal(rowOf(o, C_PP).stage, "timesheet");
  assert.equal(rowOf(o, C_BP).stage, "timesheet");
  assert.equal(rowOf(o, C_PP).cols.timesheet.label, "未提出");
  assert.equal(card(o, "timesheet"), 2);
  assert.equal(rowOf(o, C_PP).overdue, false, "今月の分は、まだ期限前");

  // 1. 勤務表提出（外部フォーム）→ 受領の印が自動で立つ
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  await submitForm(TOKEN_BP, C_BP, "timesheet", PDF_BP);
  assert.equal(progressOf(E_PP).timesheet_received, true);
  o = await office();
  assert.equal(rowOf(o, C_PP).stage, "work");
  assert.equal(rowOf(o, C_PP).sheet.state, "submitted", "届いたが、未読取");
  assert.equal(rowOf(o, C_PP).cols.work.label, "未読取");
  assert.equal(prog(o, "timesheet").done, 2);

  // 2・3. 勤務時間読取・修正 → 稼働時間確定
  for (const [c, name] of [[C_PP, "田中 太郎"], [C_BP, "鈴木 花子"]]) {
    const cf = await readAndConfirm(c, name);
    assert.equal(cf.statusCode, 200, `${name} confirm ${JSON.stringify(cf.body)}`);
  }
  assert.equal(ai.calls.length, 2);
  assert.equal(progressOf(E_PP).work_confirmed, true);
  o = await office();

  // 4・5. 案件・契約の紐付けと請求金額：確定した 24 時間 × 契約条件（月額・精算なし）
  const pp = rowOf(o, C_PP), bp = rowOf(o, C_BP);
  assert.equal(pp.stage, "invoice_create");
  assert.equal(pp.cols.work.label, "確認済 24h");
  assert.equal(pp.settle.status, "calculated");
  assert.equal(pp.settle.amount, 700000);
  assert.equal(bp.settle.amount, 800000);
  assert.equal(pp.check, false, `要確認なし ${pp.warnings}`);
  assert.ok(!pp.tags.includes("terms"));
  assert.equal(card(o, "invoice"), 2);
  assert.ok(!JSON.stringify(o).includes("999999"), "既存の unit_price は読まない・返さない");

  // 6. 請求書作成（Board で作り、ここでは「作成済み」を記録する）
  for (const c of [C_PP, C_BP]) assert.equal((await step(c, "invoice_created")).statusCode, 200);
  o = await office();
  assert.equal(rowOf(o, C_PP).stage, "invoice_send");
  assert.equal(rowOf(o, C_PP).cols.salesInvoice.label, "作成済");

  // 7. 請求書送付状態
  for (const c of [C_PP, C_BP]) {
    const r = await step(c, "invoice_sent");
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body.marks, ["sent"]);
  }
  o = await office();
  assert.equal(rowOf(o, C_PP).stage, "done", "PP は売上の送付で月次完了");
  assert.equal(rowOf(o, C_PP).cols.payment.label, "対象外");
  assert.equal(rowOf(o, C_BP).stage, "vendor", "BP は仕入請求待ち");
  assert.equal(card(o, "vendor"), 1);
  assert.equal(prog(o, "invoice").done, 2);

  // 8. BP請求書受領（BP が外部フォームから請求書を出す → 受領の印が自動で立つ）
  await submitForm(TOKEN_BP, C_BP, "invoice", INVOICE);
  assert.equal(progressOf(E_BP).bp_invoice_received, true);
  o = await office();
  assert.equal(rowOf(o, C_BP).stage, "payment");
  assert.equal(rowOf(o, C_BP).cols.vendorInvoice.label, "受領済");
  assert.equal(rowOf(o, C_BP).cols.payment.label, "請求額 未登録");
  assert.match(rowOf(o, C_BP).action.text, /請求額を登録/);
  assert.equal(o.summary.today.find((t) => t.key === "payment").count, 1, "今日やること：支払待ち 1件");

  // 9. 発注・契約との照合：BP請求書の金額を登録 → 契約条件（仕入単価 550,000円）と一致
  const sub = rows("gw_submissions").find((x) => x.kind === "invoice").id;
  let r = await payables("register", { receivedOn: "2026-11-05", invoiceNo: "INV-001", submissionId: sub,
    subtotal: 550000, tax: 55000, total: 605000, lines: [{ siteContractId: C_BP, amount: 550000 }] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const inv = r.body.invoices[0];
  assert.equal(inv.match.state, "match", JSON.stringify(inv.match));
  assert.equal(inv.lines[0].expected, 550000);
  assert.equal(inv.partnerName, "パートナー甲社");
  assert.equal(rowOf(await office(), C_BP).cols.payment.label, "照合待ち");
  assert.equal((await payables("approve", { id: inv.id })).statusCode, 200, "一致しているので、理由なしで承認できる");
  assert.equal(rowOf(await office(), C_BP).cols.payment.label, "承認済・支払予定 未定");

  // 10. 支払予定
  r = await payables("schedule", { id: inv.id, scheduledOn: "2026-11-30" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.invoices[0].payment.amount, 605000, "支払額は、既定で請求書の合計");
  o = await office();
  assert.equal(rowOf(o, C_BP).cols.payment.label, "支払予定 11/30");
  assert.match(rowOf(o, C_BP).action.text, /支払予定（11\/30）/);

  // 支払が済むまでは、月次完了できない
  let cl = await close("close");
  assert.equal(cl.statusCode, 409);
  assert.equal(cl.body.error, "not_done");
  assert.deepEqual(cl.body.remaining.map((x) => x.siteContractId), [C_BP]);

  // 11. 支払完了
  assert.equal((await payables("pay", { id: inv.id, paidOn: "2026-11-30" })).statusCode, 200);
  o = await office();
  assert.equal(rowOf(o, C_BP).stage, "done", "BP も支払済で完了");
  assert.equal(rowOf(o, C_BP).cols.payment.label, "支払済 11/30");
  assert.equal(card(o, "done"), 2);
  assert.equal(prog(o, "done").done, 2);
  assert.equal(o.summary.check, 0, "要確認は0件");
  assert.deepEqual(o.summary.today.map((t) => t.key), [], "今日やることは無い");

  // 12. 月次完了
  const ready = await call(closeApi, `/api/office/close?month=${M}`);
  assert.equal(ready.body.canClose, true);
  assert.equal(ready.body.total, 2);
  cl = await close("close");
  assert.equal(cl.statusCode, 200, JSON.stringify(cl.body));
  o = await office();
  assert.equal(o.close.closed, true);
  assert.equal(o.close.closedByName, "経理 花子");
  assert.equal(rows("gw_office_month_closes")[0].rows_total, 2);
  // 完了した月は、請求・支払の記録を動かせない
  assert.equal((await step(C_PP, "invoice_sent", false)).body.error, "month_closed");
  assert.equal((await payables("cancel_payment", { id: inv.id, reason: "誤り" })).body.error, "month_closed");
  assert.equal((await close("close")).body.error, "already_closed");

  // 監査ログ（gw_audit）・操作履歴（gw_office_events）・状態の移り変わり
  for (const k of ["vendor_invoice.register", "vendor_invoice.approve", "payment.schedule", "payment.paid", "month.close"]) {
    assert.equal(events(k).length, 1, k);
    assert.ok(logged.some((l) => l.action === `office.${k}`), `監査ログ office.${k}`);
  }
  assert.deepEqual(events("vendor_invoice.register")[0].detail.marks, [], "受領の印は外部フォームで立っていたので、変えない");
  // 履歴：確定・請求の記録が残る（金額・個人名は入れない）
  assert.equal(events("timesheet.confirm").length, 2);
  assert.equal(events("billing.invoice_created").length, 2);
  assert.equal(events("billing.invoice_sent").length, 2);
  // UUID・日時の数字がたまたま金額に見えないよう、除いてから探す
  const scrub = (t) => t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>");
  const evText = scrub(JSON.stringify(rows("gw_office_events").filter((e) => /^(billing|vendor_invoice|payment|month)\./.test(e.kind))));
  assert.ok(!/700000|800000|550000|605000|田中|鈴木/.test(evText), evText);
  assert.ok(!/550000|605000|田中|鈴木/.test(scrub(JSON.stringify(logged.filter((l) => /office\.(vendor_invoice|payment|month)/.test(l.action))))), "監査ログにも金額・氏名を入れない");
});

await ok("BP請求書を画面から受領済みにする（郵送・メールで届いた場合）→ 支払準備", async () => {
  setup();
  await submitForm(TOKEN_BP, C_BP, "timesheet", PDF_BP);
  assert.equal((await readAndConfirm(C_BP, "鈴木 花子")).statusCode, 200);
  await step(C_BP, "invoice_created"); await step(C_BP, "invoice_sent");
  const r = await step(C_BP, "vendor_received");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.marks, ["bp_invoice_received"]);
  assert.equal(rowOf(await office(), C_BP).stage, "payment");
  // 取り消すと、仕入請求待ちに戻る
  assert.equal((await step(C_BP, "vendor_received", false)).statusCode, 200);
  assert.equal(rowOf(await office(), C_BP).stage, "vendor");
  assert.equal(events("billing.vendor_received.undo").length, 1);
});

await ok("同じ記録を2回しても、印・履歴は増えない（冪等）", async () => {
  setup();
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  await readAndConfirm(C_PP, "田中 太郎");
  await step(C_PP, "invoice_created");
  const before = progressOf(E_PP).board_created_at;
  const again = await step(C_PP, "invoice_created");
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.body.marks, []);
  assert.equal(progressOf(E_PP).board_created_at, before, "作成日時を上書きしない");
  assert.equal(events("billing.invoice_created").length, 1);
});

console.log("\n— 異常系：未提出・期限超過 —");

await ok("前々月に勤務表が届いていない → 未提出・期限超過（数字カード・今日やること・絞り込み）", async () => {
  setup();
  const [y, m] = jstDate().slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 3, 1));             // 前々月（提出期限は前月中に必ず過ぎている）
  const past = d.toISOString().slice(0, 7);
  const o = await office(past);
  const pp = rowOf(o, C_PP);
  assert.equal(pp.stage, "timesheet");
  assert.equal(pp.overdue, true, `期限 ${o.deadline}・今日 ${o.today}`);
  assert.ok(pp.tags.includes("overdue"));
  assert.match(pp.action.text, /提出期限.*過ぎています/);
  assert.equal(card(o, "timesheet"), 2);
  assert.equal(o.summary.cards.find((c) => c.key === "timesheet").alert, true);
  // 未提出のまま請求に進めない
  const r = await step(C_PP, "invoice_created", true, past);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "work_not_confirmed");
});

await ok("差し戻し → 勤務表待ち（再提出待ち）に戻る", async () => {
  setup();
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  withAi(aiSheet("田中 太郎"));
  await sheet("read", C_PP);
  assert.equal((await sheet("return", C_PP, { reason: "別の月の勤務表でした" })).statusCode, 200);
  const pp = rowOf(await office(), C_PP);
  assert.equal(pp.stage, "timesheet");
  assert.match(pp.action.text, /再提出を待っています/);
});

console.log("\n— 異常系：要確認 —");

await ok("勤務表の合計と日ごとの合計が違う → 承知しないと確定できない。承知すれば確定できる", async () => {
  setup();
  await addTerms(C_PP);
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  const cf = await readAndConfirm(C_PP, "田中 太郎", { aiInput: aiSheet("田中 太郎", { total_worked: "30:00" }) });
  assert.equal(cf.statusCode, 409);
  assert.equal(cf.body.error, "ack_required");
  assert.deepEqual(cf.body.acks, ["total_mismatch"]);
  assert.equal(progressOf(E_PP).work_confirmed, false, "確定していない");
  let pp = rowOf(await office(), C_PP);
  assert.equal(pp.stage, "work");
  // 請求に進めない
  assert.equal((await step(C_PP, "invoice_created")).body.error, "work_not_confirmed");
  // 承知して確定 → 日ごとの合計（24h）で金額を出す
  const ok2 = await sheet("confirm", C_PP, { ack: ["total_mismatch"] });
  assert.equal(ok2.statusCode, 200);
  pp = rowOf(await office(), C_PP);
  assert.equal(pp.stage, "invoice_create");
  assert.equal(pp.sheet.totalMinutes, 24 * 60);
  assert.equal(pp.settle.amount, 700000);
  assert.deepEqual(events("timesheet.confirm")[0].detail.acks, ["total_mismatch"]);
});

await ok("印が順番どおりでない（勤務表の受領なしで送付済み）→ 要確認", async () => {
  setup();
  mem.rows.gw_billing_progress = [{ id: uid(900), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, billing_month: M,
    timesheet_received: false, work_confirmed: false, board_created: true, sent: true, bp_invoice_received: false }];
  const o = await office();
  const pp = rowOf(o, C_PP);
  assert.equal(pp.check, true);
  assert.ok(pp.warnings.some((w) => /順番どおり/.test(w)), pp.warnings);
  assert.ok(pp.tags.includes("check"));
  assert.equal(o.summary.today.find((t) => t.key === "check").count, 1);
});

await ok("勤務表は確定済みなのに稼働確認の印が外れている → 要確認", async () => {
  setup();
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  await readAndConfirm(C_PP, "田中 太郎");
  progressOf(E_PP).work_confirmed = false;        // 別の画面（月初作業管理）で外された
  const pp = rowOf(await office(), C_PP);
  assert.ok(pp.warnings.some((w) => /稼働確認の印がありません/.test(w)), pp.warnings);
});

await ok("勤務表の氏名が登録の氏名と違う → 要確認（別の人の勤務表の可能性）", async () => {
  setup();
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  withAi(aiSheet("佐藤 次郎"));
  assert.equal((await sheet("read", C_PP)).statusCode, 200);
  const pp = rowOf(await office(), C_PP);
  assert.equal(pp.check, true);
  assert.ok(pp.warnings.some((w) => /氏名/.test(w)), pp.warnings);
});

console.log("\n— 異常系：金額が出ない（契約条件なし・条件の不足）—");

await ok("契約条件が無い → 稼働は確定できるが、金額は出ない（契約条件の確認）", async () => {
  setup();
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  assert.equal((await readAndConfirm(C_PP, "田中 太郎")).statusCode, 200);
  const o = await office();
  const pp = rowOf(o, C_PP);
  assert.equal(pp.settle.status, "none");
  assert.equal(pp.settle.amount, null);
  assert.ok(pp.tags.includes("terms"));
  assert.equal(o.summary.today.find((t) => t.key === "terms").count, 1);
});

await ok("精算幅を超えたのに超過単価が無い → 金額は出さず要確認（精算幅の外）", async () => {
  setup();
  await addTerms(C_PP, { settlementMode: "range", settleMinHours: 10, settleMaxHours: 20 });
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  assert.equal((await readAndConfirm(C_PP, "田中 太郎")).statusCode, 200);
  const pp = rowOf(await office(), C_PP);
  assert.equal(pp.settle.status, "review");
  assert.equal(pp.settle.band, "over");
  assert.equal(pp.settle.amount, null);
  assert.ok(pp.settle.reasons.some((r) => /超過単価/.test(r)), pp.settle.reasons);
  assert.ok(pp.tags.includes("terms"));
});

await ok("超過単価があれば、精算幅の外でも金額を出す（20h 超過 4h × 5,000円）", async () => {
  setup();
  await addTerms(C_PP, { settlementMode: "range", settleMinHours: 10, settleMaxHours: 20, overRatePerHour: 5000, underRatePerHour: 5000 });
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  await readAndConfirm(C_PP, "田中 太郎");
  const pp = rowOf(await office(), C_PP);
  assert.equal(pp.settle.status, "calculated");
  assert.equal(pp.settle.amount, 720000);
});

console.log("\n— 異常系：順番違いの操作は断る —");

await ok("確定前の作成済み・作成前の送付・送付済みの作成取消し・売上のみの契約の仕入請求は 409", async () => {
  setup();
  await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
  assert.equal((await step(C_PP, "invoice_created")).body.error, "work_not_confirmed");
  await readAndConfirm(C_PP, "田中 太郎");
  assert.equal((await step(C_PP, "invoice_sent")).body.error, "invoice_not_created");
  await step(C_PP, "invoice_created");
  await step(C_PP, "invoice_sent");
  const undo = await step(C_PP, "invoice_created", false);
  assert.equal(undo.statusCode, 409);
  assert.equal(undo.body.error, "already_sent");
  const nv = await step(C_PP, "vendor_received");
  assert.equal(nv.statusCode, 409);
  assert.equal(nv.body.error, "not_vendor");
  // 作成済みの稼働は、確定を取り消せない（既存の reopen の守り）
  assert.equal((await sheet("reopen", C_PP, { reason: "直したい" })).body.error, "invoiced");
  // 送付を外してから作成を外す → 請求作成待ちに戻る
  assert.equal((await step(C_PP, "invoice_sent", false)).statusCode, 200);
  assert.equal((await step(C_PP, "invoice_created", false)).statusCode, 200);
  assert.equal(rowOf(await office(), C_PP).stage, "invoice_create");
  const p = progressOf(E_PP);
  assert.equal(p.board_created_at, null);
  assert.equal(p.sent_at, null);
});

await ok("知らない step は 400。他社・存在しない契約は 404", async () => {
  setup();
  const r = await sheet("progress", C_PP, { step: "paid" });
  assert.equal(r.statusCode, 400);
  assert.equal((await sheet("progress", uid(777), { step: "invoice_created" })).statusCode, 404);
});

console.log("\n— 仕入請求・支払・月次完了（異常系）—");

// 売上の送付まで済んだ状態（印だけで管理している契約）。BP は請求書待ち
function seedSent({ bpReceived = false } = {}) {
  setup();
  mem.rows.gw_billing_progress = [[E_PP, C_PP], [E_BP, C_BP]].map(([e, c], i) => ({
    id: uid(950 + i), tenant_id: T1, employee_id: e, site_contract_id: c, billing_month: M,
    timesheet_received: true, work_confirmed: true, board_created: true, sent: true,
    bp_invoice_received: c === C_BP ? bpReceived : false,
  }));
}
const reg = (amount = 550000, over = {}) => payables("register", {
  receivedOn: "2026-11-05", subtotal: amount, tax: Math.round(amount / 10), total: amount + Math.round(amount / 10),
  lines: [{ siteContractId: C_BP, amount }], ...over,
});

await ok("BP請求書が届いていない → 仕入請求待ち。月次完了できない（残っている案件として返す）", async () => {
  seedSent();
  await addTerms(C_BP);
  const o = await office();
  assert.equal(rowOf(o, C_BP).stage, "vendor");
  assert.equal(rowOf(o, C_BP).cols.vendorInvoice.label, "未受領");
  assert.equal(rowOf(o, C_PP).stage, "done");
  assert.equal(card(o, "vendor"), 1);
  const g = await call(closeApi, `/api/office/close?month=${M}`);
  assert.equal(g.body.canClose, false);
  assert.deepEqual(g.body.remaining.map((x) => x.stageLabel), ["仕入請求待ち"]);
  const c = await close("close");
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, "not_done");
  assert.equal(rows("gw_office_month_closes").length, 0);
  // 請求書の登録画面の「まだ登録されていない BP 契約」に出る
  const list = await call(payablesApi, `/api/office/payables?month=${M}`);
  assert.deepEqual(list.body.pending.map((x) => x.siteContractId), [C_BP]);
  assert.equal(list.body.pending[0].expected, 550000);
});

await ok("金額不一致（請求 600,000円 ／ 契約の仕入単価 550,000円）→ 要確認。理由なしでは承認できない", async () => {
  seedSent();
  await addTerms(C_BP);
  const r = await reg(600000);
  assert.equal(r.statusCode, 200);
  assert.equal(progressOf(E_BP).bp_invoice_received, true, "登録で、BP請求書受領の印が立つ");
  const inv = r.body.invoices[0];
  assert.equal(inv.match.state, "mismatch");
  assert.deepEqual(inv.match.issues.map((i) => i.code), ["amount_mismatch"]);
  assert.equal(inv.lines[0].match.diff, 50000);
  let row = rowOf(await office(), C_BP);
  assert.equal(row.cols.payment.label, "金額不一致");
  assert.equal(row.check, true);
  assert.ok(row.warnings.some((w) => /金額が一致しません/.test(w)), row.warnings);
  const a = await payables("approve", { id: inv.id });
  assert.equal(a.statusCode, 409);
  assert.equal(a.body.error, "mismatch_note_required");
  assert.equal(rows("gw_vendor_invoices")[0].status, "received", "承認していない");
  // 支払予定も入れられない（承認前）
  assert.equal((await payables("schedule", { id: inv.id, scheduledOn: "2026-11-30" })).body.error, "not_approved");
  const ok2 = await payables("approve", { id: inv.id, note: "10月は追加作業があり、BP会社と合意済み" });
  assert.equal(ok2.statusCode, 200);
  assert.equal(rows("gw_vendor_invoices")[0].mismatch_note, "10月は追加作業があり、BP会社と合意済み");
  row = rowOf(await office(), C_BP);
  assert.equal(row.check, false, "理由を残して承認したら、要確認は外れる");
  assert.deepEqual(events("vendor_invoice.approve")[0].detail.codes, ["amount_mismatch"]);
});

await ok("請求書の小計・合計が明細と合わない → 金額不一致", async () => {
  seedSent();
  await addTerms(C_BP);
  const r = await reg(550000, { subtotal: 560000, tax: 56000, total: 610000 });
  assert.deepEqual(r.body.invoices[0].match.issues.map((i) => i.code), ["subtotal_mismatch", "total_mismatch"]);
  assert.equal(rowOf(await office(), C_BP).cols.payment.label, "金額不一致");
});

await ok("契約情報不足（契約条件なし・仕入単価なし）→ 自動で照合しない。理由を書けば承認できる", async () => {
  seedSent();
  let r = await reg(550000);
  assert.equal(r.body.invoices[0].match.state, "unknown");
  assert.match(r.body.invoices[0].lines[0].expectedReasons[0], /契約条件が登録されていません/);
  assert.equal((await payables("approve", { id: r.body.invoices[0].id })).body.error, "mismatch_note_required");
  // 仕入単価だけが無い
  seedSent();
  await addTerms(C_BP, { purchaseUnitPrice: "" });
  r = await reg(550000);
  assert.match(r.body.invoices[0].lines[0].expectedReasons[0], /仕入単価が未設定/);
  // 精算幅の外は、仕入側のルールが未確定なので照合しない（推測で計算しない）
  seedSent();
  await addTerms(C_BP, { settlementMode: "range", settleMinHours: 140, settleMaxHours: 180, overRatePerHour: 4000, underRatePerHour: 4000 });
  mem.rows.gw_timesheets = [{ id: uid(970), tenant_id: T1, employee_id: E_BP, site_contract_id: C_BP, target_month: M, status: "confirmed", total_minutes: 100 * 60 }];
  r = await reg(550000);
  assert.equal(r.body.invoices[0].match.state, "unknown");
  assert.match(r.body.invoices[0].lines[0].expectedReasons[0], /仕入側の超過・控除の扱いが未確定/);
  assert.equal((await payables("approve", { id: r.body.invoices[0].id, note: "BP会社と時間を確認済み" })).statusCode, 200);
});

await ok("支払未完了（承認済み・支払予定のまま）→ 支払待ち。月次完了できない", async () => {
  seedSent();
  await addTerms(C_BP);
  const inv = (await reg()).body.invoices[0];
  await payables("approve", { id: inv.id });
  let o = await office();
  assert.equal(rowOf(o, C_BP).stage, "payment");
  assert.match(rowOf(o, C_BP).action.text, /支払予定日を入れてください/);
  assert.equal((await payables("pay", { id: inv.id, paidOn: "2026-11-30" })).body.error, "not_scheduled");
  await payables("schedule", { id: inv.id, scheduledOn: "2026-11-30", amount: 600000 });
  assert.equal(rows("gw_office_payments")[0].amount, 600000, "支払額は変えられる");
  assert.equal((await payables("schedule", { id: inv.id, scheduledOn: "2026-12-01" })).body.error, "already_scheduled");
  o = await office();
  assert.equal(rowOf(o, C_BP).stage, "payment");
  assert.equal((await close("close")).body.error, "not_done");
  // 支払予定を取り消す（理由が要る）→ 承認済みに戻る
  assert.equal((await payables("cancel_payment", { id: inv.id })).body.error, "reason_required");
  assert.equal((await payables("cancel_payment", { id: inv.id, reason: "支払日の変更" })).statusCode, 200);
  assert.equal(rowOf(await office(), C_BP).cols.payment.label, "承認済・支払予定 未定");
});

await ok("二重計上・売上のみの契約・支払済の取消しは断る。請求書を取り消せば登録し直せる", async () => {
  seedSent();
  await addTerms(C_BP);
  const inv = (await reg()).body.invoices[0];
  const dup = await reg();
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.body.error, "duplicate_line");
  const pp = await payables("register", { receivedOn: "2026-11-05", subtotal: 1, lines: [{ siteContractId: C_PP, amount: 1 }] });
  assert.equal(pp.body.error, "not_vendor");
  assert.equal((await payables("register", { receivedOn: "2026-13-01", subtotal: -1, lines: [] })).body.error, "invalid_input");
  await payables("approve", { id: inv.id });
  await payables("schedule", { id: inv.id, scheduledOn: "2026-11-30" });
  await payables("pay", { id: inv.id, paidOn: "2026-11-30" });
  assert.equal((await payables("pay", { id: inv.id, paidOn: "2026-11-30" })).body.error, "already_paid");
  assert.equal((await payables("void", { id: inv.id, reason: "誤登録" })).body.error, "paid");
  await payables("cancel_payment", { id: inv.id, reason: "誤登録" });
  assert.equal((await payables("void", { id: inv.id, reason: "誤登録" })).statusCode, 200);
  assert.equal(rowOf(await office(), C_BP).cols.payment.label, "請求額 未登録");
  assert.equal((await reg()).statusCode, 200, "取り消した明細は数えない");
});

await ok("要確認の案件が残る月は、確認の内容を書かないと月次完了できない。取消しは理由つきで、記録は残す", async () => {
  seedSent({ bpReceived: true });
  await addTerms(C_BP);
  const inv = (await reg()).body.invoices[0];
  await payables("approve", { id: inv.id });
  await payables("schedule", { id: inv.id, scheduledOn: "2026-11-30" });
  await payables("pay", { id: inv.id, paidOn: "2026-11-30" });
  mem.rows.gw_employees.find((e) => e.id === E_PP).status = "left";     // 退職済み → 要確認
  const c1 = await close("close");
  assert.equal(c1.statusCode, 409);
  assert.equal(c1.body.error, "check_note_required");
  assert.equal((await close("close", { note: "退職月の最終請求まで確認済み" })).statusCode, 200);
  assert.equal(rows("gw_office_month_closes")[0].rows_checked, 1);
  assert.equal((await close("reopen")).body.error, "reason_required");
  assert.equal((await close("reopen", { reason: "請求額の訂正" })).statusCode, 200);
  assert.equal((await office()).close.closed, false);
  assert.equal(rows("gw_office_month_closes").length, 1, "取り消しても記録は残す");
  assert.equal((await payables("cancel_payment", { id: inv.id, reason: "訂正" })).statusCode, 200, "取り消した月は、また直せる");
  assert.equal(events("month.reopen").length, 1);
});

await ok("db/117 が未適用：一覧は出る（支払は未管理）。仕入請求・月次完了の API は 503 と SQL の案内", async () => {
  seedSent({ bpReceived: true });
  mem.state.missing = { table: "gw_vendor_invoices" };
  const o = await office();
  assert.equal(rowOf(o, C_BP).cols.payment.label, "未管理");
  assert.equal(rowOf(o, C_BP).stage, "payment");
  const r = await call(payablesApi, `/api/office/payables?month=${M}`);
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /db\/117/);
  const c = await call(closeApi, `/api/office/close?month=${M}`);
  assert.equal(c.statusCode, 503);
  mem.state.missing = null;
});

console.log("\n— 権限 —");

await ok("経営者・経理は記録できる（MFA 未登録・aal1 でも）", async () => {
  for (const p of [OWNER, FINANCE]) {
    setup(); ctl.who = { ...p, factors: [] };
    await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
    await readAndConfirm(C_PP, "田中 太郎");
    assert.equal((await step(C_PP, "invoice_created")).statusCode, 200);
  }
});
await ok("責任者は、仕入請求の登録・承認はできるが、支払と月次完了はできない（経営者・経理だけ）", async () => {
  seedSent();
  await addTerms(C_BP);
  ctl.who = MANAGER;
  const inv = (await reg()).body.invoices[0];
  assert.ok(inv, "登録できる");
  assert.equal((await payables("approve", { id: inv.id })).statusCode, 200);
  for (const [a, extra] of [["schedule", { scheduledOn: "2026-11-30" }], ["pay", { paidOn: "2026-11-30" }], ["cancel_payment", { reason: "x" }]]) {
    const r = await payables(a, { id: inv.id, ...extra });
    assert.equal(r.statusCode, 403, a);
    assert.equal(r.body.error, "payment_forbidden", a);
  }
  assert.equal((await close("close")).body.error, "close_forbidden");
  assert.equal(rows("gw_office_payments").length, 0);
  const g = await call(payablesApi, `/api/office/payables?month=${M}`);
  assert.equal(g.body.canRecordPayment, false, "画面は、支払のボタンを出さない");
});
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は仕入請求・支払・月次完了の API に入れない（GET も POST も 403）`, async () => {
    seedSent();
    ctl.who = p;
    assert.equal((await call(payablesApi, `/api/office/payables?month=${M}`)).statusCode, 403);
    assert.equal((await call(closeApi, `/api/office/close?month=${M}`)).statusCode, 403);
    for (const a of ["register", "approve", "schedule", "pay", "cancel_payment", "void"]) {
      const r = await payables(a, { id: uid(5), lines: [{ siteContractId: C_BP, amount: 1 }], receivedOn: "2026-11-05", subtotal: 1 });
      assert.equal(r.statusCode, 403, a);
      assert.equal(r.body.error, "forbidden", a);
    }
    assert.equal((await close("close")).statusCode, 403);
    assert.equal(rows("gw_vendor_invoices").length + rows("gw_office_month_closes").length, 0);
  });
}
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は請求の記録ができない（403。印は変わらない）`, async () => {
    setup();
    await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
    await readAndConfirm(C_PP, "田中 太郎");
    ctl.who = p;
    for (const s of ["invoice_created", "invoice_sent", "vendor_received"]) {
      const r = await step(C_PP, s);
      assert.equal(r.statusCode, 403, s);
      assert.equal(r.body.error, "forbidden", s);
    }
    assert.equal(progressOf(E_PP).board_created, false);
  });
}

console.log(`\n${pass} 件 通過 / ${fail} 件 失敗`);
process.exit(fail ? 1 : 0);
