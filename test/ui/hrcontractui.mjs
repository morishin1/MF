// 採用HR：書類タブの「契約手続き」（社労士への依頼 → 正式PDF → 照合・承認 → LegalSign → 本人へ案内 → 同意 → 締結 → Office）を、
// 本物の API ハンドラ（api/hr/applicants/*・api/hr/offers/*・api/hr/documents.js）と偽の Supabase（test/_memdb.mjs）につないで、
// 実際のブラウザで通す。
//
// ■ 何を守るテストか（HR 社労士連携・条件通知・本人同意・LegalSign 契約管理 改善要件 §2・§6）
//   PC   … 区分のプルダウン（雇用期間・勤務地の種別・働き方）・有期のときだけ終了日・詳細は折りたたみ（勤務条件／給与・報酬／契約条件…）
//          ［条件を確定する］→ 書類タブのカード（状態・次の担当・7ステップ・主ボタン1つ）。NEXT ACTION は「下の契約手続きで進めます」
//          依頼文（要確認の警告・編集・コピー）→ チェックしないと［依頼済みにする］を押せない → 依頼済み
//          PDF のアップロード → 照合（全部✓で承認）→ LegalSign（同じ版の確認）→ 本人へ案内（正式PDFを添付）
//          → 本人が同意（公開 API）→「正式契約待ち」（正式契約済みとは出さない）→ 締結の記録（証跡）→ 版の照合が全部 ✓ → 引き渡し
//   権限 … 給与を見られない採用担当には、照合・承認を押せない理由を出し、正式PDFを開くボタンを出さない
//   スマホ … 390px でカードが縦に並び、横にはみ出さない・主ボタンは幅いっぱい
//   画面写真は test/_shot.mjs の置き場所（PR の確認用・判定には使わない）
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createMemDb } from "../_memdb.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
delete process.env.LEGALSIGN_ALLOWED_HOSTS;
process.env.PUBLIC_BASE_URL = "https://gw.example.test";

const COLS = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by",
  "handoff_at", "handoff_by", "offer_title", "offer_pdf_path", "offer_pdf_sha256",
  "doc_route", "contract_route", "official_doc_id", "legalsign_doc_id", "legalsign_doc_sha256", "formal_evidence", "formal_contract_ref", "formal_doc_sha256"];
const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]] },
    gw_hr_offers: { defaults: () => Object.fromEntries(COLS.map((c) => [c, null])) },
    gw_hr_offer_official_docs: { unique: [["offer_id", "revision"]], defaults: () => ({ status: "received", reviewed_by: null, reviewed_at: null,
      review_note: null, checks: {}, carried_from: null, uploaded_at: new Date().toISOString(), created_at: new Date().toISOString() }) },
    gw_hr_attorney_requests: { defaults: () => ({ kind: "initial", note: null, missing_labels: [], requested_at: new Date().toISOString() }) },
  },
});
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async () => ({ created: 0 }) } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
const sent = [];
mock.module(atRoot("lib/mail/index.js"), { namedExports: { ...REAL_MAIL,
  mailConfig: () => ({ configured: true, reason: null, from: "採用 <recruit@example.test>", replyTo: "hr@example.test" }),
  sendMail: async (m) => { sent.push(m); return { status: "sent", provider: "resend", providerMessageId: `msg_${sent.length}`, from: "recruit@example.test" }; },
} });
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-rec", display_name: "採用 花子" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const handlers = {
  "/api/hr/applicants/detail": (await import(atRoot("api/hr/applicants/detail.js"))).default,
  "/api/hr/applicants": (await import(atRoot("api/hr/applicants/index.js"))).default,
  "/api/hr/offers/contract": (await import(atRoot("api/hr/offers/contract.js"))).default,
  "/api/hr/offers/public": (await import(atRoot("api/hr/offers/public.js"))).default,
  "/api/hr/offers": (await import(atRoot("api/hr/offers/index.js"))).default,
  "/api/hr/documents": (await import(atRoot("api/hr/documents.js"))).default,
};
async function callHandler(path, { method, body, qs = "", headers = {} }) {
  const out = { statusCode: 0, body: null, headers: {} };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (b) => { out.body = b; };
  await handlers[path]({ method, url: path + qs, headers: { authorization: "Bearer x", ...headers }, body }, out);
  return out;
}
const api = async (path, method, body, qs = "") => {
  const r = await callHandler(path, { method, body, qs });
  try { return { status: r.statusCode, body: JSON.parse(r.body) }; } catch { return { status: r.statusCode, body: r.body }; }
};

const DUE = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
mem.rows.tenants = [{ id: "t1", name: "株式会社エイト" }];
mem.rows.gw_employees = [
  { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
  { id: "e-rec", tenant_id: "t1", user_id: "u-rec", display_name: "採用 花子", status: "active" },
];
mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
const applicant = (id, name, status = "offer_draft_pending") => ({
  id, tenant_id: "t1", name, email: `${id}@example.test`, job_title: "PM", source: "Wantedly", stage: "offer", status, decision: "hired", rank: "A",
  recruiter_id: "e-rec", employment_type: null, wage_type: null, wage_amount: null, lead_category: "recruitment", offer_type: "executive_employee",
  created_at: new Date().toISOString(),
});
mem.rows.gw_hr_applicants = [applicant("a1", "テスト 候補者"), applicant("a2", "権限 確認")];
for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_mail_sends", "gw_hr_interviews", "gw_hr_documents", "gw_hr_offer_official_docs", "gw_hr_attorney_requests"]) mem.rows[t] = [];

async function officialPdf() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([595, 842]).drawText(`Labor notice p${i + 1}`, { x: 50, y: 780, size: 12 });
  return Buffer.from(await doc.save());
}
const PDF = await officialPdf();

// a2：API で「書類受領・確認待ち」まで進めておく（給与を見られない採用担当の画面を確かめる）
{
  const made = await api("/api/hr/offers", "POST", { applicantId: "a2", respondBy: DUE, jobTitle: "PM", wageType: "月給", wageAmount: 300000,
    joinDate: "2026-12-01", workLocation: "東京本社", offerTerms: { workHours: "9:00〜18:00", contractPeriod: "期間の定めなし" } });
  const id = made.body.offer.id;
  await api("/api/hr/offers", "PATCH", { id, action: "confirm" });
  await api("/api/hr/offers/contract", "POST", { offerId: id, action: "markRequested" });
  const u = await api("/api/hr/offers/contract", "POST", { offerId: id, action: "uploadUrl", fileName: "a.pdf", size: PDF.length });
  mem.put("hr", u.body.path, PDF);
  const a = await api("/api/hr/offers/contract", "POST", { offerId: id, action: "attach", path: u.body.path, docKind: "labor_notice", receivedOn: new Date().toISOString().slice(0, 10) });
  if (a.status !== 200) throw new Error(`seed a2 ${JSON.stringify(a.body)}`);
}

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const br = await launch();
async function openApplicant(id, ctx, viewport = { width: 1360, height: 1000 }) {
  who = ctx;
  const context = await br.newContext({ viewport, timezoneId: "Asia/Tokyo" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  // 署名つきアップロード URL（偽の Storage）への PUT は、偽の Storage に置く
  await page.route("https://storage.example/**", async (route) => {
    const u = new URL(route.request().url());
    const path = decodeURIComponent(u.pathname.replace(/^\/upload\/hr\//, ""));
    mem.put("hr", path, route.request().postDataBuffer() || Buffer.alloc(0));
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === "/api/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        access: { recruit: true, officeHr: who === OWNER }, gw: { employee: who.employee, roles: who.roles, isAdmin: false, tenantId: "t1", stage: null } }) });
    }
    if (handlers[u.pathname]) {
      const body = req.method() === "GET" ? undefined : JSON.parse(req.postData() || "{}");
      const r = await callHandler(u.pathname, { method: req.method(), body, qs: u.search });
      const pdf = String(r.headers["content-type"] || "").includes("pdf");
      return route.fulfill({ status: r.statusCode, contentType: r.headers["content-type"] || "application/json",
        headers: r.headers["content-disposition"] ? { "content-disposition": r.headers["content-disposition"] } : {}, body: pdf ? r.body : r.body });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(`${BASE}/hr/applicants.html?id=${id}`);
  await page.waitForSelector("#hr-detail-next", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  return { page, errs, context };
}
const card = (page) => page.locator("#hr-contract");
const statusOf = async (page) => (await page.locator("#hr-ct-status").innerText()).trim();
const settle = (page) => page.waitForTimeout(500);

console.log("\n=== PC：条件の確定 → 社労士へ依頼 → 受領 → 承認 → LegalSign → 案内 → 同意 → 締結 → 引き渡し ===");
{
  const { page, errs, context } = await openApplicant("a1", OWNER);
  await page.locator("#hr-detail-next .btn-primary").click();
  await page.waitForSelector("#of-confirm", { timeout: 5000 }).catch(() => {});
  check(await page.locator("#of-confirm").count() === 1, "オファー入力に［条件を確定する］（社労士の正式PDFの流れ）");
  check(await page.locator("#of-send").count() === 0, "［PDFをプレビュー］（HR の条件通知書で送る流れ）は出さない");
  check((await page.locator("#of-official-note").innerText()).includes("条件案"), "HR の条件通知書は依頼用の条件案と説明する");
  await page.locator("#of-more summary").click();
  check(await page.locator('[data-field="contractPeriod"] select').count() === 1, "雇用期間はプルダウン");
  check(await page.locator('[data-field="workplaceType"] select').count() === 1 && await page.locator('[data-field="workStyle"] select').count() === 1,
    "勤務地の種別・働き方もプルダウン");
  check(await page.locator('[data-field="contractEndDate"]').isHidden(), "期間の定めなし のときは終了日を出さない");
  await page.selectOption("#of-f-contractPeriod", "期間の定めあり");
  check(await page.locator('[data-field="contractEndDate"]').isVisible(), "期間の定めあり にすると終了日が出る");
  await page.selectOption("#of-f-contractPeriod", "期間の定めなし");
  const groups = await page.locator("#of-more-fields .hr-of-group").allInnerTexts();
  check(["勤務条件", "給与・報酬", "契約条件"].every((g) => groups.includes(g)), `詳細は区切って並べる（${groups.join("・")}）`);
  await page.fill("#of-f-jobTitle", "PM");
  await page.locator('[data-field="pay"] .hr-opt button', { hasText: "月給" }).click();
  await page.fill("#of-f-wageAmount", "350000");
  await page.fill("#of-f-joinDate", "2026-12-01");
  await page.fill("#of-f-workLocation", "東京本社");
  await page.fill("#of-f-workHours", "9:00〜18:00");
  await page.locator("#of-confirm").click();
  await page.waitForSelector("#hr-contract", { timeout: 5000 }).catch(() => {});
  await settle(page);
  check(await card(page).count() === 1, "書類タブに「契約手続き」のカード");
  check(await statusOf(page) === "社労士へ依頼待ち", `状態：社労士へ依頼待ち（${await statusOf(page)}）`);
  check((await page.locator("#hr-ct-owner").innerText()) === "人事", "次の担当：人事");
  check(await page.locator("#hr-ct-steps li").count() === 7, "7つのステップ");
  check(await page.locator('#hr-ct-steps li[data-st="now"]').count() === 1, "いまのステップ（●）は1つ");
  check(await page.locator("#hr-contract .btn-primary").count() === 1, "カードの主ボタンは1つ");
  check(await page.locator("#hr-detail-next .btn-primary").count() === 0 && await page.locator("#hr-next-here").count() === 1,
    "書類タブでは NEXT ACTION に同じボタンを重ねない（下の契約手続きで進める）");
  check((await page.locator("#hr-ct-recommended").innerText()).includes("休憩"), "未入力の確認推奨項目を、依頼の前にまとめて出す");

  // 依頼文
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#ct-req-text", { timeout: 5000 }).catch(() => {});
  const text = await page.locator("#ct-req-text").inputValue();
  check(text.includes("- 氏名：テスト 候補者") && text.includes("労働条件通知書（雇用契約書）の作成をお願いいたします"), "依頼文に HR の条件が入る");
  check(text.includes("【要確認】") && await page.locator("#ct-req-missing").count() === 1, "未入力は【要確認】と警告");
  check(await page.locator("#ct-req-done").isDisabled(), "Slack で送ったチェックの前は［依頼済みにする］を押せない");
  await page.locator("#ct-req-copy").click();
  await page.waitForTimeout(200);
  check(/コピーしました|選択しました/.test(await page.locator("#ct-req-copied").innerText()), "［文章をコピー］（Slack へは送らない）");
  check(mem.rows.gw_hr_attorney_requests.filter((r) => r.applicant_id === "a1").length === 0, "コピーしただけでは記録しない");
  await page.screenshot({ path: shotPath("hr-contract-request-pc.png") });
  await page.locator("#ct-req-sent").check();
  await page.fill("#ct-req-note", "#労務相談 で依頼");
  await page.locator("#ct-req-done").click();
  await page.waitForSelector("#hr-contract", { timeout: 5000 }); await settle(page);
  check(await statusOf(page) === "社労士へ依頼済み", `依頼済みを記録（${await statusOf(page)}）`);
  check((await page.locator("#hr-ct-owner").innerText()) === "社労士", "次の担当：社労士");

  // 正式PDFの受け取り
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#ct-up-file", { timeout: 5000 });
  await page.setInputFiles("#ct-up-file", { name: "労働条件通知書.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.fill("#ct-up-author", "〇〇社労士事務所");
  await page.locator("#ct-up-go").click();
  await page.waitForSelector("#hr-contract", { timeout: 5000 }); await settle(page);
  check(await statusOf(page) === "書類受領・確認待ち", `受領：書類受領・確認待ち（${await statusOf(page)}）`);
  await page.locator("#hr-ct-docs summary").click();
  check((await page.locator("#hr-ct-docs").innerText()).includes("受領第1版"), "受領した版が並ぶ");
  await page.screenshot({ path: shotPath("hr-contract-received-pc.png"), fullPage: false });

  // 照合・承認
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#ct-rv-ok", { timeout: 5000 });
  check(await page.locator("#ct-rv-ok").isDisabled(), "全項目に✓するまで承認できない");
  for (const c of await page.locator("[data-ct-check]").all()) await c.check();
  check(!(await page.locator("#ct-rv-ok").isDisabled()), "全項目に✓で承認できる");
  await page.locator("#ct-rv-ok").click();
  await page.waitForSelector("#hr-contract", { timeout: 5000 }); await settle(page);
  check(await statusOf(page) === "本人への案内準備中", `承認：本人への案内準備中（LegalSign の登録が先）（${await statusOf(page)}）`);

  // LegalSign
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#ct-ls-url", { timeout: 5000 });
  await page.fill("#ct-ls-url", "https://sign.example.test/doc/abc");
  await page.locator("#ct-ls-save").click();
  await page.waitForTimeout(300);
  check((await page.locator("#ct-ls-msg").innerText()).includes("同じ"), "同じ版の確認が無いと記録しない");
  await page.locator("#ct-ls-same").check();
  await page.locator("#ct-ls-save").click();
  await page.waitForSelector("#hr-contract", { timeout: 5000 }); await settle(page);
  check(await statusOf(page) === "正式版確認済み", `LegalSign：正式版確認済み（${await statusOf(page)}）`);

  // 本人へ案内（正式PDFを添付）
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#sm-send", { timeout: 8000 }).catch(() => {});
  check(await page.locator("#sm-official").count() === 1 && await page.locator("#sm-notice").count() === 0, "送る画面は社労士の正式PDF（HR の条件通知書は出さない）");
  await page.screenshot({ path: shotPath("hr-contract-guide-pc.png") });
  await page.locator("#sm-send").click();
  await page.waitForSelector("#sm-done", { timeout: 8000 }).catch(() => {});
  const att = sent.at(-1)?.attachments || [];
  check(att.some((a) => Buffer.from(a.content).equals(PDF)), "メールに正式PDFそのものを添付");
  await page.locator("#sm-done").locator("..").locator("button", { hasText: "閉じる" }).click().catch(() => {});

  // 本人が同意（本人の画面の代わりに公開 API）→ 正式契約待ち
  const token = (/token=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text) || [])[1];
  const acc = await callHandler("/api/hr/offers/public", { method: "POST", body: { token, action: "accept", agreed: true },
    headers: { "x-forwarded-for": "203.0.113.5", "user-agent": "TestPhone" } });
  check(acc.statusCode === 200, "本人が条件に同意");
  await page.evaluate(() => refreshDetail("docs")); await settle(page);
  check(await statusOf(page) === "正式契約待ち", `同意しても正式契約済みとは出さない（${await statusOf(page)}）`);
  check(!(await page.locator("#hr-dr-sel").innerText()).includes("正式契約済み"), "上の状態にも正式契約済みと出さない");

  // 締結の記録
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#ct-sg-go", { timeout: 5000 });
  check(await page.locator("#ct-sg-go").isDisabled(), "証跡と同じ版の確認が無いと記録できない");
  await page.fill("#ct-sg-evidence", "LegalSign の締結完了の通知と締結済みPDFを確認");
  await page.locator("#ct-sg-same").check();
  await page.locator("#ct-sg-go").click();
  await page.waitForSelector("#hr-contract", { timeout: 5000 }); await settle(page);
  check(await statusOf(page) === "正式契約済み", `締結：正式契約済み（${await statusOf(page)}）`);
  check((await page.locator("#hr-ct-primary").innerText()).includes("Officeへ引き渡す"), "締結済・未引き渡し：主ボタンは引き渡し");
  await page.locator("#hr-ct-docs summary").click();
  const rec = await page.locator("#hr-ct-reconcile").innerText();
  check(!rec.includes("違う版") && (rec.match(/✓ 同じ/g) || []).length === 5, "版の照合：承認・案内・同意・LegalSign・締結が同じ版");
  await page.screenshot({ path: shotPath("hr-contract-signed-pc.png") });

  // 引き渡し（担当者が押す）
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#hd-go", { timeout: 5000 });
  check((await page.locator('[data-ho="reconcile"]').innerText()).includes("✓"), "引き渡しの確認に版の照合を出す");
  await page.locator("#hd-check").check();
  await page.locator("#hd-go").click();
  await page.waitForTimeout(800);
  await page.evaluate(() => refreshDetail("docs")); await settle(page);
  check(await statusOf(page) === "Office引き渡し済み", `Office へ引き渡し済み（${await statusOf(page)}）`);
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await context.close();
}

console.log("\n=== 給与を見られない採用担当（照合・承認できない） ===");
{
  const { page, errs, context } = await openApplicant("a2", RECRUITER);
  await page.evaluate(() => setDetailTab("docs")); await settle(page);
  check(await statusOf(page) === "書類受領・確認待ち", "状態：書類受領・確認待ち");
  check(await page.locator("#hr-ct-primary").isDisabled(), "照合・承認のボタンは押せない");
  check((await page.locator("#hr-ct-why").innerText()).includes("給与を見られる"), "押せない理由を出す");
  await page.locator("#hr-ct-docs summary").click();
  check(await page.locator("#hr-ct-docs button", { hasText: "PDFを開く" }).count() === 0, "正式PDFを開くボタンを出さない（給与が入るため）");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await context.close();
}

console.log("\n=== スマホ（390px） ===");
{
  const { page, errs, context } = await openApplicant("a2", OWNER, { width: 390, height: 844 });
  await page.evaluate(() => setDetailTab("docs")); await settle(page);
  check(await card(page).isVisible(), "カードが見える");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `横にはみ出さない（${over}px）`);
  const w = await page.locator("#hr-ct-primary").evaluate((b) => b.getBoundingClientRect().width);
  const cw = await card(page).evaluate((c) => c.getBoundingClientRect().width);
  check(w > cw * 0.7, `主ボタンは幅いっぱい（${Math.round(w)}/${Math.round(cw)}px）`);
  await page.locator("#hr-ct-primary").click();
  await page.waitForSelector("#ct-rv-ok", { timeout: 5000 }).catch(() => {});
  const over2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over2 <= 0, `照合の画面も横にはみ出さない（${over2}px）`);
  await page.screenshot({ path: shotPath("hr-contract-review-mobile.png"), fullPage: true });
  await page.locator("#action-root button", { hasText: "閉じる" }).first().click();
  await page.screenshot({ path: shotPath("hr-contract-card-mobile.png"), fullPage: true });
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await context.close();
}

await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\nすべて通過");
