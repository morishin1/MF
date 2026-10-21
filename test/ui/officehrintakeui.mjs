// Office 人事・労務：「HRからの引き継ぎ」（admin-hr.html の一覧と詳細ドロワー・js/office-hr-intake.js）を、
// 本物の API ハンドラ（api/hr/office-intakes.js・api/hr/documents.js・api/hr/offers/public.js・api/hr/applicants/advance.js）と
// 偽の Supabase（test/_memdb.mjs）につないで、実際のブラウザで通す（機能フラグ HR_OFFICE_INTAKE=1）。
//
// ■ 何を守るテストか（HR→Office 引き継ぎ 要件定義 2026-10-21 §5・§9、Issue #148）
//   1. 一覧：候補者・採用区分・希望条件・採用担当・Office担当・状態・NEXT ACTION・期限だけを出す。状態で絞り込める。引き渡した人は1件だけ
//   2. 詳細：上に NEXT ACTION と主ボタン1つ。面談の結果・希望条件・応募書類は折りたたみ（閲覧専用・再アップロードなし）
//   3. 受領 → 採用条件の作成 → 確定（経営者）→ 社労士へ依頼 → 正式PDF → 照合・承認 → LegalSign → 本人専用URL（メールは送らない）
//      → 本人の同意 → 締結の記録 → 社員登録へ進める準備 → ［社員登録へ］（admin-onboard.html）
//   4. 人事（給与を決められない）：給与の欄を出さず、確定のボタンは理由つきで押せない
//   5. 機能フラグ OFF：一覧を出さない
//   6. PC（1280px）と 390px で横にはみ出さない・画面のエラーなし。画面写真は test/_shot.mjs の置き場所（判定には使わない）
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createMemDb } from "../_memdb.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { MFA_AUTH } from "../_mfa.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
delete process.env.SALARY_OWNER_ONLY;
delete process.env.LEGALSIGN_ALLOWED_HOSTS;
process.env.HR_OFFICE_INTAKE = "1";
process.env.PUBLIC_BASE_URL = "https://gw.example.test";

const COLS = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by",
  "handoff_at", "handoff_by", "offer_title", "offer_pdf_path", "offer_pdf_sha256",
  "doc_route", "contract_route", "official_doc_id", "legalsign_doc_id", "legalsign_doc_sha256", "formal_evidence", "formal_contract_ref", "formal_doc_sha256",
  "accepted_at", "declined_at", "revoked_at", "sent_at", "viewed_at"];
const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]] },
    gw_hr_offers: { defaults: () => Object.fromEntries(COLS.map((c) => [c, null])) },
    gw_hr_offer_official_docs: { unique: [["offer_id", "revision"]], defaults: () => ({ status: "received", reviewed_by: null, reviewed_at: null,
      review_note: null, checks: {}, carried_from: null, uploaded_at: new Date().toISOString(), created_at: new Date().toISOString() }) },
    gw_hr_attorney_requests: { defaults: () => ({ kind: "initial", note: null, missing_labels: [], requested_at: new Date().toISOString() }) },
    gw_hr_office_intake_events: { defaults: () => ({ created_at: new Date().toISOString() }) },
  },
});
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async () => ({ created: 0 }), clearNotification: async () => {} } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
const sent = [];
mock.module(atRoot("lib/mail/index.js"), { namedExports: { ...REAL_MAIL,
  mailConfig: () => ({ configured: true, reason: null, from: "採用 <recruit@example.test>", replyTo: null }),
  sendMail: async (m) => { sent.push(m); throw new Error("本人へメールは送らない"); },
} });
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], apps: ["hr", "office"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const OHR = { userId: "u-ohr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["office"], employee: { id: "e-ohr", display_name: "労務 四郎" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
const I = await import(atRoot("lib/hr-office-intake.js"));

const handlers = {
  "/api/hr/office-intakes": (await import(atRoot("api/hr/office-intakes.js"))).default,
  "/api/hr/documents": (await import(atRoot("api/hr/documents.js"))).default,
  "/api/hr/offers/public": (await import(atRoot("api/hr/offers/public.js"))).default,
  "/api/hr/applicants/advance": (await import(atRoot("api/hr/applicants/advance.js"))).default,
};
async function callHandler(path, { method, body, qs = "", headers = {} }) {
  const out = { statusCode: 0, body: null, headers: {} };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (b) => { out.body = b; };
  await handlers[path]({ method, url: path + qs, headers: { authorization: MFA_AUTH, ...headers }, body }, out);
  return out;
}

// ---- 引き渡し済みの人（HR で社長合格 → ヒアリング → 引き渡しまで済んだ状態。PR A の API の結果と同じ行） ----
const HEARING = { offer_type: "part_time", job_title: "事務スタッフ", duties: "経理補助", desired_join_date: "2026-12-01", work_location: "東京本社",
  remote_policy: "出社のみ", weekly_days: 3, weekly_hours: 18, contract_period: "期間の定めなし", allowances_note: null, other_note: null, unresolved: [] };
function seed() {
  mem.reset(); sent.length = 0; who = OWNER;
  mem.rows.tenants = [{ id: "t1", name: "株式会社エイト" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-ohr", tenant_id: "t1", user_id: "u-ohr", display_name: "労務 四郎", status: "active" },
    { id: "e-rec", tenant_id: "t1", user_id: "u-rec", display_name: "採用 花子", status: "active" },
  ];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
  const base = { tenant_id: "t1", source: "Wantedly", stage: "offer", status: "offer_draft_pending", decision: "hired", rank: "A", recruiter_id: "e-rec",
    lead_category: "recruitment", offer_type: null, employee_id: null, job_title: "事務", advance_claimed_at: null, phone: "090-0000-0000" };
  mem.rows.gw_hr_applicants = [
    { ...base, id: "a1", name: "高木 沙綾", email: "a1@example.test" },
    { ...base, id: "a2", name: "森 一郎", email: "a2@example.test" },
    { ...base, id: "a3", name: "辞退 三子", email: "a3@example.test", status: "declined" },
  ];
  for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_mail_sends", "gw_hr_documents", "gw_hr_offer_official_docs", "gw_hr_attorney_requests",
    "gw_hr_office_intake_events", "memberships"]) mem.rows[t] = [];
  mem.rows.gw_hr_ceo_decisions = []; mem.rows.gw_hr_hearings = []; mem.rows.gw_hr_hearing_pay = []; mem.rows.gw_hr_office_intakes = [];
  for (const [i, id] of ["a1", "a2", "a3"].entries()) {
    const h = { id: `h-${id}`, tenant_id: "t1", applicant_id: id, ...HEARING, locked_at: "2026-10-20T03:00:00Z", confirmed_at: "2026-10-20T02:00:00Z",
      confirmed_by: "u-owner", recorded_by: "u-rec", recorded_at: "2026-10-19T02:00:00Z", exception_reason: null, exception_approved_by: null, exception_approved_at: null };
    mem.rows.gw_hr_hearings.push(h);
    mem.rows.gw_hr_hearing_pay.push({ hearing_id: h.id, tenant_id: "t1", applicant_id: id, desired_wage_type: "時給", desired_amount: 1500, desired_note: null });
    mem.rows.gw_hr_ceo_decisions.push({ id: `d-${id}`, tenant_id: "t1", applicant_id: id, decision: "pass", decided_by: "u-owner", decided_at: "2026-10-18T05:00:00Z", note: "ぜひ" });
    mem.rows.gw_hr_office_intakes.push({
      id: `k-${id}`, tenant_id: "t1", applicant_id: id, ceo_decision_id: `d-${id}`, hearing_id: h.id, hearing_snapshot: I.hearingSnapshot(h, true),
      unresolved_items: [], exception_reason: null, exception_approved_by: null, exception_approved_at: null, handed_by: "u-rec",
      handed_at: `2026-10-20T0${3 + i}:00:00Z`, office_assignee_id: "e-ohr", office_status: id === "a3" ? "withdrawn" : "not_started",
      received_by: id === "a3" ? "u-ohr" : null, received_at: id === "a3" ? "2026-10-20T06:00:00Z" : null, offer_id: null,
      closed_reason: id === "a3" ? "辞退：他社に決定" : null, closed_by: id === "a3" ? "u-ohr" : null, closed_at: id === "a3" ? "2026-10-21T01:00:00Z" : null,
      returned_by: null, returned_at: null, return_reason: null, client_request_id: null, created_at: "2026-10-20T03:00:00Z",
    });
  }
  mem.rows.gw_hr_interviews = [
    { id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual", conducted_at: "2026-10-01T01:00:00Z", interviewer_id: "e-rec", rank: "A",
      recommend_reason: "経理の経験が豊富", notes: "週3日を希望", scores: {}, created_at: "2026-10-01T01:00:00Z" },
    { id: "iv2", tenant_id: "t1", applicant_id: "a1", kind: "ceo", conducted_at: "2026-10-10T01:00:00Z", interviewer_id: "e-owner", rank: null,
      recommend_reason: null, notes: "合格", scores: {}, created_at: "2026-10-10T01:00:00Z" },
  ];
  mem.rows.gw_hr_documents = [{ id: "d1", tenant_id: "t1", applicant_id: "a1", doc_type: "resume", filename: "高木_履歴書.pdf", storage_path: "t1/recruit/a1/r.pdf",
    mime_type: "application/pdf", size_bytes: 10, sha256: "x", uploaded_by: "u-rec", deleted_at: null, created_at: "2026-10-01T00:00:00Z" }];
  mem.put("hr", "t1/recruit/a1/r.pdf", Buffer.from("%PDF-1.7\n"));
}
async function officialPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText("Labor notice", { x: 50, y: 780, size: 12 });
  return Buffer.from(await doc.save());
}
const PDF = await officialPdf();
const PDF_FILE = join(process.env.RUNNER_TEMP || (await import("node:os")).tmpdir(), "oi-official.pdf");
(await import("node:fs")).writeFileSync(PDF_FILE, PDF);

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const br = await launch();
async function openPage(person, { width = 1280, path = "/admin-hr.html" } = {}) {
  who = person;
  const context = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" })));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.route("https://storage.example/**", async (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "PUT") {
      mem.put("hr", decodeURIComponent(u.pathname.replace(/^\/upload\/hr\//, "")), route.request().postDataBuffer() || Buffer.alloc(0));
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.7\n" });
  });
  await page.route("**/admin-onboard.html*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>onboard</body></html>" }));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return json({ email: "hr@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, access: { officeHr: true, recruit: who === OWNER },
        gw: { employee: who.employee, roles: who.roles, isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (handlers[u.pathname]) {
      const body = req.method() === "GET" ? undefined : JSON.parse(req.postData() || "{}");
      const r = await callHandler(u.pathname, { method: req.method(), body, qs: u.search });
      return route.fulfill({ status: r.statusCode, contentType: r.headers["content-type"] || "application/json",
        headers: r.headers["content-disposition"] ? { "content-disposition": r.headers["content-disposition"] } : {}, body: r.body });
    }
    // 入退社の一覧（この画面の下の部分）は空で返す（別のテストで通す）
    if (u.pathname === "/api/hr") {
      return json({ tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
        onboarding: [], offboarding: [], done: [], kpi: null, people: [], roles: [], today: "2026-10-21", handoffs: { ready: true, rows: [] } });
    }
    if (/\/api\/hr\/retention/.test(u.pathname)) return json({ today: "2026-10-21", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/onboarding\/orientation/.test(u.pathname)) return json({ items: [], kinds: [], done: true });
    return json({});
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector("#oi-queue", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { page, errs, context };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const drawerOverflow = (page) => page.evaluate(() => { const d = document.getElementById("oi-drawer"); return d ? d.scrollWidth - d.clientWidth : 0; });
const status = async (page) => (await page.locator("#oi-status").innerText()).trim();
const primary = (page) => page.locator("#oi-next #oi-primary");
const settle = (page) => page.waitForTimeout(450);
const msg = async (page) => (await page.locator("#oi-msg").innerText().catch(() => "")).trim();

console.log("\n=== PC（1280px）：一覧 → 受領 → 採用条件 → 確定 → 社労士 → 正式PDF → 承認 → LegalSign → 本人専用URL → 同意 → 締結 → 社員登録へ ===");
{
  seed();
  const { page, errs, context } = await openPage(OWNER);
  const q = page.locator("#oi-queue");
  check(await q.count() === 1, "「HRからの引き継ぎ」の一覧が出る（フラグ ON）");
  check((await page.locator("#oi-open-n").innerText()).includes("2件"), "対応中 2件（辞退・不成立は対応中に数えない）");
  const rows = page.locator("#oi-rows .oi-row");
  check(await rows.count() === 2, "対応中の2人だけ並ぶ");
  const r1 = page.locator('[data-intake="k-a1"]');
  const t1 = await r1.innerText();
  check(t1.includes("高木 沙綾") && t1.includes("パート・アルバイト") && t1.includes("未着手"), "氏名・採用区分・状態");
  check(t1.includes("職種：事務スタッフ") && t1.includes("希望入社日：2026/12/01") && t1.includes("週3日・18時間") && t1.includes("希望報酬：入力あり"), "希望条件（希望額の値は一覧に出さない）");
  check(!t1.includes("1,500") && !t1.includes("1500"), "一覧に希望額の値を出さない");
  check(t1.includes("採用担当：採用 花子") && t1.includes("Office担当：労務 四郎"), "採用担当・Office担当");
  check((await r1.locator('[data-role="next-action"]').innerText()).includes("受け取り") && (await r1.locator('[data-role="deadline"]').innerText()).includes("2026/12/01"), "NEXT ACTION・期限");
  await page.locator('[data-filter="withdrawn"]').click();
  check(await page.locator("#oi-rows .oi-row").count() === 1 && (await page.locator("#oi-rows").innerText()).includes("辞退 三子"), "状態で絞り込める（辞退・不成立）");
  await page.locator('[data-filter="open"]').click();
  check(await overflow(page) <= 0, "横にはみ出さない（一覧）");
  await page.screenshot({ path: shotPath("officehrintake-1280-queue.png"), fullPage: true });

  await r1.locator('[data-act="open"]').click();
  await page.waitForSelector("#oi-drawer header", { timeout: 5000 }).catch(() => {});
  await settle(page);
  check(await status(page) === "未着手", "詳細：状態 未着手");
  check(await page.locator("#oi-drawer .btn-primary").count() === 1 && (await primary(page).innerText()).includes("受領して着手"), "上に主ボタンが1つだけ（受領して着手）");
  check(await page.locator("#oi-drawer details[open]").count() === 0, "詳細・経緯は折りたたみ（閉じた状態）");
  await page.locator('[data-sec="desired"] summary').click();
  const desired = await page.locator("#oi-desired").innerText();
  check(desired.includes("事務スタッフ") && desired.includes("候補者希望：時給 1,500円"), "希望条件（候補者の希望・給与を見られる人には額）");
  await page.locator('[data-sec="interviews"] summary').click();
  check((await page.locator('[data-sec="interviews"]').innerText()).includes("経理の経験が豊富"), "面談の結果（閲覧専用）");
  await page.locator('[data-sec="docs"] summary').click();
  await page.waitForSelector('#oi-docs [data-doc="resume"]', { timeout: 5000 }).catch(() => {});
  check((await page.locator("#oi-docs").innerText()).includes("高木_履歴書.pdf") && (await page.locator("#oi-docs").innerText()).includes("再アップロードは要りません"), "応募書類は HR の原本を閲覧専用で（再アップロードなし）");
  check(await page.locator('#oi-docs input[type="file"]').count() === 0, "応募書類のアップロード欄は無い");
  await page.screenshot({ path: shotPath("officehrintake-1280-detail.png"), fullPage: false });

  await primary(page).click(); await settle(page);
  check(await status(page) === "条件整理中", `受領 → 条件整理中（${await status(page)}）`);
  check((await primary(page).innerText()).includes("採用条件を作る"), "次：採用条件を作る");
  await primary(page).click(); await settle(page);
  check(await page.locator('#oi-form[data-form="offer"]').count() === 1, "採用条件の入力が開く");
  check(await page.locator("#oi-of-wageAmount").count() === 1, "経営者には給与・報酬の欄がある");
  check((await page.locator("#oi-of-joinDate").inputValue()) === "2026-12-01", "候補者の希望（希望入社日）を下書きに入れる（直せる）");
  await page.selectOption("#oi-of-employmentType", "パート").catch(() => {});
  await page.fill("#oi-of-wageAmount", "1400");
  await page.fill("#oi-of-workDays", "月・水・金").catch(() => {});
  await page.fill("#oi-of-workHours", "10:00〜16:00").catch(() => {});
  await page.locator("#oi-of-save").click(); await settle(page);
  if (await msg(page)) console.log("    msg:", await msg(page));
  check((await primary(page).innerText()).includes("採用条件を確定"), "作成 → 次：採用条件を確定（経営者）");
  await primary(page).click(); await settle(page);
  await page.locator('#oi-form[data-form="confirmOffer"] .btn-primary').click(); await settle(page);
  check(await status(page) === "社労士依頼中", `確定 → 社労士依頼中（${await status(page)}）`);

  await primary(page).click();
  await page.waitForSelector("#oi-req-text", { timeout: 5000 }).catch(() => {});
  check((await page.locator("#oi-req-text").inputValue()).includes("高木 沙綾"), "社労士への依頼文（下書き）に候補者の条件");
  await page.locator("#oi-req-done").click(); await settle(page);
  check((await msg(page)).includes("送ったこと"), "送ったチェックの前は依頼済みにしない");
  await page.locator("#oi-req-sent").check();
  await page.locator("#oi-req-done").click(); await settle(page);
  check(await status(page) === "正式PDF受領待ち", `依頼済み → 正式PDF受領待ち（${await status(page)}）`);
  await primary(page).click(); await settle(page);
  await page.setInputFiles("#oi-up-file", PDF_FILE);
  await page.locator('#oi-form[data-form="upload"] .btn-primary').click(); await page.waitForTimeout(900);
  if (await msg(page)) console.log("    msg:", await msg(page));
  check(mem.rows.gw_hr_offer_official_docs.length === 1 && /^[0-9a-f]{64}$/.test(mem.rows.gw_hr_offer_official_docs[0].file_sha256), "正式PDFを受け取る（版・SHA-256）");
  check((await primary(page).innerText()).includes("照合して承認"), "次：照合して承認");
  await primary(page).click(); await settle(page);
  for (const c of await page.locator("[data-oi-check]").all()) await c.check();
  await page.locator('#oi-form[data-form="review"] .btn-primary').first().click(); await settle(page);
  check((await primary(page).innerText()).includes("LegalSign"), "承認 → 次：LegalSign の登録");
  await primary(page).click(); await settle(page);
  await page.fill("#oi-ls-url", "https://sign.example.test/doc/1");
  await page.locator("#oi-ls-same").check();
  await page.locator('#oi-form[data-form="legalsign"] .btn-primary').click(); await settle(page);
  check((await primary(page).innerText()).includes("本人専用URL"), "次：本人専用URLを発行（メールは送らない）");
  await primary(page).click(); await settle(page);
  await page.locator("#oi-issue").click(); await settle(page);
  const url = (await page.locator("#oi-url").innerText()).trim();
  check(/\/hr\/offer\.html\?token=/.test(url), "本人専用URLを画面に出す（手で送る）");
  await page.locator("#oi-marksent").click(); await settle(page);
  check(await status(page) === "本人承諾待ち", `送付済み → 本人承諾待ち（${await status(page)}）`);
  check(sent.length === 0, "本人へメールは送らない");
  // 本人が同意（公開ページ。テストでは API を直接呼ぶ）
  const token = decodeURIComponent(url.split("token=")[1]);
  const acc = await callHandler("/api/hr/offers/public", { method: "POST", body: { token, action: "accept", agreed: true },
    headers: { "x-forwarded-for": "203.0.113.5", "user-agent": "TestPhone" } });
  check(acc.statusCode === 200, `本人の同意（${acc.statusCode}）`);
  await page.locator('#oi-drawer .oi-x').click();
  await page.locator('[data-intake="k-a1"] [data-act="open"]').click(); await page.waitForTimeout(700);
  check(await status(page) === "契約手続き中", `同意 → 契約手続き中（${await status(page)}）`);
  check((await primary(page).innerText()).includes("締結を記録"), "次：締結を記録");
  await primary(page).click(); await settle(page);
  await page.fill("#oi-sg-evidence", "LegalSign の締結完了の通知と締結済みPDFを確認");
  await page.locator("#oi-sg-same").check();
  await page.locator('#oi-form[data-form="signed"] .btn-primary').click(); await settle(page);
  check((await primary(page).innerText()).includes("社員登録へ進める準備"), "締結 → 次：社員登録へ進める準備");
  await primary(page).click(); await settle(page);
  await page.locator('#oi-form[data-form="formalHandoff"] .btn-primary').click(); await settle(page);
  check(await status(page) === "入社準備中", `準備 → 入社準備中（${await status(page)}）`);
  check(Boolean(mem.rows.gw_hr_offers.find((o) => o.applicant_id === "a1" && !o.revoked_at)?.handoff_at), "既存の handoff_at（社員登録へ進める印）が入る");
  await page.locator('[data-sec="contract"] summary').click();
  check(await page.locator('#oi-steps li[data-st="done"]').count() >= 5, "契約手続きのステップが済みになっている");
  check(await drawerOverflow(page) <= 0 && await overflow(page) <= 0, "横にはみ出さない（詳細）");
  await page.screenshot({ path: shotPath("officehrintake-1280-preparing.png"), fullPage: false });
  check((await primary(page).innerText()).includes("社員登録へ"), "次：社員登録へ");
  await primary(page).click();
  await page.waitForURL(/admin-onboard\.html\?applicantId=a1/, { timeout: 5000 }).catch(() => {});
  check(/admin-onboard\.html\?applicantId=a1/.test(page.url()), "［社員登録へ］で既存の社員登録の画面へ");
  check(!errs.length, `画面のエラーなし ${errs.join(" / ")}`);
  await context.close();
}

console.log("\n=== 390px：人事（給与を決められない）。給与の欄を出さず、確定は理由つきで押せない ===");
{
  const { page, errs, context } = await openPage(OHR, { width: 390 });
  check(await overflow(page) <= 0, "390px で横にはみ出さない（一覧）");
  const btnW = await page.locator('[data-intake="k-a2"] [data-act="open"]').evaluate((b) => b.getBoundingClientRect().width);
  check(btnW > 300, `390px：［開く］は幅いっぱい（${Math.round(btnW)}px）`);
  await page.screenshot({ path: shotPath("officehrintake-390-queue.png"), fullPage: true });
  await page.locator('[data-intake="k-a2"] [data-act="open"]').click(); await page.waitForTimeout(700);
  check(await drawerOverflow(page) <= 0 && await overflow(page) <= 0, "390px：詳細も横にはみ出さない");
  const pw = await primary(page).evaluate((b) => b.getBoundingClientRect().width);
  check(pw > 300, `390px：主ボタンは幅いっぱい（${Math.round(pw)}px）`);
  await primary(page).click(); await settle(page);
  await primary(page).click(); await settle(page);
  check(await page.locator("#oi-of-wageAmount").count() === 0, "人事には給与・報酬の欄を出さない（経営者が決める）");
  await page.selectOption("#oi-of-employmentType", "パート").catch(() => {});
  await page.locator("#oi-of-save").click(); await settle(page);
  if (await msg(page)) console.log("    msg:", await msg(page));
  check(await primary(page).isDisabled() && (await page.locator("#oi-why").innerText()).includes("経営者"), "確定は押せず、理由（経営者が確定）を出す");
  await page.locator('[data-sec="desired"] summary').click();
  check((await page.locator('[data-role="desired-pay"]').innerText()).includes("候補者希望"), "人事（給与を見られる）には希望額を出す");
  await page.screenshot({ path: shotPath("officehrintake-390-detail.png"), fullPage: false });
  check(!errs.length, `画面のエラーなし ${errs.join(" / ")}`);
  await context.close();
}

console.log("\n=== 機能フラグ OFF：一覧を出さない ===");
{
  process.env.HR_OFFICE_INTAKE = "0";
  const { page, errs, context } = await openPage(OWNER);
  check(await page.locator("#oi-queue").count() === 0 && await page.locator("#hr-intake").isHidden(), "OFF のときは「HRからの引き継ぎ」を出さない");
  check(!errs.length, `画面のエラーなし ${errs.join(" / ")}`);
  await context.close();
  process.env.HR_OFFICE_INTAKE = "1";
}

await br.close();
console.log(bad ? `\nNG ${bad} 件` : "\nすべて ok");
process.exit(bad ? 1 : 0);
