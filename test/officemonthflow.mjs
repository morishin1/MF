// Office の月次フローを、本物のハンドラと偽の Supabase（test/_memdb.mjs）で、最初から最後まで通す。
//
//   勤務表提出（外部フォーム）→ AI読取・修正 → 稼働時間確定 → 契約条件で請求金額を計算
//   → 請求書作成済み → 送付済み → BP請求書受領（外部フォーム／画面）→ 支払準備（BP）・完了（PP）
//
// ■ 何を守るテストか
//
//   1. 正常系：PP（売上のみ）は「完了」まで、BP は「支払準備」まで進む。各段階で /api/office の
//      現在工程・数字カード・月次進捗が変わる。請求金額は契約条件から出る
//   2. 異常系：未提出・期限超過／要確認（印の順番違い・勤務表の合計の不一致）／契約条件なし（金額が出ない）
//      ／順番違いの操作（確定前の請求作成・作成前の送付・送付済みの作成取消し・売上のみの契約の仕入請求）
//   3. 請求の記録（progress）は Office の権限だけ。他は 403
//
// ■ ここに無いもの（docs/office-migration-plan.md の Phase 6〜8。未実装）
//   発注書・BP請求書の金額照合、支払予定・支払完了の記録、月次締め。BP の行は「支払準備」で止まる（完了にしない）
import assert from "node:assert/strict";
import {
  atRoot, mem, ctl, ai, call, OWNER, FINANCE, DENIED,
  uid, T1, E_PP, E_BP, C_PP, C_BP, PC_1,
} from "./_officeharness.mjs";

const { default: officeApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));
const { default: publicApi } = await import(atRoot("api/billing-submission/public.js"));
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

function setup() {
  mem.reset();
  ctl.who = FINANCE; ctl.aal = "aal1";       // 経理・MFA 未登録（本番は MFA_ENABLED=false）
  ai.calls.length = 0; ai.reply = null;
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
  // 9〜11. 発注照合・支払予定・支払完了は未実装（Phase 6・7）。BP は「支払準備」で止まり、完了にしない
  assert.equal(rowOf(o, C_BP).stage, "payment");
  assert.equal(rowOf(o, C_BP).stageLabel, "支払準備");
  assert.equal(rowOf(o, C_BP).cols.vendorInvoice.label, "受領済");
  assert.equal(rowOf(o, C_BP).cols.payment.label, "未管理");
  // 12. 月次完了
  assert.equal(card(o, "done"), 1, "完了は PP の1件だけ");
  assert.equal(prog(o, "done").done, 1);
  assert.equal(prog(o, "vendor").done, 1);
  assert.equal(o.summary.check, 0, "要確認は0件");
  assert.deepEqual(o.summary.today.map((t) => t.key), [], "今日やることは無い（BP の支払準備は、Phase 7 まで今日やることに出さない）");

  // 履歴：確定・請求の記録が残る（金額・個人名は入れない）
  assert.equal(events("timesheet.confirm").length, 2);
  assert.equal(events("billing.invoice_created").length, 2);
  assert.equal(events("billing.invoice_sent").length, 2);
  const evText = JSON.stringify(rows("gw_office_events").filter((e) => e.kind.startsWith("billing.")));
  assert.ok(!/700000|800000|田中|鈴木/.test(evText), evText);
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

console.log("\n— 権限 —");

await ok("経営者・経理は記録できる（MFA 未登録・aal1 でも）", async () => {
  for (const p of [OWNER, FINANCE]) {
    setup(); ctl.who = { ...p, factors: [] };
    await submitForm(TOKEN_PP, C_PP, "timesheet", PDF);
    await readAndConfirm(C_PP, "田中 太郎");
    assert.equal((await step(C_PP, "invoice_created")).statusCode, 200);
  }
});
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
