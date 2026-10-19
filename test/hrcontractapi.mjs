// 採用HR：契約手続き（社労士への作成依頼 → 正式PDFの受領・照合・承認 → LegalSign の登録 → 本人へ案内 → 条件同意
// → 締結の記録 → Office 引き渡し。db/139・api/hr/offers/contract.js・api/hr/offers/index.js）を、偽の Supabase で通す。
//
// ■ 何を守るテストか（HR 社労士連携・条件通知・本人同意・LegalSign 契約管理 改善要件 §6 受け入れ基準）
//   1. 区分ごとに依頼文を作る（正社員・パートは労働条件通知書、業務委託は業務委託契約書。未入力は【要確認】。架空の値で埋めない）
//      給与を見られない人には給与・報酬を伏せる。下書きを作っただけ・コピーしただけでは「依頼済み」にならない
//   2. 「依頼済みにする」を押したときだけ記録。一覧で 依頼待ち／依頼済み が分かる。Slack へは送らない（送信済みと言わない）
//   3. 社労士のPDFを受け取る（PDFの中身・大きさ・置き場所・版・SHA-256）。照合・承認は給与を見られる人だけ・全項目に✓
//      差し戻し（理由つき）→ 修正の依頼文（理由入り）→ 新しい版。承認・差し戻しの前にメール送信できない
//   4. 正式契約が要る版は、LegalSign に承認した版を登録した記録（または例外ルート）が無いと送れない
//   5. 送ると、承認した正式PDFそのものを添付し、notice_* と official_doc_id に固定する（本人の画面・承諾済みPDF・Office も同じ版）
//      保存されたPDFが記録のハッシュと違えば送らない。同じ送信キーの2回目は送らない（重複送信）
//   6. 条件同意と正式契約は別：同意しても「正式契約済み」と出さない。締結の記録は証跡が要り、本人の同意の前でもよい
//      承諾済・未締結／締結済・未同意は Office へ引き渡せない。締結済・同意済で引き渡せる（引き渡しは担当者が押す）
//   7. 再発行した版へ、承認した正式PDFは引き継ぐが、本人の同意は引き継がない
//   8. db/139 が無い環境では、これまでどおり（カードは出さない・HR の条件通知書で送る）
//   ※ 実在の応募者・実際のメール送信・Slack は使わない（送信は偽物。宛先は example.test）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
delete process.env.LEGALSIGN_ALLOWED_HOSTS;
process.env.PUBLIC_BASE_URL = "https://gw.example.test";

const COLS_132 = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by"];
const COLS_133 = ["handoff_at", "handoff_by"];
const COLS_137 = ["offer_title", "offer_pdf_path", "offer_pdf_sha256"];
const COLS_139 = ["doc_route", "contract_route", "official_doc_id", "legalsign_doc_id", "legalsign_doc_sha256", "formal_evidence", "formal_contract_ref", "formal_doc_sha256"];
let c139 = true;   // db/139 が適用済みの DB か
const nulls = (cols) => Object.fromEntries(cols.map((c) => [c, null]));
// db/139 の CHECK と同じ条件（API が DB に断られる形も確かめる）
const offerCheck = (r) => {
  if (r.doc_route === "official" && r.sent_at && !r.official_doc_id) return "gw_hr_offers_official_sent_chk";
  if (r.official_doc_id && !(r.notice_pdf_path && r.notice_pdf_sha256)) return "gw_hr_offers_official_notice_chk";
  if (r.legalsign_doc_sha256 && r.notice_pdf_sha256 && r.legalsign_doc_sha256 !== r.notice_pdf_sha256) return "gw_hr_offers_legalsign_doc_chk";
  if (r.formal_doc_sha256 && r.formal_doc_sha256 !== r.notice_pdf_sha256) return "gw_hr_offers_formal_doc_chk";
  if (r.doc_route === "official" && r.formal_signed_at && !(r.formal_evidence && r.formal_doc_sha256)) return "gw_hr_offers_formal_evidence_chk";
  if (r.formal_signed_at && !r.accepted_at && !(r.doc_route === "official" && r.sent_at && r.official_doc_id && (r.legalsign_url || r.contract_route === "other"))) return "gw_hr_offers_formal_order_chk";
  if (r.handoff_at && (!r.accepted_at || r.declined_at || r.revoked_at)) return "gw_hr_offers_handoff_accepted_chk";
  if (r.handoff_at && r.formal_contract_required && !r.formal_signed_at) return "gw_hr_offers_handoff_formal_chk";
  return null;
};
const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]], required: ["tenant_id", "to_email", "subject", "body", "request_key"] },
    gw_hr_offers: {
      defaults: () => ({ ...nulls(COLS_132), ...nulls(COLS_133), ...nulls(COLS_137), ...(c139 ? nulls(COLS_139) : {}) }),
      check: offerCheck,
    },
    gw_hr_offer_official_docs: {
      unique: [["offer_id", "revision"]],
      required: ["tenant_id", "applicant_id", "offer_id", "revision", "doc_kind", "title", "file_path", "file_sha256", "file_size", "received_on", "uploaded_by"],
      defaults: () => ({ status: "received", reviewed_by: null, reviewed_at: null, review_note: null, checks: {}, carried_from: null,
        uploaded_at: new Date().toISOString(), created_at: new Date().toISOString() }),
      check: (r) => (["approved", "returned"].includes(r.status) && !(r.reviewed_by && r.reviewed_at) ? "review_chk"
        : r.status === "returned" && !r.review_note ? "return_chk" : !/^[0-9a-f]{64}$/.test(r.file_sha256) ? "file_chk" : null),
    },
    gw_hr_attorney_requests: {
      required: ["tenant_id", "applicant_id", "offer_id", "requested_by"],
      defaults: () => ({ kind: "initial", note: null, missing_labels: [], requested_at: new Date().toISOString() }),
    },
  },
});
// 依頼・差し戻しの前後を時刻で見るので、続けて操作するところは少し間をあける（本物の DB の now() はマイクロ秒）
const tick = () => new Promise((r) => setTimeout(r, 5));
const notified = [];
const logged = [];
const sent = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => { notified.push(...rows); return { created: rows.length }; } } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
const MAIL_ON = { configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.test>", replyTo: "hr@example.test" };
mock.module(atRoot("lib/mail/index.js"), {
  namedExports: {
    ...REAL_MAIL,
    mailConfig: () => MAIL_ON,
    sendMail: async (m) => {
      sent.push(m);
      const bad = REAL_MAIL.attachmentProblem(m.attachments);
      const base = { provider: "resend", from: MAIL_ON.from, replyTo: MAIL_ON.replyTo, providerMessageId: null, error: null };
      if (bad) return { ...base, status: "failed", error: bad };
      return { ...base, status: "sent", providerMessageId: `msg_${sent.length}` };
    },
  },
});
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-rec", display_name: "採用 花子" } };
const OTHER = { userId: "u-other", tenantId: "t2", isAdmin: false, roles: ["owner"], employee: { id: "e-other", display_name: "他社 社長" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { default: contractApi } = await import(atRoot("api/hr/offers/contract.js"));
const { default: publicApi } = await import(atRoot("api/hr/offers/public.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));
const C = await import(atRoot("lib/hr-contract.js"));
const { sha256: pdfSha } = await import(atRoot("lib/pdf-jp.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {}, raw: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => {
    if (Buffer.isBuffer(b) && String(r.headers["content-type"] || "").includes("pdf")) { r.raw = b; return; }
    try { r.body = JSON.parse(b); } catch { r.body = b; }
  };
  return r;
};
const call = async (fn, req) => { const r = res(); await fn({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const createOffer = (body) => call(offersApi, { method: "POST", url: "/api/hr/offers", body });
const patchOffer = (body) => call(offersApi, { method: "PATCH", url: "/api/hr/offers", body });
const sendDraft = (id) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}` });
const hrFile = (id, file) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}&file=${file}` });
const cardOf = (applicantId = "a1") => call(contractApi, { method: "GET", url: `/api/hr/offers/contract?applicantId=${applicantId}` });
const draftOf = (offerId, kind = "") => call(contractApi, { method: "GET", url: `/api/hr/offers/contract?offerId=${offerId}&draft=request${kind ? `&kind=${kind}` : ""}` });
const docFile = (docId) => call(contractApi, { method: "GET", url: `/api/hr/offers/contract?docId=${docId}&file=1` });
const act = (offerId, action, body = {}) => call(contractApi, { method: "POST", url: "/api/hr/offers/contract", body: { offerId, action, ...body } });
const getDetail = (id = "a1") => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const listAll = () => call(listApi, { method: "GET", url: "/api/hr/applicants" });
const PUB = { "x-forwarded-for": "203.0.113.5", "user-agent": "Mozilla/5.0 (TestPhone) Safari" };
const viewPublic = (token) => call(publicApi, { method: "GET", url: `/api/hr/offers/public?token=${encodeURIComponent(token)}`, headers: PUB });
const pubFile = (token, file) => call(publicApi, { method: "GET", url: `/api/hr/offers/public?token=${encodeURIComponent(token)}&file=${file}`, headers: PUB });
const respond = (body) => call(publicApi, { method: "POST", url: "/api/hr/offers/public", body, headers: PUB });
let keyN = 0;
const key = () => `ctkey-${String(++keyN).padStart(4, "0")}`;

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

const DUE = T.defaultRespondBy();
const today = T.todayJst();
const ALL_CHECKS = (type) => Object.fromEntries(C.reviewChecksOf(type).map((c) => [c.key, true]));
// 社労士が作った正式PDF（テスト用。中身はダミー）
async function officialPdf(pages = 2, label = "Labor notice") {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`${label} p${i + 1}`, { x: 50, y: 780, size: 12 });
  return new Uint8Array(await doc.save());
}

function setup(offerType = "executive_employee", extra = {}, { contract = true } = {}) {
  mem.reset(); logged.length = 0; sent.length = 0; notified.length = 0; who = OWNER; c139 = contract;
  mem.rows.tenants = [{ id: "t1", name: "株式会社エイト" }, { id: "t2", name: "別の会社" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-rec", tenant_id: "t1", user_id: "u-rec", display_name: "採用 花子", status: "active" },
  ];
  mem.rows.gw_hr_applicants = [{
    id: "a1", tenant_id: "t1", name: "テスト 候補者", email: "candidate@example.test", job_title: "PM", source: "テスト",
    stage: "offer", status: "offer_draft_pending", decision: "hired", rank: "A", recruiter_id: "e-rec",
    employment_type: null, wage_type: null, wage_amount: null, lead_category: "recruitment", offer_type: offerType, ...extra,
  }];
  for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_mail_sends", "gw_hr_interviews", "memberships",
    "gw_hr_offer_official_docs", "gw_hr_attorney_requests"]) mem.rows[t] = [];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
}
const app = () => mem.rows.gw_hr_applicants[0];
const current = () => mem.rows.gw_hr_offers.filter((o) => !o.revoked_at).sort((a, b) => b.version - a.version)[0];
const docsRows = () => mem.rows.gw_hr_offer_official_docs;
const tl = () => mem.rows.gw_hr_timeline;
const tokenIn = (text) => (/token=([A-Za-z0-9_-]+)/.exec(text) || [])[1] || null;

const BASE = {
  executive_employee: { jobTitle: "PM", wageType: "月給", wageAmount: 350000, joinDate: "2026-12-01", workLocation: "東京本社",
    probationMonths: 3, offerTerms: { workHours: "9:00〜18:00", breakTime: "60分", holidays: "土日祝", duties: "プロジェクト管理", contractPeriod: "期間の定めなし" } },
  part_time: { employmentType: "パート", wageAmount: 1300, joinDate: "2026-12-01", workLocation: "東京本社",
    offerTerms: { workDays: "月・水・金", workHours: "10:00〜15:00", contractPeriod: "期間の定めあり" } },
  contractor: { wageType: "月額", wageAmount: 200000, joinDate: "2026-12-01", contractEndDate: "2027-03-31",
    offerTerms: { duties: "営業活動および顧客フォロー", workHours: "週20時間程度", paymentTerms: "月末締め翌月末払い" } },
};

/** 条件を作って確定する（社労士へ依頼待ちまで） */
async function confirmed(type = "executive_employee", over = {}) {
  setup(type);
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, ...BASE[type], ...over });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const id = made.body.offer.id;
  const c = await patchOffer({ id, action: "confirm" });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  return id;
}
/** PDF を置いて受け取る（版を返す） */
async function receive(offerId, { pages = 2, bytes = null, docKind = null, label = "Labor notice" } = {}) {
  const pdf = bytes || await officialPdf(pages, label);
  const u = await act(offerId, "uploadUrl", { fileName: "通知書.pdf", size: pdf.length });
  assert.equal(u.statusCode, 200, JSON.stringify(u.body));
  mem.put("hr", u.body.path, pdf);
  const a = await act(offerId, "attach", { path: u.body.path, docKind: docKind || C.defaultDocKind(current().offer_type),
    receivedOn: today, authorName: "〇〇社労士事務所", fileName: "通知書.pdf" });
  return { r: a, pdf, path: u.body.path };
}
/** 依頼済み → 受領 → 承認（→ LegalSign 登録）まで */
async function approvedOffer(type = "executive_employee", { legal = "legalsign", over = {} } = {}) {
  const id = await confirmed(type, over);
  assert.equal((await act(id, "markRequested", { note: "Slack で依頼" })).statusCode, 200);
  const { r, pdf } = await receive(id);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const ap = await act(id, "approve", { docId: r.body.doc.id, checks: ALL_CHECKS(type) });
  assert.equal(ap.statusCode, 200, JSON.stringify(ap.body));
  if (legal === "legalsign") {
    const l = await act(id, "legalsign", { route: "legalsign", url: "https://sign.example.test/doc/abc", sameDoc: true });
    assert.equal(l.statusCode, 200, JSON.stringify(l.body));
  } else if (legal === "other") {
    assert.equal((await act(id, "legalsign", { route: "other" })).statusCode, 200);
  }
  return { id, docId: r.body.doc.id, pdf };
}
async function sendIt(id) {
  const d = (await sendDraft(id)).body;
  return patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
}

// ============================================================================
console.log("\n— 依頼文（Slack に貼る下書き。送らない） —");

await ok("正社員：依頼文は区分の言い方・HR の条件だけで作り、未入力は【要確認】（架空の値で埋めない）", () => {
  const offer = { offer_type: "executive_employee", job_title: "PM", join_date: "2026-12-01", work_location: "東京本社",
    wage_type: "月給", wage_amount: 350000, probation_months: 3,
    offer_terms: { workHours: "9:00〜18:00", duties: "プロジェクト管理", contractPeriod: "期間の定めなし" } };
  const d = C.requestText({ offer, applicantName: "テスト 候補者" });
  assert.equal(d.docName, "労働条件通知書（雇用契約書）");
  assert.equal(d.recipient, "社労士");
  for (const s of ["下記の方の労働条件通知書（雇用契約書）の作成をお願いいたします。", "- 氏名：テスト 候補者", "- 雇用区分：正社員・幹部候補",
    "- 入社予定日：2026年12月1日", "- 雇用期間：期間の定めなし", "- 給与・報酬：月給 350,000円", "- 試用期間：3か月",
    "本人への同意案内とLegalSignによる契約手続きを進めます。"]) assert.ok(d.text.includes(s), s);
  assert.ok(d.text.includes("- 休憩・休日：【要確認】"), d.text);
  assert.deepEqual(d.missing, ["休憩・休日"]);
  assert.ok(!/送信済み|送信しました/.test(d.text), "依頼文は下書き。送ったとは書かない");
});

await ok("給与を見られない人が作ると、給与・報酬は伏せて【要確認】（権限者が記入）", () => {
  const offer = { offer_type: "executive_employee", job_title: "PM", join_date: "2026-12-01", work_location: "東京",
    wage_type: "月給", wage_amount: 350000, probation_months: 0, offer_terms: { workHours: "9-18", breakTime: "60分", holidays: "土日", contractPeriod: "期間の定めなし" } };
  const d = C.requestText({ offer, applicantName: "A", salary: false });
  assert.ok(!d.text.includes("350,000"), "金額を出さない");
  assert.ok(d.text.includes("- 給与・報酬：【要確認】（給与・報酬は、権限のある担当者が記入してください）"), d.text);
  assert.ok(d.missing.includes("給与・報酬（権限者が記入）"));
  assert.ok(d.text.includes("- 試用期間：なし"));
});

await ok("パート：有期で終了日が無ければ【要確認】／業務委託：業務委託契約書・社労士・法務・報酬", () => {
  const p = C.requestText({ offer: { offer_type: "part_time", employment_type: "パート", join_date: "2026-12-01",
    offer_terms: { contractPeriod: "期間の定めあり" } }, applicantName: "B" });
  assert.ok(p.text.includes("- 雇用区分：パート・アルバイト・パート"), p.text);
  assert.ok(p.text.includes("- 雇用期間：期間の定めあり（終了日【要確認】）"), p.text);
  assert.ok(p.missing.includes("雇用期間"));
  const c = C.requestText({ offer: { offer_type: "contractor", join_date: "2026-12-01", contract_end_date: "2027-03-31",
    wage_type: "月額", wage_amount: 200000, offer_terms: { duties: "営業", paymentTerms: "月末締め翌月末払い", nda: "必要" } },
    applicantName: "C", contractRoute: "other" });
  assert.equal(c.docName, "業務委託契約書（条件通知書）");
  assert.equal(c.recipient, "社労士・法務");
  for (const s of ["下記の方の業務委託契約書（条件通知書）の作成をお願いいたします。", "- 契約区分：業務委託",
    "- 契約期間：2026年12月1日から2027年3月31日まで", "- 報酬：月額 200,000円・支払条件：月末締め翌月末払い",
    "- その他の確認事項：NDA：必要", "契約手続き（紙・対面など）を進めます。"]) assert.ok(c.text.includes(s), s);
  assert.ok(!c.text.includes("労働条件通知書"), "業務委託を労働条件通知書と呼ばない");
});

await ok("差し戻しのあとの依頼文は、直してほしい点を先に書く", () => {
  const d = C.requestText({ offer: { offer_type: "executive_employee", join_date: "2026-12-01" }, applicantName: "D", kind: "revision", reason: "試用期間を3か月に" });
  assert.ok(d.text.includes("先日ご依頼したD様の労働条件通知書（雇用契約書）について、修正をお願いいたします。"), d.text);
  assert.ok(d.text.includes("【修正をお願いしたい点】\n試用期間を3か月に"), d.text);
});

// ============================================================================
console.log("\n— 正社員：依頼 → 受領 → 差し戻し → 再依頼 → 承認 → LegalSign → 案内 → 同意 → 締結 → 引き渡し —");

await ok("条件の確定前はカードが「条件作成中」。確定すると「社労士へ依頼待ち」（主ボタンは依頼文の作成1つ）", async () => {
  setup();
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, ...BASE.executive_employee });
  const id = made.body.offer.id;
  let card = (await cardOf()).body;
  assert.equal(card.applicable, true, JSON.stringify(card));
  assert.equal(card.procedure.state, "conditions");
  assert.equal(card.procedure.primary.action, "editConditions");
  assert.equal(card.procedure.steps.length, 7);
  await patchOffer({ id, action: "confirm" });
  card = (await cardOf()).body;
  assert.equal(card.procedure.state, "request_pending");
  assert.equal(card.procedure.statusLabel, "社労士へ依頼待ち");
  assert.equal(card.procedure.owner, "人事");
  assert.equal(card.procedure.primary.action, "request");
  assert.deepEqual(card.procedure.steps.map((s) => s.state), ["done", "now", "todo", "todo", "todo", "todo", "todo"]);
  // NEXT ACTION（ドロワーの上）は、カードを開くボタンだけ
  const det = (await getDetail()).body.applicant;
  assert.equal(det.nextActionKey, "openContract");
  assert.equal(det.statusLabel, "社労士へ依頼待ち");
});

await ok("依頼文を作る・コピーするだけでは記録しない。「依頼済みにする」を押したときだけ記録（一覧で依頼待ち／依頼済みが分かる）", async () => {
  const id = await confirmed();
  const d = await draftOf(id);
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  assert.ok(d.body.text.includes("テスト 候補者"));
  assert.ok(d.body.notice.includes("Slack へは送っていません"));
  assert.equal(mem.rows.gw_hr_attorney_requests.length, 0, "下書きでは記録しない");
  assert.equal((await listAll()).body.applicants.find((a) => a.id === "a1").statusLabel, "社労士へ依頼待ち");
  const m = await act(id, "markRequested", { note: "Slack #労務 で依頼", missingLabels: d.body.missing });
  assert.equal(m.statusCode, 200, JSON.stringify(m.body));
  assert.equal(mem.rows.gw_hr_attorney_requests.length, 1);
  assert.equal(mem.rows.gw_hr_attorney_requests[0].requested_by, "u-owner");
  assert.ok(tl().some((t) => t.event_key === "attorney_requested" && t.label.includes("担当者が依頼済みと記録")));
  assert.ok(!tl().some((t) => /Slack.*送信/.test(t.label)), "Slack へ送ったとは書かない");
  assert.equal((await listAll()).body.applicants.find((a) => a.id === "a1").statusLabel, "社労士へ依頼済み");
  assert.equal(current().doc_route, "official", "最初の操作で流れを固定する");
});

await ok("給与を見られない採用担当：依頼文の給与は伏せる・正式PDFは開けない・照合と承認はできない", async () => {
  const id = await confirmed();
  await act(id, "markRequested");
  const { r } = await receive(id);
  who = RECRUITER;
  const d = await draftOf(id);
  assert.ok(!d.body.text.includes("350,000"), d.body.text);
  assert.equal(d.body.salaryVisible, false);
  assert.equal((await docFile(r.body.doc.id)).statusCode, 403);
  const ap = await act(id, "approve", { docId: r.body.doc.id, checks: ALL_CHECKS("executive_employee") });
  assert.equal(ap.statusCode, 403);
  const card = (await cardOf()).body;
  assert.equal(card.procedure.primary.action, "review");
  assert.ok(card.procedure.primary.disabledReason.includes("給与を見られる"), "押せない理由を出す");
});

await ok("依頼を記録する前は受け取れない。PDF以外・置き場所の違うファイルは断る", async () => {
  const id = await confirmed();
  const early = await act(id, "uploadUrl", { fileName: "a.pdf", size: 100 });
  assert.equal(early.statusCode, 409);
  assert.ok(early.body.hint.includes("依頼済みにする"));
  await act(id, "markRequested");
  const u = await act(id, "uploadUrl", { fileName: "a.pdf", size: 100 });
  mem.put("hr", u.body.path, Buffer.from("not a pdf"));
  const bad = await act(id, "attach", { path: u.body.path, docKind: "labor_notice", receivedOn: today });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "not_pdf");
  const wrong = await act(id, "attach", { path: `t1/recruit/a1/x.pdf`, docKind: "labor_notice", receivedOn: today });
  assert.equal(wrong.statusCode, 403);
  const big = await act(id, "uploadUrl", { fileName: "a.pdf", size: 16 * 1024 * 1024 });
  assert.equal(big.statusCode, 400);
  const kind = await receive(id, { docKind: "contractor_contract" });
  assert.equal(kind.r.statusCode, 400, "正社員に業務委託契約書は選べない");
});

await ok("受け取ると版・SHA-256 を記録し「書類受領・確認待ち」。承認・差し戻しの前は本人へ送れない", async () => {
  const id = await confirmed();
  await act(id, "markRequested");
  const { r, pdf } = await receive(id);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.doc.revision, 1);
  assert.equal(r.body.doc.sha256, pdfSha(pdf));
  assert.equal(docsRows()[0].received_on, today);
  assert.equal(docsRows()[0].author_name, "〇〇社労士事務所");
  assert.equal((await cardOf()).body.procedure.state, "review_pending");
  const sd = (await sendDraft(id)).body;
  assert.equal(sd.canSend, false, "承認前は送れない");
  assert.equal(sd.official.error, "official_not_ready");
  const s = await patchOffer({ id, action: "send", subject: sd.subject, body: sd.body, requestKey: key() });
  assert.equal(s.statusCode, 409);
  assert.equal(s.body.error, "official_not_ready");
  assert.equal(sent.length, 0, "メールは送っていない");
  assert.equal(mem.rows.gw_hr_mail_sends.length, 0, "送った記録も作らない");
  const link = await patchOffer({ id, action: "issueLink" });
  assert.equal(link.statusCode, 409, "手で送るURLも出さない");
});

await ok("差し戻し（理由つき）→ 修正の依頼文に理由が入る → 再依頼 → 新しい版を受け取る", async () => {
  const id = await confirmed();
  await act(id, "markRequested");
  const { r } = await receive(id);
  await tick();
  assert.equal((await act(id, "return", { docId: r.body.doc.id })).statusCode, 400, "理由が要る");
  const ret = await act(id, "return", { docId: r.body.doc.id, reason: "試用期間の記載が条件と違います" });
  assert.equal(ret.statusCode, 200, JSON.stringify(ret.body));
  let card = (await cardOf()).body;
  assert.equal(card.procedure.state, "returned");
  assert.equal(card.procedure.primary.label, "修正の依頼文を作成");
  const d = await draftOf(id);
  assert.equal(d.body.kind, "revision");
  assert.ok(d.body.text.includes("試用期間の記載が条件と違います"), d.body.text);
  await tick();
  assert.equal((await act(id, "markRequested")).statusCode, 200);
  assert.equal(mem.rows.gw_hr_attorney_requests.at(-1).kind, "revision");
  assert.equal((await cardOf()).body.procedure.state, "requested");
  const r2 = await receive(id);
  assert.equal(r2.r.body.doc.revision, 2);
  card = (await cardOf()).body;
  assert.equal(card.procedure.state, "review_pending");
  assert.deepEqual(card.docs.map((x) => [x.revision, x.status]), [[2, "received"], [1, "returned"]]);
});

await ok("照合は全項目に✓が要る。承認すると、正式契約が要る版は「本人への案内準備中」（LegalSign の登録が先）", async () => {
  const id = await confirmed();
  await act(id, "markRequested");
  const { r } = await receive(id);
  const part = await act(id, "approve", { docId: r.body.doc.id, checks: { person: true } });
  assert.equal(part.statusCode, 400);
  assert.ok(part.body.missing.length >= 4);
  assert.equal((await act(id, "approve", { docId: r.body.doc.id, checks: ALL_CHECKS("executive_employee") })).statusCode, 200);
  const card = (await cardOf()).body;
  assert.equal(card.procedure.state, "guide_prep");
  assert.equal(card.procedure.statusLabel, "本人への案内準備中");
  assert.equal(card.procedure.primary.action, "legalsign");
  const sd = (await sendDraft(id)).body;
  assert.equal(sd.official.error, "legalsign_not_ready");
  assert.equal(sd.canSend, false);
});

await ok("LegalSign の登録：同じ版の確認が要る・https だけ。登録すると「正式版確認済み」で送れる", async () => {
  const { id } = await approvedOffer("executive_employee", { legal: null });
  assert.equal((await act(id, "legalsign", { route: "legalsign", url: "https://sign.example.test/x" })).statusCode, 400, "同じ版の確認が要る");
  assert.equal((await act(id, "legalsign", { route: "legalsign", url: "javascript:alert(1)", sameDoc: true })).statusCode, 400);
  const l = await act(id, "legalsign", { route: "legalsign", url: "https://sign.example.test/doc/abc", sameDoc: true });
  assert.equal(l.statusCode, 200, JSON.stringify(l.body));
  assert.equal(current().legalsign_doc_sha256, docsRows()[0].file_sha256);
  assert.ok(!logged.some((e) => JSON.stringify(e).includes("sign.example.test")), "URL は監査ログに残さない");
  const card = (await cardOf()).body;
  assert.equal(card.procedure.state, "approved");
  assert.equal(card.procedure.primary.action, "guide");
  assert.equal((await sendDraft(id)).body.canSend, true);
});

await ok("保存されたPDFが記録と違えば送らない（Storage の書き換え）", async () => {
  const { id } = await approvedOffer();
  const doc = docsRows()[0];
  const keep = mem.storageFiles.get(`hr/${doc.file_path}`);
  mem.put("hr", doc.file_path, await officialPdf(1, "tampered"));
  const s = await sendIt(id);
  assert.equal(s.statusCode, 409);
  assert.equal(s.body.error, "official_mismatch");
  assert.equal(sent.length, 0);
  mem.storageFiles.set(`hr/${doc.file_path}`, keep);
});

await ok("送る：承認した正式PDFそのものを添付し、送った版に固定する。同じキーの2回目は送らない", async () => {
  const { id, docId, pdf } = await approvedOffer();
  const d = (await sendDraft(id)).body;
  const k = key();
  const s = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: k });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  const o = current();
  assert.equal(o.official_doc_id, docId);
  assert.equal(o.doc_route, "official");
  assert.equal(o.notice_pdf_sha256, pdfSha(pdf));
  assert.equal(o.notice_title, "労働条件通知書");
  const att = sent[0].attachments;
  assert.equal(att.length, 2, "内定通知書（会社）＋社労士の正式PDF");
  assert.ok(att.some((a) => Buffer.from(a.content).equals(Buffer.from(pdf))), "正式PDFそのもの");
  const again = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: k });
  assert.equal(again.body.duplicate, true);
  assert.equal(sent.length, 1, "重複送信しない");
  const other = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(other.statusCode, 409);
  assert.equal((await cardOf()).body.procedure.state, "guided");
  // 本人の画面の条件通知書は、正式PDF
  const token = tokenIn(sent[0].text);
  assert.equal((await viewPublic(token)).statusCode, 200);
  const f = await pubFile(token, "notice");
  assert.ok(f.raw && Buffer.from(f.raw).equals(Buffer.from(pdf)), "本人が保存するPDFも同じ版");
});

await ok("案内したあとは正式PDFを差し替えられない（承認・差し戻し・条件の修正）", async () => {
  const { id } = await approvedOffer();
  await sendIt(id);
  assert.equal((await act(id, "reopen")).statusCode, 409);
  assert.equal((await act(id, "uploadUrl", { fileName: "a.pdf", size: 10 })).statusCode, 409);
});

await ok("同意しても「正式契約済み」とは出さない。承諾済・未締結は引き渡せない。締結の記録は権限者・証跡が要る", async () => {
  const { id, pdf } = await approvedOffer();
  await sendIt(id);
  const token = tokenIn(sent[0].text);
  const acc = await respond({ token, action: "accept", agreed: true });
  assert.equal(acc.statusCode, 200, JSON.stringify(acc.body));
  const o = current();
  assert.ok(o.accepted_at && o.accepted_pdf_path);
  // 承諾済みPDF＝正式PDF（2ページ）＋電子承諾記録（1ページ）
  const accPdf = mem.storageFiles.get(`hr/${o.accepted_pdf_path}`);
  assert.equal((await PDFDocument.load(accPdf)).getPageCount(), (await PDFDocument.load(pdf)).getPageCount() + 1);
  let det = (await getDetail()).body.applicant;
  assert.equal(det.statusLabel, "正式契約待ち");
  assert.notEqual(det.statusLabel, "正式契約済み");
  let card = (await cardOf()).body;
  assert.equal(card.procedure.state, "formal_waiting");
  assert.deepEqual(card.procedure.handoffBlockers, ["正式契約（LegalSign）の締結を記録していません"]);
  const ho = await patchOffer({ id, action: "handoff" });
  assert.equal(ho.statusCode, 409, "承諾済・未締結は引き渡せない");
  // 締結：採用担当は不可・証跡が要る・同じ版の確認が要る
  who = RECRUITER;
  assert.equal((await act(id, "signed", { evidence: "締結完了の通知を確認", sameDoc: true })).statusCode, 403);
  who = OWNER;
  assert.equal((await act(id, "signed", { sameDoc: true })).statusCode, 400);
  assert.equal((await act(id, "signed", { evidence: "締結完了の通知を確認" })).statusCode, 400);
  assert.equal((await patchOffer({ id, action: "markFormalSigned" })).body.error, "use_contract", "これまでの「正式契約済みにする」は使わない");
  const sg = await act(id, "signed", { evidence: "LegalSign の締結完了の通知と締結済みPDFを確認", contractRef: "LS-2026-0001", sameDoc: true });
  assert.equal(sg.statusCode, 200, JSON.stringify(sg.body));
  assert.equal(current().formal_doc_sha256, current().notice_pdf_sha256);
  det = (await getDetail()).body.applicant;
  assert.equal(det.statusLabel, "正式契約済み");
  card = (await cardOf()).body;
  assert.equal(card.procedure.state, "signed");
  assert.equal(card.procedure.primary.action, "handoff", "締結済・未引き渡し：主ボタンは引き渡し");
  assert.ok(card.procedure.reconcile.ok);
  assert.ok(card.procedure.reconcile.rows.every((x) => x.match === true), JSON.stringify(card.procedure.reconcile.rows));
  // 引き渡しは担当者が押す（採用担当は不可）
  who = RECRUITER;
  assert.equal((await patchOffer({ id, action: "handoff" })).statusCode, 403);
  who = OWNER;
  const h = await patchOffer({ id, action: "handoff" });
  assert.equal(h.statusCode, 200, JSON.stringify(h.body));
  assert.equal((await cardOf()).body.procedure.state, "handed_off");
});

// ============================================================================
console.log("\n— パート（例外ルート）：本人の同意より先に締結 —");

await ok("例外ルート（紙・対面）なら LegalSign の URL なしで送れる。同意の前に締結を記録でき、同意がそろうまで引き渡せない", async () => {
  const { id } = await approvedOffer("part_time", { legal: "other", over: { contractEndDate: "2027-05-31" } });
  assert.equal(current().contract_route, "other");
  const s = await sendIt(id);
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  const sg = await act(id, "signed", { evidence: "紙の雇用契約書（双方押印）を確認・原本は総務で保管", sameDoc: true });
  assert.equal(sg.statusCode, 200, JSON.stringify(sg.body));
  const card = (await cardOf()).body;
  assert.equal(card.procedure.state, "signed_before_consent");
  assert.equal(card.procedure.statusLabel, "正式契約済み（条件同意待ち）");
  assert.equal(card.procedure.primary, null, "本人の同意を待つ（押すボタンは無い）");
  assert.ok(tl().some((t) => t.event_key === "formal_signed" && t.detail.includes("条件同意はまだ")));
  // 同意する前は、引き渡せない（応募者の状態が承諾済みでない）
  assert.equal((await patchOffer({ id, action: "handoff" })).statusCode, 409);
  const token = tokenIn(sent[0].text);
  assert.equal((await respond({ token, action: "accept", agreed: true })).statusCode, 200);
  assert.equal((await cardOf()).body.procedure.state, "signed");
  assert.equal((await patchOffer({ id, action: "handoff" })).statusCode, 200);
});

// ============================================================================
console.log("\n— 業務委託・再発行・条件の修正・db/139 なし —");

await ok("業務委託：書類の種類は業務委託契約書・業務委託条件通知書（労働条件通知書は選べない）", async () => {
  const id = await confirmed("contractor");
  const card = (await cardOf()).body;
  assert.deepEqual(card.docKinds.map((k) => k.key), ["contractor_contract", "contractor_terms", "other"]);
  assert.equal(card.attorneyLabel, "社労士・法務");
  assert.equal(card.procedure.primary.label, "社労士・法務への依頼文を作成");
  await act(id, "markRequested");
  const wrong = await receive(id, { docKind: "labor_notice" });
  assert.equal(wrong.r.statusCode, 400);
});

await ok("再発行（回答期限切れなど）：承認した正式PDFは新しい版へ引き継ぐが、本人の同意は引き継がない", async () => {
  const { id, pdf } = await approvedOffer();
  await sendIt(id);
  const re = await patchOffer({ id, action: "issueLink" });
  assert.equal(re.statusCode, 200, JSON.stringify(re.body));
  const o = current();
  assert.notEqual(o.id, id);
  assert.equal(o.version, 2);
  assert.ok(o.official_doc_id && o.notice_pdf_sha256 === pdfSha(pdf), "同じ正式PDFを固定");
  assert.ok(!o.accepted_at, "新しい版に同意は無い");
  assert.equal(o.legalsign_doc_sha256, pdfSha(pdf), "LegalSign の登録（同じPDF）は引き継ぐ");
  const copy = docsRows().find((d) => d.offer_id === o.id);
  assert.equal(copy.status, "approved");
  assert.ok(copy.carried_from);
  assert.equal((await respond({ token: re.body.token, action: "accept", agreed: true })).statusCode, 200);
  assert.ok(current().accepted_at);
  assert.ok(!mem.rows.gw_hr_offers.find((x) => x.id === id).accepted_at, "古い版には同意が付かない");
});

await ok("同意の前に LegalSign の締結を記録した版は、URLを再発行しない（締結の記録を黙って消さない）", async () => {
  const { id } = await approvedOffer();
  await sendIt(id);
  const sg = await act(id, "signed", { evidence: "LegalSign の締結完了の通知を確認", sameDoc: true });
  assert.equal(sg.statusCode, 200, JSON.stringify(sg.body));
  const re = await patchOffer({ id, action: "issueLink" });
  assert.equal(re.statusCode, 409);
  assert.equal(re.body.error, "reissue_blocked");
  assert.ok(re.body.hint.includes("引き継げない"));
  assert.equal(current().id, id, "新しい版は作らない");
  assert.ok(current().formal_signed_at && !current().revoked_at, "締結の記録はそのまま");
});

await ok("条件を直す：確定を取り消し、受け取った版は使わなくなる（社労士へ依頼し直す）", async () => {
  const { id } = await approvedOffer();
  const r = await act(id, "reopen", { reason: "入社日が変わった" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(app().status, "offer_review_pending");
  assert.ok(docsRows().every((d) => d.status === "superseded"));
  assert.equal(current().legalsign_doc_sha256, null, "LegalSign の登録も外す");
  assert.equal((await cardOf()).body.procedure.state, "conditions");
  assert.equal((await patchOffer({ id, action: "update", joinDate: "2027-01-05" })).statusCode, 200, "条件を直せる");
});

await ok("別の会社の人は、カード・依頼・PDFに届かない", async () => {
  const { id, docId } = await approvedOffer();
  who = OTHER;
  assert.equal((await cardOf()).statusCode, 404);
  assert.equal((await act(id, "markRequested")).statusCode, 404);
  assert.equal((await docFile(docId)).statusCode, 404);
});

await ok("db/139 が無い環境では、カードを出さず（流すよう知らせる）、これまでどおり HR の条件通知書で送る", async () => {
  setup("executive_employee", {}, { contract: false });
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, ...BASE.executive_employee });
  const id = made.body.offer.id;
  const card = (await cardOf()).body;
  assert.equal(card.applicable, false);
  assert.equal(card.notReady, true);
  assert.ok(card.message.includes("db/139"));
  assert.equal((await act(id, "markRequested")).statusCode, 503);
  const s = await sendIt(id);
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.ok(current().notice_pdf_path.includes("/notice-"), "HR の条件通知書");
});

await ok("db/139 を流す前に HR の条件通知書で送った人は、途中で流れを変えない（再発行の版も HR の条件通知書で送れる）", async () => {
  setup();
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, ...BASE.executive_employee });
  const id = made.body.offer.id;
  // db/139 より前に送った版（流れは空・HR の条件通知書で送付済み）
  Object.assign(current(), { sent_at: new Date().toISOString(), notice_title: "労働条件通知書", notice_pdf_path: "t1/offers/a1/x/notice-v1-a.pdf",
    notice_pdf_sha256: "a".repeat(64), doc_route: null });
  app().status = "offer_sent";
  assert.equal(C.docRouteOf(current()), "generated");
  assert.equal((await cardOf()).body.applicable, false, "カードは出さない");
  const re = await patchOffer({ id, action: "issueLink" });
  assert.equal(re.statusCode, 200, JSON.stringify(re.body));
  assert.equal(current().version, 2);
  assert.equal(current().doc_route, "generated", "再発行した版も同じ流れ（明示して入れる）");
  // 古いアプリが db/139 の前に作った再発行の版（流れが空・第2版）も、正式PDFの流れにしない
  assert.equal(C.docRouteOf({ ...current(), doc_route: null }), "generated");
});

await ok("db/139 のあとに作る2つ目の版は、作成のときに流れ（正式PDF）を入れる", async () => {
  setup();
  mem.rows.gw_hr_offers.push({ id: "old-1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "executive_employee",
    token_hash: "x", expires_at: new Date().toISOString(), revoked_at: new Date().toISOString(),
    ...Object.fromEntries([...COLS_132, ...COLS_133, ...COLS_137, ...COLS_139].map((c) => [c, null])) });
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, ...BASE.executive_employee });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  assert.equal(current().version, 2);
  assert.equal(current().doc_route, "official");
  assert.equal(C.docRouteOf(current()), "official");
});

await ok("育成枠は、これまでどおり（社労士の正式PDFの流れに乗せない）", async () => {
  setup("training");
  await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-12-01", wageType: "時給", wageAmount: 1500, offerTerms: { course: "無限道場" } });
  assert.equal((await cardOf()).body.applicable, false);
  assert.equal(C.docRouteOf(current()), "generated");
});

console.log(`\nhr contract: 合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
