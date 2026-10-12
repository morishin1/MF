// 採用HR：条件通知書PDF・本人の電子承諾記録・LegalSign による正式契約（db/132）と、応募者メールの登録を API から通す。
//
// ■ 何を守るテストか（応募者ドロワー・条件通知書PDF・電子承諾・LegalSign 連携・メール編集 UI/UX 改善仕様）
//   1. 送るとき、確定した版から条件通知書PDFを作り（書類名は区分ごと）、メールに添付する。パス・SHA-256 は一度だけ記録
//      送れなかったときの送り直しは、同じPDF（同じ版）を使う。給与を見られない人は PDF を開けない
//   2. 本人は専用URLから PDF を保存できる。承諾には同意のチェックが要る。承諾すると、氏名・メール・IP・利用環境・
//      同意の文言を同じ版に一度だけ残し、承諾済みPDF（条件通知書＋電子承諾記録のページ）を作る。監査ログには IP・メールを残さない
//   3. 承諾した版は、回答期限を過ぎても見られる（回答はもうできない）
//   4. LegalSign の URL：承諾後だけ登録できる・https:// だけ（javascript: data: http: 空白入りは断る）・LEGALSIGN_ALLOWED_HOSTS で絞れる
//      本人へ案内するまでは直せる。案内（メール／自分で送った記録）→ 正式契約待ち → 正式契約済み（取り消せない）
//      URL は監査ログ・タイムライン・送った記録・console に残さない
//   5. db/132 が無い環境では、これまでどおり PDF なしで送り・承諾できる（PDF・LegalSign の操作だけ 503）
//   6. 応募者のメール：形を確かめる・前後の空白を除く・空欄は未登録に戻す
//   ※ 実在の応募者・実際のメール送信は使わない（送信は偽物。宛先は example.test）
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

const DOC_COLS = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by"];
let docsOn = true;   // db/132 が適用済みの DB か（false＝列が無い）
const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]], required: ["tenant_id", "to_email", "subject", "body", "request_key"] },
    gw_hr_offers: { defaults: () => (docsOn ? Object.fromEntries(DOC_COLS.map((c) => [c, null])) : {}) },
  },
});
const logged = [];
const sent = [];
let mailMode = "sent";
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => ({ created: rows.length }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
const MAIL_ON = { configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.test>", replyTo: "hr@example.test" };
mock.module(atRoot("lib/mail/index.js"), {
  namedExports: {
    ...REAL_MAIL,
    mailConfig: () => (mailMode === "off" ? { configured: false, reason: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています", from: null, replyTo: null } : MAIL_ON),
    sendMail: async (m) => {
      sent.push(m);
      const bad = REAL_MAIL.attachmentProblem(m.attachments);
      const base = { provider: "resend", from: MAIL_ON.from, replyTo: MAIL_ON.replyTo, providerMessageId: null, error: null };
      if (bad) return { ...base, status: "failed", error: bad };
      if (mailMode === "failed") return { ...base, status: "failed", error: "送信サービスが断りました（422）" };
      return { ...base, status: "sent", providerMessageId: `msg_${sent.length}` };
    },
  },
});
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const RECRUITER = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-hr", display_name: "採用 花子" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { default: publicApi } = await import(atRoot("api/hr/offers/public.js"));
const { sha256 } = await import(atRoot("lib/hr.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));
const D = await import(atRoot("lib/hr-offer-docs.js"));
const { sha256: pdfSha } = await import(atRoot("lib/pdf-jp.js"));

// JSON も PDF も受け取れる res
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
const getDetail = (id) => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const patchDetail = (body) => call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const listAll = () => call(listApi, { method: "GET", url: "/api/hr/applicants" });
const createOffer = (body) => call(offersApi, { method: "POST", url: "/api/hr/offers", body });
const patchOffer = (body) => call(offersApi, { method: "PATCH", url: "/api/hr/offers", body });
const sendDraft = (id) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}` });
const hrFile = (id, file) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}&file=${file}` });
const PUB_HEADERS = { "x-forwarded-for": "203.0.113.5, 10.0.0.1", "user-agent": "Mozilla/5.0 (TestPhone) Safari" };
const viewPublic = (token) => call(publicApi, { method: "GET", url: `/api/hr/offers/public?token=${encodeURIComponent(token)}`, headers: PUB_HEADERS });
const pubFile = (token, file) => call(publicApi, { method: "GET", url: `/api/hr/offers/public?token=${encodeURIComponent(token)}&file=${file}`, headers: PUB_HEADERS });
const respond = (body) => call(publicApi, { method: "POST", url: "/api/hr/offers/public", body, headers: PUB_HEADERS });
let keyN = 0;
const key = () => `docskey-${String(++keyN).padStart(4, "0")}`;

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

const DUE = T.defaultRespondBy();
function setup(offerType = "training", extra = {}, { docs = true } = {}) {
  mem.reset(); logged.length = 0; sent.length = 0; mailMode = "sent"; who = OWNER; docsOn = docs;
  delete process.env.LEGALSIGN_ALLOWED_HOSTS;
  mem.rows.tenants = [{ id: "t1", name: "株式会社エイト" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-hr", tenant_id: "t1", user_id: "u-hr", display_name: "採用 花子", email: "hanako@example.test", status: "active" },
  ];
  mem.rows.gw_hr_applicants = [{
    id: "a1", tenant_id: "t1", name: "テスト 候補者", email: "candidate@example.test", job_title: "エンジニア", source: "テスト",
    stage: "offer", status: "offer_draft_pending", decision: "hired", rank: "A", recruiter_id: "e-hr",
    employment_type: null, wage_type: null, wage_amount: null, lead_category: "recruitment", offer_type: offerType, ...extra,
  }];
  for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_mail_sends", "gw_hr_interviews", "memberships"]) mem.rows[t] = [];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
}
const app = () => mem.rows.gw_hr_applicants[0];
const offerRow = () => mem.rows.gw_hr_offers.find((o) => !o.revoked_at);
const tl = () => mem.rows.gw_hr_timeline;
const tokenIn = (text) => (/token=([A-Za-z0-9_-]+)/.exec(text) || [])[1] || null;
const stored = (path) => mem.storageFiles.get(`hr/${path}`);
const pages = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();
async function sendTraining() {
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", wageType: "時給", wageAmount: 1500, offerTerms: { course: "無限道場" } });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const id = made.body.offer.id;
  const d = (await sendDraft(id)).body;
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  return { id, d, r };
}
async function acceptedTraining() {
  setup();
  const { id } = await sendTraining();
  const token = tokenIn(sent[0].text);
  const r = await respond({ token, action: "accept", agreed: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return { id, token };
}

console.log("\n— 条件通知書PDF（送るときに作り、メールに添付） —");
await ok("書類名は区分ごと（労働条件通知書／育成参加条件通知書／業務委託条件通知書／案件条件通知書）", () => {
  const t = (k) => D.noticeTitleOf({ offer_type: k });
  assert.deepEqual(["executive_employee", "part_time", "training", "contractor", "spot"].map(t),
    ["労働条件通知書", "労働条件通知書", "育成参加条件通知書", "業務委託条件通知書", "案件条件通知書"]);
  assert.equal(t(null), null, "区分の無い合格通知には作らない");
});

await ok("送る前：下書きに書類名と添付の案内。プレビューの PDF は作るだけで置かない（db/132 の列も入れない）", async () => {
  setup();
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", wageType: "時給", wageAmount: 1500, offerTerms: { course: "無限道場" } });
  const id = made.body.offer.id;
  const d = (await sendDraft(id)).body;
  assert.deepEqual([d.notice.ready, d.notice.title, d.notice.stored], [true, "育成参加条件通知書", false]);
  assert.ok(d.body.includes("「育成参加条件通知書」（PDF）を添付しています"), d.body);
  const p = await hrFile(id, "preview");
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  assert.equal(p.headers["content-type"], "application/pdf");
  assert.ok(p.raw.subarray(0, 5).toString() === "%PDF-");
  assert.ok(/filename\*=UTF-8''/.test(p.headers["content-disposition"]));
  assert.equal(mem.storageFiles.size, 0, "確認用は置かない");
  const row = offerRow();
  assert.deepEqual([row.notice_pdf_path, row.notice_pdf_sha256, row.notice_title, row.sent_at ?? null], [null, null, null, null], "プレビューでは確定しない");
  const pv = logged.filter((e) => e.action === "hr.offer_pdf_preview");
  assert.equal(pv.length, 1, "プレビューした事実を監査ログに残す");
  assert.deepEqual(pv[0].detail, { version: 1 });
  // 直して、もう一度プレビュー：直した内容で作り直す（まだ置かない）
  await patchOffer({ id, action: "update", wageAmount: 1600, respondBy: DUE });
  const p2 = await hrFile(id, "preview");
  assert.equal(p2.statusCode, 200);
  assert.notEqual(Buffer.compare(p.raw, p2.raw), 0, "直した内容でプレビューが変わる");
  assert.equal(mem.storageFiles.size, 0);
  assert.equal(offerRow().notice_pdf_path, null);
});

await ok("［メールでオファー送信］：確定した版から PDF を作って置き、パス・SHA-256・書類名を記録し、メールに添付する", async () => {
  setup();
  const { id, r } = await sendTraining();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const o = offerRow();
  assert.equal(o.notice_title, "育成参加条件通知書");
  assert.match(o.notice_pdf_path, new RegExp(`^t1/offers/a1/${id}/notice-v1-[0-9a-f]+\\.pdf$`));
  const bytes = stored(o.notice_pdf_path);
  assert.ok(bytes, "Storage（hr）に置いた");
  assert.equal(o.notice_pdf_sha256, pdfSha(bytes), "記録のハッシュ＝置いたPDFのハッシュ");
  const att = sent[0].attachments;
  assert.equal(att.length, 1);
  assert.deepEqual([att[0].filename, att[0].contentType], ["育成参加条件通知書_第1版.pdf", "application/pdf"]);
  assert.equal(pdfSha(att[0].content), o.notice_pdf_sha256, "添付したのは、記録した PDF そのもの");
  assert.ok(tl().some((t) => t.event_key === "offer_sent" && t.detail.includes("育成参加条件通知書（PDF）添付")));
  assert.ok(mem.rows.gw_hr_mail_sends[0].template_name.includes("条件通知書PDF添付"));
  const n = await hrFile(id, "notice");
  assert.equal(pdfSha(n.raw), o.notice_pdf_sha256, "HR が開くのも同じ PDF");
  assert.equal((await sendDraft(id)).body.notice.stored, true);
});

await ok("送れなかったあとの送り直しは、同じ版の同じ PDF を使う（作り直さない）", async () => {
  setup();
  mailMode = "failed";
  const { id, d, r } = await sendTraining();
  assert.equal(r.statusCode, 502);
  const first = { path: offerRow().notice_pdf_path, sha: offerRow().notice_pdf_sha256 };
  assert.ok(first.path);
  mailMode = "sent";
  const again = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.deepEqual({ path: offerRow().notice_pdf_path, sha: offerRow().notice_pdf_sha256 }, first);
  assert.equal(pdfSha(sent[1].attachments[0].content), first.sha);
  assert.equal([...mem.storageFiles.keys()].filter((k) => k.includes("/notice-")).length, 1, "PDF は1つだけ");
});

await ok("条件通知書を作った版は直せない（送った書面と中身をずらさない）", async () => {
  setup();
  mailMode = "failed";
  const { id } = await sendTraining();
  // 送れなかった版（送付待ち）。状態を下書きに戻されても、条件通知書があれば直さない
  app().status = "offer_review_pending";
  const up = await patchOffer({ id, action: "update", messageToCandidate: "変える" });
  assert.equal(up.statusCode, 409);
  assert.ok(up.body.hint.includes("条件通知書"));
});

await ok("給与を見られない人は、PDF（給与が入る）を開けない", async () => {
  setup();
  const { id } = await sendTraining();
  who = RECRUITER;
  for (const f of ["preview", "notice", "accepted"]) {
    const r = await hrFile(id, f);
    assert.equal(r.statusCode, 403, f);
  }
  const d = (await sendDraft(id)).body;
  assert.equal(d.notice.salaryVisible, false);
});

await ok("手で送るとき（URLを発行）も、本人が保存できるよう条件通知書PDFを用意する", async () => {
  setup();
  mailMode = "off";
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", offerTerms: { course: "無限道場" } });
  const id = made.body.offer.id;
  await patchOffer({ id, action: "confirm" });
  const link = await patchOffer({ id, action: "issueLink" });
  assert.equal(link.statusCode, 200);
  assert.ok(offerRow().notice_pdf_path, "条件通知書を置いた");
  const f = await pubFile(link.body.token, "notice");
  assert.equal(f.statusCode, 200);
  assert.equal(pdfSha(f.raw), offerRow().notice_pdf_sha256);
});

console.log("\n— 本人：PDF を保存 → 同意のチェック → 条件を承諾（電子承諾記録） —");
await ok("本人は専用URLから条件通知書PDFを保存できる（閲覧の記録・状態は変えない）", async () => {
  setup();
  await sendTraining();
  const token = tokenIn(sent[0].text);
  const f = await pubFile(token, "notice");
  assert.equal(f.statusCode, 200, JSON.stringify(f.body));
  assert.equal(pdfSha(f.raw), offerRow().notice_pdf_sha256);
  assert.equal(offerRow().viewed_at ?? null, null, "PDF の保存では閲覧にしない");
  assert.equal(app().status, "offer_sent");
  const v = (await viewPublic(token)).body;
  assert.deepEqual([v.noticePdf, v.noticeTitle, v.acceptedPdf], [true, "育成参加条件通知書", false]);
  assert.equal((await pubFile("x".repeat(43), "notice")).statusCode, 404, "token が違えば開けない");
});

await ok("承諾すると、氏名・メール・IP・利用環境・同意の文言を同じ版に残し、承諾済みPDF（＋電子承諾記録）を作る", async () => {
  const { id, token } = await acceptedTraining();
  const o = offerRow();
  assert.ok(o.accepted_at);
  assert.deepEqual([o.accept_name, o.accept_email, o.accept_ip, o.accept_ua],
    ["テスト 候補者", "candidate@example.test", "203.0.113.5", "Mozilla/5.0 (TestPhone) Safari"]);
  assert.equal(o.accept_text, "上記の条件通知書の内容を確認し、この条件に同意します");
  assert.match(o.accepted_pdf_path, new RegExp(`^t1/offers/a1/${id}/accepted-v1-[0-9a-f]+\\.pdf$`));
  const acc = stored(o.accepted_pdf_path);
  assert.equal(o.accepted_pdf_sha256, pdfSha(acc));
  assert.equal(await pages(acc), (await pages(stored(o.notice_pdf_path))) + 1, "条件通知書のあとに「電子承諾記録」のページが1枚");
  assert.notEqual(o.accepted_pdf_sha256, o.notice_pdf_sha256);
  // 監査ログには IP・利用環境・メールを残さない（記録は gw_hr_offers の行と承諾済みPDF）
  const log = logged.find((e) => e.action === "hr.offer_accepted");
  assert.equal(log.detail.noticeSha256, o.notice_pdf_sha256);
  assert.equal(/203\.0\.113\.5|TestPhone|candidate@example/.test(JSON.stringify(logged)), false);
  assert.ok(tl().some((t) => t.label === "本人が育成参加決定通知の条件を承諾"));
  // 本人・HR の両方が承諾済みPDFを保存できる（同じもの）
  const pub = await pubFile(token, "accepted");
  const hr = await hrFile(id, "accepted");
  assert.equal(pdfSha(pub.raw), o.accepted_pdf_sha256);
  assert.equal(pdfSha(hr.raw), o.accepted_pdf_sha256);
  const v = (await viewPublic(token)).body;
  assert.deepEqual([v.responseStatus, v.acceptedPdf, v.doneTitle], ["accepted", true, "条件の承諾を受け付けました。"]);
  const a = (await getDetail("a1")).body.applicant;
  assert.equal(a.statusLabel, "条件承諾済み");
});

await ok("同意のチェックが無ければ承諾できない（記録も残らない）", async () => {
  setup();
  await sendTraining();
  const token = tokenIn(sent[0].text);
  const r = await respond({ token, action: "accept" });
  assert.deepEqual([r.statusCode, r.body.error], [400, "agreement_required"]);
  assert.ok(r.body.hint.includes("上記の条件通知書の内容を確認し、この条件に同意します"));
  assert.equal(offerRow().accept_ip, null);
  assert.equal(offerRow().accepted_at ?? null, null);
});

await ok("承諾済みPDFを作れなくても承諾は記録する。保存するときに、残した記録から作る", async () => {
  setup();
  await sendTraining();
  const token = tokenIn(sent[0].text);
  mem.state.storageFail = "storage down";
  const r = await respond({ token, action: "accept", agreed: true });
  mem.state.storageFail = null;
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.acceptedPdf, false);
  assert.ok(offerRow().accepted_at && offerRow().accept_ip);
  assert.equal(offerRow().accepted_pdf_path, null);
  const f = await pubFile(token, "accepted");
  assert.equal(f.statusCode, 200);
  assert.ok(offerRow().accepted_pdf_path, "保存のときに作って置いた");
  assert.equal(pdfSha(f.raw), offerRow().accepted_pdf_sha256);
});

await ok("承諾した版は、回答期限を過ぎても見られる（回答はもうできない）", async () => {
  const { token } = await acceptedTraining();
  offerRow().expires_at = new Date(Date.now() - 86400000).toISOString();
  assert.equal((await viewPublic(token)).statusCode, 200);
  assert.equal((await pubFile(token, "accepted")).statusCode, 200);
  assert.equal((await respond({ token, action: "decline" })).statusCode, 409);
});

console.log("\n— 正式契約（LegalSign） —");
const URL1 = "https://sign.example.test/contracts/abc123";
const URL2 = "https://sign.example.test/contracts/def456";
const noUrlLeak = (url) => {
  const text = JSON.stringify(logged) + JSON.stringify(tl()) + JSON.stringify(mem.rows.gw_hr_mail_sends);
  assert.equal(text.includes(url), false, "URL を監査ログ・タイムライン・送った記録に残さない");
};

await ok("承諾する前は LegalSign の URL を登録できない", async () => {
  setup();
  const { id } = await sendTraining();
  const r = await patchOffer({ id, action: "setLegalSign", url: URL1 });
  assert.equal(r.statusCode, 409);
});

await ok("URL は https:// だけ（javascript: data: http: 空白入り・ID 入りは断る）", async () => {
  const { id } = await acceptedTraining();
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://sign.example.test/x",
    "https://sign.example.test/a b", "https://user:pw@sign.example.test/x", "ftp://sign.example.test/x", ""]) {
    const r = await patchOffer({ id, action: "setLegalSign", url: bad });
    assert.equal(r.statusCode, 400, bad);
  }
  assert.equal(offerRow().legalsign_url, null);
});

await ok("LEGALSIGN_ALLOWED_HOSTS があれば、そのホストだけ", async () => {
  const { id } = await acceptedTraining();
  process.env.LEGALSIGN_ALLOWED_HOSTS = "*.legalsign.example";
  assert.equal((await patchOffer({ id, action: "setLegalSign", url: URL1 })).statusCode, 400);
  assert.equal((await patchOffer({ id, action: "setLegalSign", url: "https://app.legalsign.example/x" })).statusCode, 200);
  delete process.env.LEGALSIGN_ALLOWED_HOSTS;
});

await ok("登録 → 案内前は直せる → メールで案内（正式契約待ち）→ 案内後は直せない → 正式契約済み（取り消せない）", async () => {
  const { id, token } = await acceptedTraining();
  const consoleOut = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"]) console[k] = (...a) => { consoleOut.push(a.join(" ")); keep[k](...a); };
  try {
    let r = await patchOffer({ id, action: "setLegalSign", url: URL1 });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(offerRow().legalsign_url, URL1);
    r = await patchOffer({ id, action: "setLegalSign", url: URL2 });
    assert.equal(r.statusCode, 200, "案内する前は直せる");
    assert.equal(offerRow().legalsign_url, URL2);
    assert.equal((await getDetail("a1")).body.applicant.statusLabel, "条件承諾済み");

    const p = (await patchOffer({ id, action: "sendFormal", preview: true })).body;
    assert.ok(p.body.includes("{{正式契約URL}}"));
    const s1 = await patchOffer({ id, action: "sendFormal", channel: "email", subject: p.subject, body: p.body, requestKey: key() });
    assert.equal(s1.statusCode, 200, JSON.stringify(s1.body));
    const mail = sent[sent.length - 1];
    assert.ok(mail.text.includes(URL2), "本人へのメールには URL が入る");
    assert.ok(mem.rows.gw_hr_mail_sends.at(-1).body.includes("LegalSign の URL・記録には残しません"));
    assert.ok(offerRow().formal_sent_at && offerRow().formal_sent_by === "u-owner");
    let a = (await getDetail("a1")).body.applicant;
    assert.deepEqual([a.statusLabel, a.nextActionCta], ["正式契約待ち", "正式契約済みにする"]);
    const l = (await listAll()).body.applicants.find((x) => x.id === "a1");
    assert.equal(l.statusLabel, "正式契約待ち", "一覧も同じ");
    let v = (await viewPublic(token)).body;
    assert.deepEqual([v.formal.url, v.formal.sent, v.formal.signed], [URL2, true, false], "本人には案内した URL を見せる");

    assert.equal((await patchOffer({ id, action: "setLegalSign", url: URL1 })).statusCode, 409, "案内したあとは URL を変えられない");
    assert.equal(offerRow().legalsign_url, URL2);
    const sentAt = offerRow().formal_sent_at;
    const again = await patchOffer({ id, action: "sendFormal", channel: "manual" });
    assert.equal(again.statusCode, 200);
    assert.equal(offerRow().formal_sent_at, sentAt, "2回目の案内でも、初回の日時は変えない");

    r = await patchOffer({ id, action: "markFormalSigned" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(offerRow().formal_signed_at && offerRow().formal_signed_by === "u-owner");
    a = (await getDetail("a1")).body.applicant;
    assert.deepEqual([a.statusLabel, a.nextActionCta], ["正式契約済み", "育成開始手続きへ進む"]);
    assert.equal((await patchOffer({ id, action: "markFormalSigned" })).statusCode, 409, "二度は押せない");
    v = (await viewPublic(token)).body;
    assert.deepEqual([v.formal.url, v.formal.signed], [null, true], "正式契約済みのあとは URL を出さない");

    // 事実だけ残す（URL は残さない）
    const actions = logged.map((e) => e.action);
    for (const k of ["hr.offer_legalsign_url_set", "hr.offer_formal_sent", "hr.offer_formal_signed"]) assert.ok(actions.includes(k), k);
    assert.ok(tl().some((t) => t.label === "正式契約（LegalSign）の URL を登録"));
    assert.ok(tl().some((t) => t.label === "正式契約（LegalSign）を本人へメールで案内"));
    assert.ok(tl().some((t) => t.label === "正式契約済み（LegalSign）"));
    noUrlLeak(URL1); noUrlLeak(URL2);
    assert.equal(consoleOut.some((x) => x.includes(URL1) || x.includes(URL2)), false, "console にも出さない");
  } finally { Object.assign(console, keep); }
});

await ok("URL を登録せずに案内はできない。メール送信の設定が無ければ「自分で送った」記録だけ", async () => {
  const { id } = await acceptedTraining();
  assert.equal((await patchOffer({ id, action: "sendFormal", channel: "manual" })).statusCode, 400);
  await patchOffer({ id, action: "setLegalSign", url: URL1 });
  mailMode = "off";
  const p = (await patchOffer({ id, action: "sendFormal", preview: true })).body;
  assert.equal(p.mail.configured, false);
  const e = await patchOffer({ id, action: "sendFormal", channel: "email", subject: p.subject, body: p.body, requestKey: key() });
  assert.equal(e.statusCode, 409);
  assert.equal(offerRow().formal_sent_at, null);
  const m = await patchOffer({ id, action: "sendFormal", channel: "manual" });
  assert.equal(m.statusCode, 200);
  assert.ok(offerRow().formal_sent_at);
  assert.ok(tl().some((t) => t.label === "正式契約（LegalSign）を本人へ案内（自分で送付）"));
});

await ok("区分ごとの条件承諾後の NEXT ACTION（業務委託［正式契約へ］→ 正式契約済み［稼働開始準備へ進む］）", async () => {
  setup("contractor");
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", wageType: "月額", wageAmount: 200000,
    offerTerms: { duties: T.DUTY_TEMPLATES[1].text } });
  const id = made.body.offer.id;
  const d = (await sendDraft(id)).body;
  await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(sent[0].attachments[0].filename, "業務委託条件通知書_第1版.pdf");
  await respond({ token: tokenIn(sent[0].text), action: "accept", agreed: true });
  let a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.statusLabel, a.nextActionCta, a.nextActionKey], ["条件承諾済み", "正式契約へ", "formalContract"]);
  await patchOffer({ id, action: "setLegalSign", url: URL1 });
  await patchOffer({ id, action: "markFormalSigned" });
  a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.statusLabel, a.nextActionCta], ["正式契約済み", "稼働開始準備へ進む"]);
  assert.equal(a.steps.steps.find((s) => s.state === "now").label, "入社/稼働");
});

console.log("\n— db/132 が無い環境 —");
await ok("これまでどおり PDF なしで送り・承諾できる。PDF・LegalSign の操作だけ 503", async () => {
  setup("training", {}, { docs: false });
  const { id, d, r } = await sendTraining();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(d.notice.ready, false);
  assert.equal(d.body.includes("添付しています"), false);
  assert.equal(sent[0].attachments, undefined, "添付なし（これまでと同じ送り方）");
  const token = tokenIn(sent[0].text);
  const acc = await respond({ token, action: "accept", agreed: true });
  assert.equal(acc.statusCode, 200, JSON.stringify(acc.body));
  assert.ok(offerRow().accepted_at);
  assert.equal("accept_ip" in offerRow(), false, "列の無い DB に書かない");
  assert.equal((await hrFile(id, "notice")).statusCode, 503);
  assert.equal((await patchOffer({ id, action: "setLegalSign", url: URL1 })).statusCode, 503);
  assert.equal((await getDetail("a1")).body.applicant.statusLabel, "条件承諾済み");
});

console.log("\n— 応募者のメール（ドロワー・送信画面から登録・編集） —");
await ok("形を確かめる・前後の空白を除く・空欄は未登録に戻す。監査ログには値を残さない。タイムラインは増やさない", async () => {
  setup();
  const bad = await patchDetail({ id: "a1", email: "candidate@" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.detail, "メールアドレスの形式を確認してください");
  assert.equal(app().email, "candidate@example.test", "変えない");
  const good = await patchDetail({ id: "a1", email: "  new.mail@example.test  " });
  assert.equal(good.statusCode, 200, JSON.stringify(good.body));
  assert.equal(app().email, "new.mail@example.test");
  assert.equal(good.body.applicant.email, "new.mail@example.test");
  const log = logged.find((e) => e.action === "hr.applicant_update");
  assert.deepEqual(log.detail.fields, ["email"]);
  assert.equal(JSON.stringify(logged).includes("new.mail@example.test"), false);
  assert.equal(tl().length, 0, "メールの変更でタイムラインを増やさない");
  const empty = await patchDetail({ id: "a1", email: "" });
  assert.equal(empty.statusCode, 200);
  assert.equal(app().email, null);
});

await ok("メール未登録 → 送信画面で登録して続ける → 送信先は最新のメール", async () => {
  setup("training", { email: null });
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", offerTerms: { course: "無限道場" } });
  const id = made.body.offer.id;
  let d = (await sendDraft(id)).body;
  assert.deepEqual([d.to, d.mail.configured], [null, false]);
  assert.equal((await patchDetail({ id: "a1", email: "first@example.test" })).statusCode, 200);
  d = (await sendDraft(id)).body;
  assert.deepEqual([d.to, d.mail.configured], ["first@example.test", true]);
  assert.equal((await patchDetail({ id: "a1", email: "second@example.test" })).statusCode, 200, "送信先を変更");
  d = (await sendDraft(id)).body;
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(sent[0].to, "second@example.test", "変更後のメールへ送る");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
