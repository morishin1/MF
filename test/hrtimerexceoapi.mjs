// TimeRex 連携：カジュアル面談・社長面談の両方（lib/hr-timerex.js・lib/hr-timerex-calendars.js）と、
// TimeRex 連携済みの面談を HR 側で直接書き換えないこと（api/hr/interviews）を、Webhook から通す。
//
// ■ fixture（test/fixtures/timerex-event-confirmed.json）
//   実際に TimeRex から届いた社長最終面談の event_confirmed と同じ構造。
//   氏名・メール・event ID・Meet URL・取消／リスケ URL は匿名化した値。
//   calendar_url_path は event の中ではなく body 直下（実 payload のとおり）。
//   guest_reschedule_url / guest_cancel_url / host_cancel_url は event の中。
//
// ■ キャンセルの Webhook は event 名が未確認。ここでは「実際の名前を環境変数で有効にしたら
//   受け付けられる」ことだけを確かめる（名前は仮の TEST_CANCEL_TYPE。本番の名前を推測しない）。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);
const FIXTURE = JSON.parse(readFileSync(_join(_HERE, "fixtures/timerex-event-confirmed.json"), "utf8"));

// ---- 偽の DB -------------------------------------------------------------------
const db = { rows: {} };
const logged = [];
const notified = [];
const warned = [];
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
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => { notified.push(...rows); return { created: rows.length }; } } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-hr" }), getMemberships: async () => [] } });
const REAL_GW = await import(atRoot("lib/gw.js"));
const HR = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], employee: { id: "e-hr" } };
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => HR } });

process.env.TIMEREX_WEBHOOK_SECRET = "test-secret-value-long-enough";
process.env.TIMEREX_CASUAL_INTERVIEW_URL = "https://timerex.net/s/eight_hr/c0a1b2c3";
const origWarn = console.warn;
console.warn = (...a) => { warned.push(a.join(" ")); };

const { default: webhook } = await import(atRoot("api/hr/timerex/webhook.js"));
const { default: interviewsApi } = await import(atRoot("api/hr/interviews/index.js"));
const { applyTimerexEvent } = await import(atRoot("lib/hr-timerex.js"));
const { kindForCalendar, timerexCalendarMap } = await import(atRoot("lib/hr-timerex-calendars.js"));

const res = () => { const r = { statusCode: 0, body: null }; r.setHeader = () => {}; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const AUTH = { "x-timerex-authorization": "test-secret-value-long-enough" };
const hook = async (body) => { const r = res(); await webhook({ method: "POST", headers: AUTH, body }, r); return r; };
const patchIv = async (body) => { const r = res(); await interviewsApi({ method: "PATCH", headers: { authorization: "Bearer x" }, url: "/api/hr/interviews", body }, r); return r; };

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const payload = (over = {}, evOver = {}) => {
  const p = copy(FIXTURE);
  Object.assign(p, over);
  Object.assign(p.event, evOver);
  return p;
};
const casualPayload = (evOver = {}) => payload({ calendar_url_path: "c0a1b2c3" }, { id: "evt_casual_1",
  start_datetime: "2026-10-02T01:00:00Z", ...evOver });

function setup() {
  logged.length = 0; notified.length = 0; warned.length = 0;
  db.rows = {
    gw_hr_applicants: [
      // 社長面談待ち（CEO REVIEW で社長面談の日程調整に進んだ人）
      { id: "a-ceo", tenant_id: "t1", name: "匿名 候補者", email: "candidate@example.test", stage: "ceo_recommend", status: "ceo_interview_pending" },
      // カジュアル面談の日程調整中
      { id: "a-cas", tenant_id: "t1", name: "匿名 応募者", email: "casual@example.test", stage: "applied", status: "scheduling" },
    ],
    gw_hr_interviews: [], gw_hr_timeline: [],
    memberships: [], gw_employees: [{ id: "e-owner", tenant_id: "t1", user_id: "u-owner", status: "active" }],
    gw_role_grants: [{ employee_id: "e-owner", role: "owner" }],
  };
}
const ivs = () => db.rows.gw_hr_interviews;
const app = (id) => db.rows.gw_hr_applicants.find((a) => a.id === id);

console.log("\n— 予約枠の設定（1か所） —");
await ok("calendar_url_path → 面談の種類。カジュアルは現行の予約URLから、社長は確認済みの予約枠", async () => {
  assert.equal(kindForCalendar("98b26445"), "ceo");
  assert.equal(kindForCalendar("eight_hr/98b26445"), "ceo");
  assert.equal(kindForCalendar("c0a1b2c3"), "casual");
  assert.equal(kindForCalendar("zzzz9999"), null, "知らない予約枠はカジュアル扱いにしない");
  assert.equal(kindForCalendar(null), null);
  const m = timerexCalendarMap({ TIMEREX_HR_CALENDARS: '{"x1":"casual","x2":"ceo","x3":"other"}' });
  assert.deepEqual([m.x1, m.x2, m.x3], ["casual", "ceo", undefined]);
});

await ok("本番のカジュアル予約URL（…/bo_43ba_dabf/b4da552f）→ b4da552f=casual、98b26445=ceo", async () => {
  const env = { TIMEREX_CASUAL_INTERVIEW_URL: "https://timerex.net/s/bo_43ba_dabf/b4da552f" };
  assert.equal(kindForCalendar("b4da552f", env), "casual");
  assert.equal(kindForCalendar("98b26445", env), "ceo");
  // Webhook を通しても、body 直下の calendar_url_path=b4da552f はカジュアル面談として入る
  const prev = process.env.TIMEREX_CASUAL_INTERVIEW_URL;
  process.env.TIMEREX_CASUAL_INTERVIEW_URL = env.TIMEREX_CASUAL_INTERVIEW_URL;
  try {
    setup();
    const r = await hook(payload({ calendar_url_path: "b4da552f" }, { id: "evt_casual_prod",
      form: [{ field_type: "guest_email", value: "casual@example.test" }] }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(ivs()[0].kind, "casual");
    assert.deepEqual([app("a-cas").stage, app("a-cas").status], ["casual_interview", "interview_scheduled"]);
  } finally { process.env.TIMEREX_CASUAL_INTERVIEW_URL = prev; }
});

console.log("\n— 予約 —");
await ok("カジュアル面談予約：kind=casual・stage=casual_interview・status=interview_scheduled", async () => {
  setup();
  const r = await hook(casualPayload({ form: [{ field_type: "guest_email", value: "casual@example.test" }] }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs().length, 1);
  assert.equal(ivs()[0].kind, "casual");
  assert.deepEqual([app("a-cas").stage, app("a-cas").status], ["casual_interview", "interview_scheduled"]);
});

await ok("社長面談予約（実 payload の形）：kind=ceo・stage=ceo_interview・status=interview_scheduled・判断者へ通知", async () => {
  setup();
  const r = await hook(payload());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs().length, 1);
  const iv = ivs()[0];
  assert.equal(iv.kind, "ceo");
  assert.equal(iv.applicant_id, "a-ceo");
  assert.equal(Date.parse(iv.scheduled_at), Date.parse("2026-10-01T07:15:00Z"));
  assert.deepEqual([app("a-ceo").stage, app("a-ceo").status], ["ceo_interview", "interview_scheduled"]);
  assert.deepEqual(notified.map((n) => [n.employeeId, n.title, n.link]), [["e-owner", "社長面談が入りました", "/hr/ceo-review.html"]]);
  assert.ok(notified[0].body.includes("10/1 16:15"), "日時は日本時間");
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.label === "社長面談が決まりました（TimeRex）"));
});

await ok("社長面談 applicant_not_found の再現：以前はカジュアル専用（scheduling でしか探さない）で見つからなかった", async () => {
  setup();
  // 以前の探し方（status=scheduling・kind=casual 固定）では、社長面談待ちの人は対象外
  assert.equal(db.rows.gw_hr_applicants.filter((a) => a.email === "candidate@example.test" && a.status === "scheduling").length, 0);
  const r = await hook(payload());
  assert.equal(r.statusCode, 200, "今は社長面談の予約枠なら ceo_interview_pending から探して見つかる");
  // 社長面談の予約枠でも、対象ステータスでなければ見つからない（勝手に紐付けない）
  setup();
  app("a-ceo").status = "eval_pending";
  const r2 = await hook(payload());
  assert.equal(r2.statusCode, 404);
  assert.equal(r2.body.error, "applicant_not_found");
  assert.equal(ivs().length, 0);
});

await ok("同じメールの候補が2名いれば自動で決めない（ambiguous_applicant）", async () => {
  setup();
  db.rows.gw_hr_applicants.push({ id: "a-dup", tenant_id: "t1", name: "別人", email: "candidate@example.test", status: "ceo_interview_pending" });
  const r = await hook(payload());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "ambiguous_applicant");
  assert.equal(ivs().length, 0);
});

await ok("payload に applicant_id があれば最優先", async () => {
  setup();
  const r = await hook(payload({ applicant_id: "a-cas", calendar_url_path: "c0a1b2c3" }, { form: [] }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs()[0].applicant_id, "a-cas");
});

await ok("Google Meet URL・日程変更・取消の導線を保存（ログ・通知には URL を入れない）", async () => {
  setup();
  await hook(payload());
  const iv = ivs()[0];
  assert.equal(iv.meeting_url, "https://meet.google.com/anon");
  assert.equal(iv.timerex_reschedule_url, "https://timerex.net/anon/guest_reschedule/ANON_RESCHEDULE_TOKEN");
  assert.equal(iv.timerex_guest_cancel_url, "https://timerex.net/anon/guest_cancel/ANON_GUEST_CANCEL_TOKEN");
  assert.equal(iv.timerex_host_cancel_url, "https://timerex.net/anon/host_cancel/ANON_HOST_CANCEL_TOKEN");
  assert.equal(iv.timerex_calendar_path, "98b26445");
  assert.ok(iv.timerex_synced_at);
  const leaked = JSON.stringify([logged, notified, warned]);
  assert.equal(/https?:|TOKEN|candidate@example/.test(leaked), false, "ログ・通知に URL・トークン・メールを残さない");
});

console.log("\n— 再送・リスケ —");
await ok("同じ Webhook の再送：面談を増やさず更新（通知も重ねない）", async () => {
  setup();
  await hook(payload());
  notified.length = 0;
  const r = await hook(payload());
  assert.equal(r.body.action, "resynced");
  assert.equal(ivs().length, 1);
  assert.equal(notified.length, 0);
});

await ok("リスケ（old_event_id → new_event_id）：既存の面談を更新し、新しい面談を増やさない", async () => {
  setup();
  await hook(payload());
  const r = await hook(payload({}, { id: "evt_anon_ceo_0002", start_datetime: "2026-10-03T02:00:00Z",
    is_changed: true, old_event_id: "evt_anon_ceo_0001", new_event_id: "evt_anon_ceo_0002" }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, "rescheduled");
  assert.equal(ivs().length, 1);
  assert.equal(ivs()[0].timerex_event_id, "evt_anon_ceo_0002");
  assert.equal(ivs()[0].scheduled_at, "2026-10-03T02:00:00Z");
  assert.ok(notified.some((n) => n.title === "社長面談の日程が変わりました"));
});

console.log("\n— キャンセル（受信できる形だけ用意。event 名は実ログで確認してから有効にする） —");
await ok("キャンセルの event 名が未設定なら、推測せず止める（名前だけ記録）", async () => {
  setup();
  await hook(payload());
  const r = await hook(payload({ webhook_type: "TEST_CANCEL_TYPE" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "unsupported_webhook_type");
  assert.equal(ivs()[0].canceled_at ?? null, null, "面談は変わらない");
  assert.ok(warned.some((w) => w.includes("TEST_CANCEL_TYPE")));
  assert.equal(/candidate@|https?:/.test(warned.join(" ")), false);
});

await ok("社長面談キャンセル後 → stage=ceo_interview・status=ceo_interview_pending（物理削除しない）", async () => {
  setup();
  await hook(payload());
  process.env.TIMEREX_CANCEL_WEBHOOK_TYPES = "TEST_CANCEL_TYPE";
  try {
    const r = await hook(payload({ webhook_type: "TEST_CANCEL_TYPE" }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, "canceled");
  } finally { delete process.env.TIMEREX_CANCEL_WEBHOOK_TYPES; }
  assert.equal(ivs().length, 1);
  assert.ok(ivs()[0].canceled_at);
  assert.deepEqual([app("a-ceo").stage, app("a-ceo").status], ["ceo_interview", "ceo_interview_pending"]);
});

await ok("カジュアル面談キャンセル後 → status=scheduling", async () => {
  setup();
  await hook(casualPayload({ form: [{ field_type: "guest_email", value: "casual@example.test" }] }));
  const r = await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "evt_casual_1", applicantId: "a-cas" });
  assert.equal(r.action, "canceled");
  assert.ok(ivs()[0].canceled_at);
  assert.equal(app("a-cas").status, "scheduling");
});

console.log("\n— 知らない予約枠 —");
await ok("不明な calendar_url_path は安全に停止（422 unknown_timerex_calendar・何も書かない）", async () => {
  setup();
  for (const path of ["zzzz9999", null]) {
    const r = await hook(payload({ calendar_url_path: path }));
    assert.equal(r.statusCode, 422, JSON.stringify(r.body));
    assert.equal(r.body.error, "unknown_timerex_calendar");
  }
  assert.equal(ivs().length, 0);
  assert.equal(app("a-ceo").status, "ceo_interview_pending");
});

console.log("\n— 実 payload の構造 —");
await ok("fixture は実 payload と同じ階層（calendar_url_path は body 直下）で、社長面談待ち → 面談予定になる", async () => {
  assert.equal(FIXTURE.calendar_url_path, "98b26445");
  assert.equal("calendar_url_path" in FIXTURE.event, false, "event の中には無い");
  for (const k of ["guest_reschedule_url", "guest_cancel_url", "host_cancel_url"]) assert.ok(FIXTURE.event[k], `event.${k}`);
  setup();
  assert.equal(app("a-ceo").status, "ceo_interview_pending");
  const r = await hook(copy(FIXTURE));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([app("a-ceo").stage, app("a-ceo").status], ["ceo_interview", "interview_scheduled"]);
  const iv = ivs()[0];
  assert.deepEqual([iv.kind, iv.timerex_event_id, iv.meeting_url, iv.timerex_calendar_path],
    ["ceo", "evt_anon_ceo_0001", "https://meet.google.com/anon", "98b26445"]);
});

console.log("\n— DEBUG ログ —");
await ok("TIMEREX_WEBHOOK_DEBUG_LOG=1 でも payload 全体は出さない（メール・氏名・URL・Secret なし）", async () => {
  setup();
  const lines = [];
  const origLog = console.log;
  process.env.TIMEREX_WEBHOOK_DEBUG_LOG = "1";
  console.log = (...a) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  try { await hook(copy(FIXTURE)); } finally { console.log = origLog; delete process.env.TIMEREX_WEBHOOK_DEBUG_LOG; }
  const out = lines.join("\n");
  const dbg = lines.find((l) => l.startsWith("[timerex-webhook][debug]"));
  assert.ok(dbg, "DEBUG の1行は出る");
  const j = JSON.parse(dbg.replace("[timerex-webhook][debug] ", ""));
  assert.deepEqual(j, { webhook_type: "event_confirmed", calendar_url_path: "98b26445", event_id: "evt_anon_ceo_0001",
    is_changed: false, old_event_id: null, new_event_id: null,
    form_field_types: ["company_name", "guest_name", "guest_email", "guest_comment"] });
  assert.equal(/candidate@example|匿名候補者|https?:|TOKEN|meet\.google|test-secret-value/.test(out), false,
    "メール・氏名・URL・トークン・Secret を出さない");
});

console.log("\n— HR 画面からの操作（手動面談と TimeRex 面談を分ける） —");
await ok("手動登録の面談は、HR から日時・Meet URL を変更できる", async () => {
  setup();
  db.rows.gw_hr_interviews.push({ id: "iv-manual", tenant_id: "t1", applicant_id: "a-cas", kind: "casual",
    scheduled_at: "2026-10-05T01:00:00Z", meeting_url: null, timerex_event_id: null });
  const r = await patchIv({ id: "iv-manual", action: "update", scheduledAt: "2026-10-06T01:00:00Z", meetingUrl: "https://meet.google.com/new-url-xyz" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs()[0].scheduled_at, "2026-10-06T01:00:00Z");
  assert.equal(r.body.interview.timerex, null, "手動の面談は TimeRex 連携なし");
});

await ok("TimeRex 面談は HR から日時・Meet URL・キャンセルを直接変更できない（409 timerex_managed）。評価系は入力できる", async () => {
  setup();
  await hook(payload());
  const id = ivs()[0].id;
  const before = ivs()[0].scheduled_at;
  for (const body of [{ action: "update", scheduledAt: "2026-10-09T01:00:00Z" }, { action: "update", meetingUrl: "https://meet.google.com/x" },
    { action: "cancel" }]) {
    const r = await patchIv({ id, ...body });
    assert.equal(r.statusCode, 409, JSON.stringify(body));
    assert.equal(r.body.error, "timerex_managed");
  }
  assert.equal(ivs()[0].scheduled_at, before);
  assert.equal(ivs()[0].canceled_at ?? null, null);
  const notes = await patchIv({ id, action: "update", notes: "当日の確認事項" });
  assert.equal(notes.statusCode, 200, JSON.stringify(notes.body));
  assert.equal(notes.body.interview.timerex.linked, true);
  assert.equal(notes.body.interview.timerex.rescheduleUrl, "https://timerex.net/anon/guest_reschedule/ANON_RESCHEDULE_TOKEN");
  assert.equal(notes.body.interview.timerex.cancelUrl, "https://timerex.net/anon/host_cancel/ANON_HOST_CANCEL_TOKEN", "取消は主催者用を優先");
});

console.warn = origWarn;
console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
