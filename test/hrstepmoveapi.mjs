// 採用HR：応募者詳細の「ステップを直接移動する」（PATCH /api/hr/applicants/detail action:"moveStep"）を API から通す。
//
// ■ 何を守るテストか
//   1. 理由は必須。選考タイムラインに「変更前 → 変更後・理由」、監査ログに from/to/reason/操作者
//   2. メール・合格通知（オファー）・契約・署名・通知を作らない（ステップを動かしただけで事実を作らない）
//   3. 入社予定へは進めない。承諾・契約・引き渡し・社員登録の記録がある人は、どこへも動かさない（記録を守る）
//   4. 内定（合格）にする・社長判断待ちを動かすのは社長・管理者だけ（採用担当は 409／画面でも「移動できない＋理由」）
//   5. 注意（飛ばす・送付済みの合格通知が有効なまま…）は dryRun で先に返し、確認なしでは 409
//   6. 同時に別の人が動かしていたら上書きしない（読んだときの stage・status の行だけを書く）
//   ※ 実在の応募者・実際のメール送信は使わない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;

const mem = createMemDb();
const logged = [], notified = [], mailed = [];
// 同時操作の再現用：hook があれば、クライアントを包む
let hook = null;
const client = () => (hook ? hook(mem.admin()) : mem.admin());
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => client(), userClient: () => client() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => { notified.push(...rows); return { created: rows.length }; } } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_MAIL = await import(atRoot("lib/mail/index.js"));
mock.module(atRoot("lib/mail/index.js"), { namedExports: { ...REAL_MAIL, sendMail: async (m) => { mailed.push(m); return { status: "sent" }; } } });
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner", display_name: "社長 一郎" } };
const RECRUITER = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-hr", display_name: "採用 花子" } };
const SALES = { userId: "u-s", tenantId: "t1", isAdmin: false, roles: ["sales"], employee: { id: "e-s", display_name: "営業" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const SM = await import(atRoot("lib/hr-step-move.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await detailApi({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const move = (body) => call({ method: "PATCH", url: "/api/hr/applicants/detail", body: { id: "a1", action: "moveStep", ...body } });
const getDetail = () => call({ method: "GET", url: "/api/hr/applicants/detail?id=a1" });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

function setup(extra = {}, { offers = [], interviews = [] } = {}) {
  mem.reset(); logged.length = 0; notified.length = 0; mailed.length = 0; who = OWNER;
  mem.rows.tenants = [{ id: "t1", name: "株式会社テスト" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-hr", tenant_id: "t1", user_id: "u-hr", display_name: "採用 花子", status: "active" },
  ];
  mem.rows.gw_hr_applicants = [{
    id: "a1", tenant_id: "t1", name: "架空 候補者", email: "candidate@example.test", job_title: "営業", source: "Wantedly",
    stage: "applied", status: "todo", decision: null, rank: null, recruiter_id: "e-hr", employee_id: null,
    lead_category: "recruitment", offer_type: null, ...extra,
  }];
  mem.rows.gw_hr_offers = offers.map((o) => ({ tenant_id: "t1", applicant_id: "a1", revoked_at: null, sent_at: null, accepted_at: null, declined_at: null, ...o }));
  mem.rows.gw_hr_interviews = interviews.map((i) => ({ tenant_id: "t1", applicant_id: "a1", canceled_at: null, conducted_at: null, ...i }));
  mem.rows.gw_hr_timeline = [];
  mem.rows.gw_hr_mail_sends = [];
}
const app = () => mem.rows.gw_hr_applicants[0];
const sideEffects = () => ({
  offers: mem.rows.gw_hr_offers.length, mails: mem.rows.gw_hr_mail_sends.length, mailed: mailed.length, notified: notified.length,
});

console.log("\n— 選べる先（画面と API が同じ判定） —");
await ok("新規応募：内定までは社長なら選べる。入社予定は選べない（理由つき）", () => {
  const m = SM.stepMoveOptions({ stage: "applied", status: "todo" }, { canDecide: true });
  assert.equal(m.current, "applied");
  assert.deepEqual(m.options.map((o) => `${o.key}:${o.state}`),
    ["applied:current", "casual_interview:allowed", "ceo_recommend:allowed", "ceo_interview:allowed", "offer:allowed", "joining_scheduled:blocked"]);
  assert.match(m.options.at(-1).reason, /承諾と契約の記録/);
});
await ok("採用担当は内定（合格）にできない。社長判断待ちはどこへも動かせない", () => {
  const r = SM.stepMoveOptions({ stage: "ceo_interview", status: "ceo_interview_pending" }, { canDecide: false });
  assert.equal(r.options.find((o) => o.key === "offer").state, "blocked");
  assert.match(r.options.find((o) => o.key === "offer").reason, /社長・管理者/);
  assert.equal(r.options.find((o) => o.key === "casual_interview").state, "allowed");
  const d = SM.stepMoveOptions({ stage: "ceo_interview", status: "ceo_decision_pending" }, { canDecide: false });
  assert.ok(d.options.filter((o) => o.state !== "current").every((o) => o.state === "blocked" && /社長判断待ち/.test(o.reason)));
});
await ok("承諾・契約・引き渡し・社員登録の記録がある人は、どこへも動かせない", () => {
  for (const [a, offers] of [
    [{ stage: "offer", status: "accepted" }, []],
    [{ stage: "offer", status: "offer_sent" }, [{ version: 1, sent_at: "2026-10-01", accepted_at: "2026-10-02" }]],
    [{ stage: "offer", status: "offer_sent" }, [{ version: 1, sent_at: "2026-10-01", formal_signed_at: "2026-10-03" }]],
    [{ stage: "joining_scheduled", status: "done", employee_id: "e9" }, []],
  ]) {
    const m = SM.stepMoveOptions(a, { offers, canDecide: true });
    assert.ok(m.locked, JSON.stringify(a));
    assert.ok(m.options.every((o) => o.state !== "allowed"), JSON.stringify(a));
  }
});
await ok("無限道場リードは対象外", () => {
  const m = SM.stepMoveOptions({ stage: "md_trial", status: "todo", lead_category: "mugendojo" }, { canDecide: true });
  assert.ok(m.locked && m.options.every((o) => o.state !== "allowed"));
});

console.log("\n— 移動する（API） —");
await ok("電話で面談・合格を確認 → 新規応募から内定へ（社長）。理由・変更前後が履歴と監査ログに残る。メール・オファーは作らない", async () => {
  setup();
  const dry = await move({ to: "offer", dryRun: true });
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
  assert.ok(dry.body.warnings.some((w) => w.includes("カジュアル面談・社長推薦・社長面談")), dry.body.warnings.join("|"));
  assert.ok(dry.body.notes.some((n) => n.includes("メール・合格通知の送付は行いません")));
  assert.equal(app().stage, "applied", "dryRun では変えない");

  const noReason = await move({ to: "offer", acknowledgeWarnings: true });
  assert.equal(noReason.statusCode, 400);
  assert.equal(noReason.body.error, "reason_required");
  const noAck = await move({ to: "offer", reason: "電話で社長面談・合格を確認済み" });
  assert.equal(noAck.statusCode, 409);
  assert.equal(noAck.body.error, "step_move_warning");
  assert.equal(app().stage, "applied");

  const r = await move({ to: "offer", reason: "電話で社長面談・合格を確認済み", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([app().stage, app().status, app().decision], ["offer", "offer_draft_pending", "hired"]);
  const t = mem.rows.gw_hr_timeline.find((x) => x.event_key === "step_moved");
  assert.ok(t, "タイムラインに残る");
  assert.equal(t.created_by, "u-owner");
  assert.match(t.detail, /変更前：新規応募（未対応） → 変更後：内定（合格通知作成待ち）／理由：電話で社長面談・合格を確認済み/);
  assert.ok(mem.rows.gw_hr_timeline.some((x) => x.event_key === "decision_hired"), "合格の判断も記録（本人へ未連絡の判定に使う）");
  const log = logged.find((l) => l.action === "hr.applicant_step_move");
  assert.deepEqual([log.actorId, log.detail.from.stage, log.detail.to.stage, log.detail.reason, log.detail.acknowledged],
    ["u-owner", "applied", "offer", "電話で社長面談・合格を確認済み", true]);
  assert.deepEqual(sideEffects(), { offers: 0, mails: 0, mailed: 0, notified: 0 }, "メール・オファー・通知を作らない");
  assert.equal(r.body.applicant.nextActionCta !== undefined, true);
});

await ok("採用担当：内定へは 409（社長・管理者だけ）。カジュアル面談へは動かせる", async () => {
  setup({ stage: "applied", status: "todo" });
  who = RECRUITER;
  const r = await move({ to: "offer", reason: "x", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "step_blocked");
  assert.equal(app().stage, "applied");
  const c = await move({ to: "casual_interview", reason: "電話でカジュアル面談の日程を相談中" });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.deepEqual([app().stage, app().status], ["casual_interview", "scheduling"], "面談記録が無いので日程調整から");
});

await ok("実施済みのカジュアル面談があれば、カジュアル面談へ戻すと評価待ち", async () => {
  setup({ stage: "ceo_recommend", status: "ceo_recommend_pending" }, { interviews: [{ id: "i1", kind: "casual", conducted_at: "2026-10-01T01:00:00Z" }] });
  const r = await move({ to: "casual_interview", reason: "評価をやり直す" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([app().stage, app().status], ["casual_interview", "eval_pending"]);
});

await ok("入社予定へは進めない（承諾と契約の記録から進む）", async () => {
  setup({ stage: "offer", status: "offer_draft_pending", decision: "hired" });
  const r = await move({ to: "joining_scheduled", reason: "電話で承諾を聞いた", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "step_blocked");
  assert.equal(app().status, "offer_draft_pending");
});

await ok("承諾済みの人は戻せない（承諾・契約の記録を消さない）", async () => {
  setup({ stage: "offer", status: "accepted", decision: "hired" },
    { offers: [{ id: "o1", version: 1, sent_at: "2026-10-01T00:00:00Z", accepted_at: "2026-10-02T00:00:00Z" }] });
  const r = await move({ to: "ceo_interview", reason: "やり直し", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /承諾・契約・引き渡しの記録/);
  assert.deepEqual([app().status, mem.rows.gw_hr_offers[0].accepted_at], ["accepted", "2026-10-02T00:00:00Z"]);
});

await ok("送付済みの合格通知があるときに戻す：注意を確認すれば戻せる。合格通知（送付・URL）は消さない・取り消さない", async () => {
  setup({ stage: "offer", status: "offer_sent", decision: "hired" },
    { offers: [{ id: "o1", version: 2, sent_at: "2026-10-10T00:00:00Z", token_hash: "h", expires_at: "2026-10-20T00:00:00Z" }] });
  const dry = await move({ to: "ceo_interview", dryRun: true });
  assert.ok(dry.body.warnings.some((w) => w.includes("送付済みの合格通知（第2版）は取り消されません")), dry.body.warnings.join("|"));
  assert.ok(dry.body.warnings.some((w) => w.includes("これまでの判断（合格）は記録に残ります")));
  const r = await move({ to: "ceo_interview", reason: "条件を再検討するため社長面談からやり直す", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const o = mem.rows.gw_hr_offers[0];
  assert.deepEqual([o.sent_at, o.revoked_at, o.token_hash], ["2026-10-10T00:00:00Z", null, "h"], "送付の記録・URLはそのまま");
  assert.equal(app().decision, "hired", "判断の記録は消さない");
  assert.deepEqual(sideEffects(), { offers: 1, mails: 0, mailed: 0, notified: 0 });
});

await ok("見送りの人を再開するときは確認が要る（見送りの記録は履歴に残る）", async () => {
  setup({ stage: "casual_interview", status: "passed", decision: "rejected" });
  const dry = await move({ to: "casual_interview", dryRun: true });
  assert.equal(dry.statusCode, 400, "いまのステップへは no_change");
  const d2 = await move({ to: "ceo_recommend", dryRun: true });
  assert.ok(d2.body.warnings.some((w) => w.includes("選考を再開します")));
});

await ok("同時に別の人が動かしていたら、上書きしない（409・読み直し）", async () => {
  setup({ stage: "applied", status: "todo" });
  // 読んだあと・書く前に、ほかの人が状態を変えたことを再現（応募者の update の直前に行を書き換える）
  hook = (real) => ({ ...real, from: (name) => {
    const q = real.from(name);
    if (name !== "gw_hr_applicants") return q;
    const upd = q.update.bind(q);
    q.update = (v) => { mem.rows.gw_hr_applicants[0].status = "scheduling"; return upd(v); };
    return q;
  } });
  try {
    const r = await move({ to: "casual_interview", reason: "x" });
    assert.equal(r.statusCode, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "stale");
    assert.equal(mem.rows.gw_hr_timeline.length, 0, "記録も残さない");
    assert.equal(app().stage, "applied", "上書きしない");
  } finally { hook = null; }
});

await ok("採用HR権限が無い人は 403。理由が長すぎると 400", async () => {
  setup();
  who = SALES;
  assert.equal((await move({ to: "casual_interview", reason: "x" })).statusCode, 403);
  who = OWNER;
  const long = await move({ to: "casual_interview", reason: "あ".repeat(501) });
  assert.equal(long.statusCode, 400);
});

await ok("詳細（GET）に、選べる先と移動できない理由が載る", async () => {
  setup({ stage: "ceo_interview", status: "ceo_interview_pending" });
  who = RECRUITER;
  const d = await getDetail();
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  const opts = d.body.stepMoves.options;
  assert.equal(opts.find((o) => o.key === "ceo_interview").state, "current");
  assert.equal(opts.find((o) => o.key === "offer").state, "blocked");
  assert.ok(opts.every((o) => !("target" in o)), "内部の値は返さない");
});

console.log(`\nHRステップ移動 API：${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
