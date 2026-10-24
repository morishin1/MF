// 採用HR：合格通知（内定通知書・条件通知書のPDF）をメールで送る前の「送信内容の確認」を API から通す（lib/hr-offer-confirm.js）。
//
// ■ 何を守るテストか
//   1. 送る前の確認（GET）に、送信元・宛先（CC/BCC はなし）・添付するPDFが出る。給与・PDFの識別子は出さない
//   2. 確認なし（confirmDigest なし）では送らない（400。送った記録も作らない）
//   3. 確認したあとで 件名・本文・宛先・条件（PDFの中身）・会社名 が変わったら 409（送らない・記録も作らない）
//   4. 確認どおりなら送る（添付は確認画面に出したPDFと同じ数・同じ題名）
//   5. 添付PDFを作れるかの確認（check=1）は中身を返さない。作れないときは ok:false（画面は送信ボタンを出さない）
//   ※ 実在の応募者・実際のメール送信は使わない（送信は偽物。宛先は example.test）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
process.env.PUBLIC_BASE_URL = "https://gw.example.test";

const DOC_COLS = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by",
  "offer_title", "offer_pdf_path", "offer_pdf_sha256"];
const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]], required: ["tenant_id", "to_email", "subject", "body", "request_key"] },
    gw_hr_offers: { defaults: () => Object.fromEntries(DOC_COLS.map((c) => [c, null])) },
  },
});
const sent = [];
let pdfFail = false;
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => ({ created: rows.length }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
const MAIL_ON = { configured: true, reason: null, from: "株式会社テスト 採用 <recruit@example.test>", replyTo: "hr@example.test" };
mock.module(atRoot("lib/mail/index.js"), {
  namedExports: {
    ...REAL_MAIL,
    mailConfig: () => MAIL_ON,
    sendMail: async (m) => { sent.push(m); return { provider: "resend", from: MAIL_ON.from, replyTo: MAIL_ON.replyTo, status: "sent", providerMessageId: `msg_${sent.length}` }; },
  },
});
const REAL_PDF = await import(atRoot("lib/pdf-jp.js"));
mock.module(atRoot("lib/pdf-jp.js"), {
  namedExports: { ...REAL_PDF, renderContractPdf: async (p) => { if (pdfFail) throw new Error("font missing"); return REAL_PDF.renderContractPdf(p); } },
});
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const RECRUITER = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-hr", display_name: "採用 花子" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));
const C = await import(atRoot("lib/hr-offer-confirm.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await offersApi({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const createOffer = (body) => call({ method: "POST", url: "/api/hr/offers", body });
const patchOffer = (body) => call({ method: "PATCH", url: "/api/hr/offers", body });
const draftOf = async (id) => (await call({ method: "GET", url: `/api/hr/offers?id=${id}` })).body;
const check = (id) => call({ method: "GET", url: `/api/hr/offers?id=${id}&check=1` });
let keyN = 0;
const key = () => `confirmkey-${String(++keyN).padStart(4, "0")}`;
const confirmOf = (d, subject = d.subject, body = d.body) => C.confirmDigestOf(d.confirm.base, subject, body);
const send = (id, d, extra = {}) => patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key(), confirmDigest: confirmOf(d), ...extra });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

const DUE = T.defaultRespondBy();
async function setup() {
  mem.reset(); sent.length = 0; who = OWNER; pdfFail = false;
  mem.rows.tenants = [{ id: "t1", name: "株式会社テスト" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-hr", tenant_id: "t1", user_id: "u-hr", display_name: "採用 花子", status: "active" },
  ];
  mem.rows.gw_hr_applicants = [{
    id: "a1", tenant_id: "t1", name: "架空 候補者", email: "candidate@example.test", job_title: "エンジニア", source: "テスト",
    stage: "offer", status: "offer_draft_pending", decision: "hired", rank: "A", recruiter_id: "e-hr",
    employment_type: null, wage_type: null, wage_amount: null, lead_category: "recruitment", offer_type: "executive_employee",
  }];
  for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_mail_sends", "gw_hr_interviews", "memberships"]) mem.rows[t] = [];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, jobTitle: "エンジニア", wageType: "月給", wageAmount: 412345,
    joinDate: "2026-12-01", workLocation: "東京（架空）" });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  return made.body.offer.id;
}
const nothingSent = () => { assert.equal(sent.length, 0, "メールを送らない"); assert.equal(mem.rows.gw_hr_mail_sends.length, 0, "送った記録も作らない"); };

console.log("\n— 送る前の確認（GET） —");
await ok("送信元・宛先（CC/BCC はなし）・添付する2点（内定通知書・労働条件通知書）が出る。要約は64桁", async () => {
  const id = await setup();
  const d = await draftOf(id);
  const c = d.confirm;
  assert.deepEqual([c.from, c.replyTo, c.to, c.toName, c.cc, c.bcc], [MAIL_ON.from, MAIL_ON.replyTo, "candidate@example.test", "架空 候補者", [], []]);
  assert.deepEqual(c.documents.map((x) => `${x.kind}:${x.title}:${x.stored}:${x.file}`), ["offer:内定通知書:false:previewOffer", "notice:労働条件通知書:false:preview"]);
  assert.match(c.base, /^[0-9a-f]{64}$/);
  assert.ok(c.documents.every((x) => !("identity" in x)), "PDFの識別子は出さない");
});
await ok("給与を見られない人の確認にも、給与は出ない（要約は鍵つきで、中身を推し量れない形）", async () => {
  const id = await setup();
  who = RECRUITER;
  const d = await draftOf(id);
  const text = JSON.stringify(d.confirm);
  assert.ok(!text.includes("412345") && !text.includes("412,345"), text);
  assert.equal(d.confirm.documents.length, 2);
});

console.log("\n— 送る（confirmDigest を確かめる） —");
await ok("確認なし（confirmDigest なし・形が違う）では送らない", async () => {
  const id = await setup();
  const d = await draftOf(id);
  for (const extra of [{ confirmDigest: undefined }, { confirmDigest: "abc" }]) {
    const r = await send(id, d, extra);
    assert.equal(r.statusCode, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "confirm_required");
  }
  nothingSent();
  assert.ok(!mem.rows.gw_hr_offers[0].sent_at, "送付済みにしない");
});
await ok("確認のあとで件名・本文を変えて送ろうとしたら 409（確認し直し）", async () => {
  const id = await setup();
  const d = await draftOf(id);
  const r1 = await patchOffer({ id, action: "send", subject: `${d.subject}（変更）`, body: d.body, requestKey: key(), confirmDigest: confirmOf(d) });
  assert.equal(r1.statusCode, 409, JSON.stringify(r1.body));
  assert.equal(r1.body.error, "confirm_mismatch");
  const r2 = await patchOffer({ id, action: "send", subject: d.subject, body: `${d.body}\n追伸`, requestKey: key(), confirmDigest: confirmOf(d) });
  assert.equal(r2.statusCode, 409);
  nothingSent();
});
await ok("確認のあとで宛先を変えたら 409", async () => {
  const id = await setup();
  const d = await draftOf(id);
  mem.rows.gw_hr_applicants[0].email = "other@example.test";
  const r = await send(id, d);
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  nothingSent();
});
await ok("確認のあとで条件（PDFの中身）を直したら 409。確認し直せば送れる", async () => {
  const id = await setup();
  const d = await draftOf(id);
  const up = await patchOffer({ id, action: "update", workLocation: "大阪（架空）" });
  assert.equal(up.statusCode, 200, JSON.stringify(up.body));
  const r = await send(id, d);
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  nothingSent();
  const d2 = await draftOf(id);
  assert.notEqual(d2.confirm.base, d.confirm.base, "要約が変わる");
  const ok2 = await send(id, d2);
  assert.equal(ok2.statusCode, 200, JSON.stringify(ok2.body));
});
await ok("確認のあとで会社名（PDFの宛名・差出人）が変わったら 409", async () => {
  const id = await setup();
  const d = await draftOf(id);
  mem.rows.tenants[0].name = "株式会社テスト（新社名）";
  const r = await send(id, d);
  assert.equal(r.statusCode, 409);
  nothingSent();
});
await ok("確認どおりなら送る。添付は確認に出した2点と同じ題名", async () => {
  const id = await setup();
  const d = await draftOf(id);
  const r = await send(id, d);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "sent");
  assert.equal(sent.length, 1);
  const names = sent[0].attachments.map((a) => a.filename);
  assert.equal(names.length, d.confirm.documents.length);
  for (const doc of d.confirm.documents) assert.ok(names.some((n) => n.includes(doc.title)), `${doc.title} が添付される（${names.join(",")}）`);
  assert.equal(sent[0].to, d.confirm.to);
  assert.equal(sent[0].cc, undefined, "CC なし");
  assert.equal(sent[0].bcc, undefined, "BCC なし");
});
await ok("二度押し（同じ鍵）は1通だけ（確認の仕組みを足しても、これまでの二重送信防止はそのまま）", async () => {
  const id = await setup();
  const d = await draftOf(id);
  const k = key();
  const body = { id, action: "send", subject: d.subject, body: d.body, requestKey: k, confirmDigest: confirmOf(d) };
  const [a, b] = await Promise.all([patchOffer(body), patchOffer(body)]);
  assert.ok([a.statusCode, b.statusCode].every((s) => s === 200), `${a.statusCode}/${b.statusCode}`);
  assert.equal(sent.length, 1);
});

console.log("\n— 添付PDFを作れるか（check=1） —");
await ok("作れる：ok。要約は確認と同じ。PDFの中身は返さない（給与を見られない人も確かめられる）", async () => {
  const id = await setup();
  const d = await draftOf(id);
  who = RECRUITER;
  const r = await check(id);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.documents.map((x) => `${x.kind}:${x.ok}`), ["offer:true", "notice:true"]);
  assert.equal(r.body.base, (await draftOf(id)).confirm.base, "同じ人が見た確認と同じ要約（発行者名が入るので、人ごとに違う）");
  assert.notEqual(r.body.base, d.confirm.base, "別の人（社長）の確認は使い回せない");
  assert.ok(!JSON.stringify(r.body).includes("412345"));
});
await ok("作れない：ok:false と理由（画面は送信ボタンを出さない）。送ろうとしても PDF を作れず送らない", async () => {
  const id = await setup();
  const d = await draftOf(id);
  pdfFail = true;
  const r = await check(id);
  assert.deepEqual(r.body.documents.map((x) => x.ok), [false, false]);
  assert.match(r.body.documents[0].hint, /PDFを作れませんでした/);
  const s = await send(id, d);
  assert.equal(s.statusCode, 500, JSON.stringify(s.body));
  assert.equal(s.body.error, "document_failed");
  assert.equal(sent.length, 0, "メールは送らない");
  assert.ok(!mem.rows.gw_hr_offers[0].sent_at, "送付済みにしない");
});

console.log(`\n合格通知の送信前確認 API：${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
