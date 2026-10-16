// HR → Office の状態遷移（本物のハンドラをつないで通す）。
//
// ■ 何を守るテストか（HR → Office 切替ルール。引き渡しは「HR が承諾内容を確認して押した」ときだけ）
//
//   本人が条件承諾 → HR に「条件承諾済み」→ HR が承諾内容・条件・入社予定日を確認
//     → 正式契約が必要？
//         ├ 必要 … HR で LegalSign（URL 登録 → 本人へ案内 → 署名済み）まで終える
//         └ 不要 … そのまま
//     → ［承諾内容を確認してOfficeへ引き渡す］ → Office「HRから引き渡し」 → 入社準備（社員登録 → 入社書類 …）
//
//   1. 承諾しただけでは Office に出ない（キューにも、書類の閲覧にも、社員登録にも）
//   2. 正式契約が必要な版は、署名済み（formal_signed_at）になるまで引き渡せない。不要なら承諾のまま引き渡せる
//   3. 育成枠は、正式契約の要否に関わらず Office へ引き渡さない（LMS・育成開始）
//   4. 引き渡すと、誰が・いつ（handoff_by / handoff_at）が残り、二度目を押しても変わらない
//   5. Office の「HRから引き渡し」には handoff_at の入った人だけ。引き渡したあとは、書類の閲覧・社員登録に進める
//   6. 社員登録（確定）は一度だけ。済んだ人は「HRから引き渡し」から外れ、入社手続きに「HRから引き渡し」の印が付く
//
// 各段階で、HR の見え方・Office の見え方・できること を1枚の表（snap）にして、まとめて比べる。
// ※ 実在の応募者・実際のメール送信は使わない（送信は偽物。宛先は example.test）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";
import { MFA_AUTH } from "./_mfa.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
delete process.env.LEGALSIGN_ALLOWED_HOSTS;
delete process.env.SALARY_OWNER_ONLY;
process.env.PUBLIC_BASE_URL = "https://gw.example.test";

const DOC_COLS = ["notice_title", "notice_pdf_path", "notice_pdf_sha256", "accept_name", "accept_email", "accept_ip", "accept_ua",
  "accept_text", "accepted_pdf_path", "accepted_pdf_sha256", "legalsign_url", "formal_sent_at", "formal_sent_by", "formal_signed_at", "formal_signed_by"];
const H133_COLS = ["formal_contract_required", "handoff_at", "handoff_by"];
const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: { unique: [["tenant_id", "request_key"]], required: ["tenant_id", "to_email", "subject", "body", "request_key"] },
    gw_hr_offers: { defaults: () => ({
      ...Object.fromEntries(DOC_COLS.map((c) => [c, null])),
      ...Object.fromEntries(H133_COLS.map((c) => [c, null])),
    }) },
  },
});
const notified = [];
const logged = [];
const sent = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: {
  notify: async (rows) => { notified.push(...rows); return { created: rows.length }; }, clearNotification: async () => {},
} });
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => ({ sent: true }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
const MAIL_ON = { configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.test>", replyTo: "hr@example.test" };
mock.module(atRoot("lib/mail/index.js"), {
  namedExports: {
    ...REAL_MAIL,
    mailConfig: () => MAIL_ON,
    sendMail: async (m) => {
      sent.push(m);
      return { provider: "resend", from: MAIL_ON.from, replyTo: MAIL_ON.replyTo, providerMessageId: `msg_${sent.length}`, error: null, status: "sent" };
    },
  },
});

// 呼ぶ人。社長／採用担当（HR だけ）／Office の人事（会計側の管理者。採用HRの権限は無い）
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-rec", display_name: "採用 花子" } };
const OFFICE = { userId: "u-oa", tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: { id: "e-oa", display_name: "管理 太郎" } };
const OFFICE_T2 = { ...OFFICE, userId: "u-oa2", tenantId: "t2" };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { default: publicApi } = await import(atRoot("api/hr/offers/public.js"));
const { default: officeApi } = await import(atRoot("api/hr/index.js"));
const { default: advanceApi } = await import(atRoot("api/hr/applicants/advance.js"));
const { default: docsApi } = await import(atRoot("api/hr/documents.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));

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
// HR の画面
const getDetail = () => call(detailApi, { method: "GET", url: "/api/hr/applicants/detail?id=a1" });
const createOffer = (body) => call(offersApi, { method: "POST", url: "/api/hr/offers", body });
const patchOffer = (body) => call(offersApi, { method: "PATCH", url: "/api/hr/offers", body });
const sendDraft = (id) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}` });
const offerFile = (id, file) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}&file=${file}` });
const respond = (body) => call(publicApi, { method: "POST", url: "/api/hr/offers/public", body, headers: { authorization: "", "x-forwarded-for": "203.0.113.5", "user-agent": "Mozilla/5.0 (TestPhone)" } });
// Office の画面
const officeGet = (qs = "") => call(officeApi, { method: "GET", url: `/api/hr${qs}` });
const officeCreate = (body) => call(officeApi, { method: "POST", url: "/api/hr", body });
const docsGet = (qs) => call(docsApi, { method: "GET", url: `/api/hr/documents?${qs}` });
const prefill = () => call(advanceApi, { method: "GET", url: "/api/hr/applicants/advance?applicantId=a1" });
const claim = () => call(advanceApi, { method: "POST", url: "/api/hr/applicants/advance", body: { applicantId: "a1" } });
const complete = (employeeId) => call(advanceApi, { method: "PATCH", url: "/api/hr/applicants/advance", body: { applicantId: "a1", action: "complete", employeeId } });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

let keyN = 0;
const key = () => `flowkey-${String(++keyN).padStart(4, "0")}`;
const DUE = T.defaultRespondBy();
const tokenIn = (text) => (/token=([A-Za-z0-9_-]+)/.exec(text) || [])[1] || null;
const URL1 = "https://sign.example.test/contracts/abc123";
const offer = () => mem.rows.gw_hr_offers.find((o) => !o.revoked_at);
const applicant = () => mem.rows.gw_hr_applicants[0];
const tl = () => mem.rows.gw_hr_timeline;

function setup(type) {
  mem.reset(); logged.length = 0; sent.length = 0; notified.length = 0; who = OWNER;
  mem.rows.tenants = [{ id: "t1", name: "株式会社エイト" }, { id: "t2", name: "別会社" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-rec", tenant_id: "t1", user_id: "u-rec", display_name: "採用 花子", email: "hanako@example.test", status: "active" },
    { id: "e-oa", tenant_id: "t1", user_id: "u-oa", display_name: "管理 太郎", status: "active" },
    { id: "e-new", tenant_id: "t1", user_id: "u-new", display_name: "高木 沙綾", status: "active" },
  ];
  mem.rows.gw_hr_applicants = [{
    id: "a1", tenant_id: "t1", name: "高木 沙綾", email: "candidate@example.test", job_title: "エンジニア", source: "テスト",
    stage: "offer", status: "offer_draft_pending", decision: "hired", rank: "A", recruiter_id: "e-rec",
    employment_type: null, wage_type: null, wage_amount: null, lead_category: "recruitment", offer_type: type,
  }];
  for (const t of ["gw_hr_offers", "gw_hr_timeline", "gw_hr_mail_sends", "gw_hr_interviews", "gw_procedures", "gw_procedure_items", "gw_tasks", "memberships"]) mem.rows[t] = [];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
  // HR が登録した書類（Office は、引き渡されたあとにこれを見るだけ）
  mem.put("hr", "t1/recruit/a1/r.pdf", Buffer.from("%PDF-1.4\n"));
  mem.rows.gw_hr_documents = [{ id: "d1", tenant_id: "t1", applicant_id: "a1", doc_type: "resume", filename: "高木_履歴書.pdf", storage_path: "t1/recruit/a1/r.pdf",
    mime_type: "application/pdf", size_bytes: 10, created_at: "2026-10-01T00:00:00Z" }];
}

const BASE = {
  contractor: { wageType: "月額", wageAmount: 200000, offerTerms: { duties: T.DUTY_TEMPLATES[1].text } },
  training: { wageType: "時給", wageAmount: 1500, offerTerms: { course: "無限道場" } },
};
// 作る → 送る → 本人が承諾する（本物のハンドラ）。送ったあと・承諾したあとの状態を返す
async function draftAndSend(type, extra = {}) {
  setup(type);
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", ...BASE[type], ...extra });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const id = made.body.offer.id;
  const d = (await sendDraft(id)).body;
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return { id, token: tokenIn(sent[0].text) };
}
async function accepted(type, extra = {}) {
  const x = await draftAndSend(type, extra);
  const acc = await respond({ token: x.token, action: "accept", agreed: true });
  assert.equal(acc.statusCode, 200, JSON.stringify(acc.body));
  return x;
}
const handoff = (id) => patchOffer({ id, action: "handoff" });
const signFormal = async (id) => {
  assert.equal((await patchOffer({ id, action: "setLegalSign", url: URL1 })).statusCode, 200);
  assert.equal((await patchOffer({ id, action: "sendFormal", channel: "manual" })).statusCode, 200);
  assert.equal((await patchOffer({ id, action: "markFormalSigned" })).statusCode, 200);
};

/**
 * いまの状態を、HR の見え方・Office の見え方・できること にして1つにまとめる。
 * （呼ぶたびに、見る人を切り替える：HR＝社長／Office＝Office の人事）
 */
async function snap(id) {
  const o = mem.rows.gw_hr_offers.find((x) => x.id === id);
  who = OWNER;
  const a = (await getDetail()).body.applicant;
  who = OFFICE;
  const queue = (await officeGet()).body.handoffs;
  const docs = await docsGet("applicantId=a1");
  const adv = await prefill();
  who = OWNER;
  return {
    hr: [a.statusLabel, a.nextActionCta ?? null, a.nextActionKey ?? null],           // HR の状態・NEXT ACTION の CTA・その操作
    officeQueue: queue.rows.some((r) => r.applicantId === "a1"),                  // Office「HRから引き渡し」に載っているか
    officeDocs: docs.statusCode,                                                   // Office から HR 書類を見られるか（200／403）
    officeAdvance: adv.statusCode === 200 ? "進める" : adv.body.error,             // 社員登録の事前入力に進めるか
    handoffAt: o?.handoff_at ? "あり" : "なし",
    handoffBy: o?.handoff_by ?? null,
  };
}

console.log("\n=== 正式契約が必要な区分（業務委託）：承諾 → 正式契約（HR）→ 引き渡し → Office ===");
await ok("状態の遷移表：承諾 → 正式契約待ち → 正式契約済み → 引き渡し（承諾しただけ・正式契約済みだけでは Office に出ない）", async () => {
  const { id, token } = await draftAndSend("contractor");
  // S0 送った（本人はまだ承諾していない）：Office には出ない
  const s0 = await snap(id);
  assert.deepEqual([s0.hr[0].startsWith("条件承諾待ち"), s0.officeQueue, s0.officeDocs, s0.officeAdvance, s0.handoffAt], [true, false, 403, "invalid_state", "なし"], "S0 送った：Office には出ない");

  // S1 本人が承諾
  assert.equal((await respond({ token, action: "accept", agreed: true })).statusCode, 200);
  assert.deepEqual(await snap(id), {
    hr: ["条件承諾済み", "正式契約へ", "formalContract"], officeQueue: false, officeDocs: 403, officeAdvance: "handoff_required", handoffAt: "なし", handoffBy: null,
  });
  // 承諾しただけでは引き渡せない（正式契約が必要）
  let r = await handoff(id);
  assert.deepEqual([r.statusCode, r.body.error], [409, "formal_required"]);

  // S2 LegalSign：URL → 案内
  assert.equal((await patchOffer({ id, action: "setLegalSign", url: URL1 })).statusCode, 200);
  assert.equal((await patchOffer({ id, action: "sendFormal", channel: "manual" })).statusCode, 200);
  assert.deepEqual(await snap(id), {
    hr: ["正式契約待ち", "正式契約済みにする", "formalContract"], officeQueue: false, officeDocs: 403, officeAdvance: "handoff_required", handoffAt: "なし", handoffBy: null,
  });
  r = await handoff(id);
  assert.deepEqual([r.statusCode, r.body.error], [409, "formal_required"], "案内しただけでは引き渡せない");

  // S3 正式契約済み（HR で完了）。まだ Office には出ない：HR が承諾内容を確認して引き渡すまで
  assert.equal((await patchOffer({ id, action: "markFormalSigned" })).statusCode, 200);
  assert.deepEqual(await snap(id), {
    hr: ["正式契約済み", "承諾内容を確認してOfficeへ引き渡す", "handoff"], officeQueue: false, officeDocs: 403, officeAdvance: "handoff_required", handoffAt: "なし", handoffBy: null,
  });

  // S4 HR が引き渡す → Office「HRから引き渡し」。誰が・いつが残る
  r = await handoff(id);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(await snap(id), {
    hr: ["Office引き渡し済み", null, null], officeQueue: true, officeDocs: 200, officeAdvance: "進める", handoffAt: "あり", handoffBy: "u-owner",
  });
  assert.equal(applicant().status, "accepted", "引き渡しただけでは社員にしない");
  assert.equal(applicant().employee_id ?? null, null);
});

await ok("Office のキューの中身：HRで正式契約まで完了・連絡先・引き渡し記録・入社の流れ。給与・LegalSign URLは出さない", async () => {
  const { id } = await accepted("contractor");
  await signFormal(id);
  assert.equal((await handoff(id)).statusCode, 200);
  who = OFFICE;
  const q = (await officeGet()).body.handoffs;
  assert.equal(q.ready, true);
  assert.equal(q.rows.length, 1);
  const row = q.rows[0];
  assert.deepEqual([row.applicantId, row.name, row.offerTypeLabel, row.joinDate, row.formalRequired, row.handoffByName],
    ["a1", "高木 沙綾", "業務委託", "2026-11-01", true, "社長 一郎"]);
  assert.ok(row.formalSignedAt && row.handoffAt && row.acceptedAt);
  assert.equal(row.email, "candidate@example.test", "入社準備用のメールをHRから引き継ぐ");
  assert.deepEqual(row.hire.steps.map((s) => s.key), ["docs", "account", "orientation", "complete"], "Office の流れは 入社書類 → アカウント・端末 → オリエンテーション → 入社完了");
  assert.equal(row.hire.steps[0].state, "current");
  assert.deepEqual([row.hire.hr.label, row.hire.hr.detail], ["HRで正式契約まで完了", "正式契約：署名済み"]);
  const text = JSON.stringify(q);
  for (const secret of ["200000", "sign.example.test", "203.0.113.5", "u-owner"]) assert.equal(text.includes(secret), false, `${secret} を出さない`);
});

await ok("引き渡すと誰が・いつが残る（handoff_by / handoff_at）。二度押しても変わらない（記録は1回だけ・通知も1回）", async () => {
  const { id } = await accepted("contractor");
  await signFormal(id);
  const r1 = await handoff(id);
  assert.equal(r1.statusCode, 200);
  const first = { at: offer().handoff_at, by: offer().handoff_by };
  assert.deepEqual([typeof first.at, first.by], ["string", "u-owner"]);
  const log = logged.find((e) => e.action === "hr.offer_handoff");
  assert.deepEqual([log.actorId, log.detail.formalRequired, log.detail.formalSigned], ["u-owner", true, true]);
  assert.ok(tl().some((t) => t.event_key === "office_handoff" && t.created_by === "u-owner"));
  const notes = notified.filter((n) => n.dedupeKey === "hr_handoff:a1").length;
  assert.ok(notes >= 1, "Office の人事・労務へ通知");
  // もう一度押しても、最初の記録のまま（二度目は already）
  const r2 = await handoff(id);
  assert.deepEqual([r2.statusCode, r2.body.already], [200, true]);
  assert.deepEqual({ at: offer().handoff_at, by: offer().handoff_by }, first, "handoff_at / handoff_by は変わらない");
  assert.equal(tl().filter((t) => t.event_key === "office_handoff").length, 1);
  assert.equal(logged.filter((e) => e.action === "hr.offer_handoff").length, 1);
  assert.equal(notified.filter((n) => n.dedupeKey === "hr_handoff:a1").length, notes, "通知も増えない");
});

await ok("引き渡せる人：社長・管理者・人事。採用担当だけ・Office の人事（採用HRの権限なし）はできない", async () => {
  const { id } = await accepted("contractor", { formalContractRequired: false });
  who = RECRUITER;
  assert.equal((await handoff(id)).statusCode, 403, "採用担当だけの人は引き渡せない");
  who = OFFICE;
  assert.equal((await handoff(id)).statusCode, 403, "Office の人事は、HR の画面の操作はできない（引き渡しは HR の確認のあと）");
  assert.equal(offer().handoff_at, null);
  who = OWNER;
  assert.equal((await handoff(id)).statusCode, 200);
});

console.log("\n=== 正式契約が不要の区分（承諾後そのまま確認して引き渡す） ===");
await ok("状態の遷移表：承諾 →（HR の確認）→ 引き渡し。承諾しただけでは Office に出ない。LegalSign の操作はできない", async () => {
  const { id } = await accepted("contractor", { formalContractRequired: false });
  assert.deepEqual(await snap(id), {
    hr: ["条件承諾済み", "承諾内容を確認してOfficeへ引き渡す", "handoff"], officeQueue: false, officeDocs: 403, officeAdvance: "handoff_required", handoffAt: "なし", handoffBy: null,
  });
  for (const body of [{ action: "setLegalSign", url: URL1 }, { action: "sendFormal", channel: "manual" }, { action: "markFormalSigned" }]) {
    const r = await patchOffer({ id, ...body });
    assert.deepEqual([r.statusCode, r.body.error], [409, "not_required"], body.action);
  }
  assert.equal((await handoff(id)).statusCode, 200);
  assert.deepEqual(await snap(id), {
    hr: ["Office引き渡し済み", null, null], officeQueue: true, officeDocs: 200, officeAdvance: "進める", handoffAt: "あり", handoffBy: "u-owner",
  });
  who = OFFICE;
  const row = (await officeGet()).body.handoffs.rows[0];
  assert.deepEqual([row.formalRequired, row.hire.hr.detail], [false, "正式契約：不要"]);
});

console.log("\n=== 育成枠：Office へは引き渡さない（正式契約の要否に関わらず LMS・育成開始） ===");
for (const formal of [false, true]) {
  await ok(`育成枠（正式契約 ${formal ? "必要" : "不要"}${formal ? "・署名済み" : ""}）：引き渡せない・Office のキューにも書類閲覧にも出ない。NEXT ACTION は LMS・育成開始`, async () => {
    const { id } = await accepted("training", { formalContractRequired: formal });
    if (formal) await signFormal(id);
    const s = await snap(id);
    assert.match(s.hr[1], /育成開始/, "NEXT ACTION は LMS・育成開始（HR で進める）");
    assert.equal(s.hr[2], "advance", "Office へ引き渡す操作（handoff）ではない");
    assert.deepEqual([s.officeQueue, s.officeDocs, s.handoffAt], [false, 403, "なし"]);
    const r = await handoff(id);
    assert.deepEqual([r.statusCode, r.body.error], [409, "training"]);
    assert.equal(offer().handoff_at ?? null, null);
    assert.deepEqual(await snap(id), { ...s }, "拒まれたあとも状態は変わらない");
    // Office のキューが空のまま（handoff_at が入っていないものは出ない。入っていても育成枠は出さない）
    who = OFFICE;
    assert.deepEqual((await officeGet()).body.handoffs.rows, []);
    offer().handoff_at = "2026-10-20T00:00:00Z";   // 万一データが入っていても Office には出さない
    assert.deepEqual((await officeGet()).body.handoffs.rows, [], "育成枠は handoff_at が入っていても出さない");
    assert.equal((await docsGet("applicantId=a1")).statusCode, 403, "書類の閲覧も許さない");
  });
}

console.log("\n=== 承諾していない・辞退した版は引き渡せない／Office に出ない ===");
await ok("送っただけ（承諾前）・本人が辞退：引き渡せない。Office のキューにも書類閲覧にも出ない", async () => {
  const { id, token } = await draftAndSend("contractor", { formalContractRequired: false });
  let r = await handoff(id);
  assert.deepEqual([r.statusCode, r.body.error], [409, "invalid_state"], "承諾前");
  who = OFFICE;
  assert.deepEqual((await officeGet()).body.handoffs.rows, []);
  who = OWNER;
  assert.equal((await respond({ token, action: "decline", reason: "他社に決まりました" })).statusCode, 200);
  r = await handoff(id);
  assert.deepEqual([r.statusCode, r.body.error], [409, "invalid_state"], "辞退");
  who = OFFICE;
  assert.deepEqual((await officeGet()).body.handoffs.rows, []);
  assert.equal((await docsGet("applicantId=a1")).statusCode, 403);
});

console.log("\n=== 引き渡したあと：Office の書類閲覧（閲覧専用）と社員登録 ===");
await ok("書類：引き渡したあとだけ、Office が HR の原本を見られる（履歴書・条件通知書・承諾済みPDF）。登録・削除はできない。別テナントは 404", async () => {
  const { id } = await accepted("contractor", { formalContractRequired: false });
  who = OFFICE;
  assert.equal((await docsGet("applicantId=a1")).statusCode, 403, "引き渡し前");
  assert.equal((await docsGet("id=d1")).statusCode, 403);
  assert.equal((await offerFile(id, "accepted")).statusCode, 403);
  who = OWNER;
  assert.equal((await handoff(id)).statusCode, 200);
  who = OFFICE;
  const list = await docsGet("applicantId=a1");
  assert.equal(list.statusCode, 200);
  assert.deepEqual([list.body.readOnly, list.body.offerId, list.body.documents.find((d) => d.docType === "resume").latest.filename], [true, id, "高木_履歴書.pdf"]);
  assert.equal((await docsGet("id=d1&applicantId=a1")).statusCode, 200, "原本の URL（短時間）");
  for (const f of ["notice", "accepted"]) {
    const r = await offerFile(id, f);
    assert.equal(r.statusCode, 200, f);
    assert.equal(r.headers["content-type"], "application/pdf");
  }
  const w = await call(docsApi, { method: "DELETE", url: "/api/hr/documents?id=d1" });
  assert.deepEqual([w.statusCode, w.body.error], [403, "read_only"]);
  assert.equal(mem.rows.gw_hr_documents.length, 1, "書類は消えない");
  who = OFFICE_T2;
  assert.equal((await docsGet("applicantId=a1")).statusCode, 404, "別のテナントからは見えない");
  assert.equal((await offerFile(id, "accepted")).statusCode, 404);
});

await ok("社員登録：引き渡し前は進めない（事前入力・手続き開始・完了とも 409）。引き渡し後は進められ、確定は一度だけ。済んだ人は「HRから引き渡し」から外れ、入社手続きに印が付く", async () => {
  const { id } = await accepted("contractor");
  await signFormal(id);
  who = OFFICE;
  for (const r of [await prefill(), await claim(), await complete("e-new")]) assert.deepEqual([r.statusCode, r.body.error], [409, "handoff_required"]);
  assert.equal(applicant().employee_id ?? null, null);
  who = OWNER;
  assert.equal((await handoff(id)).statusCode, 200);
  who = OFFICE;
  const p = await prefill();
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  assert.equal(p.body.prefill.name, "高木 沙綾");
  assert.equal((await claim()).statusCode, 200);
  assert.equal((await complete("e-new")).statusCode, 200);
  assert.deepEqual([applicant().status, applicant().employee_id], ["done", "e-new"]);
  const again = await complete("e-new");
  assert.deepEqual([again.statusCode, again.body.error], [409, "already_advanced"], "二重に確定しない");
  // 社員登録が済んだ人は「HRから引き渡し」には出ない
  assert.deepEqual((await officeGet()).body.handoffs.rows, []);
  // 入社手続きを作ると、一覧に「HRから引き渡し」の印と、入社書類から始まる NEXT ACTION
  const made = await officeCreate({ employeeId: "e-new", kind: "onboarding", targetOn: "2026-11-01" });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const list = (await officeGet()).body;
  const row = list.onboarding.find((x) => x.employeeId === "e-new");
  assert.deepEqual([row.fromHr, row.hireKey, row.hirePhase], [true, "docs", "入社書類"]);
  const one = (await officeGet(`?id=${row.id}`)).body.procedure;
  assert.deepEqual([one.hire.fromHr, one.hire.handoff.applicantId, one.hire.handoff.handoffByName, one.hire.hr.label],
    [true, "a1", "社長 一郎", "HRで正式契約まで完了"]);
  assert.deepEqual(one.hire.steps.map((s) => s.key), ["docs", "account", "orientation", "complete"]);
});

await ok("Office の人事権限が無い人（採用担当だけ）は Office のキューも社員登録も使えない", async () => {
  const { id } = await accepted("contractor", { formalContractRequired: false });
  who = OWNER; await handoff(id);
  who = RECRUITER;
  assert.equal((await officeGet()).statusCode, 403);
  assert.equal((await prefill()).statusCode, 403);
  assert.equal((await claim()).statusCode, 403);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
