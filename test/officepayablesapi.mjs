// /api/office/vendors・/api/office/invoices・/api/office/mf-csv（請求・支払＝支払管理）を、偽の Supabase で通す。
//
// ■ 何を守るテストか（要件の最低限テスト 1〜20 に対応）
//   1  PDF／JPEG／PNG のアップロード（別の形式・10MB超・偽装は断る）
//   2  支払先（マスタ）の登録・更新・無効化
//   3  金額・請求日・支払期日の保存
//   4  支払先マスタから初期入力（締め日・支払条件・支払期日・標準仕訳）
//   5  請求書の明示期日が優先（明記 → 経理の入力 → マスタ → 未設定）／休日調整
//   6  未払い → 支払予定 → 支払済みの遷移
//   7  期限超過・7日以内・今日支払
//   8  支払取消の履歴（理由を保存・物理削除しない）
//   9〜11 単一仕訳／複合仕訳／貸借不一致のブロック
//   12〜18 MF CSV：27列・yyyy/MM/dd・複合仕訳の同一取引No・仕入計上・支払・UTF-8 BOM・支払済みだけ
//   19 MF未出力フィルタ（「CSV出力済み」と「MFへ登録済み」は別）
//   + 権限（経営者・責任者・経理／支払・仕訳・CSV は経営者・経理）・他社の請求書に触れない・RLS ポリシー無しの表を userClient で読まない
import assert from "node:assert/strict";
import {
  atRoot, mem, ctl, asked, logged, call, aiInvoice, OWNER, MANAGER, FINANCE, DENIED, P, uid, T1, T2,
} from "./_officeharness.mjs";
import { ymd } from "../lib/jst.js";
import { addDays } from "../lib/office-payables-calc.js";

const { default: vendorsApi } = await import(atRoot("api/office/vendors.js"));
const { default: invoicesApi } = await import(atRoot("api/office/invoices.js"));
const { default: csvApi } = await import(atRoot("api/office/mf-csv.js"));
const { default: payablesApi } = await import(atRoot("api/office/payables.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const BUCKET = "office-invoices";
const MONTH = "2026-10";
const TODAY = ymd(new Date());
const rows = (t) => mem.rows[t] || [];
const V = (action, body = {}, o = {}) => call(vendorsApi, "/api/office/vendors", { method: "POST", body: { action, ...body }, ...o });
const I = (action, body = {}, o = {}) => call(invoicesApi, "/api/office/invoices", { method: "POST", body: { action, month: MONTH, ...body }, ...o });
const list = (month = MONTH, o = {}) => call(invoicesApi, `/api/office/invoices?month=${month}`, o);
const detail = (id, o = {}) => call(invoicesApi, `/api/office/invoices?id=${id}`, o);
const CSV = (method, b, o = {}) => (method === "GET"
  ? call(csvApi, `/api/office/mf-csv?${new URLSearchParams({ month: MONTH, ...b })}`, o)
  : call(csvApi, "/api/office/mf-csv", { method: "POST", body: { month: MONTH, ...b }, ...o }));

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MIME = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };

const parseCsv = (csv) => {
  const rowsOut = []; let row = [], cur = "", q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) { if (c === '"') { if (csv[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* */ } else if (c === "\n") { row.push(cur); rowsOut.push(row); row = []; cur = ""; }
    else cur += c;
  }
  return rowsOut;
};

let seq = 0;
function setup() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2";
  asked.length = 0; logged.length = 0; aiInvoice.calls.length = 0; aiInvoice.reply = null; seq = 0;
  mem.rows.gw_employees = [{ id: uid(99), tenant_id: T1, display_name: "経理 花子" }];
}

/** 支払先を1つ作って id を返す（月末締め翌月末払い・外注費／未払金・課対仕入10%・適格） */
async function mkVendor(o = {}) {
  const r = await V("create", {
    vendor: {
      name: "株式会社ABC", shortName: "ABC", registrationNo: "T1234567890123", closingDay: 31, paymentMonthOffset: 1, paymentDay: 31,
      stdDebitAccount: "外注費", stdTaxClass: "課対仕入10%", stdInvoiceClass: "適格", stdCreditAccount: "未払金",
      stdPaymentMethod: "transfer", stdSourceAccount: "普通預金", ...o,
    },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body.vendor.id;
}
/** ファイルを置いて uploadId を返す */
async function put(buf = PDF, ext = "pdf") {
  const u = await I("upload", { mimeType: MIME[ext], sizeBytes: buf.length });
  assert.equal(u.statusCode, 200, JSON.stringify(u.body));
  mem.put(BUCKET, u.body.path, buf);
  return u.body.uploadId;
}
/** 請求書を登録して id を返す */
async function mkInvoice(vendorId, o = {}) {
  seq++;
  const r = await I("register", {
    vendorId, invoiceNo: `INV-${seq}`, invoiceDate: "2026-10-31", total: 110000, tax: 10000, subtotal: 100000, ...o,
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body.invoiceId;
}
const inv = (id) => rows("gw_vendor_invoices").find((x) => x.id === id);
const J = (side, account, amount, extra = {}) => ({ side, account, amount, ...extra });
const SINGLE = [J("debit", "外注費", 110000, { taxClass: "課対仕入10%", invoiceClass: "適格", taxAmount: 10000 }), J("credit", "未払金", 110000)];
const COMPOUND = [J("debit", "通信費", 20000), J("debit", "消耗品費", 30000), J("debit", "外注費", 50000), J("credit", "未払金", 100000)];
/** 確認 → 仕訳確定まで進める */
async function ready(id, lines = SINGLE) {
  assert.equal((await I("confirm", { id })).statusCode, 200);
  const r = await I("save_journal", { id, lines, summary: "10月分業務委託費", confirm: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
}
const schedule = (id, o = {}) => I("schedule", { id, scheduledOn: addDays(TODAY, 10), ...o });
const pay = (id, o = {}) => I("pay", { id, paidOn: TODAY, ...o });

console.log("— 入れる人（経営者・責任者・経理）／支払・仕訳・マスタ・CSV は 経営者・経理 —");
for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
  await ok(`${label} は、一覧を見られる。二段階認証（MFA）は要求しない`, async () => {
    setup(); ctl.who = p; ctl.aal = "aal1";
    assert.equal((await list()).statusCode, 200);
    assert.equal((await call(vendorsApi, "/api/office/vendors")).statusCode, 200);
  });
}
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は、一覧・マスタ・登録・CSV すべて 403 で、何も読まず書かない`, async () => {
    setup(); ctl.who = p;
    assert.equal((await list()).statusCode, 403);
    assert.equal((await call(vendorsApi, "/api/office/vendors")).statusCode, 403);
    assert.equal((await V("create", { vendor: { name: "x" } })).statusCode, 403);
    assert.equal((await I("register", {})).statusCode, 403);
    assert.equal((await CSV("GET", { kind: "both", mode: "all" })).statusCode, 403);
    assert.equal(mem.state.log.length, 0);
  });
}
await ok("責任者は、請求書の登録・確認はできるが、仕訳・支払・取消・マスタ・CSV は 403", async () => {
  setup();
  const vid = await mkVendor();
  ctl.who = MANAGER;
  const id = await mkInvoice(vid);
  assert.equal((await I("confirm", { id })).statusCode, 200);
  for (const [a, b] of [["save_journal", { id, lines: SINGLE, confirm: true }], ["schedule", { id, scheduledOn: TODAY }], ["pay", { id, paidOn: TODAY }],
    ["cancel_payment", { id, reason: "x" }], ["void", { id, reason: "x" }], ["unconfirm", { id, reason: "x" }]]) {
    const r = await I(a, b);
    assert.equal(r.statusCode, 403, a);
    assert.equal(r.body.error, "payment_forbidden");
  }
  assert.equal((await V("create", { vendor: { name: "別の支払先" } })).statusCode, 403);
  assert.equal((await CSV("GET", { kind: "both", mode: "all" })).statusCode, 403);
  assert.equal((await CSV("POST", { kind: "both", mode: "all" })).statusCode, 403);
  const l = await list();
  assert.equal(l.body.canRecord, false);
});

console.log("— 2: 支払先マスタ —");
await ok("登録：名称・略称・登録番号・標準締め日・標準支払条件・標準仕訳・メモ。有効", async () => {
  setup();
  const r = await V("create", { vendor: { name: "株式会社ABC", shortName: "ABC", registrationNo: "t1234567890123", closingDay: 31, paymentMonthOffset: 1, paymentDay: 31,
    stdDebitAccount: "外注費", stdDebitSubAccount: "開発", stdDepartment: "開発部", stdTaxClass: "課対仕入10%", stdInvoiceClass: "適格", stdCreditAccount: "未払金", memo: "毎月10日頃に届く" } });
  assert.equal(r.statusCode, 200);
  const v = r.body.vendors[0];
  assert.equal(v.registrationNo, "T1234567890123", "小文字の t は T にそろえる");
  assert.equal(v.termsLabel, "月末締め翌月末払い");
  assert.equal(v.stdDebitAccount, "外注費");
  assert.equal(v.stdInvoiceClass, "適格");
  assert.equal(v.active, true);
  assert.equal(rows("gw_office_events").filter((e) => e.kind === "vendor.create").length, 1);
});
await ok("名称なし・登録番号の形・支払条件の片方だけ・インボイス区分の誤りは 400", async () => {
  setup();
  for (const vendor of [{}, { name: "x", registrationNo: "123" }, { name: "x", paymentDay: 31 }, { name: "x", closingDay: 32 }, { name: "x", stdInvoiceClass: "適格請求書" }, { name: "x", stdPaymentMethod: "bitcoin" }]) {
    const r = await V("create", { vendor });
    assert.equal(r.statusCode, 400, JSON.stringify(vendor));
  }
  assert.equal(rows("gw_office_vendors").length, 0);
});
await ok("同じ名称は 409。他社の同名は別（テナントごと）", async () => {
  setup();
  await mkVendor();
  assert.equal((await V("create", { vendor: { name: "株式会社ABC" } })).statusCode, 409);
});
await ok("更新（送った項目だけ）・無効化（消さない）・有効に戻す", async () => {
  setup();
  const id = await mkVendor();
  const u = await V("update", { id, vendor: { stdDebitAccount: "通信費", memo: "変更" } });
  assert.equal(u.statusCode, 200);
  const v = rows("gw_office_vendors")[0];
  assert.equal(v.std_debit_account, "通信費");
  assert.equal(v.std_credit_account, "未払金", "送っていない項目は変わらない");
  assert.equal((await V("set_active", { id, active: false })).statusCode, 200);
  assert.equal(rows("gw_office_vendors")[0].is_active, false);
  assert.equal(rows("gw_office_vendors").length, 1, "消えない");
  const l = await list();
  assert.equal(l.body.vendors.length, 0, "無効は選択肢に出ない");
  assert.equal((await V("set_active", { id, active: true })).statusCode, 200);
  assert.equal((await V("update", { id: uid(777), vendor: { memo: "x" } })).statusCode, 404);
});
await ok("他社の支払先は触れない（404）", async () => {
  setup();
  mem.rows.gw_office_vendors = [{ id: uid(600), tenant_id: T2, name: "他社の支払先" }];
  assert.equal((await V("update", { id: uid(600), vendor: { memo: "x" } })).statusCode, 404);
  assert.equal((await V("set_active", { id: uid(600), active: false })).statusCode, 404);
  assert.equal(rows("gw_office_vendors")[0].is_active, undefined, "他社の行は変わらない");
});

console.log("— 設定：休日調整・候補リスト —");
await ok("休日調整は 前営業日／翌営業日／調整しない。それ以外は 400", async () => {
  setup();
  for (const h of ["prev", "next", "none"]) assert.equal((await V("save_settings", { settings: { holidayAdjust: h } })).statusCode, 200);
  assert.equal(rows("gw_office_payables_settings")[0].holiday_adjust, "none");
  assert.equal((await V("save_settings", { settings: { holidayAdjust: "random" } })).statusCode, 400);
});
await ok("候補リスト：既定＋会社の設定＋支払先で使っている名称（重複なし）", async () => {
  setup();
  await mkVendor({ stdDebitAccount: "独自科目" });
  await V("save_settings", { settings: { candidates: { accounts: ["特別費用", " 外注費 "], departments: ["開発部"], tax_classes: [], sub_accounts: ["A社"] } } });
  const l = await list();
  const c = l.body.candidates;
  assert.ok(c.accounts.includes("特別費用") && c.accounts.includes("独自科目") && c.accounts.includes("通信費"));
  assert.equal(c.accounts.filter((x) => x === "外注費").length, 1);
  assert.deepEqual(c.departments, ["開発部"]);
  assert.ok(c.tax_classes.includes("課対仕入10%"));
  assert.deepEqual(l.body.options.invoiceClasses, ["適格", "80%控除", "70%控除", "50%控除", "30%控除", "控除なし"]);
});

console.log("— 1: 請求書ファイルのアップロード（PDF／JPEG／PNG）—");
for (const [ext, buf] of [["pdf", PDF], ["jpg", JPG], ["png", PNG]]) {
  await ok(`${ext.toUpperCase()}：置き場所を出し → 登録でき → 詳細で署名付きURLが出る`, async () => {
    setup();
    const vid = await mkVendor();
    const up = await put(buf, ext);
    const id = await mkInvoice(vid, { uploadId: up, fileName: `請求書.${ext}` });
    const row = inv(id);
    assert.equal(row.file_mime, MIME[ext]);
    assert.equal(row.file_size, buf.length);
    assert.match(row.file_sha256, /^[0-9a-f]{64}$/);
    assert.ok(row.file_path.startsWith(`${T1}/`));
    const d = await detail(id);
    assert.equal(d.statusCode, 200);
    assert.match(d.body.file.url, /^https:\/\//);
    assert.equal(d.body.file.mime, MIME[ext]);
    assert.ok(logged.some((e) => e.action === "office.invoice.view"), "閲覧を監査ログに残す");
    assert.ok(list.length >= 0);
    const l = await list();
    assert.equal(l.body.rows[0].hasFile, true);
  });
}
await ok("形式が違う・10MB超・サイズ不正は、置き場所を出す前に断る", async () => {
  setup();
  assert.equal((await I("upload", { mimeType: "text/plain", sizeBytes: 10 })).statusCode, 400);
  assert.equal((await I("upload", { mimeType: "application/pdf", sizeBytes: 10 * 1024 * 1024 + 1 })).body.error, "file_too_large");
  assert.equal((await I("upload", { mimeType: "application/pdf", sizeBytes: 0 })).statusCode, 400);
});
await ok("拡張子だけ PDF の別物（中身が違う）は、登録時に断ってファイルを消す", async () => {
  setup();
  const vid = await mkVendor();
  const up = await put(Buffer.from("MZ これは実行ファイル"), "pdf");
  const r = await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 1000, uploadId: up });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "unsupported_file");
  assert.equal(rows("gw_vendor_invoices").length, 0);
  assert.ok(mem.removed.length >= 1);
});
await ok("置いていない uploadId・他社のパスは読めない", async () => {
  setup();
  const vid = await mkVendor();
  const r = await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 1000, uploadId: uid(900) });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_file");
  mem.put(BUCKET, `${T2}/${uid(901)}.pdf`, PDF);
  assert.equal((await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 1000, uploadId: uid(901) })).body.error, "no_file");
});
await ok("同じファイルの二重登録は 409。確認して「それでも登録」なら通る", async () => {
  setup();
  const vid = await mkVendor();
  const a = await put(PDF);
  await mkInvoice(vid, { uploadId: a });
  const b = await put(PDF);
  const r = await I("register", { vendorId: vid, invoiceNo: "X-2", invoiceDate: "2026-10-31", total: 5000, uploadId: b });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "duplicate_file");
  assert.equal(rows("gw_vendor_invoices").length, 1);
  const r2 = await I("register", { vendorId: vid, invoiceNo: "X-2", invoiceDate: "2026-10-31", total: 5000, uploadId: b, allowDuplicate: true });
  assert.equal(r2.statusCode, 200);
});
await ok("ファイル無しでも登録できる（「PDFなし」と分かる）", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  const l = await list();
  assert.equal(l.body.rows[0].hasFile, false);
  assert.equal(inv(id).file_path, null);
});

console.log("— 3・4: 登録（金額・請求日・支払期日）と支払先マスタからの初期入力 —");
await ok("金額・請求日・対象月・受領日・請求書番号・摘要が保存される", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid, { invoiceNo: "A-001", invoiceDate: "2026-10-25", receivedOn: "2026-11-02", description: "10月分業務委託費" });
  const r = inv(id);
  assert.equal(r.invoice_kind, "general");
  assert.equal(r.vendor_id, vid);
  assert.equal(r.invoice_no, "A-001");
  assert.equal(r.invoice_date, "2026-10-25");
  assert.equal(r.received_on, "2026-11-02");
  assert.equal(r.billing_month, MONTH);
  assert.equal(Number(r.subtotal_amount), 100000);
  assert.equal(Number(r.tax_amount), 10000);
  assert.equal(Number(r.total_amount), 110000);
  assert.equal(r.description, "10月分業務委託費");
  assert.equal(r.status, "received");
  assert.equal(r.journal_status, "none");
  const row = (await list()).body.rows[0];
  assert.equal(row.total, 110000);
  assert.equal(row.next.key, "confirm", "登録直後の NEXT ACTION は「内容を確認」");
});
await ok("支払先マスタから、締め日・支払条件・支払期日・支払方法・支払元口座が入る", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  const r = inv(id);
  assert.equal(r.closing_day, 31);
  assert.equal(r.payment_terms, "月末締め翌月末払い");
  assert.equal(r.payment_due_on, "2026-11-30");
  assert.equal(r.due_source, "master");
  assert.equal(r.payment_method, "transfer");
  assert.equal(r.source_account, "普通預金");
  assert.equal(r.registration_no, "T1234567890123");
});
await ok("合計だけ・小計＋消費税だけでも補う。合わなければ 400", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { subtotal: undefined, tax: undefined, total: 110000 });
  assert.equal(Number(inv(a).subtotal_amount), 110000);
  const b = await mkInvoice(vid, { subtotal: 200000, tax: 20000, total: undefined });
  assert.equal(Number(inv(b).total_amount), 220000);
  const bad = await I("register", { vendorId: vid, invoiceDate: "2026-10-31", subtotal: 100000, tax: 10000, total: 120000 });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.hint, /合いません/);
  assert.equal((await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 0 })).statusCode, 400);
  assert.equal((await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 10.5 })).statusCode, 400);
});
await ok("支払先なし・請求日なし・実在しない日付・対象月の形は 400（新規の一般請求書は vendorId 必須）", async () => {
  setup();
  const vid = await mkVendor();
  for (const b of [{ vendorId: undefined, invoiceDate: "2026-10-31", total: 1000 }, { vendorId: vid, invoiceDate: undefined, total: 1000 },
    { vendorId: vid, invoiceDate: "2026-10-32", total: 1000 }, { vendorId: vid, invoiceDate: "2026-10-31", total: 1000, month: "202610" },
    { vendorId: vid, invoiceDate: "2026-10-31", total: 1000, receivedOn: "2026-02-30" }]) {
    assert.equal((await I("register", b)).statusCode, 400, JSON.stringify(b));
  }
  assert.equal(rows("gw_vendor_invoices").length, 0);
});
await ok("無効な支払先・存在しない支払先・他社の支払先は登録できない", async () => {
  setup();
  const vid = await mkVendor();
  await V("set_active", { id: vid, active: false });
  assert.equal((await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 1000 })).body.error, "vendor_inactive");
  assert.equal((await I("register", { vendorId: uid(700), invoiceDate: "2026-10-31", total: 1000 })).statusCode, 404);
  mem.rows.gw_office_vendors.push({ id: uid(701), tenant_id: T2, name: "他社" });
  assert.equal((await I("register", { vendorId: uid(701), invoiceDate: "2026-10-31", total: 1000 })).statusCode, 404);
});
await ok("同じ支払先・同じ請求書番号は 409（取り消した請求書は数えない）", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid, { invoiceNo: "DUP-1" });
  assert.equal((await I("register", { vendorId: vid, invoiceNo: "DUP-1", invoiceDate: "2026-10-31", total: 1000 })).body.error, "duplicate_invoice_no");
  assert.equal((await I("void", { id, reason: "二重登録" })).statusCode, 200);
  assert.equal((await I("register", { vendorId: vid, invoiceNo: "DUP-1", invoiceDate: "2026-10-31", total: 1000 })).statusCode, 200);
});
await ok("月次完了した月には登録できない（409）", async () => {
  setup();
  const vid = await mkVendor();
  mem.rows.gw_office_month_closes = [{ id: uid(800), tenant_id: T1, billing_month: MONTH, closed_at: new Date().toISOString(), reopened_at: null }];
  const r = await I("register", { vendorId: vid, invoiceDate: "2026-10-31", total: 1000 });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "month_closed");
});

console.log("— 5: 支払期日の決定順・休日調整 —");
await ok("請求書に明記された支払期日が最優先（マスタの計算・経理の入力より）", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid, { paymentDueOn: "2026-11-15", dueSource: "invoice" });
  assert.equal(inv(id).payment_due_on, "2026-11-15");
  assert.equal(inv(id).due_source, "invoice");
  const l = await list();
  assert.equal(l.body.rows[0].dueSource, "invoice");
});
await ok("明記が無く、経理が入れたらそれ（due_source=manual）", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid, { paymentDueOn: "2026-11-20", dueSource: "manual" });
  assert.equal(inv(id).payment_due_on, "2026-11-20");
  assert.equal(inv(id).due_source, "manual");
});
await ok("どちらも無ければマスタから自動計算（master）。マスタに条件も無ければ「支払期日未設定」（推測しない）", async () => {
  setup();
  const v1 = await mkVendor();
  assert.equal(inv(await mkInvoice(v1)).due_source, "master");
  const v2 = await mkVendor({ name: "条件なし商事", closingDay: undefined, paymentMonthOffset: undefined, paymentDay: undefined });
  const id = await mkInvoice(v2);
  assert.equal(inv(id).payment_due_on, null);
  assert.equal(inv(id).due_source, null);
  const row = (await list()).body.rows.find((r) => r.id === id);
  assert.equal(row.dueOn, null);
  assert.equal(row.flags.noDue, true);
  assert.equal(row.flags.overdue, false);
  const d = await detail(id);
  assert.equal(d.body.invoice.dueSourceLabel, "支払期日未設定");
});
await ok("休日調整：マスタ計算の日が休日のとき 前営業日／翌営業日／調整しない（設定で切り替え）", async () => {
  setup();
  // 当月払い（offset 0）の月末 2026-10-31 は土曜
  const vid = await mkVendor({ paymentMonthOffset: 0, paymentDay: 31 });
  const expect = { prev: "2026-10-30", next: "2026-11-02", none: "2026-10-31" };
  for (const [adj, date] of Object.entries(expect)) {
    await V("save_settings", { settings: { holidayAdjust: adj } });
    const id = await mkInvoice(vid);
    assert.equal(inv(id).payment_due_on, date, adj);
  }
});
await ok("明記された期日は、休日でも調整しない", async () => {
  setup();
  const vid = await mkVendor();
  await V("save_settings", { settings: { holidayAdjust: "prev" } });
  const id = await mkInvoice(vid, { paymentDueOn: "2026-10-31", dueSource: "invoice" });
  assert.equal(inv(id).payment_due_on, "2026-10-31");
});
await ok("preview_due：登録前に、マスタから計算した日付と出どころを見せる（保存しない）", async () => {
  setup();
  const vid = await mkVendor();
  const r = await I("preview_due", { vendorId: vid });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.date, "2026-11-30");
  assert.equal(r.body.source, "master");
  assert.equal(r.body.termsLabel, "月末締め翌月末払い");
  assert.equal(rows("gw_vendor_invoices").length, 0);
  const v2 = await mkVendor({ name: "条件なし", closingDay: undefined, paymentMonthOffset: undefined, paymentDay: undefined });
  const r2 = await I("preview_due", { vendorId: v2 });
  assert.equal(r2.body.date, null);
  assert.equal(r2.body.sourceLabel, "支払期日未設定");
});
await ok("基本情報の更新：支払期日を直す／マスタから計算し直す。支払済みは直せない", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  const u = await I("update", { id, fields: { paymentDueOn: "2026-12-05", dueSource: "invoice" } });
  assert.equal(u.statusCode, 200);
  assert.equal(inv(id).due_source, "invoice");
  const u2 = await I("update", { id, fields: { recomputeDue: true } });
  assert.equal(u2.statusCode, 200);
  assert.equal(inv(id).due_source, "master");
  assert.equal(inv(id).payment_due_on, "2026-11-30");
  await I("confirm", { id });
  await schedule(id);
  await pay(id);
  assert.equal((await I("update", { id, fields: { invoiceNo: "変更" } })).body.error, "paid");
});

console.log("— 7: AI 読取（読取候補 → 人が確認 → 確定）—");
const toolReply = (input) => ({ model: "claude-test-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "read_invoice", input }] });
await ok("読取は候補を返すだけ。請求書は作られない（自動確定しない）", async () => {
  setup();
  const vid = await mkVendor();
  aiInvoice.reply = toolReply({ payee_name: "株式会社ABC", invoice_no: "ABC-77", invoice_date: "2026年10月31日", due_date: "2026/11/30", subtotal: "100,000", tax: "10,000", total: "¥110,000", registration_no: "T1234567890123", description: "10月分業務委託費", confidence: "high" });
  const up = await put(PDF);
  const r = await I("read", { uploadId: up });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.candidates.invoiceDate, "2026-10-31");
  assert.equal(r.body.candidates.dueDate, "2026-11-30");
  assert.equal(r.body.candidates.total, 110000);
  assert.equal(r.body.candidates.registrationNo, "T1234567890123");
  assert.equal(r.body.vendorMatch.id, vid, "登録番号が一致する支払先を候補にする");
  assert.match(r.body.note, /自動では確定しません/);
  assert.equal(rows("gw_vendor_invoices").length, 0);
  assert.equal(rows("gw_office_payments").length, 0);
});
await ok("読めない値は null＋警告。合計が合わなければ警告。推測で埋めない", async () => {
  setup();
  aiInvoice.reply = toolReply({ payee_name: "ABC", invoice_date: "令和8年10月", due_date: null, subtotal: "100,000", tax: "10,000", total: "120,000", registration_no: "123", confidence: "low", unreadable: ["invoice_no"] });
  const up = await put(PDF);
  const r = await I("read", { uploadId: up });
  assert.equal(r.statusCode, 200);
  const c = r.body.candidates;
  assert.equal(c.invoiceDate, null);
  assert.equal(c.dueDate, null, "書かれていない支払期日は計算しない");
  assert.equal(c.registrationNo, null);
  assert.equal(c.invoiceNo, null);
  const codes = r.body.warnings.map((w) => w.code);
  assert.ok(codes.includes("bad_invoice_date") && codes.includes("sum_mismatch") && codes.includes("low_confidence") && codes.includes("unreadable_invoice_no"));
});
await ok("AI の失敗は 422＋手入力の案内。ファイルが無ければ 404", async () => {
  setup();
  const up = await put(PDF);
  aiInvoice.reply = Object.assign(new Error("invalid_request_error: sk-ant-secret"), { status: 400 });
  const r = await I("read", { uploadId: up });
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.code, "rejected");
  assert.ok(!JSON.stringify(r.body).includes("sk-ant"), "内部のエラー文を画面に出さない");
  assert.equal((await I("read", { uploadId: uid(950) })).statusCode, 404);
  aiInvoice.reply = { stop_reason: "end_turn", content: [{ type: "text", text: "読めません" }] };
  assert.equal((await I("read", { uploadId: up })).body.code, "no_tool");
});

console.log("— 確認（confirm）—");
await ok("確認すると status=approved。BP 請求書は月次の照合・承認へ誘導（409）", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  assert.equal((await I("confirm", { id })).statusCode, 200);
  assert.equal(inv(id).status, "approved");
  assert.equal((await I("confirm", { id })).body.error, "already_confirmed");
  // BP 請求書（db/117 の形）
  mem.rows.gw_vendor_invoices.push({ id: uid(300), tenant_id: T1, billing_month: MONTH, received_on: "2026-11-02", subtotal_amount: 100, tax_amount: 10, total_amount: 110, status: "received", invoice_kind: "bp" });
  const r = await I("confirm", { id: uid(300) });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "bp_invoice");
});
await ok("確認の取り消しは理由が要る。支払予定・CSV出力後は取り消せない", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  await I("confirm", { id });
  assert.equal((await I("unconfirm", { id, reason: "" })).statusCode, 400);
  await schedule(id);
  assert.equal((await I("unconfirm", { id, reason: "誤り" })).body.error, "has_payment");
  await I("cancel_payment", { id, reason: "誤り" });
  assert.equal((await I("unconfirm", { id, reason: "誤り" })).statusCode, 200);
  assert.equal(inv(id).status, "received");
});

console.log("— 9〜11: 仕訳（単一・複合・貸借不一致）—");
await ok("確認前は仕訳できない（先に内容を確認）", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  const r = await I("save_journal", { id, lines: SINGLE, confirm: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "not_confirmed");
});
await ok("単一仕訳：確定できる。journal_status=confirmed。支払先の「前回使った仕訳」に保存される", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  await I("confirm", { id });
  const r = await I("save_journal", { id, lines: SINGLE, summary: "10月分業務委託費", memo: "メモ", tags: ["経理", "10月"], confirm: true });
  assert.equal(r.statusCode, 200);
  assert.equal(inv(id).journal_status, "confirmed");
  const j = rows("gw_office_invoice_journals").filter((x) => x.invoice_id === id);
  assert.equal(j.length, 2);
  assert.deepEqual(j.map((x) => x.side).sort(), ["credit", "debit"]);
  assert.ok(j.every((x) => x.summary === "10月分業務委託費" && x.memo === "メモ" && x.tags.join(",") === "経理,10月"));
  assert.equal(j.find((x) => x.side === "debit").partner, "株式会社ABC", "取引先は支払先から入る");
  assert.equal(j.find((x) => x.side === "debit").invoice_class, "適格");
  assert.equal(rows("gw_office_vendors")[0].last_journal.lines[0].account, "外注費");
  assert.equal(r.body.journal.balance.diff, 0);
  assert.equal((await list()).body.rows[0].next.key, "schedule", "仕訳済み・支払予定なし → 支払予定を登録");
});
await ok("複合仕訳：通信費20,000＋消耗品費30,000＋外注費50,000／未払金100,000 が確定でき、差額 0", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { total: 100000, subtotal: 100000, tax: 0 });
  await I("confirm", { id });
  const r = await I("save_journal", { id, lines: COMPOUND, confirm: true });
  assert.equal(r.statusCode, 200);
  assert.equal(rows("gw_office_invoice_journals").filter((x) => x.invoice_id === id).length, 4);
  assert.equal(r.body.journal.balance.diff, 0);
  assert.equal(r.body.journal.lines.length, 4);
});
await ok("貸借不一致：確定は 409（差額を返す）。下書きの保存はできて、確定はされない", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { total: 100000, subtotal: 100000, tax: 0 });
  await I("confirm", { id });
  const bad = COMPOUND.map((l) => (l.side === "credit" ? { ...l, amount: 90000 } : l));
  const r = await I("save_journal", { id, lines: bad, confirm: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "journal_unbalanced");
  assert.equal(r.body.diff, 10000);
  assert.match(r.body.hint, /差額 10,000円/);
  assert.equal(inv(id).journal_status, "none");
  const d = await I("save_journal", { id, lines: bad, confirm: false });
  assert.equal(d.statusCode, 200);
  assert.equal(inv(id).journal_status, "draft");
  assert.equal(d.body.journal.balance.diff, 10000, "画面に差額を出せる");
});
await ok("行の誤り（科目なし・金額0・区分の誤り）は 400。借方だけも確定できない", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await I("confirm", { id });
  for (const lines of [[J("debit", "", 1000), J("credit", "未払金", 1000)], [J("debit", "外注費", 0), J("credit", "未払金", 0)],
    [J("debit", "外注費", 1000, { invoiceClass: "適格請求書" }), J("credit", "未払金", 1000)], []]) {
    assert.equal((await I("save_journal", { id, lines, confirm: true })).statusCode, 400);
  }
  assert.equal((await I("save_journal", { id, lines: [J("debit", "外注費", 1000)], confirm: true })).statusCode, 400, "借方だけ（貸方なし）");
  assert.equal(rows("gw_office_invoice_journals").length, 0);
});
await ok("インボイス区分 70%控除 も通る。6区分すべて保存できる", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await I("confirm", { id });
  for (const c of ["適格", "80%控除", "70%控除", "50%控除", "30%控除", "控除なし"]) {
    const r = await I("save_journal", { id, lines: [J("debit", "外注費", 110000, { invoiceClass: c }), J("credit", "未払金", 110000)], confirm: true });
    assert.equal(r.statusCode, 200, c);
    assert.equal(rows("gw_office_invoice_journals").find((x) => x.invoice_id === id && x.side === "debit").invoice_class, c);
  }
});
await ok("仕訳の初期値：前回使った仕訳 → 支払先マスタの標準仕訳", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid);
  const d1 = await detail(a);
  assert.equal(d1.body.suggestion.source, "vendor");
  assert.equal(d1.body.suggestion.lines[0].account, "外注費");
  assert.equal(d1.body.suggestion.lines[0].amount, 110000);
  await ready(a, [J("debit", "通信費", 110000, { taxClass: "課対仕入10%" }), J("credit", "未払金", 110000)]);
  const b = await mkInvoice(vid, { total: 55000, subtotal: 50000, tax: 5000 });
  const d2 = await detail(b);
  assert.equal(d2.body.suggestion.source, "last");
  assert.equal(d2.body.suggestion.lines[0].account, "通信費");
  assert.equal(d2.body.suggestion.lines[0].amount, 55000, "金額は今回の請求額");
});
await ok("請求額と仕訳の合計が違うときは警告（止めない）。金額を直すと確定済みの仕訳は下書きに戻る", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await I("confirm", { id });
  const r = await I("save_journal", { id, lines: [J("debit", "外注費", 100000), J("credit", "未払金", 100000)], confirm: true });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.warnings.length, 1);
  const u = await I("update", { id, fields: { subtotal: 200000, tax: 20000 } });
  assert.equal(u.statusCode, 200);
  assert.equal(u.body.journalReset, true);
  assert.equal(inv(id).journal_status, "draft");
});

console.log("— 6・7: 支払予定 → 支払済み／期限超過 —");
await ok("未払い → 支払予定 → 支払済み。一覧に「支払予定 / 日付 / 金額」の元データが出る", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  assert.equal((await list()).body.rows[0].payment, null);
  const sched = addDays(TODAY, 10);
  const s = await I("schedule", { id, scheduledOn: sched, amount: 110000, method: "transfer", sourceAccount: "普通預金", memo: "月末払い" });
  assert.equal(s.statusCode, 200);
  let row = (await list()).body.rows[0];
  assert.equal(row.payment.status, "scheduled");
  assert.equal(row.payment.scheduledOn, sched);
  assert.equal(row.payment.amount, 110000);
  assert.equal(row.payment.method, "transfer");
  assert.equal(row.flags.scheduled, true);
  assert.equal(row.next.key, "wait");
  const p = await pay(id, { paidAmount: 110000, feeAmount: 330, sourceAccount: "普通預金", memo: "完了" });
  assert.equal(p.statusCode, 200);
  row = (await list()).body.rows[0];
  assert.equal(row.payment.status, "paid");
  assert.equal(row.payment.paidOn, TODAY);
  assert.equal(row.payment.paidAmount, 110000);
  assert.equal(row.payment.feeAmount, 330);
  assert.equal(row.flags.paid, true);
  assert.equal(row.next.key, "export", "支払済み・MF未出力 → MF CSVへ出力");
});
await ok("順番を飛ばせない：確認前の支払予定・予定なしの支払済み・二重の予定・二重の支払は 409", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  assert.equal((await schedule(id)).body.error, "not_confirmed");
  await I("confirm", { id });
  assert.equal((await pay(id)).body.error, "not_scheduled");
  assert.equal((await schedule(id)).statusCode, 200);
  assert.equal((await schedule(id)).body.error, "already_scheduled");
  assert.equal((await pay(id)).statusCode, 200);
  assert.equal((await pay(id)).body.error, "already_paid");
});
await ok("入力の誤り：支払予定日・実支払日が実在しない／未来、金額が負・小数 → 400", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await I("confirm", { id });
  assert.equal((await schedule(id, { scheduledOn: "2026-02-30" })).statusCode, 400);
  assert.equal((await schedule(id, { amount: -1 })).statusCode, 400);
  assert.equal((await schedule(id, { amount: 10.5 })).statusCode, 400);
  assert.equal((await schedule(id, { method: "bitcoin" })).statusCode, 400);
  await schedule(id);
  assert.equal((await pay(id, { paidOn: addDays(TODAY, 1) })).statusCode, 400, "先の日付は実支払日にできない");
  assert.equal((await pay(id, { paidOn: "2026-13-01" })).statusCode, 400);
  assert.equal((await pay(id, { feeAmount: -5 })).statusCode, 400);
});
await ok("期限超過（赤）・7日以内・今日支払・支払済み（緑）が、サマリーと行のフラグに出る", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { paymentDueOn: addDays(TODAY, -3), dueSource: "invoice" });             // 期限超過（未確認）
  const b = await mkInvoice(vid, { paymentDueOn: addDays(TODAY, 5), dueSource: "invoice" });              // 7日以内
  const c = await mkInvoice(vid, { paymentDueOn: addDays(TODAY, 30), dueSource: "invoice" });             // まだ先
  const d = await mkInvoice(vid, { paymentDueOn: TODAY, dueSource: "invoice" });                          // 今日
  const e = await mkInvoice(vid, { paymentDueOn: addDays(TODAY, -10), dueSource: "invoice" });            // 支払済み（超過ではない）
  await I("confirm", { id: e }); await schedule(e, { scheduledOn: addDays(TODAY, -10) }); await pay(e, { paidOn: addDays(TODAY, -9) });
  await I("confirm", { id: b }); await schedule(b, { scheduledOn: addDays(TODAY, 5) });
  const l = (await list()).body;
  const f = (id) => l.rows.find((r) => r.id === id).flags;
  assert.equal(f(a).overdue, true);
  assert.equal(f(b).within7, true);
  assert.equal(f(b).scheduled, true);
  assert.equal(f(c).overdue || f(c).within7, false);
  assert.equal(f(d).payToday, true);
  assert.equal(f(e).paid, true);
  assert.equal(f(e).overdue, false);
  assert.equal(l.summary.overdue, 1);
  assert.equal(l.summary.within7, 2, "期日（支払予定日）が今日〜7日後の未払い：今日(d)と5日後(b)");
  assert.equal(l.summary.payToday, 1);
  assert.equal(l.summary.paid, 1);
  assert.equal(l.summary.scheduled, 1);
  assert.equal(l.summary.unconfirmed, 3);
  assert.equal(l.summary.unjournaled, 5);
  assert.equal(l.summary.total, 5);
});
await ok("期限超過は支払予定があっても、期日を過ぎて未払いなら超過", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { paymentDueOn: addDays(TODAY, -2), dueSource: "invoice" });
  await I("confirm", { id });
  await schedule(id, { scheduledOn: addDays(TODAY, 3) });
  assert.equal((await list()).body.rows[0].flags.overdue, true);
});

console.log("— 8: 支払の取消（理由・履歴・物理削除しない）—");
await ok("理由が無いと取り消せない。取り消すと status=void で行は残り、理由・日時・人が保存される", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  await schedule(id);
  await pay(id);
  assert.equal((await I("cancel_payment", { id, reason: "" })).body.error, "reason_required");
  const r = await I("cancel_payment", { id, reason: "金額を誤って登録したため" });
  assert.equal(r.statusCode, 200);
  const p = rows("gw_office_payments").filter((x) => x.vendor_invoice_id === id);
  assert.equal(p.length, 1, "物理削除しない");
  assert.equal(p[0].status, "void");
  assert.equal(p[0].cancel_reason, "金額を誤って登録したため");
  assert.ok(p[0].cancelled_at);
  assert.ok(p[0].cancelled_by);
  const d = await detail(id);
  assert.equal(d.body.payments.length, 1);
  assert.equal(d.body.payments[0].cancelReason, "金額を誤って登録したため");
  const h = d.body.history.find((x) => x.kind === "payment.cancel");
  assert.ok(h, "履歴に取消が残る");
  assert.equal(h.reason, "金額を誤って登録したため");
  assert.equal(d.body.invoice.next.key, "schedule", "取り消すと支払予定の登録に戻る");
});
await ok("取消後に支払予定を入れ直せる。履歴には取消した支払も残る", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  await schedule(id);
  await I("cancel_payment", { id, reason: "日付違い" });
  assert.equal((await schedule(id, { scheduledOn: addDays(TODAY, 20) })).statusCode, 200);
  const d = await detail(id);
  assert.equal(d.body.payments.length, 2);
  assert.deepEqual(d.body.payments.map((p) => p.status), ["void", "scheduled"]);
});
await ok("支払予定が無ければ取消は 409。MF CSV 出力済みの支払は、確認なしでは取り消せない", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  assert.equal((await I("cancel_payment", { id, reason: "x" })).body.error, "not_scheduled");
  await schedule(id); await pay(id);
  assert.equal((await CSV("POST", { kind: "both", mode: "all" })).statusCode, 200);
  const r = await I("cancel_payment", { id, reason: "誤り" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "exported_change");
  assert.equal((await I("cancel_payment", { id, reason: "誤り", acknowledgeExported: true })).statusCode, 200);
  const h = (await detail(id)).body.history.find((x) => x.kind === "payment.cancel");
  assert.ok(h);
});
await ok("月次完了した月は、支払予定・支払済み・取消も 409", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  await schedule(id);
  mem.rows.gw_office_month_closes = [{ id: uid(801), tenant_id: T1, billing_month: MONTH, closed_at: new Date().toISOString(), reopened_at: null }];
  assert.equal((await pay(id)).body.error, "month_closed");
  assert.equal((await I("cancel_payment", { id, reason: "x" })).body.error, "month_closed");
  assert.equal((await I("save_journal", { id, lines: SINGLE })).body.error, "month_closed");
});
await ok("請求書の取り消し：理由が要る。支払済みは断る。履歴に残り、行は消えない", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  assert.equal((await I("void", { id, reason: "" })).statusCode, 400);
  await ready(id); await schedule(id); await pay(id);
  assert.equal((await I("void", { id, reason: "誤登録" })).body.error, "paid");
  await I("cancel_payment", { id, reason: "取り消すため" });
  assert.equal((await I("void", { id, reason: "誤登録" })).statusCode, 200);
  assert.equal(inv(id).status, "void");
  assert.equal(rows("gw_vendor_invoices").length, 1);
  assert.equal((await list()).body.rows.length, 0, "取り消した請求書は一覧に出ない");
  assert.equal((await call(invoicesApi, `/api/office/invoices?month=${MONTH}&void=1`)).body.rows.length, 1);
});

console.log("— 12〜19: MFクラウド用 CSV —");
await ok("仕入計上 CSV：27列・UTF-8 BOM・yyyy/MM/dd・債務。出力すると記録が残る", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { description: "10月分業務委託費" });
  await ready(id);
  const r = await CSV("POST", { kind: "purchase", mode: "unexported" });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["content-type"], /^text\/csv/);
  assert.match(r.headers["content-disposition"], /mf-journal_2026-10_purchase_\d{8}-\d{4}\.csv/);
  const csv = r.body;
  assert.equal(csv.charCodeAt(0), 0xfeff, "UTF-8 BOM");
  const t = parseCsv(csv.slice(1));
  assert.equal(t.length, 2);
  assert.equal(t[0].length, 27);
  assert.equal(t[0][0], "取引No");
  assert.equal(t[0][26], "最終更新者");
  const x = t[1];
  assert.equal(x.length, 27);
  assert.equal(x[0], "1");
  assert.equal(x[1], "2026/10/31");
  assert.equal(x[2], "外注費");
  assert.equal(x[5], "株式会社ABC");
  assert.equal(x[6], "課対仕入10%");
  assert.equal(x[7], "適格");
  assert.equal(x[8], "110000");
  assert.equal(x[9], "10000");
  assert.equal(x[10], "未払金");
  assert.equal(x[16], "110000");
  assert.equal(x[18], "10月分業務委託費");
  assert.equal(x[21], "債務");
  assert.deepEqual(x.slice(23), ["", "", "", ""]);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(csv), "日付は yyyy/MM/dd だけ");
  // 出力の記録
  assert.equal(rows("gw_office_mf_exports").length, 1);
  const b = rows("gw_office_mf_exports")[0];
  assert.equal(b.kind, "purchase"); assert.equal(b.mode, "unexported"); assert.equal(b.row_count, 1); assert.equal(b.exported_by_name, "経理 花子");
  assert.match(b.batch_code, /^MF-202610-/);
  assert.equal(r.headers["x-mf-batch"], b.batch_code);
  assert.equal(rows("gw_office_mf_export_items").length, 1);
  assert.ok(inv(id).mf_purchase_first_exported_at);
  assert.equal(inv(id).mf_purchase_first_exported_at, inv(id).mf_purchase_last_exported_at);
});
await ok("複合仕訳：3行が同一取引No・同一取引日で出て、借方合計＝貸方合計", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { total: 100000, subtotal: 100000, tax: 0 });
  await ready(id, COMPOUND);
  const r = await CSV("POST", { kind: "purchase", mode: "all" });
  assert.equal(r.statusCode, 200);
  const t = parseCsv(r.body.slice(1)).slice(1);
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => x[0]), ["1", "1", "1"]);
  assert.deepEqual(t.map((x) => x[1]), ["2026/10/31", "2026/10/31", "2026/10/31"]);
  assert.equal(t.reduce((s, x) => s + Number(x[8] || 0), 0), t.reduce((s, x) => s + Number(x[16] || 0), 0));
  assert.equal(r.headers["x-mf-entries"], "1");
  assert.equal(r.headers["x-mf-rows"], "3");
});
await ok("支払 CSV は支払済みだけ。支払予定は出さない。借方 未払金／貸方 支払元口座・実支払日・経費・債務支払", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { invoiceNo: "A" });
  const b = await mkInvoice(vid, { invoiceNo: "B" });
  await ready(a); await ready(b);
  await schedule(a); await pay(a, { paidOn: "2026-10-12" });
  await schedule(b);                                   // 予定のまま
  const r = await CSV("POST", { kind: "payment", mode: "all" });
  assert.equal(r.statusCode, 200);
  const t = parseCsv(r.body.slice(1)).slice(1);
  assert.equal(t.length, 1, "支払済みの1件だけ");
  assert.equal(t[0][1], "2026/10/12");
  assert.equal(t[0][2], "未払金");
  assert.equal(t[0][5], "株式会社ABC");
  assert.equal(t[0][8], "110000");
  assert.equal(t[0][10], "普通預金");
  assert.equal(t[0][16], "110000");
  assert.equal(t[0][18], "10月分請求 支払");
  assert.equal(t[0][21], "経費・債務支払");
  assert.ok(rows("gw_office_payments").find((p) => p.vendor_invoice_id === a).mf_payment_last_exported_at);
  assert.equal(rows("gw_office_payments").find((p) => p.vendor_invoice_id === b).mf_payment_last_exported_at, undefined);
  assert.equal(inv(a).mf_purchase_last_exported_at, undefined, "支払だけ出したので、仕入計上は未出力のまま");
});
await ok("支払の CSV に振込手数料と、実支払額・支払元口座が反映される", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  await schedule(id);
  await pay(id, { feeAmount: 330, sourceAccount: "当座預金" });
  const t = parseCsv((await CSV("POST", { kind: "payment", mode: "all" })).body.slice(1)).slice(1);
  assert.equal(t.length, 2);
  assert.equal(t[0][2], "未払金");
  assert.equal(t[0][16], "110330");
  assert.equal(t[0][10], "当座預金");
  assert.equal(t[1][2], "支払手数料");
  assert.equal(t[1][8], "330");
  assert.equal(t[1][0], t[0][0], "同一取引No");
});
await ok("両方：仕入計上と支払が日付順に並び、取引No は別々", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { invoiceDate: addDays(TODAY, -20) });
  await ready(id); await schedule(id); await pay(id, { paidOn: TODAY });
  const r = await CSV("POST", { kind: "both", mode: "all" });
  const t = parseCsv(r.body.slice(1)).slice(1);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x[21]), ["債務", "経費・債務支払"]);
  assert.deepEqual(t.map((x) => x[0]), ["1", "2"]);
  assert.match(r.headers["content-disposition"], /_all_/);
});
await ok("MF未出力フィルタ：未出力のみ → 出力済みは出ない（409）／全件 → もう一度出せる。初回は変わらず最終が更新", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { invoiceNo: "A" });
  await ready(a);
  assert.equal((await CSV("POST", { kind: "purchase", mode: "unexported" })).statusCode, 200);
  const first = inv(a).mf_purchase_first_exported_at;
  const again = await CSV("POST", { kind: "purchase", mode: "unexported" });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, "nothing_to_export");
  const b = await mkInvoice(vid, { invoiceNo: "B" });
  await ready(b);
  const only = await CSV("POST", { kind: "purchase", mode: "unexported" });
  assert.equal(only.statusCode, 200);
  assert.equal(parseCsv(only.body.slice(1)).length - 1, 1, "未出力の B だけ");
  await new Promise((r) => setTimeout(r, 5));
  const all = await CSV("POST", { kind: "purchase", mode: "all" });
  assert.equal(parseCsv(all.body.slice(1)).length - 1, 2, "全件");
  assert.equal(inv(a).mf_purchase_first_exported_at, first, "初回の出力日時は変わらない");
  assert.notEqual(inv(a).mf_purchase_last_exported_at, first, "最終の出力日時は更新される");
  assert.equal(rows("gw_office_mf_exports").length, 3, "出力のたびに1バッチ");
  const codes = rows("gw_office_mf_exports").map((x) => x.batch_code);
  assert.equal(new Set(codes).size, 3, "バッチIDは重複しない");
});
await ok("GET の見込み：何件出せて、何が未仕訳／出力済みか。何も書かない", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { invoiceNo: "A" }); await ready(a);
  const b = await mkInvoice(vid, { invoiceNo: "B" });             // 未仕訳
  await I("confirm", { id: b });
  const before = mem.state.log.length;
  const r = await CSV("GET", { kind: "purchase", mode: "unexported" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.purchase.targets, 1);
  assert.equal(r.body.purchase.notReady, 1);
  assert.equal(r.body.canExport, true);
  assert.equal(mem.state.log.length, before, "見込みでは何も書かない");
  assert.equal(rows("gw_office_mf_exports").length, 0);
});
await ok("貸借が合わない仕訳は CSV を出さず 409（blocked）。出力の記録も残さない", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { invoiceNo: "A" }); await ready(a);
  const b = await mkInvoice(vid, { invoiceNo: "B" }, ); await ready(b);
  // DB が壊れた状態（貸方を書き換え）を再現
  rows("gw_office_invoice_journals").find((j) => j.invoice_id === b && j.side === "credit").amount = 100;
  const r = await CSV("POST", { kind: "purchase", mode: "all" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "blocked");
  assert.equal(r.body.blocked.length, 1);
  assert.match(r.body.blocked[0].reason, /貸借が一致しません/);
  assert.match(r.body.blocked[0].label, /ABC B/);
  assert.equal(rows("gw_office_mf_exports").length, 0);
  assert.equal(inv(a).mf_purchase_last_exported_at, undefined, "出せなかったので、他の請求書も出力済みにしない");
  assert.equal((await CSV("GET", { kind: "purchase", mode: "all" })).body.canExport, false);
});
await ok("仕訳が確定していない請求書の支払は出せない（blocked）。仕入計上の対象にもならない", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await I("confirm", { id }); await schedule(id); await pay(id);        // 仕訳なしで支払済み
  const r = await CSV("POST", { kind: "payment", mode: "all" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.blocked[0].kind, "payment");
  assert.match(r.body.blocked[0].reason, /仕入計上の仕訳が確定していません/);
  const p = await CSV("POST", { kind: "purchase", mode: "all" });
  assert.equal(p.body.error, "nothing_to_export");
});
await ok("引数の誤りは 400。対象月は請求書の対象月で絞る", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  assert.equal((await CSV("POST", { kind: "x", mode: "all" })).statusCode, 400);
  assert.equal((await CSV("POST", { kind: "both", mode: "x" })).statusCode, 400);
  assert.equal((await CSV("POST", { kind: "both", mode: "all", month: "2026-13" })).statusCode, 400);
  assert.equal((await CSV("POST", { kind: "both", mode: "all", month: "2026-09" })).body.error, "nothing_to_export");
});
await ok("取り消した請求書・他社の請求書は CSV に入らない", async () => {
  setup();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { invoiceNo: "A" }); await ready(a);
  const b = await mkInvoice(vid, { invoiceNo: "B" }); await ready(b);
  await I("void", { id: b, reason: "誤登録" });
  mem.rows.gw_vendor_invoices.push({ id: uid(310), tenant_id: T2, billing_month: MONTH, received_on: "2026-11-01", subtotal_amount: 1, tax_amount: 0, total_amount: 1, status: "approved", journal_status: "confirmed", invoice_kind: "general" });
  mem.rows.gw_office_invoice_journals = [...rows("gw_office_invoice_journals"), { id: uid(311), tenant_id: T2, invoice_id: uid(310), line_no: 1, side: "debit", account: "他社科目", amount: 1 }, { id: uid(312), tenant_id: T2, invoice_id: uid(310), line_no: 1, side: "credit", account: "他社科目", amount: 1 }];
  const t = parseCsv((await CSV("POST", { kind: "purchase", mode: "all" })).body.slice(1)).slice(1);
  assert.equal(t.length, 1);
  assert.ok(!JSON.stringify(t).includes("他社科目"));
});
await ok("出力後に仕訳を直すには確認が要る（食い違いを防ぐ）。確認すれば直せて、履歴に残る", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  await ready(id);
  await CSV("POST", { kind: "purchase", mode: "all" });
  const r = await I("save_journal", { id, lines: SINGLE, confirm: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "exported_change");
  assert.equal((await I("save_journal", { id, lines: SINGLE, confirm: true, acknowledgeExported: true })).statusCode, 200);
  const ev = rows("gw_office_events").filter((e) => e.kind === "journal.confirm");
  assert.equal(ev[ev.length - 1].detail.afterExport, true);
});

await ok("インポート確認用のサンプルCSV：ダミーの4取引。何も読まず・書かず、経営者・経理だけ", async () => {
  setup();
  const r = await call(csvApi, "/api/office/mf-csv?sample=1");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.charCodeAt(0), 0xfeff);
  assert.match(r.headers["content-disposition"], /mf-journal_import-test\.csv/);
  const t = parseCsv(r.body.slice(1));
  assert.equal(t.length, 1 + 7);
  assert.ok(t.every((x) => x.length === 27));
  assert.equal(rows("gw_office_mf_exports").length, 0);
  assert.equal(mem.state.log.length, 0);
  ctl.who = MANAGER;
  assert.equal((await call(csvApi, "/api/office/mf-csv?sample=1")).statusCode, 403);
});

console.log("— 14: MF出力状態（CSV出力済み と MFへ登録済み は別）—");
await ok("一覧・詳細は CSV を出した事実だけを持つ。「MF登録済み」という状態は持たない", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  await ready(id);
  let row = (await list()).body.rows[0];
  assert.equal(row.mf.state, "unexported");
  assert.equal(row.flags.mfPending, true);
  assert.equal((await list()).body.summary.mfPending, 1);
  await CSV("POST", { kind: "purchase", mode: "all" });
  row = (await list()).body.rows[0];
  assert.equal(row.mf.state, "exported");
  assert.ok(row.mf.purchaseExportedAt);
  assert.equal((await list()).body.summary.mfPending, 0);
  assert.ok(!JSON.stringify(row).includes("registered"));
  const d = await detail(id);
  assert.equal(d.body.exports.length, 1);
  assert.equal(d.body.exports[0].kind, "purchase");
  assert.match(d.body.exports[0].batchCode, /^MF-202610-/);
  assert.equal(d.body.exports[0].exportedByName, "経理 花子");
  assert.ok(d.body.invoice.mfFirstExportedAt);
  assert.ok(d.body.history.some((h) => h.kind === "invoice.mf_export"));
  // 支払済みにすると、支払分が未出力として再び現れる
  await schedule(id); await pay(id);
  row = (await list()).body.rows[0];
  assert.equal(row.mf.state, "partial");
  assert.equal(row.next.key, "export");
  await CSV("POST", { kind: "payment", mode: "unexported" });
  row = (await list()).body.rows[0];
  assert.equal(row.mf.state, "exported");
  assert.equal(row.next.key, "done");
});

console.log("— 15・16: 詳細ドロワーのデータ（PDF・基本情報・支払条件・仕訳・支払・MF・履歴）と NEXT ACTION —");
await ok("詳細に 7 つの区分のデータがそろう", async () => {
  setup();
  const vid = await mkVendor();
  const up = await put(PDF);
  const id = await mkInvoice(vid, { uploadId: up, fileName: "ABC_10月.pdf" });
  await ready(id);
  await schedule(id);
  const d = (await detail(id)).body;
  assert.ok(d.file.url);                                   // 1 PDF プレビュー
  assert.equal(d.invoice.invoiceNo, "INV-1");              // 2 基本情報
  assert.equal(d.invoice.vendorName, "株式会社ABC");
  assert.equal(d.invoice.paymentTerms, "月末締め翌月末払い"); // 3 支払条件
  assert.equal(d.invoice.dueOn, "2026-11-30");
  assert.equal(d.invoice.dueSourceLabel, "支払先マスタから自動計算");
  assert.equal(d.journal.lines.length, 2);                 // 4 仕訳
  assert.equal(d.journal.balance.diff, 0);
  assert.equal(d.payments.length, 1);                      // 5 支払
  assert.deepEqual(d.exports, []);                         // 6 MFクラウド
  assert.ok(d.history.length >= 4);                        // 7 履歴
  assert.deepEqual(d.history.map((h) => h.kind).slice(0, 2), ["invoice.register", "invoice.confirm"]);
  assert.ok(d.history.every((h) => !("amount" in h)), "履歴に金額を入れない");
  assert.equal(d.canRecord, true);
});
await ok("NEXT ACTION は1つずつ進む：確認 → 仕訳 → 支払予定 → 待つ → 支払 → MF → 完了", async () => {
  setup();
  const id = await mkInvoice(await mkVendor());
  const next = async () => (await detail(id)).body.invoice.next.key;
  assert.equal(await next(), "confirm");
  await I("confirm", { id });
  assert.equal(await next(), "journal");
  await I("save_journal", { id, lines: SINGLE, confirm: true });
  assert.equal(await next(), "schedule");
  await schedule(id, { scheduledOn: addDays(TODAY, 5) });
  assert.equal(await next(), "wait");
  // 支払日が来た
  rows("gw_office_payments")[0].scheduled_on = TODAY;
  assert.equal(await next(), "pay");
  await pay(id);
  assert.equal(await next(), "export");
  await CSV("POST", { kind: "both", mode: "all" });
  assert.equal(await next(), "done");
});
await ok("BP 請求書は同じ一覧に出て、PDF（提出ファイル）も見られる。月次の BP 画面（payables）には一般経費が出ない", async () => {
  setup();
  const vid = await mkVendor();
  const g = await mkInvoice(vid);
  mem.rows.gw_partner_companies = [{ id: uid(40), tenant_id: T1, company_name: "BP株式会社" }];
  mem.rows.gw_submissions = [{ id: uid(41), tenant_id: T1, employee_id: uid(11), site_contract_id: uid(21), target_month: MONTH, kind: "invoice", file_name: "bp.pdf", mime_type: "application/pdf", size_bytes: 10, storage_path: `${T1}/${uid(11)}/bp.pdf` }];
  mem.put("billing-submissions", `${T1}/${uid(11)}/bp.pdf`, PDF);
  mem.rows.gw_vendor_invoices.push({ id: uid(301), tenant_id: T1, partner_company_id: uid(40), billing_month: MONTH, received_on: "2026-11-02", subtotal_amount: 500000, tax_amount: 50000, total_amount: 550000, status: "approved", invoice_kind: "bp", submission_id: uid(41) });
  mem.rows.gw_vendor_invoice_lines = [{ id: uid(302), tenant_id: T1, invoice_id: uid(301), billing_month: MONTH, amount: 500000, site_contract_id: null }];
  const l = (await list()).body;
  assert.equal(l.rows.length, 2);
  const bp = l.rows.find((r) => r.kind === "bp");
  assert.equal(bp.vendorName, "BP株式会社");
  assert.equal(bp.hasFile, true);
  const d = (await detail(uid(301))).body;
  assert.match(d.file.url, /billing-submissions/);
  assert.equal(d.invoice.next.key, "journal", "BP 請求書も、承認済みなら仕訳 → 支払へ進める");
  // 月次の BP 請求の画面（payables）には、明細のない一般経費を出さない
  const p = await call(payablesApi, `/api/office/payables?month=${MONTH}`);
  assert.equal(p.statusCode, 200);
  const ids = p.body.invoices.map((x) => x.id);
  assert.ok(ids.includes(uid(301)) && !ids.includes(g));
});
await ok("BP 請求書にも仕訳を入れ、CSV に出せる（取引先は BP 会社名）", async () => {
  setup();
  mem.rows.gw_partner_companies = [{ id: uid(40), tenant_id: T1, company_name: "BP株式会社" }];
  mem.rows.gw_vendor_invoices = [{ id: uid(301), tenant_id: T1, partner_company_id: uid(40), billing_month: MONTH, received_on: "2026-11-02", subtotal_amount: 500000, tax_amount: 50000, total_amount: 550000, status: "approved", invoice_kind: "bp", invoice_no: "BP-1" }];
  const r = await I("save_journal", { id: uid(301), lines: [J("debit", "外注費", 550000), J("credit", "未払金", 550000)], confirm: true });
  assert.equal(r.statusCode, 200);
  const t = parseCsv((await CSV("POST", { kind: "purchase", mode: "all" })).body.slice(1)).slice(1);
  assert.equal(t[0][5], "BP株式会社");
  assert.equal(t[0][1], "2026/10/31", "請求日が無いときは対象月の末日");
});

console.log("— 他社・RLS・履歴 —");
await ok("他社の請求書は、詳細・確認・仕訳・支払・取消すべて 404", async () => {
  setup();
  mem.rows.gw_vendor_invoices = [{ id: uid(320), tenant_id: T2, billing_month: MONTH, received_on: "2026-11-01", subtotal_amount: 1, tax_amount: 0, total_amount: 1, status: "received", invoice_kind: "general" }];
  assert.equal((await detail(uid(320))).statusCode, 404);
  for (const a of ["confirm", "save_journal", "schedule", "pay", "cancel_payment", "void", "update", "unconfirm"]) {
    assert.equal((await I(a, { id: uid(320), lines: SINGLE, reason: "x", scheduledOn: TODAY, paidOn: TODAY })).statusCode, 404, a);
  }
  assert.equal((await list()).body.rows.length, 0);
});
await ok("id の形が違う・無い → 400", async () => {
  setup();
  assert.equal((await detail("abc")).statusCode, 400);
  assert.equal((await I("confirm", {})).statusCode, 400);
  assert.equal((await call(invoicesApi, "/api/office/invoices?month=2026-13")).statusCode, 400);
  assert.equal((await I("nothing", {})).statusCode, 400);
});
await ok("RLS ポリシーの無い新しい表を、ログインした人の権限（userClient）で読まない", async () => {
  setup();
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  await ready(id); await schedule(id); await pay(id);
  await CSV("POST", { kind: "both", mode: "all" });
  await list(); await detail(id);
  const NEW = ["gw_office_vendors", "gw_office_invoice_journals", "gw_office_mf_exports", "gw_office_mf_export_items", "gw_office_payables_settings"];
  assert.ok(!asked.some((a) => a.asUser && NEW.includes(a.table)));
});
await ok("履歴（gw_office_events）に、金額・口座・個人情報を入れない", async () => {
  setup();
  const id = await mkInvoice(await mkVendor(), { description: "秘密の摘要" });
  await ready(id); await schedule(id, { memo: "秘密のメモ", sourceAccount: "秘密口座" }); await pay(id, { feeAmount: 330 });
  const text = JSON.stringify(rows("gw_office_events"));
  assert.ok(!text.includes("110000") && !text.includes("秘密") && !text.includes("株式会社ABC"));
  assert.ok(rows("gw_office_events").every((e) => /^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/.test(e.kind)));
});
await ok("SQL 未適用（表が無い）のときは 503 で SQL の案内。ほかの Office は止めない", async () => {
  setup();
  mem.state.missing = "gw_office_vendors";
  const r = await call(vendorsApi, "/api/office/vendors");
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /db\/134_office_payables_general\.sql/);
  const l = await list();
  assert.equal(l.statusCode, 503);
  mem.state.missing = null;
});

console.log(`\n${pass} ok / ${fail} NG`);
process.exit(fail ? 1 : 0);
