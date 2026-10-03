// 採用判断のあと本人へ伝える：/api/hr/applicants/message（文面の下書き・メール送信・送付済みの記録）。
//
// ■ 何を守るテストか
//   1. 内定・保留・見送りの文面が出る（氏名・会社名・送る人・再判断期限）。社内の評価・所感・条件は入れない
//   2. メールの設定があれば送る。無ければ送らずに理由を返す（画面はコピー・メールソフトへ）
//   3. 送った／送付済みにしたことを選考タイムラインに残す。監査ログに本文・宛先は残さない
//   4. 採用HRを使えない人・別の会社の応募者には使えない
//   5. 採用の連絡の送信元は HR_RECRUITING_FROM、無ければ HR_ONBOARDING_FROM
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002";

const mem = createMemDb({ schema: { gw_hr_timeline: { defaults: () => ({ occurred_at: new Date().toISOString() }) } } });
const logged = [];
const sent = [];
let mailMode = "sent";
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-ceo" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
mock.module(atRoot("lib/mail/index.js"), {
  namedExports: {
    ...REAL_MAIL,
    mailConfig: () => (mailMode === "skipped" ? { configured: false, reason: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています" } : { configured: true, reason: null }),
    sendMail: async (m) => {
      sent.push(m);
      if (mailMode === "skipped") return { status: "skipped", error: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています" };
      if (mailMode === "failed") return { status: "failed", error: "Resend 500" };
      return { status: "sent", providerMessageId: "msg_1" };
    },
  },
});
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const CEO = { tenantId: T1, isAdmin: false, roles: ["owner"], employee: { id: "e-ceo", display_name: "森田 社長" } };
const SALES = { tenantId: T1, isAdmin: false, roles: ["sales"], employee: { id: "e-s" } };

const { default: api } = await import(atRoot("api/hr/applicants/message.js"));
const { decisionMessage } = await import(atRoot("lib/hr-messages.js"));

const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const call = async (req) => { const r = res(); await api({ headers: {}, ...req }, r); return r; };
const get = (id, kind) => call({ method: "GET", url: `/api/hr/applicants/message?id=${id}&kind=${kind}` });
const post = (body) => call({ method: "POST", url: "/api/hr/applicants/message", body });

function setup() {
  mem.reset(); logged.length = 0; sent.length = 0; mailMode = "sent"; who = CEO;
  mem.rows.tenants = [{ id: T1, name: "株式会社エイト" }];
  mem.rows.gw_hr_applicants = [
    { id: "a1", tenant_id: T1, name: "山田 太郎", email: "taro@example.jp", job_title: "エンジニア",
      decision: "hold", decision_due_on: "2026-10-20", rank: "A", note: "社内メモ：年収希望が高い" },
    { id: "a2", tenant_id: T1, name: "メール 無し", email: null, job_title: "営業" },
    { id: "b1", tenant_id: T2, name: "別 会社", email: "b@example.jp" },
  ];
  mem.rows.gw_hr_timeline = [];
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== 文面 ===\n");

await ok("内定・保留・見送りの文面（氏名・会社名・送る人）。内定は条件を書かず合格通知へ", async () => {
  setup();
  const h = await get("a1", "hired");
  assert.equal(h.statusCode, 200, JSON.stringify(h.body));
  assert.equal(h.body.to, "taro@example.jp");
  assert.match(h.body.subject, /株式会社エイト.*内定/);
  assert.match(h.body.body, /^山田 太郎 様/);
  assert.match(h.body.body, /合格通知/);
  assert.match(h.body.body, /採用担当　森田 社長/);
  assert.ok(!/給与|年収|円/.test(h.body.body), "条件・金額は書かない");
  assert.equal(h.body.mail.configured, true);
  const r = await get("a1", "rejected");
  assert.match(r.body.body, /ご期待に沿えない/);
});

await ok("保留の文面は再判断期限（10月20日）までに連絡すると書く", async () => {
  setup();
  const r = await get("a1", "hold");
  assert.match(r.body.body, /10月20日までに/);
  assert.equal(decisionMessage("hold", { name: "x" }).body.includes("あらためて"), true, "期限が無ければ「あらためて」");
});

await ok("社内の評価・ランク・メモは文面に入らない", async () => {
  setup();
  for (const k of ["hired", "hold", "rejected"]) {
    const r = await get("a1", k);
    assert.ok(!/ランク|年収希望|社内メモ/.test(r.body.body + r.body.subject), k);
  }
});

await ok("メールアドレスが無ければ「メールで送る」は出せない（理由つき）", async () => {
  setup();
  const r = await get("a2", "rejected");
  assert.equal(r.body.mail.configured, false);
  assert.match(r.body.mail.reason, /メールアドレス/);
});

await ok("知らない種類・id なしは 400、別の会社の応募者は 404", async () => {
  setup();
  assert.equal((await get("a1", "xx")).statusCode, 400);
  assert.equal((await call({ method: "GET", url: "/api/hr/applicants/message?kind=hold" })).statusCode, 400);
  assert.equal((await get("b1", "hold")).statusCode, 404);
});

console.log("\n=== 送る・記録する ===\n");

await ok("メールで送る：宛先は本人、送信元の用途は recruiting。タイムラインに件名つきで残す", async () => {
  setup();
  const r = await post({ id: "a1", kind: "rejected", channel: "email", subject: "【株式会社エイト】選考結果のご連絡", body: "本文です" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "taro@example.jp");
  assert.equal(sent[0].purpose, "recruiting");
  const t = mem.rows.gw_hr_timeline.at(-1);
  assert.equal(t.event_key, "message_rejected");
  assert.match(t.label, /本人へ連絡：選考結果のご連絡（メール送信）/);
  assert.equal(t.detail, "【株式会社エイト】選考結果のご連絡");
});

await ok("監査ログに本文・宛先を残さない", async () => {
  setup();
  await post({ id: "a1", kind: "hired", channel: "email", subject: "件名", body: "ひみつの本文" });
  const s = JSON.stringify(logged);
  assert.equal(logged.at(-1).action, "hr.applicant_message");
  assert.ok(!s.includes("ひみつの本文") && !s.includes("taro@example.jp"));
});

await ok("メールの設定が無ければ 409（送らない・記録しない）。理由を返す", async () => {
  setup();
  mailMode = "skipped";
  const r = await post({ id: "a1", kind: "hold", channel: "email", subject: "件名", body: "本文" });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /文面をコピー/);
  assert.equal(mem.rows.gw_hr_timeline.length, 0);
});

await ok("送信に失敗したら 502（タイムラインに「送った」と残さない）", async () => {
  setup();
  mailMode = "failed";
  const r = await post({ id: "a1", kind: "hold", channel: "email", subject: "件名", body: "本文" });
  assert.equal(r.statusCode, 502);
  assert.equal(mem.rows.gw_hr_timeline.length, 0);
  assert.equal(logged.at(-1).detail.status, "failed");
});

await ok("送付済みにする（自分で送った）：メールは送らず、タイムラインに記録だけ", async () => {
  setup();
  const r = await post({ id: "a2", kind: "rejected", channel: "manual", subject: "件名", body: "本文" });
  assert.equal(r.statusCode, 200);
  assert.equal(sent.length, 0);
  assert.match(mem.rows.gw_hr_timeline.at(-1).label, /送付済みとして記録/);
});

await ok("メールアドレスが無い人へメールでは送れない（400）", async () => {
  setup();
  const r = await post({ id: "a2", kind: "rejected", channel: "email", subject: "件名", body: "本文" });
  assert.equal(r.statusCode, 400);
  assert.equal(sent.length, 0);
});

await ok("件名に改行・空の本文・知らない送り方は 400", async () => {
  setup();
  for (const b of [{ subject: "a\nBcc: x@y.z", body: "x", channel: "email" }, { subject: "a", body: "  ", channel: "email" },
    { subject: "a", body: "x", channel: "fax" }]) {
    const r = await post({ id: "a1", kind: "hold", ...b });
    assert.equal(r.statusCode, 400, JSON.stringify(b));
  }
  assert.equal(sent.length, 0);
});

await ok("採用HRを使えない人は 403。別の会社の応募者には送れない（404）", async () => {
  setup();
  who = SALES;
  assert.equal((await get("a1", "hold")).statusCode, 403);
  who = CEO;
  const r = await post({ id: "b1", kind: "hold", channel: "manual", subject: "件名", body: "本文" });
  assert.equal(r.statusCode, 404);
});

console.log("\n=== 送信元 ===\n");

await ok("採用の連絡の送信元は HR_RECRUITING_FROM、無ければ HR_ONBOARDING_FROM", async () => {
  const base = { MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", MAIL_SEND_ENABLED: "1" };
  assert.equal(REAL_MAIL.mailConfig("recruiting", { ...base, HR_ONBOARDING_FROM: "人事 <hr@example.jp>" }).fromAddress, "hr@example.jp");
  assert.equal(REAL_MAIL.mailConfig("recruiting", { ...base, HR_ONBOARDING_FROM: "人事 <hr@example.jp>",
    HR_RECRUITING_FROM: "採用 <recruit@example.jp>" }).fromAddress, "recruit@example.jp");
  assert.equal(REAL_MAIL.mailConfig("onboarding", { ...base, HR_RECRUITING_FROM: "採用 <recruit@example.jp>" }).configured, false,
    "入社案内の送信元は、採用の送信元で代わりにしない");
});

console.log("\n=== 本人への連絡状況（タイムラインから決める・DB の列は増やさない） ===\n");

const { contactStatusOf, CONTACT_EVENT_KEYS } = await import(atRoot("lib/hr-messages.js"));
const ev = (key, at) => ({ event_key: key, occurred_at: `2026-10-0${at}T00:00:00+00:00` });

await ok("判断していなければ none（バッジを出さない）", async () => {
  assert.equal(contactStatusOf(null, [ev("message_hold", 1)]).state, "none");
});

await ok("判断のあとに同じ種類の連絡があれば連絡済み、無ければ未連絡", async () => {
  assert.equal(contactStatusOf("rejected", [ev("decision_rejected", 1)]).state, "pending");
  const done = contactStatusOf("rejected", [ev("decision_rejected", 1), ev("message_rejected", 2)]);
  assert.equal(done.state, "done"); assert.equal(done.via, "message");
});

await ok("保留を連絡したあと内定に変えたら、内定は未連絡に戻る", async () => {
  assert.equal(contactStatusOf("hired", [ev("decision_hold", 1), ev("message_hold", 2), ev("decision_hired", 3)]).state, "pending");
});

await ok("判断より前の連絡は数えない（保留 → 連絡 → 内定 → 保留に戻した）", async () => {
  assert.equal(contactStatusOf("hold", [ev("decision_hold", 1), ev("message_hold", 2), ev("decision_hired", 3),
    ev("decision_hold", 4)]).state, "pending");
});

await ok("内定は、合格通知を送ったら連絡済み（via=offer）", async () => {
  const c = contactStatusOf("hired", [ev("decision_hired", 1), ev("offer_sent", 2)]);
  assert.equal(c.state, "done"); assert.equal(c.via, "offer");
  assert.equal(contactStatusOf("rejected", [ev("decision_rejected", 1), ev("offer_sent", 2)]).state, "pending", "見送りは合格通知で連絡済みにしない");
});

await ok("判断の記録が無い古いデータでも、同じ種類の連絡があれば連絡済み", async () => {
  assert.equal(contactStatusOf("hold", [ev("message_hold", 1)]).state, "done");
  assert.ok(CONTACT_EVENT_KEYS.includes("offer_sent") && CONTACT_EVENT_KEYS.length === 7);
});

await ok("CEO REVIEW：内定・見送りで未連絡の人は「判断済み・本人へ未連絡」、連絡済みは出さない。保留は社長判断待ちに連絡状況つき", async () => {
  setup();
  const { default: ceo } = await import(atRoot("api/hr/ceo-review.js"));
  const base = { tenant_id: T1, job_title: "x", source: "x" };
  mem.rows.gw_hr_applicants = [
    { ...base, id: "h1", name: "内定 未連絡", stage: "offer", status: "offer_draft_pending", decision: "hired" },
    { ...base, id: "h2", name: "内定 通知済み", stage: "offer", status: "offer_sent", decision: "hired" },
    { ...base, id: "r1", name: "見送り 未連絡", stage: "ceo_interview", status: "passed", decision: "rejected" },
    { ...base, id: "o1", name: "保留", stage: "ceo_interview", status: "ceo_decision_pending", decision: "hold" },
    { ...base, id: "p1", name: "推薦", stage: "ceo_recommend", status: "ceo_interview_pending", decision: null },
  ];
  mem.rows.gw_hr_interviews = [];
  mem.rows.gw_hr_timeline = [
    { applicant_id: "h1", tenant_id: T1, event_key: "decision_hired", occurred_at: "2026-10-01T00:00:00Z" },
    { applicant_id: "h2", tenant_id: T1, event_key: "decision_hired", occurred_at: "2026-10-01T00:00:00Z" },
    { applicant_id: "h2", tenant_id: T1, event_key: "offer_sent", occurred_at: "2026-10-02T00:00:00Z" },
    { applicant_id: "r1", tenant_id: T1, event_key: "decision_rejected", occurred_at: "2026-10-01T00:00:00Z" },
    { applicant_id: "o1", tenant_id: T1, event_key: "decision_hold", occurred_at: "2026-10-01T00:00:00Z" },
  ];
  const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); };
  await ceo({ method: "GET", headers: {}, url: "/api/hr/ceo-review" }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.contactPending.map((a) => a.id).sort(), ["h1", "r1"]);
  assert.deepEqual(r.body.decisionPending.map((a) => [a.id, a.contact.state]), [["o1", "pending"]]);
  assert.deepEqual(r.body.recommended.map((a) => a.id), ["p1"], "見送りにした人は「社長に会ってほしい人」に残らない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
