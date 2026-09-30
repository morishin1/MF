// 採用HR：NEXT ACTION の面談を ID で操作する・社長面談後の遷移・状態の手動変更・日本時間の一致。
//
// ■ 何を守るテストか
//   1. 過去のカジュアル面談（未完了のまま）と、いまの社長面談が両方ある応募者で、
//      NEXT ACTION が指すのは社長面談（nextInterviewId）。実施済みにすると社長面談だけが更新される
//   2. 社長面談の実施済み → status=ceo_decision_pending、NEXT ACTION「社長判断をしてください」・CTA「採用判断」
//      （「社長面談を設定」「面談を予定する」へ戻らない）。CEO REVIEW でも同じ状態
//   3. 社長面談の段階で、古いカジュアル面談は実施済みにできない（状態が「評価入力待ち」へ戻らない）
//   4. カジュアル面談の実施 → eval_pending・CTA「評価を入力」（従来どおり）
//   5. 状態の手動変更：選択肢は lib/hr.js が正・注意の事前確認・タイムラインと監査ログ（actor つき）
//   6. 状態の手動変更で、面談（日時・Meet URL・TimeRex の項目・取消）を変えない
//   7. CEO REVIEW と応募者詳細で、社長面談の日時が同じ（日本時間 16:15）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

const db = { rows: {} };
const logged = [];
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
const test1 = (x, [op, k, v]) => (op === "eq" ? x[k] === v : op === "neq" ? x[k] !== v
  : op === "in" ? v.includes(x[k]) : op === "is" ? (x[k] ?? null) === v : true);
function table(name) {
  const f = [];
  let lim = null;
  const rows = () => { const o = (db.rows[name] || []).filter((x) => f.every((c) => test1(x, c))); return lim ? o.slice(0, lim) : o; };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order() { return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn) };
      return r2;
    },
    update(patch) {
      const g = [];
      const apply = () => {
        const hit = (db.rows[name] || []).filter((x) => g.every((c) => test1(x, c)));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      };
      const r2 = { eq: (k, v) => { g.push(["eq", k, v]); return r2; }, select: () => r2,
        single: apply, maybeSingle: apply, then: (fn) => apply().then(fn) };
      return r2;
    },
  };
  return q;
}
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => ({ created: rows.length }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_GW = await import(atRoot("lib/gw.js"));
const RECRUITER = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["recruiter"], employee: { id: "e-hr" } };
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner" } };
let who = RECRUITER;
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: interviewsApi } = await import(atRoot("api/hr/interviews/index.js"));
const { default: ceoReviewApi } = await import(atRoot("api/hr/ceo-review.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { STATUSES, STATUS_LABEL } = await import(atRoot("lib/hr.js"));
const JST = await import(atRoot("lib/jst.js"));

const res = () => { const r = { statusCode: 0, body: null }; r.setHeader = () => {}; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const H = { authorization: "Bearer x" };
const call = async (fn, req) => { const r = res(); await fn({ headers: H, ...req }, r); return r; };
const getDetail = (id) => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const patchDetail = (body) => call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const patchIv = (body) => call(interviewsApi, { method: "PATCH", url: "/api/hr/interviews", body });
const ceoReview = () => call(ceoReviewApi, { method: "GET", url: "/api/hr/ceo-review" });
const listAll = () => call(listApi, { method: "GET", url: "/api/hr/applicants" });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const CEO_AT = "2026-10-01T07:15:00+00:00";   // 日本時間 2026/10/1 16:15
function setup() {
  who = RECRUITER;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [
      // 社長面談の段階。過去のカジュアル面談が「未完了のまま」残っている
      { id: "a-ceo", tenant_id: "t1", name: "匿名 候補者", email: "c@example.test", stage: "ceo_interview",
        status: "interview_scheduled", rank: "A", decision: null },
      // カジュアル面談の段階
      { id: "a-cas", tenant_id: "t1", name: "匿名 応募者", email: "k@example.test", stage: "casual_interview",
        status: "interview_scheduled", rank: null, decision: null },
    ],
    gw_hr_interviews: [
      // 並び（作成の新しい順）で先に来るように、古いカジュアル面談を先に置く
      { id: "iv-old-casual", tenant_id: "t1", applicant_id: "a-ceo", kind: "casual",
        scheduled_at: "2026-09-10T01:00:00Z", conducted_at: null, canceled_at: null, created_at: "2026-09-20T00:00:00Z" },
      { id: "iv-ceo", tenant_id: "t1", applicant_id: "a-ceo", kind: "ceo", scheduled_at: CEO_AT,
        conducted_at: null, canceled_at: null, meeting_url: "https://meet.google.com/anon",
        timerex_event_id: "evt_anon_ceo_0001", timerex_calendar_path: "98b26445",
        timerex_reschedule_url: "https://timerex.net/anon/r/ANON", timerex_host_cancel_url: "https://timerex.net/anon/c/ANON",
        created_at: "2026-09-10T00:00:00Z" },
      { id: "iv-cas", tenant_id: "t1", applicant_id: "a-cas", kind: "casual", scheduled_at: "2026-10-02T01:00:00Z",
        conducted_at: null, canceled_at: null, created_at: "2026-09-25T00:00:00Z" },
    ],
    gw_hr_timeline: [], gw_hr_offers: [], gw_employees: [], memberships: [], gw_role_grants: [],
  };
}
const app = (id) => db.rows.gw_hr_applicants.find((a) => a.id === id);
const iv = (id) => db.rows.gw_hr_interviews.find((i) => i.id === id);

console.log("\n— NEXT ACTION が指す面談 —");
await ok("過去のカジュアル面談が残っていても、社長面談の段階なら nextInterviewId は社長面談", async () => {
  setup();
  const r = await getDetail("a-ceo");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a = r.body.applicant;
  assert.equal(a.nextInterviewId, "iv-ceo");
  assert.equal(a.nextInterviewKind, "ceo");
  assert.equal(a.nextActionKey, "conduct");
  assert.ok(a.nextAction.endsWith("16:15 社長面談"), `日本時間 16:15：${a.nextAction}`);
});

await ok("CEO REVIEW と応募者詳細で、社長面談の日時が同じ（日本時間 2026/10/1 16:15）", async () => {
  setup();
  const d = (await getDetail("a-ceo")).body;
  who = OWNER;
  const c = (await ceoReview()).body;
  const card = [...c.todayMeetings, ...c.recommended, ...c.decisionPending].find((x) => x.id === "a-ceo");
  assert.ok(card, "CEO REVIEW に出る");
  assert.equal(card.ceoInterview.id, "iv-ceo");
  const detailIv = d.interviews.find((i) => i.id === d.applicant.nextInterviewId);
  assert.equal(card.ceoInterview.scheduledAt, detailIv.scheduledAt);
  assert.equal(JST.dateTime(card.ceoInterview.scheduledAt), "2026/10/1 16:15");
  assert.equal(JST.dateTime(detailIv.scheduledAt), "2026/10/1 16:15");
});

await ok("一覧と詳細で NEXT ACTION が同じ（面談予定・有効な社長面談あり → 実施済みにする）", async () => {
  setup();
  const l = (await listAll()).body.applicants.find((a) => a.id === "a-ceo");
  const d = (await getDetail("a-ceo")).body.applicant;
  assert.deepEqual([l.nextActionKey, l.nextActionCta, l.nextInterviewId], ["conduct", "面談を実施済みにする", "iv-ceo"]);
  assert.deepEqual([d.nextActionKey, d.nextActionCta, d.nextInterviewId], ["conduct", "面談を実施済みにする", "iv-ceo"]);
});

await ok("面談予定なのに有効な面談が無い（社長面談の段階で古いカジュアル面談だけ）→「実施済みにする」を出さない", async () => {
  setup();
  db.rows.gw_hr_interviews = db.rows.gw_hr_interviews.filter((i) => i.id !== "iv-ceo");
  for (const a of [(await getDetail("a-ceo")).body.applicant, (await listAll()).body.applicants.find((x) => x.id === "a-ceo")]) {
    assert.equal(a.nextInterviewId, null);
    assert.equal(a.nextAction, "面談予定の記録を確認してください");
    assert.equal(a.nextActionCta, "面談タブを確認");
    assert.equal(a.nextActionKey, "checkInterviews");
  }
  // 古いカジュアル面談を直接実施済みにしようとしても 409（状態は変わらない）
  const r = await patchIv({ id: "iv-old-casual", action: "conduct" });
  assert.equal(r.statusCode, 409);
  assert.equal(iv("iv-old-casual").conducted_at, null);
  assert.equal(app("a-ceo").status, "interview_scheduled");
});

await ok("社長面談がキャンセル済みでも同じ（有効な面談として数えない）", async () => {
  setup();
  iv("iv-ceo").canceled_at = "2026-09-29T00:00:00Z";
  const a = (await getDetail("a-ceo")).body.applicant;
  assert.deepEqual([a.nextInterviewId, a.nextActionKey], [null, "checkInterviews"]);
});

console.log("\n— 社長面談の実施済み —");
await ok("NEXT ACTION の面談（社長面談）を実施済み → 社長面談だけ更新・古いカジュアル面談はそのまま", async () => {
  setup();
  const target = (await getDetail("a-ceo")).body.applicant.nextInterviewId;
  const r = await patchIv({ id: target, action: "conduct" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(iv("iv-ceo").conducted_at, "社長面談の conducted_at");
  assert.equal(iv("iv-old-casual").conducted_at, null, "古いカジュアル面談は触らない");
  assert.equal(app("a-ceo").status, "ceo_decision_pending");
  assert.equal(app("a-ceo").stage, "ceo_interview");
});

await ok("社長面談の実施後：NEXT ACTION「社長判断をしてください」・CTA「採用判断」（面談の設定へ戻らない）", async () => {
  setup();
  await patchIv({ id: "iv-ceo", action: "conduct" });
  const a = (await getDetail("a-ceo")).body.applicant;
  assert.equal(a.status, "ceo_decision_pending");
  assert.equal(a.statusLabel, "社長判断待ち");
  assert.equal(a.nextAction, "社長判断をしてください");
  assert.equal(a.nextActionCta, "採用判断");
  assert.equal(a.nextActionKey, "decide");
  assert.notEqual(a.nextActionCta, "社長面談を設定");
  assert.notEqual(a.nextActionKey, "schedule");
  // CEO REVIEW でも同じ（社長判断待ちの列に、同じ NEXT ACTION で出る）
  who = OWNER;
  const c = (await ceoReview()).body;
  const card = c.decisionPending.find((x) => x.id === "a-ceo");
  assert.ok(card, "CEO REVIEW の「判断待ち」に出る");
  assert.deepEqual([card.status, card.nextAction, card.nextActionCta], ["ceo_decision_pending", "社長判断をしてください", "採用判断"]);
  assert.equal(card.ceoInterview.id, "iv-ceo");
});

await ok("社長面談の段階で、古いカジュアル面談は実施済みにできない（409・状態は変わらない）", async () => {
  setup();
  const r = await patchIv({ id: "iv-old-casual", action: "conduct" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "interview_kind_mismatch");
  assert.equal(iv("iv-old-casual").conducted_at, null);
  assert.equal(app("a-ceo").status, "interview_scheduled", "評価入力待ちへ戻らない");
});

await ok("実施済み・キャンセル済みの面談をもう一度実施済みにしない", async () => {
  setup();
  await patchIv({ id: "iv-ceo", action: "conduct" });
  const r = await patchIv({ id: "iv-ceo", action: "conduct" });
  assert.equal(r.statusCode, 409);
});

console.log("\n— カジュアル面談の実施済み（従来どおり） —");
await ok("カジュアル面談の実施 → eval_pending・CTA「評価を入力」", async () => {
  setup();
  const target = (await getDetail("a-cas")).body.applicant.nextInterviewId;
  assert.equal(target, "iv-cas");
  const r = await patchIv({ id: target, action: "conduct" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a = (await getDetail("a-cas")).body.applicant;
  assert.deepEqual([a.status, a.nextActionCta, a.nextActionKey], ["eval_pending", "評価を入力", "evaluate"]);
});

console.log("\n— 状態（status）の手動変更 —");
await ok("選択肢は lib/hr.js の STATUSES / STATUS_LABEL（API が返す）", async () => {
  setup();
  const d = (await getDetail("a-ceo")).body;
  assert.deepEqual(d.statusOptions, STATUSES.map((key) => ({ key, label: STATUS_LABEL[key] })));
});

await ok("面談予定 → 社長判断待ち：事前確認（注意）→ 確認なしは 409 → 確認つきで変更。タイムラインと監査ログ（actor）", async () => {
  setup();
  who = OWNER;
  const pre = await patchDetail({ id: "a-ceo", action: "setStatus", status: "ceo_decision_pending", dryRun: true });
  assert.equal(pre.statusCode, 200, JSON.stringify(pre.body));
  assert.deepEqual([pre.body.from, pre.body.to], ["面談予定", "社長判断待ち"]);
  assert.ok(pre.body.warnings.some((w) => w.includes("実施済みの社長面談がありません")));
  assert.equal(app("a-ceo").status, "interview_scheduled", "dryRun では変えない");
  assert.equal(db.rows.gw_hr_timeline.length, 0);

  const no = await patchDetail({ id: "a-ceo", action: "setStatus", status: "ceo_decision_pending" });
  assert.equal(no.statusCode, 409);
  assert.equal(no.body.error, "status_change_warning");
  assert.equal(app("a-ceo").status, "interview_scheduled");

  const r = await patchDetail({ id: "a-ceo", action: "setStatus", status: "ceo_decision_pending", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(app("a-ceo").status, "ceo_decision_pending");
  assert.equal(app("a-ceo").stage, "ceo_interview", "選考段階は変えない");
  assert.equal(r.body.applicant.nextActionCta, "採用判断", "NEXT ACTION も新しい状態で返す");
  const tl = db.rows.gw_hr_timeline.at(-1);
  assert.deepEqual([tl.event_key, tl.label, tl.detail, tl.created_by], ["status_manual", "状態を手動変更", "面談予定 → 社長判断待ち", "u-owner"]);
  const lg = logged.find((l) => l.action === "hr.applicant_status_manual");
  assert.ok(lg, "監査ログ");
  assert.equal(lg.actorId, "u-owner");
  assert.deepEqual([lg.detail.from, lg.detail.to, lg.detail.acknowledged], ["interview_scheduled", "ceo_decision_pending", true]);
});

await ok("注意が無い変更は、確認フラグなしでそのまま変更できる（評価入力待ち → 次回調整待ち）", async () => {
  setup();
  app("a-cas").status = "eval_pending";
  const pre = await patchDetail({ id: "a-cas", action: "setStatus", status: "next_scheduling_pending", dryRun: true });
  assert.deepEqual(pre.body.warnings, []);
  const r = await patchDetail({ id: "a-cas", action: "setStatus", status: "next_scheduling_pending" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(app("a-cas").status, "next_scheduling_pending");
});

await ok("有効な面談が1件も無いのに「面談予定」→ 注意を出す", async () => {
  setup();
  app("a-cas").status = "scheduling";
  iv("iv-cas").canceled_at = "2026-09-29T00:00:00Z";
  const pre = await patchDetail({ id: "a-cas", action: "setStatus", status: "interview_scheduled", dryRun: true });
  assert.ok(pre.body.warnings.some((w) => w.includes("有効な（実施前・キャンセルされていない）面談が1件もありません")), JSON.stringify(pre.body));
});

await ok("TimeRex の管理項目（日時・Meet URL・予約・取消）は状態変更で変わらない", async () => {
  setup();
  who = OWNER;
  const before = copy(db.rows.gw_hr_interviews);
  const pre = await patchDetail({ id: "a-ceo", action: "setStatus", status: "ceo_interview_pending", dryRun: true });
  assert.ok(pre.body.warnings.some((w) => w.includes("TimeRex から取り消してください")), JSON.stringify(pre.body));
  const r = await patchDetail({ id: "a-ceo", action: "setStatus", status: "ceo_interview_pending", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(db.rows.gw_hr_interviews, before, "面談の行は1つも変わらない");
});

await ok("社長判断待ちへ／から動かすのは社長・管理者だけ。不正な値・同じ値は 400", async () => {
  setup();
  const r = await patchDetail({ id: "a-ceo", action: "setStatus", status: "ceo_decision_pending", acknowledgeWarnings: true });
  assert.equal(r.statusCode, 403);
  assert.equal(app("a-ceo").status, "interview_scheduled");
  assert.equal((await patchDetail({ id: "a-ceo", action: "setStatus", status: "nope" })).statusCode, 400);
  assert.equal((await patchDetail({ id: "a-ceo", action: "setStatus", status: "interview_scheduled" })).statusCode, 400);
  assert.equal(db.rows.gw_hr_timeline.length, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
