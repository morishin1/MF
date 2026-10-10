// 採用HR：オファー作成・メール送信・同意完結（オファー作成・メール送信・同意完結 UI/UX改善仕様）を、API から通す。
//
// ■ 何を守るテストか
//   1. 入力を減らす：区分ごとの通常表示は少しだけ（ほかは詳細設定）。報酬はボタン（育成は［なし］［時給］［月額］、
//      パートは時給だけ）。業務委託の既定値・業務内容の標準文・無限道場の期間（3か月）・評価日・回答期限（送る日から3日後）
//   2. ［内容を確認してメールで送信］1回で：内容の確定 → 本人専用URL → メール → sent_at → タイムライン → 承諾待ち
//      既存のメール送信（lib/mail）と送った記録（gw_hr_mail_sends）を使う。新しい表は作らない
//   3. 送った記録・監査ログに本人専用URL（token）を残さない。二重送信しない（同じ鍵の2回目は送らない）
//   4. 送れないとき（設定が無い・アドレスが無い・失敗・結果不明）は、送付済みにせず、手で送る道を残す
//   5. 本人は「上記の内容を確認し、同意します」にチェックしたときだけ同意できる。同意＝契約完了（accepted_at・版・タイムライン）
//   6. HR は「契約完了」。NEXT ACTION は区分ごと
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

const mem = createMemDb({
  schema: {
    gw_hr_mail_sends: {
      unique: [["tenant_id", "request_key"]],
      required: ["tenant_id", "to_email", "subject", "body", "request_key"],
    },
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
      const base = { provider: "resend", from: MAIL_ON.from, replyTo: MAIL_ON.replyTo, providerMessageId: null, error: null };
      if (mailMode === "failed") return { ...base, status: "failed", error: "送信サービスが断りました（422）" };
      if (mailMode === "timeout") return { ...base, status: "failed", error: "送信サービスの応答がありませんでした（時間切れ）" };
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
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { default: publicApi } = await import(atRoot("api/hr/offers/public.js"));
const { normalizeOffer, sha256 } = await import(atRoot("lib/hr.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (fn, req) => { const r = res(); await fn({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getDetail = (id) => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const createOffer = (body) => call(offersApi, { method: "POST", url: "/api/hr/offers", body });
const patchOffer = (body) => call(offersApi, { method: "PATCH", url: "/api/hr/offers", body });
const sendDraft = (id) => call(offersApi, { method: "GET", url: `/api/hr/offers?id=${id}` });
const viewPublic = (token) => call(publicApi, { method: "GET", url: `/api/hr/offers/public?token=${encodeURIComponent(token)}` });
const respond = (body) => call(publicApi, { method: "POST", url: "/api/hr/offers/public", body });
let keyN = 0;
const key = () => `sendkey-${String(++keyN).padStart(4, "0")}`;

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

const DUE = T.defaultRespondBy();   // 今日（日本時間）から3日後
function setup(offerType = "training", extra = {}) {
  mem.reset(); logged.length = 0; sent.length = 0; mailMode = "sent"; who = OWNER;
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
  mem.rows.gw_hr_offers = [];
  mem.rows.gw_hr_timeline = [];
  mem.rows.gw_hr_mail_sends = [];
  mem.rows.gw_hr_interviews = [];
  mem.rows.memberships = [];
  mem.rows.gw_role_grants = [{ employee_id: "e-owner", role: "owner" }];
}
const app = () => mem.rows.gw_hr_applicants[0];
const tl = () => mem.rows.gw_hr_timeline.map((t) => t.label);
const offerRow = () => mem.rows.gw_hr_offers.find((o) => !o.revoked_at);
const trainingOffer = () => createOffer({
  applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", wageType: "時給", wageAmount: 1500, offerTerms: { course: "無限道場" },
});
const tokenIn = (text) => (/token=([A-Za-z0-9_-]+)/.exec(text) || [])[1] || null;

console.log("\n— 入力を減らす（定義・既定値・自動で決まる値） —");
await ok("通常表示は区分ごとに少しだけ（回答期限を入れて4〜6項目）。ほかは詳細設定", () => {
  const basicOf = (k) => T.offerTypeOf(k).fields.filter((f) => f.basic && !f.hidden).map((f) => f.key);
  assert.deepEqual(basicOf("training"), ["course", "joinDate", "wageAmount"]);
  assert.deepEqual(basicOf("part_time"), ["employmentType", "wageAmount", "workDays", "workHours", "joinDate"]);
  assert.deepEqual(basicOf("contractor"), ["duties", "wageAmount", "joinDate", "workHours"]);
  assert.deepEqual(basicOf("spot"), ["projectName", "duties", "joinDate", "workHours", "wageAmount"]);
  assert.deepEqual(basicOf("executive_employee"), ["jobTitle", "wageAmount", "joinDate", "workLocation"]);
  for (const k of T.OFFER_TYPE_KEYS) {
    const n = basicOf(k).length + 1;   // ＋回答期限
    assert.ok(n >= 4 && n <= 6, `${k}: ${n}項目`);
  }
  // 育成の担当講師・評価日・実案件開始予定は詳細設定
  const more = T.offerTypeOf("training").fields.filter((f) => !f.basic && !f.hidden).map((f) => f.key);
  assert.ok(["trainingPeriod", "instructor", "midReviewOn", "finalReviewOn", "projectStartOn"].every((k) => more.includes(k)), more.join(","));
});

await ok("報酬はボタン：育成［なし］［時給］［月額］／業務委託［月額］［時給］［案件］［成果報酬］／スポット［日額］［時給］［案件］／パートは時給だけ", () => {
  const labels = (k) => [...(T.offerTypeOf(k).pay.none ? [T.offerTypeOf(k).pay.none.label] : []), ...(T.offerTypeOf(k).pay.buttons || []).map((b) => b.label)];
  assert.deepEqual(labels("training"), ["なし", "時給", "月額"]);
  assert.deepEqual(labels("contractor"), ["月額", "時給", "案件", "成果報酬"]);
  assert.deepEqual(labels("spot"), ["日額", "時給", "案件"]);
  assert.equal(T.offerTypeOf("part_time").pay.fixed, "時給");
  assert.deepEqual(T.offerTypeOf("part_time").fields.find((f) => f.key === "wageType").options, ["時給"], "給与区分を選ばせない");
  // 給与区分・育成中の報酬は、入力欄を出さない（ボタンが決める）
  const pub = T.OFFER_TYPES_PUBLIC.find((t) => t.key === "training");
  assert.deepEqual(pub.fields.filter((f) => f.hidden).map((f) => f.key), ["paidDuringTraining", "wageType"]);
});

await ok("既定値：業務委託は 協議のうえ更新・月末締め翌月末払い・NDA 必要。業務内容は標準文から選べる", () => {
  const def = Object.fromEntries(T.offerTypeOf("contractor").fields.filter((f) => f.value != null).map((f) => [f.key, f.value]));
  assert.deepEqual(def, { renewal: "協議のうえ更新", paymentTerms: "月末締め翌月末払い", nda: "必要" });
  assert.deepEqual(T.DUTY_TEMPLATES.map((t) => t.label), ["AI・DX支援", "営業", "運営", "講師", "バックオフィス", "その他"]);
  assert.equal(T.DUTY_TEMPLATES.find((t) => t.label === "営業").text, "法人への営業活動、商談対応、顧客フォローおよび関連業務");
  assert.equal(T.DUTY_TEMPLATES.find((t) => t.label === "AI・DX支援").text, "企業・自治体へのAI・DX導入支援、業務改善、調査、提案および関連業務");
  const pub = T.OFFER_TYPES_PUBLIC.find((t) => t.key === "contractor").fields.find((f) => f.key === "duties");
  assert.equal(pub.templates.length, 6, "画面へも渡す");
});

await ok("回答期限は送る日（日本時間）から3日後。評価日は開始日と期間から", () => {
  const now = Date.UTC(2026, 9, 10, 16, 0, 0);   // 日本時間 10/11 01:00
  assert.equal(T.todayJst(now), "2026-10-11");
  assert.equal(T.defaultRespondBy(now), "2026-10-14");
  assert.equal(T.periodMonths("3か月"), 3);
  assert.equal(T.periodMonths("6ヶ月"), 6);
  assert.equal(T.periodMonths("半年"), null);
  assert.deepEqual(T.reviewDates("2026-11-01", 3), { mid: "2026-12-17", final: "2027-01-31" });
  assert.deepEqual(T.reviewDates("2027-01-31", 1), { mid: "2027-02-14", final: "2027-02-27" }, "月末の開始でも月をまたがない");
});

await ok("育成：無限道場で期間3か月・評価日が自動。［なし］なら金額を持たない、［時給］なら「あり」", () => {
  const base = { respondBy: DUE, joinDate: "2026-11-01" };
  const paid = normalizeOffer({ ...base, wageType: "時給", wageAmount: 1500, offerTerms: { course: "無限道場" } }, { name: "x" }, { offerType: "training" });
  assert.deepEqual(paid.value.offer_terms, { course: "無限道場", paidDuringTraining: "あり", trainingPeriod: "3か月", midReviewOn: "2026-12-17", finalReviewOn: "2027-01-31" });
  assert.deepEqual([paid.value.wage_type, paid.value.wage_amount], ["時給", 1500]);
  const none = normalizeOffer({ ...base, wageType: "", wageAmount: 1500, offerTerms: { course: "無限道場", paidDuringTraining: "なし" } },
    { name: "x", wage_type: "時給", wage_amount: 1200 }, { offerType: "training" });
  assert.deepEqual([none.value.wage_type, none.value.wage_amount], [null, null]);
  const mine = normalizeOffer({ ...base, offerTerms: { course: "AI講座", trainingPeriod: "6か月", midReviewOn: "2027-01-15" } }, { name: "x" }, { offerType: "training" });
  assert.deepEqual(mine.value.offer_terms, { course: "AI講座", trainingPeriod: "6か月", midReviewOn: "2027-01-15", finalReviewOn: "2027-04-30" }, "入っている値は変えない");
});

await ok("パート：時給だけ（区分を選ばなくても時給）。応募時の「月給 30万円」を時給に持ち込まない", () => {
  const r = normalizeOffer({ respondBy: DUE, joinDate: "2026-11-01", employmentType: "パート", offerTerms: {} },
    { name: "x", wage_type: "月給", wage_amount: 300000 }, { offerType: "part_time" });
  assert.deepEqual([r.value.wage_type, r.value.wage_amount], [null, null]);
  const r2 = normalizeOffer({ respondBy: DUE, joinDate: "2026-11-01", employmentType: "パート", wageAmount: 1500, offerTerms: {} },
    { name: "x" }, { offerType: "part_time" });
  assert.deepEqual([r2.value.wage_type, r2.value.wage_amount], ["時給", 1500]);
  assert.equal(normalizeOffer({ respondBy: DUE, joinDate: "2026-11-01", wageType: "月給", wageAmount: 1 }, { name: "x" }, { offerType: "part_time" }).error, "invalid_body");
});

await ok("メールの文面は区分ごと（育成：【株式会社エイト】育成プログラムのご案内）。URLの場所は {{オファーURL}}", () => {
  const m = T.offerMail({ offer_type: "training", respond_by: "2026-10-13" }, { name: "テスト 候補者", company: "株式会社エイト" });
  assert.equal(m.subject, "【株式会社エイト】育成プログラムのご案内");
  assert.ok(m.body.startsWith("テスト 候補者 様\n"));
  assert.ok(m.body.includes("株式会社エイトより、\n育成プログラムへの参加をご案内いたします。"));
  assert.ok(m.body.includes("「同意して契約を完了する」を押してください"));
  assert.ok(m.body.includes("［内容を確認する］\n{{オファーURL}}"));
  assert.ok(m.body.includes("回答期限：2026年10月13日"));
  assert.equal(T.offerMail({ offer_type: "contractor" }, { name: "x", company: "株式会社エイト" }).subject, "【株式会社エイト】業務委託契約のご案内");
  assert.ok(T.offerMail({ offer_type: "part_time", employment_type: "アルバイト" }, { name: "x", company: "c" }).body.includes("アルバイトとしての採用"));
});

console.log("\n— 内容を確認して、メールで送る —");
await ok("送る前の確認：本人に見える条件（重要条件が先）・件名・本文・送れるか", async () => {
  setup();
  const made = await trainingOffer();
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const d = await sendDraft(made.body.offer.id);
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  const top = d.body.items.filter((i) => i.highlight).map((i) => `${i.label}:${i.value}`);
  assert.deepEqual(top, ["育成コース:無限道場", "開始日:2026年11月1日", "期間:3か月", "報酬:時給 1,500円"]);
  assert.equal(d.body.subject, "【株式会社エイト】育成プログラムのご案内");
  assert.ok(d.body.body.includes(d.body.urlTag));
  assert.deepEqual([d.body.mail.configured, d.body.canSend, d.body.to], [true, true, "candidate@example.test"]);
});

await ok("給与を見られない人の確認画面には、報酬の行を出さない", async () => {
  setup();
  const made = await trainingOffer();
  who = RECRUITER;
  const d = await sendDraft(made.body.offer.id);
  assert.equal(d.statusCode, 200);
  assert.equal(d.body.items.some((i) => i.label === "報酬"), false);
  assert.equal(JSON.stringify(d.body).includes("1,500"), false);
  assert.equal("wageAmount" in d.body.offer, false);
});

await ok("［メールでオファー送信］1回で：確定 → URL → メール → sent_at → タイムライン → 承諾待ち", async () => {
  setup();
  const made = await trainingOffer();
  const id = made.body.offer.id;
  const d = (await sendDraft(id)).body;
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "sent");
  assert.equal(sent.length, 1);
  const mail = sent[0];
  assert.equal(mail.to, "candidate@example.test");
  assert.equal(mail.purpose, "recruiting", "既存の採用メール（送信元）");
  assert.ok(mail.text.includes("https://gw.example.test/hr/offer.html?token="), mail.text);
  assert.equal(mail.text.includes("{{"), false);
  const token = tokenIn(mail.text);
  const o = offerRow();
  assert.equal(o.token_hash, sha256(token), "メールのURLが、この版の本人専用URL");
  assert.ok(o.sent_at, "sent_at");
  assert.equal(app().status, "offer_sent");
  assert.ok(tl().includes("育成参加決定通知の内容を確定"), tl().join(","));
  assert.ok(tl().includes("育成参加決定通知をメールで送付"), tl().join(","));
  // 送った記録：既存の gw_hr_mail_sends（ひな型ではないので template_id は空）。URL（token）は残さない
  const rec = mem.rows.gw_hr_mail_sends[0];
  assert.deepEqual([rec.status, rec.template_id, rec.applicant_id], ["sent", null, "a1"]);
  assert.ok(rec.template_name.startsWith("オファー送付（育成参加決定通知・第1版）"), rec.template_name);
  assert.equal(rec.body.includes(token), false);
  assert.ok(rec.body.includes("本人専用URL・記録には残しません"));
  assert.equal(JSON.stringify(logged).includes(token), false, "監査ログにも残さない");
  assert.equal(JSON.stringify(r.body).includes(token), false, "送れたときは、画面にも URL を返さない");
  const a = (await getDetail("a1")).body.applicant;
  assert.equal(a.statusLabel, "承諾待ち");
});

await ok("同じ鍵の2回目は送らない（二度押し・通信のやり直し）", async () => {
  setup();
  const id = (await trainingOffer()).body.offer.id;
  const d = (await sendDraft(id)).body;
  const k = key();
  await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: k });
  const again = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: k });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(sent.length, 1);
  const other = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(other.statusCode, 409, "送った版は、もう一度送らない（再発行へ）");
  assert.equal(sent.length, 1);
});

await ok("送れない内容は送らない：{{オファーURL}} が無い・件名が空・回答期限が過ぎている", async () => {
  setup();
  const id = (await trainingOffer()).body.offer.id;
  const d = (await sendDraft(id)).body;
  const noTag = await patchOffer({ id, action: "send", subject: d.subject, body: "URLの無い本文", requestKey: key() });
  assert.equal(noTag.statusCode, 400);
  assert.ok(noTag.body.hint.includes("{{オファーURL}}"));
  assert.equal((await patchOffer({ id, action: "send", subject: "", body: d.body, requestKey: key() })).statusCode, 400);
  offerRow().respond_by = "2020-01-01";
  const late = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(late.statusCode, 400);
  assert.ok(late.body.hint.includes("回答期限"));
  assert.equal(sent.length, 0);
  assert.equal(app().status, "offer_review_pending", "状態は変えない");
  assert.equal(mem.rows.gw_hr_mail_sends.length, 0);
});

await ok("メール送信の設定が無い・アドレスが無い：409。状態・URLは変えない（手で送る道へ）", async () => {
  setup();
  const id = (await trainingOffer()).body.offer.id;
  const before = offerRow().token_hash;
  const d = (await sendDraft(id)).body;
  mailMode = "off";
  assert.equal((await sendDraft(id)).body.mail.configured, false);
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.deepEqual([r.statusCode, r.body.error], [409, "mail_not_configured"]);
  mailMode = "sent";
  app().email = null;
  const r2 = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.deepEqual([r2.statusCode, r2.body.error], [409, "no_email"]);
  assert.equal(sent.length, 0);
  assert.equal(offerRow().token_hash, before);
  assert.equal(app().status, "offer_review_pending");
  // 手で送る：確定 → URL を発行 → 送付済みにする（従来の流れのまま）
  assert.equal((await patchOffer({ id, action: "confirm" })).statusCode, 200);
  const link = await patchOffer({ id, action: "issueLink" });
  assert.equal(link.statusCode, 200);
  assert.ok(link.body.token);
  assert.equal((await patchOffer({ id, action: "markSent" })).statusCode, 200);
  assert.equal(app().status, "offer_sent");
});

await ok("送れなかった（失敗）：送付済みにしない。URLを一度だけ返して、手で送って「送付済みにする」", async () => {
  setup();
  const id = (await trainingOffer()).body.offer.id;
  const d = (await sendDraft(id)).body;
  mailMode = "failed";
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(r.statusCode, 502, JSON.stringify(r.body));
  assert.equal(r.body.status, "failed");
  assert.equal(offerRow().sent_at, null);
  assert.equal(offerRow().token_hash, sha256(r.body.token), "返した URL は、この版の本人専用URL");
  assert.equal(app().status, "offer_send_pending");
  assert.equal(mem.rows.gw_hr_mail_sends[0].status, "failed");
  assert.ok(tl().includes("育成参加決定通知のメールを送れませんでした"));
  assert.equal((await patchOffer({ id, action: "markSent" })).statusCode, 200);
  assert.equal(app().status, "offer_sent");
});

await ok("結果不明（時間切れ）：届いたかもしれないので、すぐに送り直させない（sent_at は残す・確かめてから送付済み）", async () => {
  setup();
  const id = (await trainingOffer()).body.offer.id;
  const d = (await sendDraft(id)).body;
  mailMode = "timeout";
  const r = await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  assert.equal(r.statusCode, 202, JSON.stringify(r.body));
  assert.equal(r.body.status, "unknown");
  assert.ok(offerRow().sent_at);
  assert.equal(app().status, "offer_send_pending");
  assert.equal((await sendDraft(id)).body.canSend, false, "同じ版を、もう一度メールで送らせない");
  assert.equal((await patchOffer({ id, action: "markSent" })).statusCode, 200);
});

console.log("\n— 候補者：内容確認 → 同意 → 契約完了 —");
async function sentTraining() {
  setup();
  const id = (await trainingOffer()).body.offer.id;
  const d = (await sendDraft(id)).body;
  await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  return tokenIn(sent[0].text);
}

await ok("メールのURLから開ける：重要条件（コース・開始日・期間・報酬）が先。社内の状態・評価は出さない。同意の文言", async () => {
  const token = await sentTraining();
  const v = await viewPublic(token);
  assert.equal(v.statusCode, 200, JSON.stringify(v.body));
  assert.deepEqual([v.body.typeLabel, v.body.offerName], ["育成枠", "育成参加決定通知"]);
  assert.deepEqual(v.body.items.filter((i) => i.highlight).map((i) => i.label), ["育成コース", "開始日", "期間", "報酬"]);
  assert.equal(v.body.agreeCheck, "上記の内容を確認し、同意します");
  assert.equal(v.body.agreeButton, "同意して契約を完了する");
  assert.equal(JSON.stringify(v.body).includes("rank"), false);
  assert.ok(offerRow().viewed_at);
  assert.equal(app().status, "offer_response_pending");
});

await ok("同意のチェックが無ければ同意できない。チェックして同意 → accepted_at・版・タイムライン・「契約完了」", async () => {
  const token = await sentTraining();
  const no = await respond({ token, action: "accept" });
  assert.deepEqual([no.statusCode, no.body.error], [400, "agreement_required"]);
  assert.equal(offerRow().accepted_at ?? null, null);
  const yes = await respond({ token, action: "accept", agreed: true });
  assert.equal(yes.statusCode, 200, JSON.stringify(yes.body));
  const o = offerRow();
  assert.ok(o.accepted_at, "accepted_at");
  assert.equal(app().status, "accepted");
  assert.ok(tl().includes("本人が育成参加決定通知に同意（契約完了）"), tl().join(","));
  const log = logged.find((e) => e.action === "hr.offer_accepted");
  assert.deepEqual([log.detail.version, log.detail.agreed], [1, true], "どの版に同意したか");
  const v = await viewPublic(token);
  assert.equal(v.body.responseStatus, "accepted");
  assert.equal(v.body.doneTitle, "契約手続きが完了しました。");
  assert.equal(v.body.afterAccept, "ご同意ありがとうございます。\n次の手続きについて株式会社エイトからご案内します。");
  const d = (await getDetail("a1")).body;
  assert.equal(d.applicant.statusLabel, "契約完了");
  assert.equal(d.applicant.nextActionCta, "育成開始手続きへ進む");
  assert.ok(d.offers[0].acceptedAt && d.offers[0].version === 1);
  assert.equal((await respond({ token, action: "accept", agreed: true })).statusCode, 409, "二度は同意しない");
});

await ok("区分ごとに、契約完了後の NEXT ACTION が違う（業務委託 → 稼働開始準備）", async () => {
  setup("contractor");
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, joinDate: "2026-11-01", wageType: "月額", wageAmount: 200000,
    offerTerms: { duties: T.DUTY_TEMPLATES[0].text, renewal: "協議のうえ更新", paymentTerms: "月末締め翌月末払い", nda: "必要" } });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const id = made.body.offer.id;
  const d = (await sendDraft(id)).body;
  assert.equal(d.subject, "【株式会社エイト】業務委託契約のご案内");
  await patchOffer({ id, action: "send", subject: d.subject, body: d.body, requestKey: key() });
  const token = tokenIn(sent[0].text);
  const v = (await viewPublic(token)).body;
  const items = Object.fromEntries(v.items.map((i) => [i.label, i.value]));
  assert.equal(items.報酬, "月額 200,000円");
  assert.equal(items.支払条件, "月末締め翌月末払い");
  assert.equal((await respond({ token, action: "accept", agreed: true })).statusCode, 200);
  const a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.statusLabel, a.nextActionCta], ["契約完了", "稼働開始準備へ進む"]);
});

await ok("区分の無い、これまでの合格通知は、これまでどおり承諾できる（チェックは求めない）", async () => {
  setup(null);
  const made = await createOffer({ applicantId: "a1", respondBy: DUE, jobTitle: "エンジニア" });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const id = made.body.offer.id;
  await patchOffer({ id, action: "confirm" });
  const token = (await patchOffer({ id, action: "issueLink" })).body.token;
  await patchOffer({ id, action: "markSent" });
  const r = await respond({ token, action: "accept" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(tl().includes("本人が承諾"));
  assert.equal((await getDetail("a1")).body.applicant.statusLabel, "承諾済み");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
