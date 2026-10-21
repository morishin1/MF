// Office 人事・労務の「HRからの引き継ぎ」（api/hr/office-intakes.js。PR B）を、本物のハンドラで通す。
//
// ■ 何を守るテストか（HR→Office 引き継ぎ 要件定義 2026-10-21 §5・§7・§8・§9、Issue #148）
//   1. 権限：Office の人事・労務だけ（採用担当だけ・Office 権限なし・別の会社・別の応募者は、一覧・詳細・書類・更新とも断る）
//   2. キュー：引き渡した人が1件だけ出る（旧来の「HRから引き渡し」には重ねない）。受領・着手・担当
//   3. 状態は事実から決める（同じ関数を HR の一覧も使う）。9つの状態を、条件の版・依頼・正式PDF・承諾・締結・社員登録から
//   4. 契約の手続きを Office で：条件の作成 → 確定（経営者）→ 社労士へ依頼 → 正式PDF の受領（版・SHA-256）→ 照合・承認（給与を見られる人）
//      → LegalSign の登録 → 本人専用URL（メールは送らない）→ 本人の同意 → 締結の記録 → 社員登録へ進める準備（handoff_at）→ 社員登録 → 完了
//   5. 引き渡し後、HR からの書き込みは 409（読むのはよい）。旧フローの応募者は HR でこれまでどおり
//   6. 給与：希望額・会社の条件・条件PDF は給与を見られる人だけ。会社の給与を入れる・確定するのは経営者だけ
//   7. 辞退・不成立（理由つき・履歴を残す・HR では「終了」）、差し戻し（社長・管理者・理由・版の前だけ・行を消さない）
//   8. 社員登録：承諾・締結の前・status=accepted だけ（版なし）・二重登録は断る
//   9. 機能フラグ OFF：Office の画面も API も出さない
// ※ 実在の応募者は使わない。メール・Slack は送らない（送ろうとしたら失敗にする）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createMemDb } from "./_memdb.mjs";
import { MFA_AUTH } from "./_mfa.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
delete process.env.SALARY_OWNER_ONLY;
delete process.env.LEGALSIGN_ALLOWED_HOSTS;
process.env.HR_OFFICE_INTAKE = "1";
process.env.PUBLIC_BASE_URL = "https://gw.example.test";

const COLS_132 = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by"];
const COLS_133 = ["handoff_at", "handoff_by"];
const COLS_137 = ["offer_title", "offer_pdf_path", "offer_pdf_sha256"];
const COLS_139 = ["doc_route", "contract_route", "official_doc_id", "legalsign_doc_id", "legalsign_doc_sha256", "formal_evidence", "formal_contract_ref", "formal_doc_sha256"];
const nulls = (cols) => Object.fromEntries(cols.map((c) => [c, null]));
const mem = createMemDb({
  schema: {
    gw_hr_office_intakes: { unique: [["tenant_id", "applicant_id", "active_key"], ["tenant_id", "client_request_id"]],
      defaults: () => ({ active_key: "active", returned_at: null, returned_by: null, return_reason: null, office_status: "not_started",
        office_assignee_id: null, received_at: null, received_by: null, offer_id: null, closed_at: null, closed_by: null, closed_reason: null,
        client_request_id: null, handed_at: new Date().toISOString(), created_at: new Date().toISOString() }) },
    gw_hr_hearings: { unique: [["tenant_id", "applicant_id", "open_key"]],
      defaults: () => ({ open_key: "open", locked_at: null, confirmed_at: null, confirmed_by: null, exception_reason: null,
        exception_approved_by: null, exception_approved_at: null, unresolved: [] }) },
    gw_hr_hearing_pay: { unique: [["hearing_id"]], noId: true },
    gw_hr_ceo_decisions: { defaults: () => ({ decided_at: new Date().toISOString(), created_at: new Date().toISOString() }) },
    gw_hr_office_intake_events: { defaults: () => ({ created_at: new Date().toISOString() }) },
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]] },
    gw_hr_offers: { defaults: () => ({ ...nulls(COLS_132), ...nulls(COLS_133), ...nulls(COLS_137), ...nulls(COLS_139),
      accepted_at: null, declined_at: null, revoked_at: null, sent_at: null, viewed_at: null }) },
    gw_hr_offer_official_docs: {
      unique: [["offer_id", "revision"]],
      defaults: () => ({ status: "received", reviewed_by: null, reviewed_at: null, review_note: null, checks: {}, carried_from: null,
        uploaded_at: new Date().toISOString(), created_at: new Date().toISOString() }),
    },
    gw_hr_attorney_requests: { defaults: () => ({ kind: "initial", note: null, missing_labels: [], requested_at: new Date().toISOString() }) },
  },
});
const logged = [];
const notified = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: {
  notify: async (rows) => { notified.push(...rows); return { created: rows.length }; }, clearNotification: async () => {},
} });
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => { throw new Error("PR B は Slack を送らない"); } } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
mock.module(atRoot("lib/mail/index.js"), { namedExports: {
  ...REAL_MAIL,
  mailConfig: () => ({ configured: true, reason: null, from: "採用 <recruit@example.test>", replyTo: null }),
  sendMail: async () => { throw new Error("PR B は本人へメールを送らない"); },
} });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });

// 呼ぶ人
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], apps: ["hr", "office"], employee: { id: "e-owner" } };
const ADMIN = { userId: "u-adm", tenantId: "t1", isAdmin: true, isHr: true, roles: [], apps: ["hr", "office"], employee: { id: "e-adm" } };
const HRP = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"], employee: { id: "e-hr" } };
// Office の人事・労務（採用HRの権限は無い）
const OHR = { userId: "u-ohr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["office"], employee: { id: "e-ohr" } };
const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], apps: ["hr"], employee: { id: "e-rec" } };
const FIN = { userId: "u-fin", tenantId: "t1", isAdmin: false, isHr: false, roles: ["finance"], apps: ["office"], employee: { id: "e-fin" } };
const MEMBER = { userId: "u-mem", tenantId: "t1", isAdmin: false, isHr: false, roles: [], apps: [], employee: { id: "e-mem" } };
const OTHER = { userId: "u-oth", tenantId: "t2", isAdmin: false, isHr: true, roles: ["owner"], apps: ["hr", "office"], employee: { id: "e-oth" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { default: contractApi } = await import(atRoot("api/hr/offers/contract.js"));
const { default: publicApi } = await import(atRoot("api/hr/offers/public.js"));
const { default: advanceApi } = await import(atRoot("api/hr/applicants/advance.js"));
const { default: docsApi } = await import(atRoot("api/hr/documents.js"));
const { default: officeHrApi } = await import(atRoot("api/hr/index.js"));
const { default: officeApi } = await import(atRoot("api/hr/office-intakes.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));
const C = await import(atRoot("lib/hr-contract.js"));
const I = await import(atRoot("lib/hr-office-intake.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {}, raw: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => {
    if (Buffer.isBuffer(b) && String(r.headers["content-type"] || "").includes("pdf")) { r.raw = b; return; }
    try { r.body = JSON.parse(b); } catch { r.body = b; }
  };
  return r;
};
const call = async (fn, req) => { const r = res(); await fn({ headers: { authorization: MFA_AUTH }, ...req }, r); return r; };
const as = (p) => { who = p; };
const hrPatch = (body) => call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const hrList = () => call(listApi, { method: "GET", url: "/api/hr/applicants?category=all" });
const queue = (q = "") => call(officeApi, { method: "GET", url: `/api/hr/office-intakes${q}` });
const detail = (id, q = "") => call(officeApi, { method: "GET", url: `/api/hr/office-intakes?intake=${id}${q}` });
const op = (intake, action, body = {}) => call(officeApi, { method: "POST", url: "/api/hr/office-intakes", body: { intake, action, ...body } });
const PUB = { "x-forwarded-for": "203.0.113.5", "user-agent": "Mozilla/5.0 (TestPhone) Safari" };
const respond = (body) => call(publicApi, { method: "POST", url: "/api/hr/offers/public", body, headers: PUB });
const advanceGet = (id) => call(advanceApi, { method: "GET", url: `/api/hr/applicants/advance?applicantId=${id}` });
const advanceClaim = (id) => call(advanceApi, { method: "POST", url: "/api/hr/applicants/advance", body: { applicantId: id } });
const advanceDone = (id, employeeId) => call(advanceApi, { method: "PATCH", url: "/api/hr/applicants/advance", body: { applicantId: id, action: "complete", employeeId } });
const docs = (id) => call(docsApi, { method: "GET", url: `/api/hr/documents?applicantId=${id}` });
const docUrl = (docId) => call(docsApi, { method: "GET", url: `/api/hr/documents?id=${docId}` });

let okN = 0, ngN = 0;
const ok = async (name, fn) => {
  try { await fn(); okN++; console.log("  ok", name); }
  catch (e) { ngN++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

const DUE = T.defaultRespondBy();
const today = T.todayJst();
const FULL = {
  offer_type: "part_time", job_title: "事務スタッフ", duties: "経理補助", desired_join_date: "2026-12-01",
  work_location: "東京本社", remote_policy: "出社のみ", weekly_days: 3, weekly_hours: 18, contract_period: "期間の定めあり",
};
const OFFER = { employmentType: "パート", joinDate: "2026-12-01", workLocation: "東京本社", respondBy: DUE,
  offerTerms: { workDays: "月・水・金", workHours: "10:00〜16:00", contractPeriod: "期間の定めなし" } };
const ALL_CHECKS = Object.fromEntries(C.reviewChecksOf("part_time").map((c) => [c.key, true]));
const app = (id) => mem.rows.gw_hr_applicants.find((a) => a.id === id);
const offersOf = (id) => mem.rows.gw_hr_offers.filter((o) => o.applicant_id === id);
const currentOf = (id) => I.currentOfferOf(offersOf(id));
const intakeOf = (id) => mem.rows.gw_hr_office_intakes.find((i) => i.applicant_id === id && !i.returned_at);
async function officialPdf(label = "Labor notice") {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText(label, { x: 50, y: 780, size: 12 });
  return new Uint8Array(await doc.save());
}

function setup() {
  mem.reset(); logged.length = 0; notified.length = 0; who = OWNER;
  process.env.HR_OFFICE_INTAKE = "1";
  delete process.env.SALARY_OWNER_ONLY;
  mem.rows.tenants = [{ id: "t1", name: "テスト会社" }, { id: "t2", name: "別会社" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-adm", tenant_id: "t1", user_id: "u-adm", display_name: "管理 三郎", status: "active" },
    { id: "e-hr", tenant_id: "t1", user_id: "u-hr", display_name: "人事 次郎", status: "active" },
    { id: "e-ohr", tenant_id: "t1", user_id: "u-ohr", display_name: "労務 四郎", status: "active" },
    { id: "e-rec", tenant_id: "t1", user_id: "u-rec", display_name: "採用 花子", status: "active" },
    { id: "e-new", tenant_id: "t1", user_id: null, display_name: "新 一郎", status: "invited" },
    { id: "e-oth", tenant_id: "t2", user_id: "u-oth", display_name: "他社 社長", status: "active" },
  ];
  const base = { tenant_id: "t1", email: "cand@example.test", phone: "090-0000-0000", source: "テスト", rank: "A", recruiter_id: "e-rec",
    lead_category: "recruitment", employee_id: null, offer_type: null, decision: null, job_title: "事務", advance_claimed_at: null };
  mem.rows.gw_hr_applicants = [
    { ...base, id: "a1", name: "新 一郎", stage: "ceo_interview", status: "ceo_decision_pending" },
    { ...base, id: "a2", name: "新 二郎", stage: "ceo_interview", status: "ceo_decision_pending" },
    // 旧フローの「内定」：HR がオファーの版を作っている（新しい合格記録なし）
    { ...base, id: "old1", name: "旧 三郎", stage: "offer", status: "offer_draft_pending", decision: "hired", offer_type: "part_time" },
    // 承諾済みだが、承諾した版が無い（一括・手での変更や古いデータ）
    { ...base, id: "acc0", name: "抜 四郎", stage: "offer", status: "accepted", decision: "hired" },
    { ...base, id: "x1", tenant_id: "t2", name: "他社 五郎", stage: "ceo_interview", status: "ceo_decision_pending" },
  ];
  for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_interviews", "gw_hr_ceo_decisions", "gw_hr_hearings", "gw_hr_hearing_pay",
    "gw_hr_office_intakes", "gw_hr_office_intake_events", "memberships", "gw_hr_documents", "gw_hr_mail_sends",
    "gw_hr_offer_official_docs", "gw_hr_attorney_requests", "gw_procedures", "gw_procedure_items"]) mem.rows[t] = [];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
  mem.rows.gw_hr_interviews = [
    { id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual", conducted_at: "2026-10-01T01:00:00Z", rank: "A", recommend_reason: "経理経験が豊富",
      notes: "週3日希望", interviewer_id: "e-rec", scores: {}, created_at: "2026-10-01T01:00:00Z" },
    { id: "iv2", tenant_id: "t1", applicant_id: "a1", kind: "ceo", conducted_at: "2026-10-10T01:00:00Z", rank: null, recommend_reason: null,
      notes: "合格", interviewer_id: "e-owner", scores: {}, created_at: "2026-10-10T01:00:00Z" },
  ];
  mem.rows.gw_hr_documents = [
    { id: "d1", tenant_id: "t1", applicant_id: "a1", doc_type: "resume", filename: "履歴書.pdf", storage_path: "t1/recruit/a1/r.pdf",
      mime_type: "application/pdf", size_bytes: 10, sha256: "x", uploaded_by: "u-rec", deleted_at: null, created_at: "2026-10-01T00:00:00Z" },
    { id: "d2", tenant_id: "t1", applicant_id: "old1", doc_type: "resume", filename: "旧の履歴書.pdf", storage_path: "t1/recruit/old1/r.pdf",
      mime_type: "application/pdf", size_bytes: 10, sha256: "y", uploaded_by: "u-rec", deleted_at: null, created_at: "2026-10-01T00:00:00Z" },
  ];
  mem.put("hr", "t1/recruit/a1/r.pdf", new Uint8Array([37, 80, 68, 70]));
  mem.put("hr", "t1/recruit/old1/r.pdf", new Uint8Array([37, 80, 68, 70]));
}

/** db/143 の trigger（引き渡したらヒアリングを固定）の代わり */
function lockHearing(id) {
  const i = intakeOf(id);
  const h = mem.rows.gw_hr_hearings.find((x) => x.id === i.hearing_id);
  h.locked_at = i.handed_at; h.open_key = `locked-${h.id}`;
}
/** 社長合格 → ヒアリング → 確認 → ［Officeへ引き渡す］（PR A の API）。引き渡しの ID を返す */
async function handOff(id = "a1") {
  as(OWNER);
  let r = await hrPatch({ id, decision: "hired", stage: "offer", status: "offer_draft_pending", decisionNote: "ぜひ" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  as(HRP);
  r = await hrPatch({ id, action: "saveHearing", hearing: FULL, unresolved: [], pay: { desired_wage_type: "時給", desired_amount: 1500 } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await hrPatch({ id, action: "confirmHearing" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await hrPatch({ id, action: "officeHandoff", confirm: true, officeAssigneeId: "e-ohr" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  lockHearing(id);
  return intakeOf(id).id;
}
/** 受領 → 条件の作成（人事）→ 確定（経営者）。版の ID を返す */
async function confirmedOffer(id = "a1") {
  const k = await handOff(id);
  as(OHR);
  assert.equal((await op(k, "receive")).statusCode, 200);
  const made = await op(k, "createOffer", { offerType: "part_time", ...OFFER });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  as(OWNER);
  const offerId = made.body.offer.id;
  const upd = await op(k, "updateOffer", { offerId, wageAmount: 1400 });
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.body));
  const c = await op(k, "confirmOffer", { offerId });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  as(OHR);
  return { k, offerId };
}
async function receivePdf(k, offerId, label = "Labor notice") {
  const pdf = await officialPdf(label);
  const u = await op(k, "contract", { offerId, step: "uploadUrl", fileName: "通知書.pdf", size: pdf.length });
  assert.equal(u.statusCode, 200, JSON.stringify(u.body));
  mem.put("hr", u.body.path, pdf);
  const a = await op(k, "contract", { offerId, step: "attach", path: u.body.path, docKind: C.defaultDocKind("part_time"),
    receivedOn: today, authorName: "〇〇社労士事務所", fileName: "通知書.pdf" });
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  return { doc: a.body.doc, pdf, path: u.body.path };
}
/** 本人へ案内するまで（依頼 → 受領 → 承認 → LegalSign → URL → 送付済み）。token を返す */
async function guided(id = "a1") {
  const { k, offerId } = await confirmedOffer(id);
  assert.equal((await op(k, "contract", { offerId, step: "markRequested", note: "Slack で依頼" })).statusCode, 200);
  const { doc } = await receivePdf(k, offerId);
  const ap = await op(k, "contract", { offerId, step: "approve", docId: doc.id, checks: ALL_CHECKS });
  assert.equal(ap.statusCode, 200, JSON.stringify(ap.body));
  const ls = await op(k, "contract", { offerId, step: "legalsign", route: "legalsign", url: "https://sign.example.test/doc/1", sameDoc: true });
  assert.equal(ls.statusCode, 200, JSON.stringify(ls.body));
  const link = await op(k, "issueLink", { offerId });
  assert.equal(link.statusCode, 200, JSON.stringify(link.body));
  assert.ok(link.body.token, "本人専用URLの token は一度だけ返る");
  const sent = await op(k, "markSent", { offerId });
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  return { k, offerId, token: link.body.token, docId: doc.id };
}
const statusOf = async (k) => (await detail(k)).body.intake.status.key;

console.log("\n=== 1. 権限：Office の人事・労務だけ ===\n");

await ok("Office の人事（採用HRの権限なし）はキューを見られ、引き渡した人が1件だけ出る（項目：候補者・採用区分・希望条件・採用担当・Office担当・次にやること・期限）", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  const r = await queue();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 1);
  const it = r.body.items[0];
  assert.equal(it.id, k);
  assert.equal(it.name, "新 一郎");
  assert.equal(it.offerTypeLabel, "パート・アルバイト");
  assert.deepEqual([it.desired.jobTitle, it.desired.joinDate, it.desired.weeklyDays, it.desired.pay], ["事務スタッフ", "2026-12-01", 3, "entered"]);
  assert.equal(it.recruiterName, "採用 花子");
  assert.equal(it.assigneeName, "労務 四郎");
  assert.equal(it.status.key, "not_started");
  assert.equal(it.next.action, "receive");
  assert.equal(it.deadline, "2026-12-01");
  assert.ok(!JSON.stringify(r.body).includes("1500"), "一覧に希望額の値を出さない");
  assert.equal(r.body.counts.not_started, 1);
  const s = await queue("?summary=1");
  assert.deepEqual([s.body.open, s.body.counts.not_started, s.body.items], [1, 1, undefined]);
});

await ok("採用担当だけ・経理だけ・一般・Office 権限なしは 403（一覧・詳細・更新・書類とも）", async () => {
  setup();
  const k = await handOff("a1");
  for (const p of [RECRUITER, FIN, MEMBER]) {
    as(p);
    assert.equal((await queue()).statusCode, 403, p.userId);
    assert.equal((await detail(k)).statusCode, 403, p.userId);
    assert.equal((await op(k, "receive")).statusCode, 403, p.userId);
  }
  as(FIN);
  assert.equal((await docs("a1")).statusCode, 403, "経理は採用書類を見られない");
  assert.equal(intakeOf("a1").received_at, null);
});

await ok("別の会社の人：一覧に出ない・詳細・更新・書類は 404/403（ID を知っていても）", async () => {
  setup();
  const k = await handOff("a1");
  as(OTHER);
  assert.equal((await queue()).body.items.length, 0);
  assert.equal((await detail(k)).statusCode, 404);
  assert.equal((await op(k, "receive")).statusCode, 404);
  assert.equal(intakeOf("a1").received_at, null);
});

await ok("別の応募者：引き渡していない人の書類は Office から見られない・ほかの人の版を混ぜられない", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  const own = await docs("a1");
  assert.equal(own.statusCode, 200, JSON.stringify(own.body));
  assert.equal(own.body.readOnly, true);
  assert.equal(own.body.documents.find((d) => d.docType === "resume").latest.filename, "履歴書.pdf");
  assert.equal((await docs("old1")).statusCode, 403, "引き渡していない応募者の書類は見せない");
  assert.equal((await docUrl("d2")).statusCode, 403, "書類の ID だけでは見せない");
  assert.equal((await docUrl("d1")).statusCode, 200);
  const up = await call(docsApi, { method: "POST", url: "/api/hr/documents", body: { action: "upload", applicantId: "a1", docType: "resume", mimeType: "application/pdf", sizeBytes: 10 } });
  assert.equal(up.statusCode, 403, "Office から書類を登録し直させない（重複登録しない）");
  // 旧フローの応募者の版を、a1 の引き渡しの操作に混ぜられない
  as(HRP);
  const o = await call(offersApi, { method: "POST", url: "/api/hr/offers", body: { applicantId: "old1", ...OFFER } });
  assert.equal(o.statusCode, 200, JSON.stringify(o.body));
  as(OHR);
  await op(k, "receive");
  assert.equal((await op(k, "issueLink", { offerId: o.body.offer.id })).statusCode, 404);
  assert.equal((await detail(k, `&offerId=${o.body.offer.id}&file=offer`)).statusCode, 404);
});

await ok("機能フラグ OFF：GET は { enabled:false }・書き込みは 409。書類も早期引き渡しでは見せない", async () => {
  setup();
  const k = await handOff("a1");
  process.env.HR_OFFICE_INTAKE = "0";
  as(OHR);
  assert.deepEqual((await queue()).body, { enabled: false });
  assert.equal((await op(k, "receive")).statusCode, 409);
  assert.equal((await docs("a1")).statusCode, 403);
  process.env.HR_OFFICE_INTAKE = "1";
});

console.log("\n=== 2. 受領・詳細（閲覧専用の面談結果・希望条件・書類） ===\n");

await ok("受領は一度だけ（担当は引き渡しのまま）。受領前は条件を作れない。担当は同じ会社の在籍者だけ", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  assert.equal((await op(k, "createOffer", { offerType: "part_time", ...OFFER })).body.error, "not_received");
  const r = await op(k, "receive");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal((await op(k, "receive")).statusCode, 409);
  assert.equal(intakeOf("a1").received_by, "u-ohr");
  assert.equal(intakeOf("a1").office_assignee_id, "e-ohr");
  assert.equal(await statusOf(k), "organizing");
  assert.equal((await op(k, "assign", { assigneeId: "e-oth" })).statusCode, 400, "他社の社員は担当にできない");
  assert.equal((await op(k, "assign", { assigneeId: "e-hr" })).statusCode, 200);
  assert.ok(mem.rows.gw_hr_office_intake_events.some((e) => e.kind === "received"));
  assert.ok(mem.rows.gw_hr_office_intake_events.some((e) => e.kind === "assignee_changed"));
});

await ok("詳細：面談の結果・社長判断・希望条件（候補者の希望）・連絡先を閲覧専用で返す。希望額は給与を見られる人だけ", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  const d = await detail(k);
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  assert.equal(d.body.interviews.length, 2);
  assert.equal(d.body.interviews[0].recommendReason, "経理経験が豊富");
  assert.equal(d.body.decision.decidedByName, "社長 一郎");
  assert.equal(d.body.hearing.find((h) => h.key === "job_title").value, "事務スタッフ");
  assert.equal(d.body.pay.desiredAmount, 1500, "人事（給与を見られる）には希望額");
  process.env.SALARY_OWNER_ONLY = "1";
  const d2 = await detail(k);
  assert.equal(d2.body.pay.desiredAmount, undefined, "給与を見られない人には希望額を出さない");
  assert.equal(d2.body.pay.entered, true);
  assert.equal(d2.body.salaryVisible, false);
  delete process.env.SALARY_OWNER_ONLY;
});

console.log("\n=== 3. 採用条件（会社の正式な提示条件）と給与の決定 ===\n");

await ok("人事が条件を作ると給与・報酬は入らない（経営者が入れる）。確定は経営者だけ。版と引き渡しが結ばれる", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  await op(k, "receive");
  const made = await op(k, "createOffer", { offerType: "part_time", ...OFFER, wageAmount: 99999 });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const o = currentOf("a1");
  assert.equal(o.wage_amount ?? null, null, "人事の入れた給与は捨てる（経営者が決める）");
  assert.equal(o.offer_type, "part_time");
  assert.equal(intakeOf("a1").offer_id, o.id, "引き渡しと版を結ぶ");
  assert.equal(app("a1").status, "offer_review_pending");
  assert.equal(await statusOf(k), "organizing");
  assert.equal((await op(k, "createOffer", { offerType: "part_time", ...OFFER })).statusCode, 409, "版は二重に作らない");
  assert.equal((await op(k, "confirmOffer", { offerId: o.id })).statusCode, 403, "人事は確定できない（給与の決定は経営者）");
  as(OWNER);
  assert.equal((await op(k, "updateOffer", { offerId: o.id, wageAmount: 1400 })).statusCode, 200);
  assert.equal(currentOf("a1").wage_amount, 1400);
  assert.equal((await op(k, "confirmOffer", { offerId: o.id })).statusCode, 200);
  assert.equal(app("a1").status, "offer_send_pending");
  assert.equal(await statusOf(k), "attorney_requested");
  assert.ok(logged.some((l) => l.action === "hr.offer_create"), "HR と同じ処理（監査ログも同じ）");
});

await ok("育成枠・知らない区分では作らない", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  await op(k, "receive");
  assert.equal((await op(k, "createOffer", { offerType: "training", ...OFFER })).statusCode, 400);
});

console.log("\n=== 4. 引き渡し後、HR からの書き込みは 409（読むのはよい） ===\n");

await ok("HR の版の作成・更新・確定・URL・契約手続きの書き込みは 409。カードは閲覧専用で読める", async () => {
  setup();
  const { k, offerId } = await confirmedOffer("a1");
  as(HRP);
  assert.equal((await call(offersApi, { method: "POST", url: "/api/hr/offers", body: { applicantId: "a1", ...OFFER } })).body.error, "moved_to_office");
  for (const action of ["update", "confirm", "issueLink", "markSent", "handoff", "send"]) {
    const r = await call(offersApi, { method: "PATCH", url: "/api/hr/offers", body: { id: offerId, action, jobTitle: "x" } });
    assert.equal(r.statusCode, 409, action);
    assert.equal(r.body.error, "moved_to_office", action);
  }
  for (const action of ["markRequested", "approve", "legalsign", "signed"]) {
    const r = await call(contractApi, { method: "POST", url: "/api/hr/offers/contract", body: { offerId, action } });
    assert.equal(r.body.error, "moved_to_office", action);
  }
  assert.equal(mem.rows.gw_hr_attorney_requests.length, 0);
  const card = await call(contractApi, { method: "GET", url: "/api/hr/offers/contract?applicantId=a1" });
  assert.equal(card.statusCode, 200);
  assert.equal(card.body.movedToOffice, true);
  assert.equal(card.body.procedure.primary, null, "HR ではボタンを出さない");
  // HR の一覧は「Officeへ移動済み」で、Office と同じ状態
  const l = (await hrList()).body.applicants.find((a) => a.id === "a1");
  assert.equal(l.listTab, "office");
  assert.equal(l.officeIntake.officeStatus, "attorney_requested");
  assert.ok(l.statusLabel.includes("社労士依頼中"), l.statusLabel);
  assert.equal(await statusOf(k), "attorney_requested");
});

await ok("旧フロー（新しい合格記録なし・HR で版を作った人）は HR でこれまどおり作成・確定でき、Office には出ない", async () => {
  setup();
  await handOff("a1");
  as(HRP);
  const o = await call(offersApi, { method: "POST", url: "/api/hr/offers", body: { applicantId: "old1", ...OFFER } });
  assert.equal(o.statusCode, 200, JSON.stringify(o.body));
  const c = await call(offersApi, { method: "PATCH", url: "/api/hr/offers", body: { id: o.body.offer.id, action: "confirm" } });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  const m = await call(contractApi, { method: "POST", url: "/api/hr/offers/contract", body: { offerId: o.body.offer.id, action: "markRequested" } });
  assert.equal(m.statusCode, 200, JSON.stringify(m.body));
  as(OHR);
  assert.ok(!(await queue()).body.items.some((x) => x.applicantId === "old1"));
  const l = (await (as(HRP), hrList())).body.applicants.find((a) => a.id === "old1");
  assert.notEqual(l.listTab, "office");
  assert.equal(l.officeIntake, null);
});

console.log("\n=== 5. 契約の手続き（社労士 → 正式PDF → 案内 → 同意 → 締結 → 社員登録 → 完了） ===\n");

await ok("正式PDF：版（受領第1版→第2版）と SHA-256 の証跡。承認は給与を見られる人だけ。保存されたPDFが記録と違えば承認しない", async () => {
  setup();
  const { k, offerId } = await confirmedOffer("a1");
  assert.equal((await op(k, "contract", { offerId, step: "markRequested" })).statusCode, 200);
  assert.equal(await statusOf(k), "awaiting_official_pdf");
  const first = await receivePdf(k, offerId, "v1");
  const second = await receivePdf(k, offerId, "v2");
  const rows = mem.rows.gw_hr_offer_official_docs;
  assert.deepEqual(rows.map((d) => d.revision), [1, 2]);
  assert.equal(rows[0].status, "superseded", "前に受け取った確認待ちの版は使わない");
  assert.match(rows[1].file_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].file_sha256, rows[1].file_sha256);
  // 給与を見られない人は承認できない
  process.env.SALARY_OWNER_ONLY = "1";
  assert.equal((await op(k, "contract", { offerId, step: "approve", docId: second.doc.id, checks: ALL_CHECKS })).statusCode, 403);
  assert.equal((await detail(k, `&docId=${second.doc.id}`)).statusCode, 403, "正式PDFは給与を見られる人だけ");
  delete process.env.SALARY_OWNER_ONLY;
  // Storage を書き換えられた：承認しない
  mem.put("hr", second.path, await officialPdf("tampered"));
  const bad = await op(k, "contract", { offerId, step: "approve", docId: second.doc.id, checks: ALL_CHECKS });
  assert.equal(bad.statusCode, 409);
  mem.put("hr", second.path, second.pdf);
  const good = await op(k, "contract", { offerId, step: "approve", docId: second.doc.id, checks: ALL_CHECKS });
  assert.equal(good.statusCode, 200, JSON.stringify(good.body));
  const pdf = await detail(k, `&docId=${second.doc.id}`);
  assert.equal(pdf.statusCode, 200);
  assert.ok(pdf.raw && pdf.raw.length > 0);
  assert.ok(logged.some((l) => l.action === "hr.official_doc_received" && l.detail.sha256 === rows[1].file_sha256));
  assert.equal(first.doc.revision, 1);
});

await ok("本人への案内はメールを送らない（URL を発行して手で送る）。案内後は本人承諾待ち。期限は回答期限", async () => {
  setup();
  const { k, offerId } = await confirmedOffer("a1");
  await op(k, "contract", { offerId, step: "markRequested" });
  const { doc } = await receivePdf(k, offerId);
  await op(k, "contract", { offerId, step: "approve", docId: doc.id, checks: ALL_CHECKS });
  await op(k, "contract", { offerId, step: "legalsign", route: "legalsign", url: "https://sign.example.test/doc/1", sameDoc: true });
  const send = await call(officeApi, { method: "POST", url: "/api/hr/office-intakes", body: { intake: k, action: "send", offerId } });
  assert.equal(send.statusCode, 400, "メール送付の操作は無い");
  await op(k, "issueLink", { offerId });
  await op(k, "markSent", { offerId });
  const d = (await detail(k)).body;
  assert.equal(d.intake.status.key, "awaiting_consent");
  assert.equal(d.intake.deadline, DUE);
  assert.equal(currentOf("a1").official_doc_id, doc.id, "承認した正式PDFを案内した版に固定");
  assert.equal(mem.rows.gw_hr_mail_sends.length, 0);
});

await ok("同意 → 締結（人事）→ 社員登録へ進める準備（handoff_at）→ 社員登録 → 完了。通知は送らない。accepted_at・formal_signed_at は事実のまま", async () => {
  setup();
  const { k, offerId, token } = await guided("a1");
  // 同意の前・締結の前は社員登録へ進めない
  as(OHR);
  assert.equal((await advanceGet("a1")).statusCode, 409);
  const acc = await respond({ token, action: "accept", agreed: true });
  assert.equal(acc.statusCode, 200, JSON.stringify(acc.body));
  assert.equal(await statusOf(k), "contracting");
  assert.equal((await advanceGet("a1")).body.error, "handoff_required", "同意しただけ・未締結では社員登録しない");
  assert.equal((await op(k, "formalHandoff", { offerId })).statusCode, 409, "締結前は準備へ進めない");
  as(RECRUITER);
  assert.equal((await op(k, "contract", { offerId, step: "signed", evidence: "x", sameDoc: true })).statusCode, 403);
  as(OHR);
  const sg = await op(k, "contract", { offerId, step: "signed", evidence: "LegalSign の締結完了通知を確認", contractRef: "LS-1", sameDoc: true });
  assert.equal(sg.statusCode, 200, JSON.stringify(sg.body));
  assert.equal(await statusOf(k), "contracting");
  const before = notified.length;
  const ho = await op(k, "formalHandoff", { offerId });
  assert.equal(ho.statusCode, 200, JSON.stringify(ho.body));
  const o = currentOf("a1");
  assert.ok(o.handoff_at && o.accepted_at && o.formal_signed_at);
  assert.equal(notified.length, before, "Office 自身が受け手なので通知しない（通知は PR C）");
  assert.equal(await statusOf(k), "preparing_join");
  // 旧来の「HRから引き渡し」には重ねない（1件だけ）
  const q = await call(officeHrApi, { method: "GET", url: "/api/hr" });
  assert.equal(q.statusCode, 200, JSON.stringify(q.body).slice(0, 300));
  assert.ok(!(q.body.handoffs?.rows || []).some((r) => r.applicantId === "a1"), "旧来のキューに重ねない");
  // 社員登録 → 二重登録は断る
  assert.equal((await advanceClaim("a1")).statusCode, 200);
  assert.equal((await op(k, "complete")).statusCode, 409, "社員登録の前は完了にできない");
  assert.equal((await advanceDone("a1", "e-new")).statusCode, 200);
  assert.equal((await advanceDone("a1", "e-hr")).body.error, "already_advanced");
  assert.equal(app("a1").employee_id, "e-new");
  assert.equal(await statusOf(k), "preparing_join");
  assert.equal((await op(k, "withdraw", { kind: "declined", reason: "x" })).statusCode, 409, "社員登録のあとは辞退にしない");
  const done = await op(k, "complete");
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(await statusOf(k), "completed");
  assert.equal((await op(k, "assign", { assigneeId: "e-hr" })).statusCode, 409, "完了のあとは変えない");
  // 監査（追記だけ）
  const kinds = mem.rows.gw_hr_office_intake_events.map((e) => e.kind);
  for (const kind of ["handed_off", "received", "status_changed"]) assert.ok(kinds.includes(kind), kind);
});

await ok("給与：会社の条件の給与・条件PDF（正式PDF）は給与を見られる人だけ。見られない人には外して返す", async () => {
  setup();
  const { k, offerId } = await guided("a1");
  as(OWNER);
  let d = (await detail(k)).body;
  assert.equal(d.offers[0].wageAmount, 1400);
  assert.equal((await detail(k, `&offerId=${offerId}&file=notice`)).statusCode, 200, "経営者は条件PDFを開ける");
  process.env.SALARY_OWNER_ONLY = "1";
  as(OHR);
  d = (await detail(k)).body;
  assert.equal(d.offers[0].wageAmount, undefined, "給与を見られない人には給与を返さない");
  assert.ok(!JSON.stringify(d).includes("1400"), JSON.stringify(d).slice(0, 200));
  assert.equal((await detail(k, `&offerId=${offerId}&file=notice`)).statusCode, 403);
  assert.equal(d.can.approve, false);
  delete process.env.SALARY_OWNER_ONLY;
});

console.log("\n=== 6. 辞退・不成立・差し戻し ===\n");

await ok("辞退・不成立：理由が要る。版は無効にし、履歴は残す。HR では「終了」。社員登録へは進めない", async () => {
  setup();
  const { k, offerId } = await guided("a1");
  assert.equal((await op(k, "withdraw", { kind: "declined" })).statusCode, 400);
  assert.equal((await op(k, "withdraw", { kind: "x", reason: "a" })).statusCode, 400);
  const w = await op(k, "withdraw", { kind: "declined", reason: "他社に決めたため" });
  assert.equal(w.statusCode, 200, JSON.stringify(w.body));
  const i = intakeOf("a1");
  assert.deepEqual([i.office_status, i.closed_reason, i.closed_by], ["withdrawn", "辞退：他社に決めたため", "u-ohr"]);
  assert.ok(mem.rows.gw_hr_offers.find((o) => o.id === offerId).revoked_at, "本人のURLを閉じる");
  assert.equal(app("a1").status, "declined");
  assert.equal(mem.rows.gw_hr_offer_official_docs.length, 1, "正式PDFの記録は消さない");
  assert.ok(mem.rows.gw_hr_office_intake_events.some((e) => e.kind === "closed"));
  assert.equal(await statusOf(k), "withdrawn");
  assert.equal((await op(k, "receive")).statusCode, 409, "終わった引き渡しは変えない");
  as(HRP);
  const l = (await hrList()).body.applicants.find((a) => a.id === "a1");
  assert.equal(l.listTab, "closed");
  assert.equal(l.officeIntake.phase, "withdrawn");
  as(OHR);
  assert.equal((await advanceGet("a1")).statusCode, 409);
});

await ok("差し戻し：社長・管理者だけ・理由が要る・版を作る前だけ。行は消さない。HR で確かめ直して引き渡し直せる", async () => {
  setup();
  const k = await handOff("a1");
  as(OHR);
  assert.equal((await op(k, "returnToHr", { reason: "誤操作" })).statusCode, 403, "人事だけでは差し戻せない");
  as(ADMIN);
  assert.equal((await op(k, "returnToHr", {})).statusCode, 400);
  const r = await op(k, "returnToHr", { reason: "条件ヒアリングの相手を取り違えた" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const all = mem.rows.gw_hr_office_intakes.filter((x) => x.applicant_id === "a1");
  assert.equal(all.length, 1, "行は消さない");
  all[0].active_key = `returned-${all[0].id}`;   // 部分一意索引（returned_at is null）の代わり
  assert.equal(all[0].return_reason, "条件ヒアリングの相手を取り違えた");
  assert.ok(mem.rows.gw_hr_office_intake_events.some((e) => e.kind === "returned"));
  as(OHR);
  assert.equal((await queue()).body.items.length, 0, "差し戻した人はキューから外れる");
  assert.equal((await detail(k)).statusCode, 404);
  // HR：選考中に戻る（ヒアリングは確認前の写し）→ 確かめ直して引き渡し直す
  as(HRP);
  const l = (await hrList()).body.applicants.find((a) => a.id === "a1");
  assert.equal(l.listTab, "active");
  assert.equal(l.officeIntake.phase, "hearing");
  assert.equal((await hrPatch({ id: "a1", action: "confirmHearing" })).statusCode, 200);
  assert.equal((await hrPatch({ id: "a1", action: "officeHandoff", confirm: true })).statusCode, 200);
  lockHearing("a1");
  assert.equal(mem.rows.gw_hr_office_intakes.filter((x) => x.applicant_id === "a1").length, 2, "履歴は2件（1件は差し戻し済み）");
  // 版を作ったあとは差し戻せない
  const k2 = intakeOf("a1").id;
  as(OHR);
  await op(k2, "receive");
  await op(k2, "createOffer", { offerType: "part_time", ...OFFER });
  as(ADMIN);
  assert.equal((await op(k2, "returnToHr", { reason: "x" })).body.error, "has_offer");
});

console.log("\n=== 7. 社員登録の抜け道（advance.js） ===\n");

await ok("status=accepted だけ（承諾した版なし）では、事前入力・手続き開始・完了のどれも 409", async () => {
  setup();
  as(OHR);
  assert.equal((await advanceGet("acc0")).body.error, "acceptance_required");
  assert.equal((await advanceClaim("acc0")).body.error, "acceptance_required");
  assert.equal((await advanceDone("acc0", "e-new")).body.error, "acceptance_required");
  assert.equal(app("acc0").employee_id, null);
  // 承諾していない人の完了も断る（社員を別に作って結ぶ抜け道）
  assert.equal((await advanceDone("a2", "e-new")).statusCode, 409);
  assert.equal(app("a2").employee_id, null);
});

await ok("早期引き渡しの人は、区分の無い版でも handoff_at（Office の確認）が要る", async () => {
  setup();
  const k = await handOff("a2");
  // 直接 DB に「承諾した区分なしの版」があっても（古いデータ・不正な書き込みを想定）、Office の確認が無ければ進めない
  mem.rows.gw_hr_offers.push({ id: "o-x", tenant_id: "t1", applicant_id: "a2", version: 1, accepted_at: "2026-10-20T00:00:00Z",
    revoked_at: null, declined_at: null, offer_type: null, handoff_at: null });
  app("a2").status = "accepted";
  as(OHR);
  const r = await advanceGet("a2");
  assert.deepEqual([r.statusCode, r.body.error], [409, "handoff_required"]);
  assert.ok(k);
});

await ok("状態の決め方（lib/hr-office-intake.js officeStatusOf）：9つを事実から", () => {
  const intake = { office_status: "not_started", hearing_snapshot: { desired_join_date: "2026-12-01" } };
  const S = (x) => I.officeStatusOf({ intake: { ...intake, ...(x.intake || {}) }, applicant: x.applicant || { status: "offer_draft_pending" }, offers: x.offers || [], docs: x.docs || [], requests: x.requests || [] }).key;
  const base = { id: "o", version: 1, offer_type: "part_time", doc_route: "official", revoked_at: null, accepted_at: null, sent_at: null };
  assert.equal(S({}), "not_started");
  assert.equal(S({ intake: { received_at: "x" } }), "organizing");
  assert.equal(S({ intake: { received_at: "x" }, offers: [base], applicant: { status: "offer_review_pending" } }), "organizing");
  assert.equal(S({ intake: { received_at: "x" }, offers: [base], applicant: { status: "offer_send_pending" } }), "attorney_requested");
  assert.equal(S({ intake: { received_at: "x" }, offers: [base], applicant: { status: "offer_send_pending" }, requests: [{ offer_id: "o", requested_at: "1" }] }), "awaiting_official_pdf");
  assert.equal(S({ intake: { received_at: "x" }, offers: [{ ...base, sent_at: "1", official_doc_id: "d", expires_at: "2999-01-01T00:00:00Z" }], applicant: { status: "offer_sent" } }), "awaiting_consent");
  assert.equal(S({ intake: { received_at: "x" }, offers: [{ ...base, sent_at: "1", official_doc_id: "d", accepted_at: "2" }], applicant: { status: "accepted" } }), "contracting");
  assert.equal(S({ intake: { received_at: "x" }, offers: [{ ...base, sent_at: "1", official_doc_id: "d", accepted_at: "2", handoff_at: "3" }], applicant: { status: "accepted" } }), "preparing_join");
  assert.equal(S({ intake: { received_at: "x", office_status: "completed" }, applicant: { status: "done", employee_id: "e" } }), "completed");
  assert.equal(S({ intake: { received_at: "x", office_status: "withdrawn", closed_at: "1" } }), "withdrawn");
  assert.deepEqual(I.OFFICE_STATUS_KEYS.length, 9);
});

console.log(`\n合計 ${okN + ngN} 件中 ${okN} 件 通過`);
if (ngN) process.exit(1);
