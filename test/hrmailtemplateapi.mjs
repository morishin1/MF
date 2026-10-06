// 採用HR：応募者へ送るメールのひな型と送信（db/124・lib/hr-mail-template.js・api/hr/mail-templates.js・api/hr/applicants/mail.js）。
//
// ■ 何を守るテストか
//   1. ひな型の作成・編集（版が上がる・他人の変更を上書きしない）・複製・非表示（消さない・既定も外れる）・既定
//   2. 標準のひな型はテナントに1回だけ入る。直したもの・非表示にしたものを上書きしない
//   3. 差し込みは応募者ごと（氏名・この応募者の予約URL）。予約URLは用途で選び、設定が無ければ送らせない（代用しない）
//   4. 画面で直した内容はそのメールだけ（ひな型は変わらない）。送った記録は、あとでひな型を直しても変わらない
//   5. 二重送信の防止（同じ鍵の2回目は送らない）。結果は 送信済み／失敗／結果不明 に分ける
//   6. 未置換の {{…}}・件名の改行・ほかの応募者の予約URL は送らない
//   7. 採用HRを使えない人・別の会社のひな型と応募者には使えない。監査ログに本文・宛先を残さない
//   ※ 実在の応募者・実際のメール送信は使わない（送信は偽物。宛先は example.jp）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002";
const A1 = "11111111-1111-4111-8111-111111111111", A2 = "22222222-2222-4222-8222-222222222222";
const A3 = "33333333-3333-4333-8333-333333333333", B1 = "44444444-4444-4444-8444-444444444444";

process.env.TIMEREX_CASUAL_INTERVIEW_URL = "https://timerex.example/casual";
delete process.env.TIMEREX_CEO_INTERVIEW_URL;
delete process.env.TIMEREX_MUGENDOJO_CASUAL_URL;

let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 6, 0, 0, tick++)).toISOString();
const mem = createMemDb({
  schema: {
    gw_hr_timeline: { defaults: () => ({ occurred_at: stamp() }) },
    gw_hr_mail_templates: {
      defaults: () => ({ created_at: stamp(), updated_at: stamp(), seed_key: null }),
      unique: [["tenant_id", "seed_key"]],
      required: ["tenant_id", "name", "subject", "body"],
      check: (r) => (/[\r\n]/.test(r.subject) ? "subject newline" : r.is_default && !r.is_active ? "default must be active" : null),
    },
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
    mailConfig: () => (mailMode === "skipped"
      ? { configured: false, reason: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています", from: null, replyTo: null }
      : { configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.jp>", replyTo: "hr@example.jp" }),
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

const HR = { tenantId: T1, isAdmin: false, roles: ["hr"], apps: ["hr"], employee: { id: "e-hr", display_name: "人事 花子" } };
const SALES = { tenantId: T1, isAdmin: false, roles: ["sales"], apps: [], employee: { id: "e-s" } };
const OTHER = { tenantId: T2, isAdmin: false, roles: ["hr"], apps: ["hr"], employee: { id: "e-o", display_name: "他社 人事" } };

const { default: tplApi } = await import(atRoot("api/hr/mail-templates.js"));
const { default: mailApi } = await import(atRoot("api/hr/applicants/mail.js"));
const L = await import(atRoot("lib/hr-mail-template.js"));

const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const call = async (api, req) => { const r = res(); await api({ headers: {}, ...req }, r); return r; };
const tplGet = () => call(tplApi, { method: "GET", url: "/api/hr/mail-templates" });
const tplPost = (body) => call(tplApi, { method: "POST", url: "/api/hr/mail-templates", body });
const draft = (id, templateId) => call(mailApi, { method: "GET", url: `/api/hr/applicants/mail?id=${id}${templateId ? `&templateId=${templateId}` : ""}` });
const send = (body) => call(mailApi, { method: "POST", url: "/api/hr/applicants/mail", body });
let keyN = 0;
const key = () => `testkey-${String(++keyN).padStart(4, "0")}`;

function setup() {
  mem.reset(); logged.length = 0; sent.length = 0; mailMode = "sent"; who = HR;
  mem.rows.tenants = [{ id: T1, name: "株式会社エイト" }, { id: T2, name: "別の会社" }];
  mem.rows.gw_employees = [{ id: "e-rec", tenant_id: T1, display_name: "採用 太郎" }];
  mem.rows.gw_hr_applicants = [
    { id: A1, tenant_id: T1, name: "山田 太郎", email: "taro@example.jp", job_title: "エンジニア", recruiter_id: "e-rec", lead_category: null },
    { id: A2, tenant_id: T1, name: "佐藤 花子", email: "hanako@example.jp", job_title: "デザイナー", recruiter_id: null, lead_category: null },
    { id: A3, tenant_id: T1, name: "メール 無し", email: null, job_title: "営業", recruiter_id: null, lead_category: null },
    { id: B1, tenant_id: T2, name: "別 会社", email: "b@example.jp", job_title: "営業", recruiter_id: null, lead_category: null },
  ];
  mem.rows.gw_hr_timeline = [];
  mem.rows.gw_hr_mail_templates = [];
  mem.rows.gw_hr_mail_sends = [];
}
const std = () => mem.rows.gw_hr_mail_templates.find((t) => t.tenant_id === T1 && t.seed_key === "standard_application_v1");

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== 差し込み（lib） ===\n");

await ok("応募者ごとに氏名・予約URL（この応募者の ID）が入る。様は本文側", async () => {
  const tpl = L.STANDARD_TEMPLATES[0];
  const env = { TIMEREX_CASUAL_INTERVIEW_URL: "https://timerex.example/casual" };
  const r1 = L.renderMail(tpl, L.mailValues({ applicant: { id: A1, name: "山田 太郎" }, purpose: "application", companyName: "株式会社エイト", env }));
  const r2 = L.renderMail(tpl, L.mailValues({ applicant: { id: A2, name: "佐藤 花子" }, purpose: "application", companyName: "株式会社エイト", env }));
  assert.match(r1.body, /^山田 太郎 様\n/);
  assert.match(r2.body, /^佐藤 花子 様\n/);
  assert.ok(r1.body.includes(`https://timerex.example/casual?applicant_id=${A1}`));
  assert.ok(r2.body.includes(`https://timerex.example/casual?applicant_id=${A2}`));
  assert.ok(!r1.body.includes(A2) && !r2.body.includes(A1), "ほかの人の ID が混ざらない");
  assert.match(r1.body, /\n株式会社エイト\n採用担当$/);
  assert.equal(r1.subject, "ご応募ありがとうございます／事前質問とカジュアル面談のご案内");
  assert.deepEqual(r1.missing, []);
  assert.ok(!/八尾|夏子/.test(tpl.body), "個人の名前・URLを固定しない");
});

await ok("予約URLは用途で選ぶ。設定が無ければ不足（別の予約先で代用しない）", async () => {
  const env = { TIMEREX_CASUAL_INTERVIEW_URL: "https://timerex.example/casual" };
  const ceo = L.bookingUrlFor("ceo", { id: A1 }, env);
  assert.equal(ceo.url, null);
  assert.match(ceo.reason, /TIMEREX_CEO_INTERVIEW_URL/);
  assert.equal(L.bookingUrlFor("ceo", { id: A1 }, { TIMEREX_CEO_INTERVIEW_URL: "https://t.example/ceo" }).url, `https://t.example/ceo?applicant_id=${A1}`);
  assert.equal(L.bookingUrlFor("other", { id: A1 }, env).url, null);
  const lead = L.bookingUrlFor("casual", { id: A1, lead_category: "mugendojo" }, env);
  assert.equal(lead.url, null, "無限道場のリードに、通常のカジュアル面談の予約枠を使わない");
  const r = L.renderMail({ subject: "社長面談", body: "{{応募者名}} 様\n{{面談予約URL}}" },
    L.mailValues({ applicant: { id: A1, name: "山田" }, purpose: "ceo", env }));
  assert.deepEqual(r.missing.map((m) => m.key), ["面談予約URL"]);
  assert.ok(r.body.includes("{{面談予約URL}}"), "値の無い項目は {{…}} のまま（送る前に止める）");
});

await ok("差し込みは1回だけ・件名の値の改行は取り除く・知らない {{…}} は置き換えない", async () => {
  const r = L.renderMail({ subject: "{{応募者名}} 様 {{謎}}", body: "{{応募者名}}" },
    { values: { 応募者名: "{{会社名}}\n二行目" }, reasons: {} });
  assert.equal(r.subject, "{{会社名}} 二行目 様 {{謎}}");
  assert.equal(r.body, "{{会社名}}\n二行目");
  assert.deepEqual(r.unknown, ["謎"], "会社名は知っている項目");
});

await ok("送る前の確かめ：未置換・件名の改行・ほかの応募者の予約URL", async () => {
  assert.deepEqual(L.sendProblems({ subject: "件名", body: "本文", applicantId: A1 }), []);
  assert.match(L.sendProblems({ subject: "件名", body: "{{面談予約URL}}", applicantId: A1 }).join(), /差し込まれていない/);
  assert.match(L.sendProblems({ subject: "a\nb", body: "本文", applicantId: A1 }).join(), /改行/);
  assert.match(L.sendProblems({ subject: "件名", body: `https://t.example/c?applicant_id=${A2}`, applicantId: A1 }).join(), /ほかの応募者/);
  assert.deepEqual(L.sendProblems({ subject: "件名", body: `https://t.example/c?applicant_id=${A1}`, applicantId: A1 }), []);
});

await ok("結果の分け方：受け付け／失敗／結果不明（時間切れ）／未送信", async () => {
  assert.equal(L.sendOutcome({ status: "sent" }), "sent");
  assert.equal(L.sendOutcome({ status: "failed", error: "送信サービスが断りました（422）" }), "failed");
  assert.equal(L.sendOutcome({ status: "failed", error: "送信サービスの応答がありませんでした（時間切れ）" }), "unknown");
  assert.equal(L.sendOutcome({ status: "skipped", error: "未設定" }), "not_sent");
});

console.log("\n=== ひな型の管理（API） ===\n");

await ok("標準のひな型はテナントに1回だけ入り、応募受付の既定になる", async () => {
  setup();
  const r = await tplGet();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.templates.length, 1);
  const t = r.body.templates[0];
  assert.equal(t.name, "応募受付・事前質問・面談案内");
  assert.equal(t.purposeLabel, "応募受付／カジュアル面談案内");
  assert.ok(t.isDefault && t.active && t.standard);
  await tplGet(); await draft(A1);
  assert.equal(mem.rows.gw_hr_mail_templates.length, 1, "2回目以降は入れない");
});

await ok("標準のひな型を直した・非表示にしたあとも、上書き・入れ直しをしない", async () => {
  setup();
  await tplGet();
  const t = std();
  const u = await tplPost({ action: "update", id: t.id, version: 1, name: "応募受付（自社版）", purpose: "application", subject: "件名を直した", body: "{{応募者名}} 様\n直した本文" });
  assert.equal(u.statusCode, 200, JSON.stringify(u.body));
  await tplPost({ action: "set_active", id: t.id, active: false });
  await tplGet();
  assert.equal(mem.rows.gw_hr_mail_templates.length, 1);
  assert.equal(std().subject, "件名を直した");
  assert.equal(std().is_active, false);
});

await ok("作成・編集（版が上がる）・古い版での編集は 409（上書きしない）", async () => {
  setup();
  const c = await tplPost({ action: "create", name: "社長面談のご案内", purpose: "ceo", subject: "{{会社名}} 社長面談のご案内", body: "{{応募者名}} 様\n{{面談予約URL}}" });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.template.version, 1);
  assert.equal(c.body.template.isDefault, false);
  const id = c.body.template.id;
  const u = await tplPost({ action: "update", id, version: 1, name: "社長面談のご案内", purpose: "ceo", subject: "社長面談", body: "本文2" });
  assert.equal(u.body.template.version, 2);
  const stale = await tplPost({ action: "update", id, version: 1, name: "x", purpose: "ceo", subject: "y", body: "z" });
  assert.equal(stale.statusCode, 409);
  assert.equal(mem.rows.gw_hr_mail_templates.find((t) => t.id === id).subject, "社長面談");
});

await ok("入力の確かめ：知らない差し込み・件名の改行・空", async () => {
  setup();
  const bad = await tplPost({ action: "create", name: "x", purpose: "casual", subject: "件名", body: "{{応募者様}} 様" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.hint, /使えない差し込み項目.*\{\{応募者様\}\}/);
  const nl = await tplPost({ action: "create", name: "x", purpose: "casual", subject: "件名\nBcc: x@example.jp", body: "本文" });
  assert.equal(nl.statusCode, 400);
  assert.ok(nl.body.problems.some((p) => /改行/.test(p)));
  const empty = await tplPost({ action: "create", name: "", purpose: "nope", subject: "", body: "" });
  assert.equal(empty.statusCode, 400);
  assert.ok(empty.body.problems.length >= 3);
  assert.equal(mem.rows.gw_hr_mail_templates.length, 0);
});

await ok("複製：（コピー）・既定ではない・標準の印なし。元は変わらない", async () => {
  setup();
  await tplGet();
  const d = await tplPost({ action: "duplicate", id: std().id });
  assert.equal(d.statusCode, 200);
  assert.equal(d.body.template.name, "応募受付・事前質問・面談案内（コピー）");
  assert.equal(d.body.template.isDefault, false);
  assert.equal(d.body.template.standard, false);
  assert.equal(d.body.template.body, std().body);
  assert.equal(std().version, 1);
});

await ok("非表示：消さない・既定も外れる・送った記録は残る／既定：用途ごとに1つ・非表示は既定にできない", async () => {
  setup();
  await tplGet();
  const s1 = await send({ id: A1, templateId: std().id, templateVersion: 1, subject: "件名", body: "本文", requestKey: key() });
  assert.equal(s1.statusCode, 200, JSON.stringify(s1.body));
  const dup = (await tplPost({ action: "duplicate", id: std().id })).body.template;
  const h = await tplPost({ action: "set_active", id: std().id, active: false });
  assert.equal(h.body.template.active, false);
  assert.equal(h.body.template.isDefault, false);
  assert.equal(mem.rows.gw_hr_mail_templates.length, 2, "消えない");
  assert.equal(mem.rows.gw_hr_mail_sends.length, 1, "送った記録は残る");
  assert.equal(mem.rows.gw_hr_mail_sends[0].template_id, std().id);
  const no = await tplPost({ action: "set_default", id: std().id });
  assert.equal(no.statusCode, 409);
  const yes = await tplPost({ action: "set_default", id: dup.id });
  assert.equal(yes.statusCode, 200);
  await tplPost({ action: "set_active", id: std().id, active: true });
  await tplPost({ action: "set_default", id: std().id });
  const defs = mem.rows.gw_hr_mail_templates.filter((t) => t.tenant_id === T1 && t.purpose === "application" && t.is_default);
  assert.equal(defs.length, 1, "既定は用途ごとに1つ");
  assert.equal(defs[0].id, std().id);
  // 非表示のひな型は［メールを送る］の候補に出ない
  await tplPost({ action: "set_active", id: dup.id, active: false });
  const g = await draft(A1);
  assert.ok(!g.body.templates.some((t) => t.id === dup.id));
});

await ok("権限：採用HRを使えない人は 403。他社のひな型は 404（id を知っていても）", async () => {
  setup();
  await tplGet();
  who = SALES;
  assert.equal((await tplGet()).statusCode, 403);
  assert.equal((await draft(A1)).statusCode, 403);
  who = OTHER;
  const r = await tplPost({ action: "update", id: std().id, version: 1, name: "乗っ取り", purpose: "other", subject: "x", body: "y" });
  assert.equal(r.statusCode, 404);
  assert.equal((await tplPost({ action: "set_active", id: std().id, active: false })).statusCode, 404);
  const list = await tplGet();
  assert.ok(!list.body.templates.some((t) => t.id === std().id), "他社の一覧に出ない");
  assert.equal(std().is_active, true);
  assert.equal((await draft(A1)).statusCode, 404, "他社の応募者は開けない");
  assert.equal((await send({ id: A1, templateId: std().id, templateVersion: 1, subject: "x", body: "y", requestKey: key() })).statusCode, 404);
  assert.equal(sent.length, 0);
});

console.log("\n=== 応募者へ送る（API） ===\n");

await ok("下書き：宛先（氏名・メール）・差し込み済み・担当者名・送信元／返信先", async () => {
  setup();
  const r = await draft(A1);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.applicant, { id: A1, name: "山田 太郎", email: "taro@example.jp", jobTitle: "エンジニア" });
  assert.match(r.body.rendered.body, /^山田 太郎 様/);
  assert.ok(r.body.rendered.body.includes(`applicant_id=${A1}`));
  assert.equal(r.body.rendered.templateVersion, 1);
  assert.equal(r.body.mail.configured, true);
  assert.equal(r.body.mail.replyTo, "hr@example.jp");
  const r2 = await draft(A2);
  assert.match(r2.body.rendered.body, /^佐藤 花子 様/);
  assert.ok(r2.body.rendered.body.includes(`applicant_id=${A2}`) && !r2.body.rendered.body.includes(A1));
  // 担当者名：採用担当が居ればその人、居なければ送る人
  const c = await tplPost({ action: "create", name: "担当", purpose: "other", subject: "{{募集職種}}", body: "{{担当者名}}" });
  assert.equal((await draft(A1, c.body.template.id)).body.rendered.body, "採用 太郎");
  assert.equal((await draft(A2, c.body.template.id)).body.rendered.body, "人事 花子");
  assert.equal((await draft(A2, c.body.template.id)).body.rendered.subject, "デザイナー");
  const none = await draft(A3);
  assert.equal(none.body.mail.configured, false);
  assert.match(none.body.mail.reason, /メールアドレス/);
});

await ok("差し込めない項目は理由つきで出す。そのままでは送れない", async () => {
  setup();
  const c = await tplPost({ action: "create", name: "社長面談", purpose: "ceo", subject: "社長面談のご案内", body: "{{応募者名}} 様\n{{面談予約URL}}" });
  const d = await draft(A1, c.body.template.id);
  assert.deepEqual(d.body.rendered.missing.map((m) => m.key), ["面談予約URL"]);
  assert.match(d.body.rendered.missing[0].reason, /TIMEREX_CEO_INTERVIEW_URL/);
  const s = await send({ id: A1, templateId: c.body.template.id, templateVersion: 1, subject: d.body.rendered.subject, body: d.body.rendered.body, requestKey: key() });
  assert.equal(s.statusCode, 400);
  assert.match(s.body.hint, /差し込まれていない項目.*面談予約URL/);
  assert.equal(sent.length, 0);
  assert.equal(mem.rows.gw_hr_mail_sends.length, 0);
});

await ok("画面で直した内容はそのメールだけ。ひな型は変わらない。送った記録はあとでひな型を直しても変わらない", async () => {
  setup();
  const d = await draft(A1);
  const t = std();
  const before = { subject: t.subject, body: t.body, version: t.version };
  const body = `${d.body.rendered.body}\n\n追伸：この1通だけの一文`;
  const s = await send({ id: A1, templateId: t.id, templateVersion: 1, subject: "【個別】ご応募ありがとうございます", body, requestKey: key() });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "taro@example.jp");
  assert.equal(sent[0].purpose, "recruiting");
  assert.equal(sent[0].text, body);
  assert.deepEqual({ subject: std().subject, body: std().body, version: std().version }, before, "ひな型は変わらない");
  const row = mem.rows.gw_hr_mail_sends[0];
  assert.equal(row.status, "sent");
  assert.equal(row.provider_message_id, "msg_1");
  assert.equal(row.template_version, 1);
  assert.equal(row.to_name, "山田 太郎");
  assert.equal(row.sent_by_name, "人事 花子");
  assert.equal(row.reply_to, "hr@example.jp");
  assert.ok(row.finished_at);
  // ひな型を直しても、送った記録は送った時点のまま
  await tplPost({ action: "update", id: t.id, version: 1, name: "改名", purpose: "application", subject: "新しい件名", body: "新しい本文" });
  const h = (await draft(A1)).body.sends;
  assert.equal(h.length, 1);
  assert.equal(h[0].subject, "【個別】ご応募ありがとうございます");
  assert.equal(h[0].body, body);
  assert.equal(h[0].templateVersion, 1);
  assert.equal(h[0].templateName, "応募受付・事前質問・面談案内");
  // タイムライン・監査ログ（本文・宛先は残さない）
  assert.equal(mem.rows.gw_hr_timeline.length, 1);
  assert.equal(mem.rows.gw_hr_timeline[0].event_key, "mail_sent");
  const lg = logged.find((l) => l.action === "hr.applicant_mail");
  assert.ok(lg);
  assert.ok(!JSON.stringify(lg).includes("taro@example.jp") && !JSON.stringify(lg).includes("追伸"));
});

await ok("二重送信の防止：同じ鍵の2回目は送らず、1回目の結果を返す", async () => {
  setup();
  const d = await draft(A1);
  const k = key();
  const req = { id: A1, templateId: d.body.rendered.templateId, templateVersion: 1, subject: d.body.rendered.subject, body: d.body.rendered.body, requestKey: k };
  const [r1, r2] = await Promise.all([send(req), send(req)]);
  const r3 = await send(req);
  assert.equal(sent.length, 1, "送るのは1回だけ");
  assert.equal(mem.rows.gw_hr_mail_sends.length, 1);
  assert.equal([r1, r2, r3].filter((r) => r.body.duplicate).length, 2);
  assert.equal(r3.body.status, "sent");
  // 別の鍵なら、もう1通（人が［送信］を押し直した）
  await send({ ...req, requestKey: key() });
  assert.equal(sent.length, 2);
  // 鍵が無い・短いものは断る
  assert.equal((await send({ ...req, requestKey: "" })).statusCode, 400);
  assert.equal((await send({ ...req, requestKey: "short" })).statusCode, 400);
  assert.equal(sent.length, 2);
});

await ok("結果：失敗は 502・時間切れは結果不明 202・どちらもタイムラインには載せない", async () => {
  setup();
  const d = await draft(A1);
  const base = { id: A1, templateId: d.body.rendered.templateId, templateVersion: 1, subject: d.body.rendered.subject, body: d.body.rendered.body };
  mailMode = "failed";
  const f = await send({ ...base, requestKey: key() });
  assert.equal(f.statusCode, 502);
  assert.equal(f.body.status, "failed");
  assert.match(f.body.hint, /送れませんでした/);
  mailMode = "timeout";
  const u = await send({ ...base, requestKey: key() });
  assert.equal(u.statusCode, 202);
  assert.equal(u.body.status, "unknown");
  assert.match(u.body.hint, /分かりません/);
  assert.deepEqual(mem.rows.gw_hr_mail_sends.map((s) => s.status).sort(), ["failed", "unknown"]);
  assert.equal(mem.rows.gw_hr_timeline.length, 0);
  mailMode = "skipped";
  const n = await send({ ...base, requestKey: key() });
  assert.equal(n.statusCode, 409);
  assert.equal(n.body.error, "mail_not_configured");
});

await ok("送らないもの：ほかの応募者の予約URL・件名の改行・メールアドレス無し・非表示／直されたひな型", async () => {
  setup();
  const d1 = await draft(A1);
  const d2 = await draft(A2);
  const t = std();
  // A1 の下書きを A2 へ送ろうとする（ほかの人の予約URLが混ざる）
  const wrong = await send({ id: A2, templateId: t.id, templateVersion: 1, subject: d1.body.rendered.subject, body: d1.body.rendered.body, requestKey: key() });
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.body.hint, /ほかの応募者/);
  const nl = await send({ id: A2, templateId: t.id, templateVersion: 1, subject: "件名\nBcc: x@example.jp", body: d2.body.rendered.body, requestKey: key() });
  assert.equal(nl.statusCode, 400);
  const noMail = await send({ id: A3, templateId: t.id, templateVersion: 1, subject: "件名", body: "本文", requestKey: key() });
  assert.equal(noMail.statusCode, 400);
  assert.equal(noMail.body.error, "no_email");
  await tplPost({ action: "update", id: t.id, version: 1, name: t.name, purpose: "application", subject: "改", body: "改" });
  const changed = await send({ id: A2, templateId: t.id, templateVersion: 1, subject: "件名", body: "本文", requestKey: key() });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.body.error, "template_changed");
  await tplPost({ action: "set_active", id: t.id, active: false });
  const hidden = await send({ id: A2, templateId: t.id, templateVersion: 2, subject: "件名", body: "本文", requestKey: key() });
  assert.equal(hidden.statusCode, 409);
  assert.equal(hidden.body.error, "template_inactive");
  assert.equal(sent.length, 0);
  assert.equal(mem.rows.gw_hr_mail_sends.length, 0);
});

await ok("表が無い（db/124 未適用）ときは 503 と SQL の名前", async () => {
  setup();
  mem.state.missing = "gw_hr_mail_templates";
  try {
    const r = await tplGet();
    assert.equal(r.statusCode, 503, JSON.stringify(r.body));
    assert.match(r.body.message, /124_hr_mail_templates/);
    const d = await draft(A1);
    assert.equal(d.statusCode, 503);
  } finally { mem.state.missing = null; }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
