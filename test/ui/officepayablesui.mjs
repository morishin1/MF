// /office/billing.html（請求・支払＝「支払管理」｜「案件別」の2タブ）を、実際のブラウザで通す。
//
// ■ 通すもの
//   ・2タブ：既定は「支払管理」。「案件別」には、これまでの請求・BP・支払の状況が残っている（既存機能を消さない）
//   ・サマリーカード8枚（未確認／支払予定／7日以内／今日支払／支払期限超過／支払済み／未仕訳／MF未出力）→ 押すと一覧が絞り込まれる
//   ・一覧：1請求書＝1行・11列。期限超過は赤、7日以内は注意、支払済みは緑
//   ・請求書を登録（PDFを置く → AI読取は「候補」→ 確認してから登録）／支払先マスタ
//   ・ドロワー：請求書PDF → 基本情報 → 支払条件 → 仕訳 → 支払 → MFクラウド → 履歴。NEXT ACTION は常に1つ
//   ・仕訳（単一・複合・差額 0円・不一致は確定できない）→ 支払予定 → 支払済み → 取消（理由）→ MFクラウド用CSV
//   ・責任者は、見る・登録・確認まで（仕訳・支払・CSV・マスタは出ない）
//   ・PC／スマホ幅
//
// ■ ブラウザの通信は、本物の api/office/{index,vendors,invoices,mf-csv}.js のハンドラにつなぐ（DB・Storage は偽：test/_memdb.mjs）
import "../_officeharness.mjs";
import { mem, ctl, aiInvoice, call, atRoot, OWNER, MANAGER, FINANCE, uid, T1 } from "../_officeharness.mjs";
import { launch, BASE, jstToday } from "../_browser.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: vendorsApi } = await import(atRoot("api/office/vendors.js"));
const { default: invoicesApi } = await import(atRoot("api/office/invoices.js"));
const { default: csvApi } = await import(atRoot("api/office/mf-csv.js"));
const { addDays } = await import(atRoot("lib/office-payables-calc.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const MONTH = "2026-10";
const TODAY = jstToday();
const BUCKET = "office-invoices";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");

const calls = [];
const rowsOf = (t) => mem.rows[t] || [];

function seedBase(who = OWNER) {
  mem.reset();
  ctl.who = { ...who, factors: [] }; ctl.aal = "aal1"; aiInvoice.reply = null; aiInvoice.calls.length = 0; calls.length = 0;
  mem.rows.gw_employees = [{ id: uid(99), tenant_id: T1, display_name: "経理 花子" }];
}
const api = (h, url, body, method = "POST") => call(h, url, { method: body === undefined && method === "GET" ? "GET" : method, body });
async function mkVendor(o = {}) {
  const r = await api(vendorsApi, "/api/office/vendors", { action: "create", vendor: { name: "株式会社ABC", closingDay: 31, paymentMonthOffset: 1, paymentDay: 31, stdDebitAccount: "外注費", stdTaxClass: "課対仕入10%", stdInvoiceClass: "適格", stdCreditAccount: "未払金", stdPaymentMethod: "transfer", stdSourceAccount: "普通預金", ...o } });
  return r.body.vendor.id;
}
let n = 0;
async function mkInvoice(vendorId, o = {}) {
  n++;
  const r = await api(invoicesApi, "/api/office/invoices", { action: "register", month: MONTH, vendorId, invoiceNo: `INV-${n}`, invoiceDate: "2026-10-25", subtotal: 100000, tax: 10000, total: 110000, ...o });
  if (r.statusCode !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.invoiceId;
}
const inv = (action, body) => api(invoicesApi, "/api/office/invoices", { action, month: MONTH, ...body });
const SINGLE = [{ side: "debit", account: "外注費", amount: 110000, taxClass: "課対仕入10%", invoiceClass: "適格", taxAmount: 10000 }, { side: "credit", account: "未払金", amount: 110000 }];
async function ready(id) { await inv("confirm", { id }); await inv("save_journal", { id, lines: SINGLE, summary: "10月分", confirm: true }); }

const ME = (who) => ({
  email: "owner@8grp.co.jp", appRole: "owner", isAdmin: false, shows: {}, roles: [], access: { recruit: true, sell: true, office: true },
  mfa: { required: true, enrolled: false, verified: false, enforced: false, blocked: false },
  gw: { employee: { id: "e-owner", display_name: "経営 一郎", status: "active" }, roles: who.roles, isAdmin: false, tenantId: "t1", stage: null },
});

async function open(url = `/office/billing.html?month=${MONTH}`, { viewport = { width: 1440, height: 1000 }, who = OWNER } = {}) {
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo", acceptDownloads: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.example|status of 4|status of 5/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@8grp.co.jp" })); });
  await page.route("**/storage.example/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const m = /^\/(?:upload\/)?([^/]+)\/(.+)$/.exec(u.pathname);
    if (req.method() === "PUT" && m) { mem.put(m[1], decodeURIComponent(m[2]), req.postDataBuffer() || Buffer.alloc(0)); return route.fulfill({ status: 200, body: "{}" }); }
    const hit = m && mem.storageFiles.get(`${m[1]}/${decodeURIComponent(m[2])}`);
    return route.fulfill({ status: hit ? 200 : 404, contentType: "application/pdf", body: hit || "" });
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send(ME(who));
    const h = { "/api/office": indexApi, "/api/office/vendors": vendorsApi, "/api/office/invoices": invoicesApi, "/api/office/mf-csv": csvApi }[u.pathname];
    if (h) {
      calls.push(`${req.method()} ${u.pathname}${u.search}`);
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
      if (typeof r.body === "string") return route.fulfill({ status: r.statusCode, headers: { ...r.headers }, body: r.body });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  try {
    await page.waitForSelector("#cards .bl-card, #cs-sum .of-chip", { timeout: 8000 });
  } catch (e) {
    console.log("open() 失敗：", page.url(), "\n errs:", errs.join(" | "), "\n calls:", calls.join(", "), "\n body:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400));
    throw e;
  }
  return { page, errs };
}
// アイコン（Material Symbols の名前が文字として入る）は除いて読む
const texts = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => { const c = e.cloneNode(true); c.querySelectorAll(".material-symbols-outlined").forEach((i) => i.remove()); return c.textContent.replace(/\s+/g, " ").trim(); }));
const rowOf = (page, name) => page.locator("#rows tr[data-id]", { hasText: name });
const cardV = async (page, label) => (await page.locator("#cards .bl-card", { hasText: label }).locator(".v").innerText()).trim();
const drawerHas = (page) => page.locator(".of-drawer").count().then((c) => c > 0);
const bodyScrolls = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

// ============================================================================================
console.log("\n=== 2タブ：既定は「支払管理」。「案件別」には、これまでの状況が残っている ===");
{
  seedBase();
  mem.rows.gw_site_contracts = [{ id: uid(21), tenant_id: T1, employee_id: uid(11), engagement_kind: "pp", site_company: "顧客A社", period_from: "2026-04-01", period_to: null, renewal_status: "pending" }];
  mem.rows.gw_employees.push({ id: uid(11), tenant_id: T1, display_name: "田中 太郎", status: "active", employee_kind: "proper" });
  await mkInvoice(await mkVendor());
  const { page, errs } = await open();
  check(await page.title() === "請求・支払 - EIGHT OFFICE", "タイトルは 請求・支払");
  check((await texts(page, ".bl-tab")).join("|") === "支払管理|案件別", `タブは 支払管理｜案件別（いま ${(await texts(page, ".bl-tab")).join("|")}）`);
  check(await page.locator("#tab-pay").getAttribute("aria-selected") === "true", "既定は 支払管理");
  check(await page.locator("#pane-cases").isHidden(), "案件別は隠れている");
  check(!calls.some((c) => /^GET \/api\/office(\?|$)/.test(c)), "既定の表示では、案件別のデータ（/api/office）を取りにいかない");
  check((await texts(page, "#cards .bl-card .lb")).join("|") === "未確認|支払予定|7日以内|今日支払|支払期限超過|支払済み|未仕訳|MF未出力", `サマリーカード8枚（いま ${(await texts(page, "#cards .bl-card .lb")).join("|")}）`);
  await page.locator("#tab-cases").click();
  // 最初から「読み込み中…」の行があるので、行ではなく中身が届くのを待つ
  await page.waitForFunction(() => /顧客A社/.test(document.querySelector("#cs-rows")?.innerText || ""));
  check(await page.locator("#pane-cases").isVisible() && await page.locator("#pane-pay").isHidden(), "案件別に切り替わる");
  check((await texts(page, "#pane-cases thead th")).join("|") === "客先|要員|売上請求|仕入請求（BP）|支払|", "案件別の表は、これまでと同じ列");
  check((await page.locator("#cs-rows").innerText()).includes("顧客A社") && (await page.locator("#cs-rows").innerText()).includes("田中 太郎"), "案件別に、客先・要員が出る");
  check((await texts(page, "#cs-sum .of-chip .lb")).join("|") === "未完了|売上請求 未送付|BP請求書 未受領|支払 未完了", "案件別の絞り込みも残っている");
  check((await page.locator("#cs-rows a.of-btn").first().getAttribute("href")).startsWith("/office/monthly.html?month=2026-10&id="), "［案件を開く］は 月次業務へ");
  check(new URL(page.url()).searchParams.get("tab") === "cases", "URL に tab=cases");
  await page.locator("#tab-pay").click();
  check(await page.locator("#pane-pay").isVisible(), "支払管理に戻る");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}
{
  seedBase();
  const { page } = await open(`/office/billing.html?month=${MONTH}&tab=cases`);
  check(await page.locator("#tab-cases").getAttribute("aria-selected") === "true", "?tab=cases で、案件別が開く");
  check(!calls.some((c) => /invoices/.test(c)), "そのとき 支払管理のデータは取らない");
  await page.close();
}

console.log("\n=== 一覧：1請求書＝1行・11列／色（期限超過＝赤・7日以内＝注意・支払済み＝緑）／カードで絞り込み ===");
{
  seedBase();
  const vid = await mkVendor();
  const vOther = await mkVendor({ name: "株式会社XYZ", paymentMonthOffset: undefined, paymentDay: undefined, closingDay: undefined });
  const a = await mkInvoice(vid, { invoiceNo: "A-OVER", paymentDueOn: addDays(TODAY, -3), dueSource: "invoice" });
  const b = await mkInvoice(vid, { invoiceNo: "B-SOON", paymentDueOn: addDays(TODAY, 5), dueSource: "invoice" });
  const c = await mkInvoice(vid, { invoiceNo: "C-PAID", paymentDueOn: addDays(TODAY, -8), dueSource: "invoice" });
  const d = await mkInvoice(vOther, { invoiceNo: "D-NODUE" });
  await inv("confirm", { id: b }); await inv("schedule", { id: b, scheduledOn: addDays(TODAY, 5) });
  await ready(c); await inv("schedule", { id: c, scheduledOn: addDays(TODAY, -8) }); await inv("pay", { id: c, paidOn: addDays(TODAY, -7), paidAmount: 110000 });
  const { page, errs } = await open();
  check((await texts(page, "#pane-pay thead th")).join("|") === "支払先|請求番号 / PDF|請求日|対象月|締め|支払期日|税込金額|仕訳状況|支払状態|MF出力状態|詳細", "11列の見出し");
  check(await page.locator("#rows tr[data-id]").count() === 4, "4請求書＝4行");
  check(await rowOf(page, "A-OVER").evaluate((e) => e.classList.contains("r-overdue")), "期限超過の行は 赤（r-overdue）");
  check(await rowOf(page, "B-SOON").evaluate((e) => e.classList.contains("r-soon")), "7日以内の行は 注意（r-soon）");
  check(await rowOf(page, "C-PAID").evaluate((e) => e.classList.contains("r-paid")), "支払済みの行は 緑（r-paid）");
  const colorOf = (sel) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).boxShadow);
  check(/192, 57, 43/.test(await colorOf('#rows tr.r-overdue td:first-child')), "赤の印が実際に出る");
  const over = await rowOf(page, "A-OVER").innerText();
  check(/期限超過/.test(over), `期限超過のラベル（${over.replace(/\s+/g, " ").slice(0, 80)}）`);
  const soon = await rowOf(page, "B-SOON").innerText();
  check(new RegExp(`支払予定 / ${Number(addDays(TODAY, 5).slice(5, 7))}月${Number(addDays(TODAY, 5).slice(8))}日 / ¥110,000`).test(soon), "「支払予定 / 月日 / ¥金額」の形で出る");
  const paid = await rowOf(page, "C-PAID").innerText();
  check(/支払済み \/ \d+月\d+日 \/ ¥110,000/.test(paid) && /仕訳済み/.test(paid), "支払済み・仕訳済みが出る");
  const nodue = await rowOf(page, "D-NODUE").innerText();
  check(/支払期日未設定/.test(nodue), "期日が決まらないものは「支払期日未設定」");
  check(/¥110,000/.test(over) && /2026\/10\/25/.test(over) && /2026-10/.test(over) && /月末/.test(over), "税込金額・請求日・対象月・締めの列");
  check([await cardV(page, "未確認"), await cardV(page, "支払予定"), await cardV(page, "7日以内"), await cardV(page, "支払期限超過"), await cardV(page, "支払済み"), await cardV(page, "未仕訳"), await cardV(page, "MF未出力")].join(",") === "2,1,1,1,1,3,1", `カードの件数（いま ${[await cardV(page, "未確認"), await cardV(page, "支払予定"), await cardV(page, "7日以内"), await cardV(page, "支払期限超過"), await cardV(page, "支払済み"), await cardV(page, "未仕訳"), await cardV(page, "MF未出力")].join(",")}）`);
  await page.locator("#cards .bl-card", { hasText: "支払期限超過" }).click();
  check(await page.locator("#rows tr[data-id]").count() === 1 && (await page.locator("#rows").innerText()).includes("A-OVER"), "「支払期限超過」を押すと、その1件だけに絞られる");
  check(await page.locator("#cards .bl-card.on").count() === 1 && await page.locator("#filterbar").isVisible(), "押したカードが選択表示になり、絞り込み中の表示が出る");
  await page.locator("#cards .bl-card", { hasText: "未確認" }).click();
  check(await page.locator("#rows tr[data-id]").count() === 2, "別のカード（未確認）に切り替えると、その絞り込みになる");
  await page.locator("#cards .bl-card", { hasText: "未確認" }).click();
  check(await page.locator("#rows tr[data-id]").count() === 4 && await page.locator("#filterbar").isHidden(), "同じカードをもう一度押すと解除される");
  await page.locator("#cards .bl-card", { hasText: "MF未出力" }).click();
  check(await page.locator("#rows tr[data-id]").count() === 1 && (await page.locator("#rows").innerText()).includes("C-PAID"), "MF未出力（仕訳済み・未出力）の絞り込み");
  await page.locator("[data-clear]").click();
  check(await page.locator("#rows tr[data-id]").count() === 4, "［絞り込みを解除］で全件に戻る");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 請求書を登録：PDF・AI読取（候補→確認→登録）・支払先マスタの初期値・支払期日 ===");
{
  seedBase();
  const vid = await mkVendor();
  const { page, errs } = await open();
  check((await texts(page, "#actions .of-btn")).join("|") === "設定|支払先マスタ|MFクラウドCSV|請求書を登録", `右上のボタン（いま ${(await texts(page, "#actions .of-btn")).join("|")}）`);
  await page.locator('[data-act="register"]').click();
  await page.waitForSelector(".bl-modal");
  check(/請求書を登録/.test(await page.locator(".bl-modal h2").innerText()), "登録ダイアログが開く");
  const labels = await texts(page, ".bl-modal .bl-f");
  for (const l of ["支払先", "請求書番号", "請求日", "対象月", "受領日", "小計", "消費税", "合計", "締め日", "支払条件", "支払期日", "支払方法", "支払元口座", "請求書ファイル"]) {
    check(labels.some((t) => t.startsWith(l)), `入力項目：${l}`);
  }
  await page.selectOption("#f-vendorId", vid);
  // 既定の案内文にも「支払先マスタから自動計算」が入っているので、計算結果の文言（〜で登録します）を待つ
  await page.waitForFunction(() => /で登録します|自動計算できません/.test(document.querySelector("#f-paymentDueOn")?.closest("label")?.innerText || ""));
  const hint = await page.locator("#f-paymentDueOn").locator("xpath=ancestor::label").innerText();
  check(/2026\/11\/30/.test(hint) && /月末締め翌月末払い/.test(hint), `支払先を選ぶと、マスタから自動計算した支払期日が見える（${hint.replace(/\s+/g, " ").slice(-60)}）`);
  // AI 読取：ファイルを置く → 候補が黄色で入る → 確認するまで登録できない
  aiInvoice.reply = { model: "claude-test-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "read_invoice", input: {
    payee_name: "株式会社ABC", invoice_no: "ABC-100", invoice_date: "2026年10月25日", due_date: "2026/11/20", subtotal: "200,000", tax: "20,000", total: "220,000", registration_no: "T1234567890123", description: "10月分開発費", confidence: "mid" } }] };
  await page.setInputFiles("#f-file", { name: "請求書.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForSelector("#aiResult");
  check(/AI読取完了/.test(await page.locator("#fileState").innerText()), "ファイル選択だけでAI読取まで自動実行される");
  check([...mem.storageFiles.keys()].some((k) => k.startsWith(`${BUCKET}/${T1}/`)), "請求書ファイルが、非公開の保存先（office-invoices）に置かれる");
  check(await page.inputValue("#f-invoiceNo") === "ABC-100" && await page.inputValue("#f-total") === "220000" && await page.inputValue("#f-invoiceDate") === "2026-10-25", "AIの読取候補が入力欄に入る");
  check(await page.inputValue("#f-paymentDueOn") === "2026-11-20" && await page.locator('input[name="dueSource"][value="invoice"]').isChecked(), "請求書に書かれた支払期日は「請求書に記載」で入る");
  check(await page.locator("#f-invoiceNo").locator("xpath=ancestor::label").evaluate((e) => e.classList.contains("ai")), "AIの候補の欄は、黄色で区別される");
  check(!rowsOf("gw_vendor_invoices").length, "AI読取だけでは、請求書は登録されない（自動確定しない）");
  await page.locator("#regSubmit").click();
  check(/確認してから/.test(await page.locator(".bl-modal .bl-er").innerText()), "確認チェックなしでは登録できない");
  check(!rowsOf("gw_vendor_invoices").length, "確認前は登録されていない");
  await page.locator("#aiConfirm").check();
  await page.locator("#regSubmit").click();
  await page.waitForSelector(".of-drawer");
  const row = rowsOf("gw_vendor_invoices")[0];
  check(rowsOf("gw_vendor_invoices").length === 1 && row.invoice_no === "ABC-100" && Number(row.total_amount) === 220000 && row.payment_due_on === "2026-11-20" && row.due_source === "invoice", "確認後に登録され、請求書に明記された支払期日が優先される");
  check(row.file_path && row.file_mime === "application/pdf", "ファイルが請求書に結び付く");
  check(rowsOf("gw_office_events").some((e) => e.kind === "invoice.register" && e.detail.aiRead === true), "履歴に、AI読取を使ったことが残る");
  check(await page.locator("#dr-title").innerText() === "株式会社ABC", "登録後、そのままドロワーが開く");
  check((await page.locator(".bl-next .ttl").innerText()) === "内容を確認", "登録直後の NEXT ACTION は「内容を確認」");
  await page.keyboard.press("Escape");
  check(!(await drawerHas(page)), "Esc でドロワーが閉じる");
  check(await page.locator("#rows tr[data-id]").count() === 1, "一覧に1行増える");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}
{
  // 既存の支払先マスタが0件のときも、アップロードから離れずに登録可能。
  seedBase();
  const { page, errs } = await open();
  await page.locator('[data-act="register"]').click();
  await page.waitForSelector(".bl-modal");
  check(await page.locator("#f-vendorId option").count() === 1, "初回：支払先マスタが空でも登録画面を開ける");
  check(await page.locator("#quickVendorOpen").isVisible(), "初回：この画面で支払先を追加できる");
  aiInvoice.reply = { model: "claude-test-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "q", name: "read_invoice", input: {
    payee_name: "SB&C携帯代", invoice_no: "SB-001", invoice_date: "2026/10/22", due_date: "2026/11/20",
    subtotal: "10,000", tax: "1,000", total: "11,000", confidence: "mid" } }] };
  await page.setInputFiles("#f-file", { name: "SB請求書.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForSelector("#aiResult");
  check(await page.locator("#quickVendorPanel").isVisible(), "未登録の支払先を検知し、その場で作成欄を表示");
  check(await page.locator("#quickVendorName").inputValue() === "SB&C携帯代", "AIの請求元名称を編集可能な候補として提示");
  check(!rowsOf("gw_office_vendors").length && !rowsOf("gw_vendor_invoices").length, "AIが自動で支払先や請求書を確定しない");
  await page.locator("#quickVendorSave").click();
  check(/照合してチェック/.test(await page.locator(".bl-modal .bl-er").innerText()), "請求元を人が確認しなければマスタへ登録不可");
  await page.locator("#quickVendorConfirm").check();
  await page.locator("#quickVendorSave").click();
  await page.waitForFunction(() => /支払先.+登録・選択/.test(document.querySelector("#quickVendorMessage")?.textContent||""));
  check(rowsOf("gw_office_vendors").length === 1 && await page.inputValue("#f-vendorId") === rowsOf("gw_office_vendors")[0].id,
    "支払先が作成され、そのままプルダウンに反映・選択される");
  check(!rowsOf("gw_vendor_invoices").length, "支払先作成だけで請求書は未登録");
  check(await page.locator("#f-invoiceNo").inputValue() === "SB-001", "支払先の登録後もAI候補を保持");
  await page.locator("#aiConfirm").check();
  await page.locator("#regSubmit").click();
  await page.waitForSelector(".of-drawer");
  check(rowsOf("gw_vendor_invoices").length === 1, "マスタ登録後、同じ画面からPDF請求書を登録できる");
  check(errs.length === 0, "支払先追加・AI読取・請求書登録でJavaScriptエラーなし");
  await page.close();
}
{
  // AI が読めなかったとき・手入力・マスタから期日
  seedBase();
  const vid = await mkVendor();
  const { page } = await open();
  await page.locator('[data-act="register"]').click();
  await page.waitForSelector(".bl-modal");
  aiInvoice.reply = Object.assign(new Error("boom"), { status: 500 });
  await page.setInputFiles("#f-file", { name: "x.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) });
  await page.waitForFunction(() => /AIで読み取れませんでした/.test(document.querySelector("#aiBox")?.innerText || ""));
  check(/AI読取失敗/.test(await page.locator("#fileState").innerText()), "読取エラーはアップロード失敗と区別して表示する");
  check(true, "AIが失敗しても、手入力の案内が出る");
  await page.selectOption("#f-vendorId", vid);
  await page.fill("#f-invoiceNo", "MAN-1"); await page.fill("#f-invoiceDate", "2026-10-31"); await page.fill("#f-subtotal", "50000"); await page.fill("#f-tax", "5000");
  await page.locator("#regSubmit").click();
  await page.waitForSelector(".of-drawer");
  const row = rowsOf("gw_vendor_invoices")[0];
  check(Number(row.total_amount) === 55000, "合計を空にすると、小計＋消費税で補う");
  check(row.payment_due_on === "2026-11-30" && row.due_source === "master" && row.payment_terms === "月末締め翌月末払い" && row.closing_day === 31, "支払期日が空なら、支払先マスタから自動計算（11/30・master）。締め日・支払条件も入る");
  check(row.file_mime === "image/png", "PNG も置ける");
  await page.close();
}
{
  // 入力の誤り
  seedBase();
  await mkVendor();
  const { page } = await open();
  await page.locator('[data-act="register"]').click();
  await page.waitForSelector(".bl-modal");
  await page.locator("#regSubmit").click();
  check(/支払先を選んでください/.test(await page.locator(".bl-modal .bl-er").innerText()), "支払先が未選択だと、理由が出る");
  await page.selectOption("#f-vendorId", { index: 1 });
  await page.fill("#f-invoiceDate", "2026-10-31"); await page.fill("#f-subtotal", "100000"); await page.fill("#f-tax", "10000"); await page.fill("#f-total", "120000");
  await page.locator("#regSubmit").click();
  await page.waitForFunction(() => /合いません/.test(document.querySelector(".bl-modal .bl-er")?.innerText || ""));
  check(true, "小計＋消費税と合計が合わないと、理由が出て登録されない");
  check(!rowsOf("gw_vendor_invoices").length, "登録されていない");
  await page.close();
}

console.log("\n=== 支払先マスタ（画面から登録・編集・無効化）===");
{
  seedBase();
  const { page, errs } = await open();
  await page.locator('[data-act="vendors"]').click();
  await page.waitForSelector(".bl-modal");
  check(/支払先がまだありません/.test(await page.locator(".bl-modal").innerText()), "最初は空");
  await page.locator("#vNew").click();
  await page.waitForSelector("#f-v_name");
  const labels = await texts(page, ".bl-modal .bl-f");
  for (const l of ["支払先名称", "略称", "適格請求書発行事業者登録番号", "標準締め日", "標準 借方の勘定科目", "標準 借方の補助科目", "標準 部門", "標準 税区分", "標準 インボイス区分", "標準 貸方の勘定科目", "メモ"]) {
    check(labels.some((t) => t.startsWith(l)), `マスタの項目：${l}`);
  }
  check((await page.locator("#f-v_class option").allInnerTexts()).join("|") === "（指定なし）|適格|80%控除|70%控除|50%控除|30%控除|控除なし", "インボイス区分は MFクラウドの名称6つ");
  check(await page.locator("#dl-accounts option").count() > 5, "勘定科目は、候補リストから選べる（自由入力もできる）");
  await page.fill("#f-v_name", "株式会社ABC"); await page.fill("#f-v_short", "ABC"); await page.fill("#f-v_reg", "T1234567890123");
  await page.selectOption("#f-v_close", "31"); await page.selectOption("#f-v_off", "1"); await page.selectOption("#f-v_pday", "31");
  await page.fill("#f-v_debit", "外注費"); await page.fill("#f-v_tax", "課対仕入10%"); await page.selectOption("#f-v_class", "適格"); await page.fill("#f-v_credit", "未払金");
  await page.locator("#vSave").click();
  await page.waitForFunction(() => /登録しました/.test(document.querySelector(".bl-modal")?.innerText || ""));
  const v = rowsOf("gw_office_vendors")[0];
  check(v && v.name === "株式会社ABC" && v.closing_day === 31 && v.payment_month_offset === 1 && v.payment_day === 31 && v.std_invoice_class === "適格" && v.invoice_reg_no === "T1234567890123", "支払先が保存される（締め日・支払条件・標準仕訳・インボイス区分・登録番号）");
  check(/月末締め翌月末払い/.test(await page.locator(".bl-vt").innerText()), "一覧に「月末締め翌月末払い」");
  await page.locator("[data-vedit]").click();
  await page.waitForSelector("#f-v_name");
  await page.fill("#f-v_debit", "通信費");
  await page.locator("#vSave").click();
  await page.waitForFunction(() => /保存しました/.test(document.querySelector(".bl-modal")?.innerText || ""));
  check(rowsOf("gw_office_vendors")[0].std_debit_account === "通信費", "編集できる");
  await page.locator("[data-vtoggle]").click();
  await page.waitForFunction(() => /無効/.test(document.querySelector(".bl-vt tbody")?.innerText || ""));
  check(rowsOf("gw_office_vendors")[0].is_active === false && rowsOf("gw_office_vendors").length === 1, "無効にしても削除されない");
  await page.locator("#vNew").click();
  await page.fill("#f-v_name", "株式会社ABC");
  await page.locator("#vSave").click();
  await page.waitForFunction(() => /同じ名称/.test(document.querySelector(".bl-modal .bl-er")?.innerText || ""));
  check(true, "同じ名称は登録できない");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== ドロワー：順番・NEXT ACTION・確認 → 仕訳 → 支払予定 → 支払済み → MF CSV → 取消 ===");
{
  seedBase();
  const vid = await mkVendor();
  const id = await mkInvoice(vid, { invoiceDate: "2026-10-01", description: "10月分業務委託費" });
  const { page, errs } = await open();
  await rowOf(page, "INV-").first().click();
  await page.waitForSelector(".of-drawer");
  const order = await page.evaluate(() => [...document.querySelectorAll(".of-drawer section")].map((s) => s.id));
  check(order.join(",") === "dr-file,dr-basic,dr-terms,dr-journal,dr-pay,dr-mf,dr-history", `並び：請求書PDF→基本情報→支払条件→仕訳→支払→MFクラウド→履歴（いま ${order.join(",")}）`);
  check(await page.locator("#nextCard").count() === 1 && await page.locator("#nextCard [data-next]").count() === 1, "NEXT ACTION は1つだけ（ボタンも1つ）");
  const first = await page.evaluate(() => document.querySelector(".bl-db").firstElementChild.id);
  check(first === "nextCard", "NEXT ACTION が詳細の最上部");
  check(await page.locator(".bl-next .ttl").innerText() === "内容を確認", "未確認 → 内容を確認");
  check(/確認後に、仕訳を設定できます/.test(await page.locator("#dr-journal").innerText()), "確認前は、仕訳は設定できない");
  check(/支払予定は、まだありません|請求書の内容を確認すると/.test(await page.locator("#dr-pay").innerText()), "確認前は、支払予定にできない");
  // 1) 確認
  await page.locator('#nextCard [data-next="confirm"]').click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "仕訳を設定");
  check(rowsOf("gw_vendor_invoices")[0].status === "approved", "確認すると status=approved");
  // 2) 仕訳（支払先マスタの標準仕訳が初期値）
  check(/支払先マスタの標準仕訳を初期値/.test(await page.locator("#dr-journal").innerText()), "仕訳の初期値は支払先マスタの標準仕訳");
  check(await page.locator(".bl-line").count() === 2, "借方1・貸方1の2行");
  check(await page.inputValue('.bl-line[data-i="0"] [data-k="account"]') === "外注費" && await page.inputValue('.bl-line[data-i="0"] [data-k="amount"]') === "110000" && await page.inputValue('.bl-line[data-i="0"] [data-k="taxAmount"]') === "10000", "借方：外注費・110000・税額10000（目安）");
  check(await page.inputValue('.bl-line[data-i="1"] [data-k="account"]') === "未払金", "貸方：未払金");
  check(await page.inputValue('.bl-line[data-i="0"] [data-k="partner"]') === "株式会社ABC" && await page.inputValue('.bl-line[data-i="0"] [data-k="taxClass"]') === "課対仕入10%" && await page.locator('.bl-line[data-i="0"] [data-k="invoiceClass"]').inputValue() === "適格", "取引先・税区分・インボイス区分が入る");
  check((await page.locator("#jbal").innerText()).replace(/\s+/g, " ").includes("差額 0円"), "「差額 0円」が出る");
  check(await page.locator("#jconfirm").isEnabled(), "貸借が一致していれば［仕訳を確定］を押せる");
  // 複合仕訳：借方を3行に（通信費20,000＋消耗品費30,000＋外注費50,000／未払金100,000 → 請求額と違う警告だけ）
  await page.fill('.bl-line[data-i="0"] [data-k="amount"]', "50000");
  check((await page.locator("#jbal").innerText()).replace(/\s+/g, " ").includes("差額 -60,000円") && await page.locator("#jbal").evaluate((e) => e.classList.contains("bad")), "借方を変えると、差額が赤く出る");
  check(await page.locator("#jconfirm").isDisabled(), "貸借が合わないと［仕訳を確定］は押せない");
  await page.locator('[data-addline="debit"]').click();
  await page.fill('.bl-line[data-i="2"] [data-k="account"]', "通信費"); await page.fill('.bl-line[data-i="2"] [data-k="amount"]', "20000");
  await page.locator('[data-addline="debit"]').click();
  await page.fill('.bl-line[data-i="3"] [data-k="account"]', "消耗品費"); await page.fill('.bl-line[data-i="3"] [data-k="amount"]', "30000");
  await page.fill('.bl-line[data-i="1"] [data-k="amount"]', "100000");
  check((await page.locator("#jbal").innerText()).replace(/\s+/g, " ").includes("差額 0円") && await page.locator("#jbal").evaluate((e) => e.classList.contains("good")), "複合仕訳：差額 0円になる");
  check((await page.locator("#jbal").innerText()).includes("請求書の税込金額"), "請求額と違う場合は、注意が出る（止めない）");
  await page.fill('[data-j="tags"]', "経理,10月");
  await page.locator('[data-jsave="1"]').click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "支払予定を登録");
  const js = rowsOf("gw_office_invoice_journals");
  check(js.length === 4 && rowsOf("gw_vendor_invoices")[0].journal_status === "confirmed", "複合仕訳（4行）が確定する");
  check(js.every((j) => j.tags.join(",") === "経理,10月" && j.summary === "10月分業務委託費"), "摘要（請求書の摘要）・タグが全行に入る");
  check(/仕訳済み/.test(await page.locator("#dr-journal").innerText()) && await page.locator("[data-jedit]").count() === 1, "確定後は［仕訳を直す］になる");
  // 3) 支払予定
  await page.locator('#nextCard [data-next="schedule"]').click();
  await page.waitForSelector("#f-p_on");
  check(await page.inputValue("#f-p_on") === "2026-11-30" && await page.inputValue("#f-p_amount") === "110000" && await page.inputValue("#f-p_source") === "普通預金", "支払予定のダイアログ：期日・金額・口座が初期値で入る");
  for (const l of ["支払予定日", "支払金額", "支払方法", "支払元口座", "メモ"]) check((await texts(page, ".bl-modal .bl-f")).some((t) => t.startsWith(l)), `支払予定の項目：${l}`);
  await page.fill("#f-p_on", addDays(TODAY, 2)); await page.fill("#f-p_memo", "月末払い");
  await page.locator("#pSave").click();
  await page.waitForFunction(() => /待つ/.test(document.querySelector(".bl-next .ttl")?.textContent || ""));
  check(rowsOf("gw_office_payments")[0].status === "scheduled" && rowsOf("gw_office_payments")[0].memo === "月末払い", "支払予定が登録される");
  check(await page.locator("#nextCard [data-next]").count() === 0, "支払日がまだ先なら、ボタンの無い「待つ」表示");
  await page.waitForFunction(() => /支払予定 \/ \d+月\d+日 \/ ¥110,000/.test(document.querySelector("#rows")?.innerText || ""));
  check(true, "一覧にも「支払予定 / 月日 / ¥金額」");
  // 4) 支払済み（誤登録→取消も）
  await page.locator('#dr-pay [data-next="pay"]').click();
  await page.waitForSelector("#f-p_fee");
  for (const l of ["実支払日", "実支払額", "振込手数料", "支払元口座", "メモ"]) check((await texts(page, ".bl-modal .bl-f")).some((t) => t.startsWith(l)), `支払済みの項目：${l}`);
  await page.fill("#f-p_on", addDays(TODAY, 1));
  await page.locator("#pSave").click();
  await page.waitForFunction(() => /今日以前/.test(document.querySelector(".bl-modal .bl-er")?.innerText || ""));
  check(true, "実支払日が未来なら断られる");
  await page.fill("#f-p_on", TODAY); await page.fill("#f-p_fee", "330");
  await page.locator("#pSave").click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "MF CSVへ出力");
  const pay = rowsOf("gw_office_payments")[0];
  check(pay.status === "paid" && pay.paid_on === TODAY && Number(pay.fee_amount) === 330 && Number(pay.paid_amount) === 110000, "支払済み（実支払日・実支払額・振込手数料）が登録される");
  // 5) 取消（理由が要る）
  await page.locator("[data-cancelpay]").click();
  await page.waitForSelector("#f-r_reason");
  await page.locator("#rSave").click();
  check(/理由を入れてください/.test(await page.locator(".bl-modal .bl-er").innerText()), "理由が空だと取り消せない");
  await page.fill("#f-r_reason", "金額の入力ミスのため");
  await page.locator("#rSave").click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "支払予定を登録");
  check(rowsOf("gw_office_payments").length === 1 && rowsOf("gw_office_payments")[0].status === "void" && rowsOf("gw_office_payments")[0].cancel_reason === "金額の入力ミスのため", "取り消しても行は残り、理由が保存される");
  check(/取り消した支払/.test(await page.locator("#dr-pay").innerText()) && /理由：金額の入力ミスのため/.test(await page.locator("#dr-pay").innerText()), "支払の欄に、取り消した支払と理由が残る");
  check(/理由：金額の入力ミスのため/.test(await page.locator("#dr-history").innerText()) && /支払を取り消した/.test(await page.locator("#dr-history").innerText()), "履歴にも残る");
  // 6) もう一度 予定 → 支払済み → CSV
  await page.locator('#nextCard [data-next="schedule"]').click();
  await page.waitForSelector("#f-p_on");
  await page.fill("#f-p_on", TODAY);
  await page.locator("#pSave").click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "支払を確認");
  check(true, "支払予定日が今日なら「支払を確認」");
  await page.locator('#nextCard [data-next="pay"]').click();
  await page.waitForSelector("#f-p_fee");
  await page.locator("#pSave").click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "MF CSVへ出力");
  await page.locator('#nextCard [data-next="export"]').click();
  await page.waitForSelector("#csvGo");
  await page.waitForFunction(() => /出力できる/.test(document.querySelector("#csvPreview")?.innerText || ""));
  check(await page.inputValue("#f-x_month") === MONTH && await page.locator('input[name="x_mode"][value="unexported"]').isChecked() && await page.locator('input[name="x_kind"][value="both"]').isChecked(), "CSVダイアログ：対象月・未出力のみ・両方 が初期値");
  check((await texts(page, ".bl-modal .bl-radio label")).join("|") === "未出力のみ|全件（出力済みも含む）|仕入計上|支払（支払済みだけ）|両方", "選択肢：未出力のみ／全件／仕入計上／支払／両方");
  check(/MFに登録されません/.test(await page.locator(".bl-modal").innerText()), "「CSVを出しただけではMFに登録されない」と明示される");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#csvGo").click()]);
  const text = (await import("node:fs")).readFileSync(await dl.path(), "utf8");
  check(/^mf-journal_2026-10_all_\d{8}-\d{4}\.csv$/.test(dl.suggestedFilename()), `ファイル名（${dl.suggestedFilename()}）`);
  check(text.charCodeAt(0) === 0xfeff, "UTF-8 BOM 付き");
  const lines = text.slice(1).trim().split("\r\n");
  check(lines[0].split(",").length === 27 && lines.length === 1 + 3 + 1, `27列・仕入計上3行（借方3＋貸方1の複合）＋支払1行＋見出し（いま ${lines.length}行）`);
  check(lines.slice(1, 4).every((l) => l.startsWith("1,2026/10/01,")) && /債務/.test(lines[1]), "複合仕訳は同一取引No(1)・同一取引日(2026/10/01)・債務");
  check(/経費・債務支払/.test(lines[4]) && lines[4].startsWith("2,"), "支払は取引No 2・経費・債務支払");
  await page.waitForFunction(() => /MFへの登録ではなく|MFクラウドへ登録された/.test(document.querySelector("#m-body")?.innerText || ""));
  check(/MFクラウドへ登録された.*わけではありません/.test(await page.locator("#m-body").innerText()), "出力後も「MF登録済みではない」と明示される");
  await page.locator("#csvDone").click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "完了");
  check(await page.locator(".bl-next").evaluate((e) => e.classList.contains("ok")), "全部終わると「完了」");
  check(/CSV出力済み/.test(await page.locator("#dr-mf").innerText()) && /MFクラウドへ登録済みという意味ではありません/.test(await page.locator("#dr-mf").innerText()), "MFクラウドの欄：CSV出力済み。登録済みではないと書かれている");
  check(/MF-202610-/.test(await page.locator("#dr-mf").innerText()), "出力バッチIDが履歴に出る");
  const row = await rowOf(page, "INV-").first().innerText();
  check(/CSV出力済み/.test(row) && !/MF登録済み/.test(row), "一覧は「CSV出力済み」（MF登録済みとは出さない）");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== MFクラウドCSV：絞り込み・出せないものの表示・インポート確認用サンプル ===");
{
  seedBase();
  const vid = await mkVendor();
  const a = await mkInvoice(vid, { invoiceNo: "OK-1" }); await ready(a);
  const b = await mkInvoice(vid, { invoiceNo: "BAD-1" }); await ready(b);
  rowsOf("gw_office_invoice_journals").find((j) => j.invoice_id === b && j.side === "credit").amount = 1;
  const { page } = await open();
  await page.locator('[data-act="csv"]').click();
  await page.waitForSelector("#csvGo");
  await page.waitForFunction(() => /出力できないものがあります/.test(document.querySelector("#csvPreview")?.innerText || ""));
  check(/BAD-1/.test(await page.locator("#csvPreview").innerText()) && /貸借が一致しません/.test(await page.locator("#csvPreview").innerText()), "貸借が合わない請求書は、理由つきで出力できないと表示");
  check(await page.locator("#csvGo").isDisabled(), "出力できないものがあれば［ダウンロード］は押せない");
  check(rowsOf("gw_office_mf_exports").length === 0, "出力の記録は残らない");
  await page.locator('input[name="x_kind"][value="payment"]').check();
  await page.waitForFunction(() => /出力できる対象がありません/.test(document.querySelector("#csvPreview")?.innerText || ""));
  check(await page.locator("#csvGo").isDisabled(), "支払済みが無ければ、支払は出せない");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#sampleLink").click()]);
  const t = (await import("node:fs")).readFileSync(await dl.path(), "utf8");
  check(dl.suggestedFilename() === "mf-journal_import-test.csv" && t.charCodeAt(0) === 0xfeff, "インポート確認用サンプルCSV（BOM付き）をダウンロードできる");
  const ls = t.slice(1).trim().split("\r\n");
  check(ls[0].split(",").length === 27 && ls.length === 1 + 1 + 3 + 1 + 2 && ls.every((l, i) => i === 0 || /MFインポート確認用/.test(l)), `サンプル：ダミーの4取引（単一・複合・支払・手数料つき）（いま ${ls.length}行）`);
  check(rowsOf("gw_office_mf_exports").length === 0, "サンプルでは、出力の記録を残さない");
  await page.close();
}

console.log("\n=== 設定（休日調整・候補リスト）===");
{
  seedBase();
  await mkVendor();
  const { page } = await open();
  await page.locator('[data-act="settings"]').click();
  await page.waitForSelector("#f-s_hol");
  check((await page.locator("#f-s_hol option").allInnerTexts()).join("|") === "前営業日にする|翌営業日にする|調整しない", "休日調整：前営業日／翌営業日／調整しない");
  await page.selectOption("#f-s_hol", "next");
  await page.fill("#f-c_accounts", "特別費用\n外注費");
  await page.locator("#sSave").click();
  await page.waitForFunction(() => !document.querySelector(".bl-modal"));
  check(rowsOf("gw_office_payables_settings")[0].holiday_adjust === "next", "休日調整を保存できる");
  await page.locator('[data-act="register"]').click();
  await page.waitForSelector(".bl-modal");
  check([...(await page.locator("#dl-accounts option").evaluateAll((os) => os.map((o) => o.value)))].includes("特別費用"), "候補リストに足した科目が出る");
  await page.close();
}

console.log("\n=== 責任者：見る・登録・確認まで（仕訳・支払・マスタ・CSVは出ない）===");
{
  seedBase(MANAGER);
  ctl.who = { ...OWNER, factors: [] };
  const vid = await mkVendor();
  const id = await mkInvoice(vid);
  ctl.who = { ...MANAGER, factors: [] };
  const { page, errs } = await open(`/office/billing.html?month=${MONTH}`, { who: MANAGER });
  check((await texts(page, "#actions .of-btn")).join("|") === "請求書を登録", `ボタンは 請求書を登録 だけ（いま ${(await texts(page, "#actions .of-btn")).join("|")}）`);
  await rowOf(page, "INV-").first().click();
  await page.waitForSelector(".of-drawer");
  await page.locator('#nextCard [data-next="confirm"]').click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "仕訳を設定");
  check(rowsOf("gw_vendor_invoices")[0].status === "approved", "責任者も内容を確認できる");
  check(await page.locator("#nextCard [data-next]").count() === 0 && /経営者・経理が行います/.test(await page.locator("#nextCard").innerText()), "仕訳は 経営者・経理が行う旨が出て、ボタンは無い");
  check(await page.locator("#jbox").count() === 0 && await page.locator("[data-next=schedule],[data-next=pay],[data-cancelpay],[data-void]").count() === 0, "仕訳の編集・支払の操作・取消は出ない");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== スマホ幅：横にはみ出さない／カード表示／ドロワー・ダイアログが使える ===");
{
  seedBase();
  const vid = await mkVendor();
  const id = await mkInvoice(vid, { paymentDueOn: addDays(TODAY, -2), dueSource: "invoice" });
  const { page, errs } = await open(`/office/billing.html?month=${MONTH}`, { viewport: { width: 390, height: 844 } });
  check(!(await bodyScrolls(page)), "一覧が横にはみ出さない");
  check(await page.locator("#pane-pay thead").isHidden(), "表の見出しは隠れ、カード表示になる");
  check(await page.locator("#cards .bl-card").count() === 8, "カード8枚");
  const cols = await page.locator("#cards").evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  check(cols === 2, `サマリーカードは2列（いま ${cols}列）`);
  check(await page.locator('#rows tr[data-id] td[data-label="支払状態"]').count() === 1, "各項目にラベルが付く");
  await page.locator("#rows tr[data-id]").click();
  await page.waitForSelector(".of-drawer");
  check(!(await bodyScrolls(page)), "ドロワーを開いても横にはみ出さない");
  const w = await page.locator(".of-drawer").evaluate((e) => e.getBoundingClientRect().width);
  check(w <= 390, `ドロワーは画面幅に収まる（${w}px）`);
  await page.locator('#nextCard [data-next="confirm"]').click();
  await page.waitForFunction(() => document.querySelector(".bl-next .ttl")?.textContent === "仕訳を設定");
  check(await page.locator(".bl-line").first().evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length) === 2, "仕訳の行は2列で折り返す");
  check(await page.evaluate(() => document.querySelector(".of-drawer").scrollWidth <= document.querySelector(".of-drawer").clientWidth + 1), "仕訳の編集も横にはみ出さない");
  await page.keyboard.press("Escape");
  await page.locator('[data-act="register"]').click();
  await page.waitForSelector(".bl-modal");
  const m = await page.locator(".bl-modal").evaluate((e) => ({ w: e.getBoundingClientRect().width, sw: e.scrollWidth, cw: e.clientWidth }));
  check(m.w <= 390 && m.sw <= m.cw + 1, `登録ダイアログが画面幅に収まる（${m.w}px）`);
  check(await page.locator("#regForm .bl-grid").evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").length) === 1, "入力欄は1列");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて OK");
process.exit(bad ? 1 : 0);
