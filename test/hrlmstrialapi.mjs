// 採用HR：カジュアル面談のお礼＋無限道場体験のご案内（1通）と体験状況（lib/hr-lms-client.js・lib/hr-lms-trial.js・api/hr/applicants/lms-trial.js）。
//
// ■ 何を守るテストか
//   1. LMS への呼び出しは署名つき（x-hr-timestamp・x-hr-signature、request_id は毎回新しい）。LMS からはメールを送らせない（send_mail:false）
//   2. メールは1通だけ：同じ鍵の2回目・送信済みの2回目は送らない。再送は resend:true のときだけ。失敗したら送り直せる（同じ招待）
//   3. 面談未実施・メール未登録・連携の設定なし・別の会社では送らない（LMS も呼ばない）
//   4. LMS の失敗（401・409・503・届かない・登録済み）を、それぞれ説明つきで返す。メールは送らない
//   5. 招待URLは、送信記録の本文・タイムライン・監査ログに残さない。本人へのメールには入る。期限は LMS の値から
//   6. 体験状況は LMS をその場で読む（HR に保存しない）。取れなければ「取得できません」（未完了と書かない）
//   7. 採用HRを使えない人には使えない
//   ※ 実在の応募者・実際のメール送信・本物の LMS は使わない（どれも偽物。宛先は example.jp）
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002";
const A1 = "11111111-1111-4111-8111-111111111111", A2 = "22222222-2222-4222-8222-222222222222";
const A3 = "33333333-3333-4333-8333-333333333333", B1 = "44444444-4444-4444-8444-444444444444";
const SECRET = "s".repeat(24) + "-test-secret-0123456789";
const BASE = "https://lms.example.test";

function configure() {
  process.env.MUGENDOJO_HR_LMS_SECRET = SECRET;
  process.env.MUGENDOJO_LMS_BASE_URL = `${BASE}/`;
  process.env.HR_LEAD_TENANT_ID = T1;
}
configure();

let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 12, 0, 0, tick++)).toISOString();
const mem = createMemDb({
  schema: {
    gw_hr_timeline: { defaults: () => ({ occurred_at: stamp() }) },
    gw_hr_mail_sends: {
      defaults: () => ({ created_at: stamp() }),
      unique: [["tenant_id", "request_key"]],
      required: ["tenant_id", "to_email", "subject", "body", "request_key"],
    },
  },
});
const logged = [];
const sent = [];
let mailMode = "sent";
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-hr" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
mock.module(atRoot("lib/mail/index.js"), {
  namedExports: {
    ...REAL_MAIL,
    mailConfig: () => ({ configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.jp>", replyTo: "hr@example.jp" }),
    sendMail: async (m) => {
      sent.push(m);
      const base = { provider: "resend", from: "株式会社エイト 採用 <recruit@example.jp>", replyTo: "hr@example.jp", providerMessageId: null, error: null };
      if (mailMode === "failed") return { ...base, status: "failed", error: "送信サービスが断りました（422）" };
      if (mailMode === "timeout") return { ...base, status: "failed", error: "送信サービスの応答がありませんでした（時間切れ）" };
      return { ...base, status: "sent", providerMessageId: `msg_${sent.length}` };
    },
  },
});
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

// ---- 偽の LMS（eight-its/lms docs/hr-lms-api.md の振る舞い。署名は、MF のコードを使わずに確かめる） ----
const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v ?? null)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
    : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`);
// registered … LMS のアカウントがある（notEnrolled に無ければ体験版にも参加済み）。legacy … allow_existing に対応する前の LMS
const lms = { calls: [], seen: new Set(), invites: new Map(), registered: new Set(), notEnrolled: new Set(), progress: new Map(), mode: null, tokenN: 0, legacy: false };
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const h = init.headers;
  lms.calls.push({ url, body, headers: h });
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
  if (lms.mode === "down") throw new TypeError("fetch failed");
  if (lms.mode === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (lms.mode === "lms_not_configured") return reply(503, { ok: false, error: "not_configured" });
  const mac = crypto.createHmac("sha256", lms.mode === "other_secret" ? "x".repeat(40) : SECRET).update(`${h["x-hr-timestamp"]}.${canon(body)}`).digest("hex");
  if (h["x-hr-signature"] !== `v1=${mac}`) return reply(401, { ok: false, error: "bad_signature" });
  if (!/^[A-Za-z0-9_.:-]{16,80}$/.test(body.request_id)) return reply(400, { ok: false, error: "invalid_request_id" });
  if (lms.seen.has(body.request_id)) return reply(409, { ok: false, error: "replayed_request" });
  lms.seen.add(body.request_id);
  if (lms.mode === "no_course") return reply(409, { ok: false, error: "trial_course_missing" });
  if (url.endsWith("/api/hr/lms/trial-invite")) {
    const email = body.email;
    if (body.allow_existing !== undefined && typeof body.allow_existing !== "boolean" && !lms.legacy) return reply(400, { ok: false, error: "invalid_allow_existing" });
    const existing = lms.registered.has(email);
    if (existing && (lms.legacy || body.allow_existing !== true)) return reply(200, { ok: true, result: "already_registered", email, registered: true, invite: null, mail: { sent: false } });
    if (existing && !lms.notEnrolled.has(email)) return reply(200, { ok: true, result: "already_enrolled", email, registered: true, existing: true, invite: null, mail: { sent: false } });
    let inv = lms.invites.get(email);
    let result = "reused";
    if (!inv || inv.expired) {
      inv = { url: `${BASE}/mgn/${existing ? "invite" : "register"}?invite=tok-${++lms.tokenN}-SECRETTOKEN`, expires_at: "2026-10-19T05:05:00.000Z", expired: false };
      lms.invites.set(email, inv); result = "issued";
    }
    if (existing) inv = { ...inv, url: inv.url.replace("/mgn/register?", "/mgn/invite?") };   // LMS は既存アカウントには参加用URL（acceptLink）で返す
    return reply(200, { ok: true, result, email, registered: existing, ...(existing ? { existing: true } : {}),
      invite: { url: inv.url, status: "invited", created_at: "2026-10-12T05:05:00.000Z", expires_at: inv.expires_at },
      mail: { sent: body.send_mail !== false } });
  }
  if (url.endsWith("/api/hr/lms/trial-status")) {
    return reply(200, { ok: true, trial_course: { id: "c1", title: "無限道場 体験版" },
      items: body.emails.map((email) => ({ email, invited: lms.invites.has(email), invite_status: lms.invites.get(email)?.expired ? "expired" : "invited",
        registered: lms.registered.has(email), enrolled: lms.registered.has(email) && !lms.notEnrolled.has(email), started: false, completed: false,
        progress_percent: 0, lessons_done: 0, lessons_total: 6, mvv_answered: false, ai_tried: false, challenge_submitted: false,
        output_submitted: false, reflection_submitted: false, last_activity_at: null, ...(lms.progress.get(email) || {}) })),
      invalid_emails: [] });
  }
  return reply(404, { ok: false, error: "not_found" });
};

const HR = { tenantId: T1, isAdmin: false, roles: ["hr"], apps: ["hr"], employee: { id: "e-hr", display_name: "人事 花子" } };
const SALES = { tenantId: T1, isAdmin: false, roles: ["sales"], apps: [], employee: { id: "e-s" } };
const OTHER = { tenantId: T2, isAdmin: false, roles: ["hr"], apps: ["hr"], employee: { id: "e-o", display_name: "他社 人事" } };

const { default: api } = await import(atRoot("api/hr/applicants/lms-trial.js"));
const { default: mailApi } = await import(atRoot("api/hr/applicants/mail.js"));
const L = await import(atRoot("lib/hr-lms-trial.js"));
const C = await import(atRoot("lib/hr-lms-client.js"));

const res = () => { const r = { statusCode: 0, headers: {} }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const call = async (req) => { const r = res(); await api({ headers: {}, ...req }, r); return r; };
const get = (id) => call({ method: "GET", url: `/api/hr/applicants/lms-trial?id=${id}` });
let keyN = 0;
const key = () => `lmskey-${String(++keyN).padStart(4, "0")}`;
const send = async (id, extra = {}) => {
  const d = (await get(id)).body.draft || L.trialDraft({ name: "x" });
  return call({ method: "POST", url: "/api/hr/applicants/lms-trial", body: { id, action: "send", subject: d.subject, body: d.body, requestKey: key(), ...extra } });
};
const inviteCalls = () => lms.calls.filter((c) => c.url.endsWith("/trial-invite"));
const trialSends = () => mem.rows.gw_hr_mail_sends.filter((s) => s.template_name === L.LMS_TRIAL_MAIL_NAME);
const everythingStored = () => JSON.stringify({ sends: mem.rows.gw_hr_mail_sends, tl: mem.rows.gw_hr_timeline, logged });

function setup() {
  mem.reset(); logged.length = 0; sent.length = 0; mailMode = "sent"; who = HR; configure();
  Object.assign(lms, { calls: [], seen: new Set(), invites: new Map(), registered: new Set(), notEnrolled: new Set(), progress: new Map(), mode: null, tokenN: 0, legacy: false });
  mem.rows.gw_hr_applicants = [
    { id: A1, tenant_id: T1, name: "山田 太郎", email: "Taro@Example.jp" },
    { id: A2, tenant_id: T1, name: "佐藤 花子", email: "hanako@example.jp" },
    { id: A3, tenant_id: T1, name: "メール 無し", email: null },
    { id: B1, tenant_id: T2, name: "別 会社", email: "b@example.jp" },
  ];
  mem.rows.gw_hr_interviews = [
    { id: "iv1", tenant_id: T1, applicant_id: A1, kind: "casual", conducted_at: "2026-10-12T04:00:00Z", canceled_at: null },
    { id: "iv2", tenant_id: T1, applicant_id: A2, kind: "casual", conducted_at: null, canceled_at: null },
    { id: "iv3", tenant_id: T1, applicant_id: A3, kind: "casual", conducted_at: "2026-10-12T04:00:00Z", canceled_at: null },
    { id: "iv4", tenant_id: T2, applicant_id: B1, kind: "casual", conducted_at: "2026-10-12T04:00:00Z", canceled_at: null },
  ];
  mem.rows.gw_hr_timeline = [];
  mem.rows.gw_hr_mail_sends = [];
  mem.rows.gw_hr_mail_templates = [];
  mem.rows.tenants = [{ id: T1, name: "株式会社エイト" }];
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== 文面・状態（lib） ===\n");

await ok("標準の文面：件名・氏名・URL と期限の差し込み位置（日数を決め打ちしない）", async () => {
  const d = L.trialDraft({ name: "山田 太郎" });
  assert.equal(d.subject, "【株式会社エイト】本日の面談のお礼と無限道場体験のご案内");
  assert.match(d.body, /^山田 太郎 様\n/);
  assert.equal(d.body.split(L.TRIAL_URL_TAG).length, 2);
  assert.ok(d.body.includes(L.TRIAL_EXPIRY_TAG));
  assert.ok(d.body.includes("体験や継続受講の申し込みは、採用・契約の成立を意味しません。"));
  assert.ok(!/\d+日(間|以内)/.test(d.body), "有効期限の日数を書かない");
  assert.deepEqual(L.trialDraft({ name: "" }).missing.map((m) => m.key), ["応募者名"]);
});

await ok("差し込み：送る本文には URL・期限（日本時間）、記録の本文は URL を伏せる", async () => {
  const d = L.trialDraft({ name: "山田 太郎" });
  const m = L.fillTrialMail({ ...d, name: "山田 太郎", url: "https://lms.example.test/mgn/register?invite=abc", expiresAt: "2026-10-19T05:05:00.000Z" });
  assert.ok(m.text.includes("https://lms.example.test/mgn/register?invite=abc"));
  assert.ok(m.text.includes("2026年10月19日（月）14:05まで"));
  assert.ok(!m.recordBody.includes("invite=abc"));
  assert.ok(m.recordBody.includes("記録には残していません"));
  assert.equal(L.formatExpiry("bad"), null);
});

await ok("URL の差し込み位置が無い・2つある・件名にある → 送らない理由", async () => {
  assert.match(L.trialMailProblems({ subject: "s", body: "本文" })[0], /無限道場体験URL/);
  assert.match(L.trialMailProblems({ subject: "s", body: `${L.TRIAL_URL_TAG}\n${L.TRIAL_URL_TAG}` })[0], /1つだけ/);
  assert.match(L.trialMailProblems({ subject: `件名 ${L.TRIAL_URL_TAG}`, body: L.TRIAL_URL_TAG })[0], /件名/);
  assert.deepEqual(L.trialMailProblems(L.trialDraft({ name: "a" })), []);
});

await ok("体験の段階：未招待／招待済み／期限切れ／登録済み／体験中／完了。6条件をそのまま出す", async () => {
  assert.equal(L.trialStage(null).key, "none");
  assert.equal(L.trialStage({ invited: true, invite_status: "invited" }).label, "招待済み");
  assert.equal(L.trialStage({ invited: true, invite_status: "expired" }).key, "expired");
  assert.equal(L.trialStage({ invited: true, registered: true }).key, "registered");
  assert.equal(L.trialStage({ invited: true, registered: true, enrolled: true }).key, "registered");
  assert.equal(L.trialStage({ registered: true, enrolled: false }).key, "account", "アカウントあり・体験版は未参加");
  assert.equal(L.trialStage({ registered: true, enrolled: false, invited: true, invite_status: "expired" }).key, "account");
  assert.equal(L.trialStage({ registered: true, enrolled: false, invited: true, invite_status: "invited" }).key, "account_invited");
  assert.equal(L.shapeTrialStatus({ registered: true, enrolled: false }).existing, true);
  assert.equal(L.shapeTrialStatus({ registered: true, enrolled: true }).existing, false);
  assert.equal(L.trialStage({ registered: true, started: true }).key, "active");
  assert.equal(L.trialStage({ registered: true, started: true, completed: true }).label, "体験完了");
  const s = L.shapeTrialStatus({ registered: true, started: true, progress_percent: 60, lessons_done: 4, lessons_total: 6, mvv_answered: true, ai_tried: true });
  assert.equal(s.progress.percent, 60);
  assert.deepEqual(s.conditions.map((c) => [c.key, c.done]), [["lessons", false], ["mvv", true], ["ai", true], ["challenge", false], ["output", false], ["reflection", false]]);
  assert.equal(s.conditions[0].detail, "4/6");
});

await ok("連携の設定：秘密が短い・URL が https でない → 未設定（値は返さない）", async () => {
  assert.deepEqual(C.lmsConfig({ MUGENDOJO_HR_LMS_SECRET: "short", MUGENDOJO_LMS_BASE_URL: BASE }).missing, ["MUGENDOJO_HR_LMS_SECRET"]);
  assert.deepEqual(C.lmsConfig({ MUGENDOJO_HR_LMS_SECRET: SECRET, MUGENDOJO_LMS_BASE_URL: "http://lms.example.test" }).missing, ["MUGENDOJO_LMS_BASE_URL"]);
  assert.equal(C.lmsConfig({ MUGENDOJO_HR_LMS_SECRET: SECRET, MUGENDOJO_LMS_BASE_URL: "http://127.0.0.1:3100/" }).baseUrl, "http://127.0.0.1:3100");
  const r = await C.callLms("/x", {}, { env: {} });
  assert.equal(r.error, "not_configured");
});

console.log("\n=== 送る（API） ===\n");

await ok("面談実施済み → LMS で招待（署名・send_mail:false）→ お礼1通。URL は本人のメールにだけ入る", async () => {
  setup();
  const r = await send(A1);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "sent");
  assert.equal(r.body.invite.result, "issued");
  assert.equal(r.body.invite.expiresAt, "2026-10-19T05:05:00.000Z");
  assert.equal(r.body.url, undefined, "画面に URL を返さない");
  const inv = inviteCalls();
  assert.equal(inv.length, 1);
  assert.equal(inv[0].url, `${BASE}/api/hr/lms/trial-invite`);
  assert.equal(inv[0].body.send_mail, false, "LMS からはメールを送らせない");
  assert.equal(inv[0].body.email, "taro@example.jp", "小文字で問い合わせる");
  assert.match(inv[0].body.request_id, /^hr-[0-9a-f-]{36}$/);
  assert.match(inv[0].headers["x-hr-timestamp"], /^\d{10}$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "Taro@Example.jp");
  assert.ok(sent[0].text.includes("invite=tok-1-SECRETTOKEN"));
  assert.ok(sent[0].text.includes("2026年10月19日（月）14:05まで"));
  assert.ok(!/\{\{/.test(sent[0].text + sent[0].subject));
  assert.equal(trialSends().length, 1);
  assert.equal(trialSends()[0].status, "sent");
  assert.equal(trialSends()[0].template_id, null);
  assert.ok(!everythingStored().includes("SECRETTOKEN"), "送信記録・タイムライン・監査ログに URL を残さない");
  assert.ok(!everythingStored().includes(SECRET));
  assert.equal(mem.rows.gw_hr_timeline.length, 1);
  assert.match(mem.rows.gw_hr_timeline[0].label, /お礼＋無限道場体験のご案内/);
  const log = logged.find((e) => e.action === "hr.lms_trial_mail");
  assert.equal(log.detail.status, "sent");
  assert.ok(!JSON.stringify(log).includes("example.jp"), "監査ログに宛先を残さない");
});

await ok("送信記録は、これまでの［メールを送る］の履歴にも出る（本文の URL は伏せたまま）", async () => {
  mem.rows.gw_employees = [];
  const m = res();
  await mailApi({ headers: {}, method: "GET", url: `/api/hr/applicants/mail?id=${A1}` }, m);
  assert.equal(m.statusCode, 200, JSON.stringify(m.body));
  const s = m.body.sends.find((x) => x.templateName === L.LMS_TRIAL_MAIL_NAME);
  assert.ok(s, "履歴にある");
  assert.ok(!s.body.includes("SECRETTOKEN"));
});

await ok("同じ鍵の2回目（二度押し）→ 送らずに1回目の結果。LMS も呼ばない", async () => {
  setup();
  const d = (await get(A1)).body.draft;
  const body = { id: A1, action: "send", subject: d.subject, body: d.body, requestKey: "same-key-0001" };
  const r1 = await call({ method: "POST", url: "/x", body });
  const r2 = await call({ method: "POST", url: "/x", body });
  assert.equal(r1.body.status, "sent");
  assert.equal(r2.body.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(inviteCalls().length, 1);
});

await ok("送信済みにもう一度（別の鍵）→ 409 already_sent。メールも招待も増えない", async () => {
  setup();
  await send(A1);
  const r = await send(A1);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_sent");
  assert.match(r.body.hint, /再送する/);
  assert.equal(sent.length, 1);
  assert.equal(inviteCalls().length, 1);
});

await ok("再送（resend:true）→ 同じ招待URLでもう1通（招待は増えない）。履歴に（再送）", async () => {
  setup();
  await send(A1);
  const r = await send(A1, { resend: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.invite.result, "reused");
  assert.equal(sent.length, 2);
  assert.ok(sent[1].text.includes("invite=tok-1-"), "同じ URL");
  assert.equal(lms.invites.size, 1);
  assert.match(mem.rows.gw_hr_timeline.at(-1).label, /（再送）/);
});

await ok("期限切れのあとに再送 → 新しい招待URLで送る", async () => {
  setup();
  await send(A1);
  lms.invites.get("taro@example.jp").expired = true;
  const st = await get(A1);
  assert.equal(st.body.lms.stage.key, "expired");
  const r = await send(A1, { resend: true });
  assert.equal(r.body.invite.result, "issued");
  assert.ok(sent[1].text.includes("invite=tok-2-"));
});

await ok("メールが送れなかった（failed）→ 502。もう一度送れる（同じ招待）", async () => {
  setup();
  mailMode = "failed";
  const r1 = await send(A1);
  assert.equal(r1.statusCode, 502);
  assert.match(r1.body.hint, /同じ招待URL/);
  mailMode = "sent";
  const r2 = await send(A1);
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.invite.result, "reused");
  assert.equal(lms.invites.size, 1);
});

await ok("結果不明（時間切れ）→ 202。再送しないと送れない（届いたか確かめてもらう）", async () => {
  setup();
  mailMode = "timeout";
  const r1 = await send(A1);
  assert.equal(r1.statusCode, 202);
  mailMode = "sent";
  const r2 = await send(A1);
  assert.equal(r2.statusCode, 409);
  assert.match(r2.body.hint, /届いたかどうか分かりません/);
});

await ok("カジュアル面談が未実施（キャンセル済みも）→ 409。LMS を呼ばない", async () => {
  setup();
  const r = await send(A2);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "interview_not_done");
  mem.rows.gw_hr_interviews[0].canceled_at = "2026-10-12T05:00:00Z";
  assert.equal((await send(A1)).body.error, "interview_not_done");
  assert.equal(inviteCalls().length, 0);
  assert.equal(sent.length, 0);
});

await ok("メールアドレス未登録 → 400 no_email。LMS を呼ばない", async () => {
  setup();
  const r = await send(A3);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_email");
  assert.equal(lms.calls.length, 0);
});

await ok("本文に URL の差し込み位置が無い → 400（LMS に招待を作らせない）", async () => {
  setup();
  const r = await call({ method: "POST", url: "/x", body: { id: A1, action: "send", subject: "件名", body: "URL なし", requestKey: key() } });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.hint, /無限道場体験URL/);
  const r2 = await call({ method: "POST", url: "/x", body: { id: A1, action: "send", subject: "件名", body: `${L.TRIAL_URL_TAG} {{知らない項目}}`, requestKey: key() } });
  assert.equal(r2.statusCode, 400);
  assert.match(r2.body.hint, /差し込まれていない/);
  assert.equal(lms.calls.length, 0);
});

await ok("LMS 登録済み・体験版に参加済み → 409 lms_already_enrolled（招待もメールも作らない）", async () => {
  setup();
  lms.registered.add("taro@example.jp");
  const r = await send(A1);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "lms_already_enrolled");
  assert.match(r.body.hint, /参加しています/);
  assert.equal(inviteCalls()[0].body.allow_existing, true, "既存アカウントへの案内を頼む");
  assert.equal(lms.invites.size, 0);
  assert.equal(sent.length, 0);
  assert.equal(trialSends().length, 0);
});

await ok("LMS 登録済み・体験版は未参加 → 「ログインして参加」の文面と参加用URLで1通（新しい登録を促さない）", async () => {
  setup();
  lms.registered.add("taro@example.jp"); lms.notEnrolled.add("taro@example.jp");
  const g = await get(A1);
  assert.equal(g.body.lms.stage.key, "account");
  assert.equal(g.body.lms.existing, true);
  assert.equal(g.body.draft.existing, true);
  assert.match(g.body.draft.body, /ログインし、［このコースに参加する］/);
  assert.match(g.body.draft.body, /新しいアカウントの登録は不要/);
  assert.match(g.body.draft.body, /学習の記録はそのまま/);
  assert.ok(!g.body.draft.body.includes("個別登録URL"));
  const r = await send(A1, { variant: "existing" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.invite.existing, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("/mgn/invite?invite=tok-1-SECRETTOKEN"), "参加用URL（登録画面ではない）");
  assert.ok(!sent[0].text.includes("/mgn/register"));
  assert.ok(!everythingStored().includes("SECRETTOKEN"));
  assert.equal(logged.find((e) => e.action === "hr.lms_trial_mail").detail.existing, true);
  // 送ったあと：参加の案内済み。もう一度（別の鍵）は already_sent、再送は同じ参加用URL（招待は増えない）
  assert.equal((await get(A1)).body.lms.stage.key, "account_invited");
  assert.equal((await send(A1, { variant: "existing" })).body.error, "already_sent");
  const rs = await send(A1, { variant: "existing", resend: true });
  assert.equal(rs.statusCode, 200);
  assert.equal(lms.invites.size, 1);
  assert.ok(sent[1].text.includes("tok-1-SECRETTOKEN"));
  // 本人が参加したら、もう案内しない
  lms.notEnrolled.delete("taro@example.jp");
  assert.equal((await send(A1, { variant: "existing", resend: true })).body.error, "lms_already_enrolled");
  assert.equal(sent.length, 2);
});

await ok("文面の版と LMS の答えが食い違う → 409 lms_variant_changed（送らない）。開き直すと正しい版", async () => {
  setup();
  const g = await get(A1);                                 // まだアカウントなし → 登録URLの文面
  assert.equal(g.body.draft.existing, false);
  lms.registered.add("taro@example.jp"); lms.notEnrolled.add("taro@example.jp");   // 画面を開いている間に本人が登録
  const r = await call({ method: "POST", url: "/x", body: { id: A1, action: "send", subject: g.body.draft.subject, body: g.body.draft.body, requestKey: key(), variant: "new" } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "lms_variant_changed");
  assert.equal(r.body.existing, true);
  assert.equal(sent.length, 0);
  assert.equal(trialSends().length, 0);
  assert.equal((await get(A1)).body.draft.existing, true);
  const ok2 = await send(A1, { variant: "existing" });
  assert.equal(ok2.statusCode, 200);
  assert.equal(lms.invites.size, 1, "招待は使い回す（増えない）");
  // 逆向き（参加用の文面なのに、アカウントが無い）も送らない
  setup();
  const r2 = await call({ method: "POST", url: "/x", body: { id: A1, action: "send", subject: "件名", body: L.trialDraft({ name: "山田 太郎" }, { existing: true }).body, requestKey: key(), variant: "existing" } });
  assert.equal(r2.body.error, "lms_variant_changed");
  assert.equal(sent.length, 0);
});

await ok("既存アカウントへの案内に対応する前の LMS → 409 lms_already_registered（重複登録を促さない）。メールは送らない", async () => {
  setup();
  lms.legacy = true;
  lms.registered.add("taro@example.jp"); lms.notEnrolled.add("taro@example.jp");
  const r = await send(A1);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "lms_already_registered");
  assert.match(r.body.hint, /ログインして/);
  assert.equal(sent.length, 0);
  assert.equal(trialSends().length, 0);
});

await ok("URL を手で渡す（link）：既存アカウントには参加用URL（existing:true）", async () => {
  setup();
  lms.registered.add("taro@example.jp"); lms.notEnrolled.add("taro@example.jp");
  const r = await call({ method: "POST", url: "/x", body: { id: A1, action: "link" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.existing, true);
  assert.match(r.body.url, /\/mgn\/invite\?invite=tok-1-/);
  assert.equal(logged.at(-1).detail.existing, true);
  assert.ok(!everythingStored().includes("SECRETTOKEN"));
});

await ok("LMS の失敗：署名不一致 401 / LMS の設定なし 503 / 体験版なし 409 / 届かない・時間切れ → 説明つき。メールは送らない", async () => {
  const cases = [
    ["other_secret", 502, /MUGENDOJO_HR_LMS_SECRET が同じか/],
    ["lms_not_configured", 503, /無限道場の側に連携の設定/],
    ["no_course", 502, /体験版のコースがありません/],
    ["down", 503, /接続できませんでした/],
    ["timeout", 503, /時間切れ/],
  ];
  for (const [mode, code, re] of cases) {
    setup();
    lms.mode = mode;
    const r = await send(A1);
    assert.equal(r.statusCode, code, `${mode}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "lms_error");
    assert.match(r.body.hint, re, mode);
    assert.equal(sent.length, 0, mode);
    assert.equal(trialSends().length, 0, mode);
    assert.equal(logged.at(-1).detail.status, "lms_error");
  }
});

await ok("MF に連携の設定が無い → 503 not_configured（どの環境変数か）。LMS を呼ばない", async () => {
  setup();
  delete process.env.MUGENDOJO_HR_LMS_SECRET;
  const r = await send(A1);
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.body.missing, ["MUGENDOJO_HR_LMS_SECRET"]);
  const g = await get(A1);
  assert.equal(g.body.configured, false);
  assert.equal(g.body.lms.ok, false);
  assert.match(g.body.lms.hint, /MUGENDOJO_HR_LMS_SECRET/);
  assert.equal(lms.calls.length, 0);
  configure();
  delete process.env.HR_LEAD_TENANT_ID;
  assert.deepEqual((await send(A1)).body.missing, ["HR_LEAD_TENANT_ID"]);
});

await ok("無限道場を運営していない会社 → 出さない（available:false）・送れない（403）", async () => {
  setup();
  who = OTHER;
  const g = await get(B1);
  assert.equal(g.statusCode, 200);
  assert.equal(g.body.available, false);
  assert.equal(g.body.applicant, undefined);
  const r = await send(B1);
  assert.equal(r.statusCode, 403);
  assert.equal(lms.calls.length, 0);
});

await ok("別の会社の応募者 ID → 404。採用HRを使えない人 → 403", async () => {
  setup();
  assert.equal((await get(B1)).statusCode, 404);
  assert.equal((await send(B1)).statusCode, 404);
  who = SALES;
  assert.equal((await get(A1)).statusCode, 403);
  assert.equal((await send(A1)).statusCode, 403);
  assert.equal(lms.calls.length, 0);
});

await ok("URL を手で渡す（link）→ URL を返すが、どこにも残さない。面談前は出さない", async () => {
  setup();
  const r = await call({ method: "POST", url: "/x", body: { id: A1, action: "link" } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body.url, /invite=tok-1-/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(!everythingStored().includes("SECRETTOKEN"));
  assert.equal(logged.at(-1).action, "hr.lms_trial_link");
  assert.equal(sent.length, 0, "メールは送らない");
  assert.equal((await call({ method: "POST", url: "/x", body: { id: A2, action: "link" } })).body.error, "interview_not_done");
});

console.log("\n=== 体験状況（API） ===\n");

await ok("GET：下書き・面談の実施・LMS の状況（その場で読む。HR に保存しない）", async () => {
  setup();
  const g0 = await get(A1);
  assert.equal(g0.statusCode, 200);
  assert.equal(g0.body.available, true);
  assert.equal(g0.body.interviewDone, true);
  assert.equal(g0.body.lms.stage.key, "none");
  assert.match(g0.body.draft.body, /^山田 太郎 様/);
  await send(A1);
  lms.registered.add("taro@example.jp");
  lms.progress.set("taro@example.jp", { started: true, progress_percent: 50, lessons_done: 3, mvv_answered: true, last_activity_at: "2026-10-12T06:00:00Z" });
  const before = JSON.stringify(mem.rows);
  const g = await get(A1);
  assert.equal(g.body.lms.ok, true);
  assert.equal(g.body.lms.stage.label, "体験中");
  assert.equal(g.body.lms.progress.percent, 50);
  assert.equal(g.body.lms.conditions.find((c) => c.key === "mvv").done, true);
  assert.equal(g.body.lms.course, "無限道場 体験版");
  assert.equal(g.body.sends.length, 1);
  assert.equal(JSON.stringify(mem.rows), before, "体験状況を HR の表に書かない");
  const st = lms.calls.filter((c) => c.url.endsWith("/trial-status")).at(-1);
  assert.deepEqual(st.body.emails, ["taro@example.jp"]);
  lms.progress.set("taro@example.jp", { started: true, completed: true, progress_percent: 100 });
  assert.equal((await get(A1)).body.lms.stage.key, "done");
});

await ok("GET：LMS が落ちている → lms.ok:false・「接続できません」（未完了と書かない）。ほかは出る", async () => {
  setup();
  lms.mode = "down";
  const g = await get(A1);
  assert.equal(g.statusCode, 200);
  assert.equal(g.body.lms.ok, false);
  assert.equal(g.body.lms.stage, undefined);
  assert.match(g.body.lms.hint, /接続できませんでした/);
  assert.ok(g.body.draft.subject);
});

await ok("request_id は呼び出しごとに新しい（LMS の replay 防止に掛からない）", async () => {
  setup();
  await get(A1); await get(A1); await send(A1); await send(A1, { resend: true });
  const ids = lms.calls.map((c) => c.body.request_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!lms.calls.some((c) => c.headers["x-hr-signature"] === undefined));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
