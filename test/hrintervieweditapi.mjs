// 採用HR：面談情報の編集・面談メモ（api/hr/interviews/index.js の update / memo）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか（db/109_hr_interview_edit.sql）
//
//   1. 面談設定後も、日時・面談担当・面談方法・面談URLを直せる。空で送れば未定に戻せる
//   2. 日時を変えたら、選考タイムライン（JST表記）と監査ログに残る。値が同じなら何も残さない
//   3. 入力チェック（日時の形式・面談方法・URLのスキーム・別の会社の面談担当）
//   4. 別の会社（テナント）の面談は、編集もメモもできない
//   5. キャンセル済みの面談は予定を直せない（メモは書ける）
//   6. 日時を変えたら、応募者一覧・応募者詳細・今日の面談の3か所すべてに反映される
//   7. 面談メモは面談ごとに保存・編集・削除でき、応募者全体のメモ（note）とは混ざらない。
//      監査ログにメモの中身は残さない
//   8. TimeRex同期済みの面談：日時・面談URLはTimeRex側が正（409で断る）。
//      面談担当・面談方法・メモは直せる。TimeRexへは何も送らない（fetchを呼ばない）。
//      そのあとWebhookが再送されても、アプリで直した面談担当・面談方法・メモは消えない
//   9. TimeRex Webhookは、Google MeetのURLなら面談方法が未設定のときだけ「オンライン」を入れる。
//      設定済みの面談方法は上書きしない。Meet以外・URLなしは触らない。109未適用でも止まらない
//  10. 面談を予定するときも、面談担当は同じ会社の社員だけ（編集と同じ規則）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "neq") return r[k] !== v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      if (op === "is") return v === null ? r[k] == null : r[k] != null;
      if (op === "not_is") return v === null ? r[k] != null : r[k] == null;
      if (op === "gte") return r[k] != null && r[k] >= v;
      if (op === "lte") return r[k] != null && r[k] <= v;
      if (op === "lt") return r[k] != null && r[k] < v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : 0));
    return out;
  };
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    not(k, op, v) { f.push(["not_is", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    lte(k, v) { f.push(["lte", k, v]); return q; },
    lt(k, v) { f.push(["lt", k, v]); return q; },
    order(col) { order = col; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    insert(row) {
      if (db.noMethodColumn && name === "gw_hr_interviews" && [].concat(row).some((r) => "method" in r)) {
        const r3 = { select: () => r3, single: missingMethod, then: (fn) => missingMethod().then(fn) };
        return r3;
      }
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
        then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        if (db.noMethodColumn && name === "gw_hr_interviews" && "method" in patch) return missingMethod();
        // 109未適用（列が無い）ときの PostgREST の返し方をまねる
        if (db.failUpdate === name) {
          return Promise.resolve({ data: null, error: { code: "42703", message: `column "memo" of relation "${name}" does not exist` } });
        }
        const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    upsert(rowsIn, opts = {}) {
      const list = [].concat(rowsIn);
      const keyOf = (r) => (opts.onConflict || "id").split(",").map((k) => r[k]).join("|");
      const made = [];
      for (const r of list) {
        const k = keyOf(r);
        const idx = (db.rows[name] || []).findIndex((x) => keyOf(x) === k);
        if (idx >= 0) {
          if (opts.ignoreDuplicates) continue;
          Object.assign(db.rows[name][idx], r);
          made.push(db.rows[name][idx]);
        } else {
          const row = { id: r.id || `${name}-${(db.rows[name] || []).length + 1}`, ...r };
          (db.rows[name] = db.rows[name] || []).push(row);
          made.push(row);
        }
      }
      const r2 = {
        select: () => r2,
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);
// 109未適用の環境で method 列へ書こうとしたときの PostgREST のエラー
const missingMethod = () => Promise.resolve({ data: null, error: { code: "PGRST204",
  message: "Could not find the 'method' column of 'gw_hr_interviews' in the schema cache" } });

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "emp-r1", display_name: "採用 花子" } };
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "emp-m1", display_name: "一般 次郎" } };
let who = RECRUITER;
// 判定は本物（lib/gw.js）を使う
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), {
  namedExports: { ...REAL_GW, gwContext: async () => who },
});

// TimeRex等の外部へは何も送らないことを確かめる（このAPIはfetchを一切呼ばないはず）
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error(`外部へ送ろうとした: ${url}`); };

const { default: interviews } = await import(atRoot("api/hr/interviews/index.js"));
const { default: today } = await import(atRoot("api/hr/interviews/today.js"));
const { default: applicantsApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { applyTimerexEvent } = await import(atRoot("lib/hr-timerex.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const schedule = (body) => call(interviews, { method: "POST", url: "/api/hr/interviews", body });
const act = (body) => call(interviews, { method: "PATCH", url: "/api/hr/interviews", body });
const edit = (body) => act({ ...body, action: "update" });
const memo = (id, text) => act({ id, action: "memo", memo: text });
const getToday = () => call(today, { method: "GET", url: "/api/hr/interviews/today" });
const getList = () => call(applicantsApi, { method: "GET", url: "/api/hr/applicants" });
const getDetail = (id) => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

function setup() {
  who = RECRUITER;
  db.missing = null;
  db.failUpdate = null;
  db.noMethodColumn = false;
  logged.length = 0;
  fetched.length = 0;
  db.rows = {
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", source: "リファラル",
        stage: "applied", status: "todo", rank: null, decision: null, decision_due_on: null,
        recruiter_id: null, note: "応募者全体のメモ", created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" },
      { id: "b1", tenant_id: "t2", name: "他社 応募者", stage: "casual_interview", status: "interview_scheduled",
        created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" },
    ],
    gw_hr_interviews: [
      { id: "iv-b1", tenant_id: "t2", applicant_id: "b1", kind: "casual", scheduled_at: "2026-10-01T05:00:00Z",
        conducted_at: null, canceled_at: null, interviewer_id: null, meeting_url: "https://meet.example.com/b" },
    ],
    gw_hr_timeline: [], gw_hr_offers: [], gw_notifications: [],
    gw_employees: [
      { id: "e1", tenant_id: "t1", display_name: "面接 花子", status: "active" },
      { id: "e2", tenant_id: "t1", display_name: "面接 一郎", status: "active" },
      { id: "e9", tenant_id: "t2", display_name: "他社 社員", status: "active" },
    ],
  };
}

/** 手入力で面談を1件予定して、その行を返す */
async function manualInterview(over = {}) {
  const r = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: "2026-10-05T05:00:00Z",
    interviewerId: "e1", meetingUrl: "https://meet.example.com/manual", ...over });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return db.rows.gw_hr_interviews.find((i) => i.id === r.body.interview.id);
}

/** TimeRex Webhook（正規化済みイベント）で面談を1件作って、その行を返す */
async function timerexInterview() {
  const r = await applyTimerexEvent({ kind: "casual", type: "booked", eventId: "ev1", applicantId: "a1",
    scheduledAt: "2026-10-06T01:00:00Z", meetingUrl: "https://meet.google.com/abc-defg-hij" });
  assert.equal(r.action, "created", JSON.stringify(r));
  logged.length = 0;
  return db.rows.gw_hr_interviews.find((i) => i.timerex_event_id === "ev1");
}

console.log("\n=== 面談情報の編集（update） ===\n");

await ok("日時・面談担当・面談方法・面談URLをまとめて直せる", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, scheduledAt: "2026-10-07T06:30:00Z", interviewerId: "e2",
    method: "onsite", meetingUrl: "https://meet.example.com/new" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_hr_interviews.find((i) => i.id === iv.id);
  assert.equal(row.scheduled_at, "2026-10-07T06:30:00Z");
  assert.equal(row.interviewer_id, "e2");
  assert.equal(row.method, "onsite");
  assert.equal(row.meeting_url, "https://meet.example.com/new");
  assert.equal(r.body.interview.methodLabel, "対面");
  assert.deepEqual([...r.body.changed].sort(), ["interviewer_id", "meeting_url", "method", "scheduled_at"]);
});

await ok("面談を予定するときにも面談方法を入れられる", async () => {
  setup();
  const iv = await manualInterview({ method: "online" });
  assert.equal(iv.method, "online");
});

await ok("空（null）で送ると、面談担当・面談方法・面談URL・日時を未定に戻せる", async () => {
  setup();
  const iv = await manualInterview({ method: "phone" });
  const r = await edit({ id: iv.id, interviewerId: null, method: null, meetingUrl: "", scheduledAt: null });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_hr_interviews.find((i) => i.id === iv.id);
  assert.equal(row.interviewer_id, null);
  assert.equal(row.method, null);
  assert.equal(row.meeting_url, null);
  assert.equal(row.scheduled_at, null);
});

await ok("日時を変えると、選考タイムラインにJSTの新しい日時で残る", async () => {
  setup();
  const iv = await manualInterview();
  await edit({ id: iv.id, scheduledAt: "2026-10-07T06:30:00Z" });
  const t = db.rows.gw_hr_timeline.at(-1);
  assert.equal(t.event_key, "interview_rescheduled");
  assert.equal(t.label, "カジュアル面談の日時を変更");
  assert.equal(t.detail, "2026/10/7 15:30", "UTC 06:30 = JST 15:30");
});

await ok("監査ログに、変えた項目と日時の前後が残る（URL等の値そのものは残さない）", async () => {
  setup();
  const iv = await manualInterview();
  logged.length = 0;
  await edit({ id: iv.id, scheduledAt: "2026-10-07T06:30:00Z", meetingUrl: "https://meet.example.com/secret" });
  const l = logged.find((x) => x.action === "hr.interview_update");
  assert.ok(l, "hr.interview_update が残る");
  assert.equal(l.target, `hr_interview:${iv.id}`);
  assert.deepEqual([...l.detail.fields].sort(), ["meeting_url", "scheduled_at"]);
  assert.equal(l.detail.scheduledFrom, "2026-10-05T05:00:00Z");
  assert.equal(l.detail.scheduledTo, "2026-10-07T06:30:00Z");
  assert.equal(l.detail.timerex, false);
  assert.ok(!JSON.stringify(l).includes("secret"), "URLは監査ログに入れない");
});

await ok("値が変わっていなければ、タイムライン・監査ログに何も残さない", async () => {
  setup();
  const iv = await manualInterview();
  logged.length = 0;
  const before = db.rows.gw_hr_timeline.length;
  const r = await edit({ id: iv.id, scheduledAt: "2026-10-05T14:00:00+09:00", interviewerId: "e1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed, [], "同じ時刻（表記ゆれ）は変更扱いにしない");
  assert.equal(db.rows.gw_hr_timeline.length, before);
  assert.equal(logged.length, 0);
});

await ok("応募者の状態・選考ステージは動かさない", async () => {
  setup();
  const iv = await manualInterview();
  await edit({ id: iv.id, scheduledAt: "2026-10-07T06:30:00Z" });
  const a = db.rows.gw_hr_applicants.find((x) => x.id === "a1");
  assert.equal(a.status, "interview_scheduled");
  assert.equal(a.stage, "casual_interview");
});

await ok("update で受け付ける項目は main と同じ（評価の所感なども入力できる）。面談方法も一緒に保存できる", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, notes: "当日の確認事項", method: "online" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_hr_interviews.find((i) => i.id === iv.id);
  assert.equal(row.notes, "当日の確認事項");
  assert.equal(row.method, "online");
  // 同じ値をもう一度送っても「変更」にならない
  const again = await edit({ id: iv.id, notes: "当日の確認事項", method: "online" });
  assert.deepEqual(again.body.changed, []);
});

console.log("\n=== 入力チェック ===\n");

await ok("日時として読めない値は断る", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, scheduledAt: "来週の火曜" });
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).scheduled_at, "2026-10-05T05:00:00Z");
});

await ok("面談方法は online / onsite / phone だけ", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, method: "video" });
  assert.equal(r.statusCode, 400);
  assert.equal((await schedule({ applicantId: "a1", kind: "ceo", method: "zoom" })).statusCode, 400);
});

await ok("http(s)以外の面談URLは断る", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, meetingUrl: "javascript:alert(1)" });
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).meeting_url, "https://meet.example.com/manual");
});

await ok("更新する項目が1つもなければ断る", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id });
  assert.equal(r.statusCode, 400);
});

await ok("別の会社の社員は、面談担当にできない", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, interviewerId: "e9" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_interviewer");
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).interviewer_id, "e1");
});

console.log("\n=== テナント分離・権限 ===\n");

await ok("別の会社の面談は編集できない（404。中身も変わらない）", async () => {
  setup();
  const r = await edit({ id: "iv-b1", scheduledAt: "2026-10-09T00:00:00Z" });
  assert.equal(r.statusCode, 404);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === "iv-b1").scheduled_at, "2026-10-01T05:00:00Z");
});

await ok("別の会社の面談には、メモも書けない", async () => {
  setup();
  const r = await memo("iv-b1", "書き換え");
  assert.equal(r.statusCode, 404);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === "iv-b1").memo, undefined);
});

await ok("一般メンバーは、面談の編集もメモもできない", async () => {
  setup();
  const iv = await manualInterview();
  who = MEMBER;
  assert.equal((await edit({ id: iv.id, method: "online" })).statusCode, 403);
  assert.equal((await memo(iv.id, "メモ")).statusCode, 403);
});

console.log("\n=== キャンセル済み・実施済み ===\n");

await ok("キャンセル済みの面談は、日時等を直せない（409）", async () => {
  setup();
  const iv = await manualInterview();
  await act({ id: iv.id, action: "cancel" });
  const r = await edit({ id: iv.id, scheduledAt: "2026-10-09T00:00:00Z" });
  assert.equal(r.statusCode, 409);
});

await ok("キャンセル済みの面談にも、メモは書ける", async () => {
  setup();
  const iv = await manualInterview();
  await act({ id: iv.id, action: "cancel" });
  const r = await memo(iv.id, "候補者都合でキャンセル");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.interview.memo, "候補者都合でキャンセル");
});

await ok("実施済みの面談にも、メモを書ける", async () => {
  setup();
  const iv = await manualInterview();
  await act({ id: iv.id, action: "conduct" });
  const r = await memo(iv.id, "実施後のメモ");
  assert.equal(r.statusCode, 200);
});

console.log("\n=== 日時の変更が、一覧・詳細・今日の面談へ反映される ===\n");

await ok("応募者詳細：面談の日時とNEXT ACTIONが新しい日時になる", async () => {
  setup();
  const iv = await manualInterview();
  await edit({ id: iv.id, scheduledAt: "2026-10-07T06:30:00Z", method: "online" });
  const r = await getDetail("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const got = r.body.interviews.find((i) => i.id === iv.id);
  assert.equal(got.scheduledAt, "2026-10-07T06:30:00Z");
  assert.equal(got.methodLabel, "オンライン");
  assert.equal(r.body.applicant.nextAction, "2026/10/7 15:30 カジュアル面談", "JSTで出す");
});

await ok("応募者一覧：直近の面談日時とNEXT ACTIONが新しい日時になる", async () => {
  setup();
  const iv = await manualInterview();
  await edit({ id: iv.id, scheduledAt: "2026-10-07T06:30:00Z" });
  const r = await getList();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a = r.body.applicants.find((x) => x.id === "a1");
  assert.equal(a.nextInterviewAt, "2026-10-07T06:30:00Z");
  assert.equal(a.nextAction, "2026/10/7 15:30 カジュアル面談");
});

await ok("応募者一覧：キャンセル済み・実施済みの面談は直近の面談に数えない", async () => {
  setup();
  const iv = await manualInterview();
  await act({ id: iv.id, action: "cancel" });
  const r = await getList();
  const a = r.body.applicants.find((x) => x.id === "a1");
  assert.equal(a.nextInterviewAt, null);
});

await ok("今日の面談：今日へ動かせば出て、別の日へ動かせば消える", async () => {
  setup();
  const iv = await manualInterview();
  // 作った面談は固定の日付（2026-10-05）。その日（日本時間）にこのテストを回すと最初から「今日」になるので、
  // まず確実に今日ではない日へ動かしてから確かめる（日付によって落ちないように）
  await edit({ id: iv.id, scheduledAt: "2020-01-01T01:00:00Z" });
  assert.equal((await getToday()).body.interviews.length, 0);
  await edit({ id: iv.id, scheduledAt: `${jstToday()}T01:00:00Z` });
  const r1 = await getToday();
  assert.equal(r1.body.interviews.length, 1);
  assert.equal(r1.body.interviews[0].scheduledAt, `${jstToday()}T01:00:00Z`);
  await edit({ id: iv.id, scheduledAt: "2020-01-01T01:00:00Z" });
  assert.equal((await getToday()).body.interviews.length, 0);
});

console.log("\n=== 面談メモ（memo） ===\n");

await ok("面談ごとにメモを保存でき、詳細で再表示される", async () => {
  setup();
  const iv = await manualInterview();
  const r = await memo(iv.id, "  志望動機が明確。\r\n次回は年収の希望を確認  ");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_hr_interviews.find((i) => i.id === iv.id);
  assert.equal(row.memo, "志望動機が明確。\n次回は年収の希望を確認", "前後の空白を落とし、改行はそのまま");
  assert.ok(row.memo_updated_at);
  assert.equal(row.memo_updated_by, "u-1");
  const d = await getDetail("a1");
  assert.equal(d.body.interviews.find((i) => i.id === iv.id).memo, "志望動機が明確。\n次回は年収の希望を確認");
});

await ok("メモを編集（上書き）できる", async () => {
  setup();
  const iv = await manualInterview();
  await memo(iv.id, "1回目");
  await memo(iv.id, "2回目に直した");
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).memo, "2回目に直した");
});

await ok("空で保存するとメモが消える", async () => {
  setup();
  const iv = await manualInterview();
  await memo(iv.id, "消す予定");
  const r = await memo(iv.id, "   ");
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).memo, null);
});

await ok("メモは面談ごと：別の面談・応募者全体のメモ（note）・評価の所感（notes）には入らない", async () => {
  setup();
  const iv1 = await manualInterview();
  const iv2 = await manualInterview({ kind: "ceo" });
  await memo(iv1.id, "カジュアル面談のメモ");
  const rows = db.rows.gw_hr_interviews;
  assert.equal(rows.find((i) => i.id === iv2.id).memo, undefined);
  assert.equal(rows.find((i) => i.id === iv1.id).notes, undefined);
  assert.equal(db.rows.gw_hr_applicants.find((a) => a.id === "a1").note, "応募者全体のメモ");
});

await ok("4000文字を超えるメモは断る。4000文字ちょうどは保存できる", async () => {
  setup();
  const iv = await manualInterview();
  assert.equal((await memo(iv.id, "あ".repeat(4001))).statusCode, 400);
  assert.equal((await memo(iv.id, "あ".repeat(4000))).statusCode, 200);
});

await ok("memoが無い・文字列でないリクエストは断る", async () => {
  setup();
  const iv = await manualInterview();
  assert.equal((await act({ id: iv.id, action: "memo" })).statusCode, 400);
  assert.equal((await act({ id: iv.id, action: "memo", memo: { x: 1 } })).statusCode, 400);
});

await ok("監査ログには、メモの中身を残さない（文字数だけ）", async () => {
  setup();
  const iv = await manualInterview();
  logged.length = 0;
  await memo(iv.id, "機微な所感");
  const l = logged.find((x) => x.action === "hr.interview_memo");
  assert.ok(l);
  assert.equal(l.detail.length, 5);
  assert.ok(!JSON.stringify(l).includes("機微な所感"));
});

await ok("109未適用の環境では、SQLの実行を案内する（503）", async () => {
  setup();
  const iv = await manualInterview();
  db.failUpdate = "gw_hr_interviews";
  const r1 = await memo(iv.id, "x");
  const r2 = await edit({ id: iv.id, method: "online" });
  db.failUpdate = null;
  assert.equal(r1.statusCode, 503, JSON.stringify(r1.body));
  assert.match(r1.body.message, /109_hr_interview_edit\.sql/);
  assert.equal(r2.statusCode, 503);
});

console.log("\n=== TimeRex同期済みの面談（TimeRex側が正） ===\n");

await ok("TimeRex同期済みの面談は、日時を変えられない（409・DBも変わらない）", async () => {
  setup();
  const iv = await timerexInterview();
  const r = await edit({ id: iv.id, scheduledAt: "2026-10-09T01:00:00Z" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "timerex_managed");
  assert.deepEqual(r.body.fields, ["scheduled_at"]);
  assert.match(r.body.hint, /TimeRexから行ってください/);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).scheduled_at, "2026-10-06T01:00:00Z");
  assert.equal(logged.length, 0);
});

await ok("TimeRex同期済みの面談は、面談URLも変えられない", async () => {
  setup();
  const iv = await timerexInterview();
  const r = await edit({ id: iv.id, meetingUrl: "https://meet.example.com/other" });
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).meeting_url, "https://meet.google.com/abc-defg-hij");
});

await ok("TimeRex同期済みでも、面談担当・面談方法は直せる（同じ日時・URLを一緒に送っても通る）", async () => {
  setup();
  const iv = await timerexInterview();
  const r = await edit({ id: iv.id, interviewerId: "e2", method: "phone",
    scheduledAt: "2026-10-06T10:00:00+09:00", meetingUrl: "https://meet.google.com/abc-defg-hij" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([...r.body.changed].sort(), ["interviewer_id", "method"]);
  assert.equal(r.body.interview.fromTimerex, true);
  const l = logged.find((x) => x.action === "hr.interview_update");
  assert.equal(l.detail.timerex, true);
});

await ok("TimeRex同期済みでも、メモは書ける", async () => {
  setup();
  const iv = await timerexInterview();
  const r = await memo(iv.id, "TimeRexで予約された面談のメモ");
  assert.equal(r.statusCode, 200);
});

await ok("編集・メモ保存のどれでも、TimeRex等の外部へは何も送らない", async () => {
  setup();
  const iv = await timerexInterview();
  await edit({ id: iv.id, interviewerId: "e2", method: "online" });
  await edit({ id: iv.id, scheduledAt: "2026-10-09T01:00:00Z" });
  await memo(iv.id, "メモ");
  const m = await manualInterview({ kind: "ceo" });
  await edit({ id: m.id, scheduledAt: "2026-10-09T01:00:00Z" });
  assert.deepEqual(fetched, []);
});

await ok("そのあとTimeRexから日程変更が届くと、日時・URLはTimeRexの値になり、面談担当・面談方法・メモは残る", async () => {
  setup();
  const iv = await timerexInterview();
  await edit({ id: iv.id, interviewerId: "e2", method: "onsite" });
  await memo(iv.id, "残したいメモ");
  const r = await applyTimerexEvent({ kind: "casual", type: "booked", eventId: "ev1", applicantId: "a1",
    scheduledAt: "2026-10-10T02:00:00Z", meetingUrl: "https://meet.google.com/new-room" });
  assert.equal(r.action, "resynced");
  const row = db.rows.gw_hr_interviews.find((i) => i.id === iv.id);
  assert.equal(row.scheduled_at, "2026-10-10T02:00:00Z");
  assert.equal(row.meeting_url, "https://meet.google.com/new-room");
  assert.equal(row.interviewer_id, "e2");
  assert.equal(row.method, "onsite", "HRが入れた面談方法はWebhookで上書きしない");
  assert.equal(row.memo, "残したいメモ");
});

await ok("手入力の面談をTimeRexが引き継いだあとは、日時はTimeRex側が正になる（メモ・面談担当は残る）", async () => {
  setup();
  const iv = await manualInterview();
  await memo(iv.id, "手入力のときに書いたメモ");
  // 手入力のうちは、日時を直せる
  assert.equal((await edit({ id: iv.id, scheduledAt: "2026-10-08T01:00:00Z" })).statusCode, 200);
  const r = await applyTimerexEvent({ kind: "casual", type: "booked", eventId: "ev-adopt", applicantId: "a1",
    scheduledAt: "2026-10-11T01:00:00Z", meetingUrl: "https://meet.google.com/adopted" });
  assert.equal(r.action, "adopted_manual");
  const row = db.rows.gw_hr_interviews.find((i) => i.id === iv.id);
  assert.equal(row.memo, "手入力のときに書いたメモ");
  assert.equal(row.interviewer_id, "e1");
  const r2 = await edit({ id: iv.id, scheduledAt: "2026-10-12T01:00:00Z" });
  assert.equal(r2.statusCode, 409, "引き継いだあとはTimeRex側で変える");
});

console.log("\n=== TimeRex Webhookと面談方法（Google Meetなら未設定のときだけオンライン） ===\n");

const MEET = "https://meet.google.com/abc-defg-hij";
const tx = (over = {}) => applyTimerexEvent({ kind: "casual", type: "booked", eventId: "ev1", applicantId: "a1",
  scheduledAt: "2026-10-06T01:00:00Z", meetingUrl: MEET, ...over });
const txRow = (eventId = "ev1") => db.rows.gw_hr_interviews.find((i) => i.timerex_event_id === eventId);

await ok("Google MeetのURLで新しく予約されると、面談方法がオンラインになる", async () => {
  setup();
  const r = await tx();
  assert.equal(r.action, "created");
  assert.equal(txRow().method, "online");
});

await ok("Meet以外のURLなら、面談方法は未設定のまま", async () => {
  setup();
  await tx({ meetingUrl: "https://zoom.us/j/123" });
  assert.equal(txRow().method, undefined);
  setup();
  await tx({ meetingUrl: "http://meet.google.com/abc" });
  assert.equal(txRow().method, undefined, "httpsでなければMeetとみなさない");
  setup();
  await tx({ meetingUrl: "https://meet.google.com.evil.example/abc" });
  assert.equal(txRow().method, undefined, "ホストが完全一致しなければMeetとみなさない");
});

await ok("URLなしなら、面談方法は未設定のまま", async () => {
  setup();
  await tx({ meetingUrl: undefined });
  assert.equal(txRow().method, undefined);
});

await ok("面談方法が対面に設定済みなら、再送（resynced）でも上書きしない", async () => {
  setup();
  await tx();
  const row = txRow();
  row.method = "onsite";
  const r = await tx({ scheduledAt: "2026-10-07T01:00:00Z" });
  assert.equal(r.action, "resynced");
  assert.equal(txRow().method, "onsite");
  assert.equal(txRow().scheduled_at, "2026-10-07T01:00:00Z");
});

await ok("面談方法が対面に設定済みなら、日程変更（rescheduled）でも上書きしない", async () => {
  setup();
  await tx();
  txRow().method = "onsite";
  const r = await tx({ eventId: "ev2", previousEventId: "ev1", scheduledAt: "2026-10-08T01:00:00Z" });
  assert.equal(r.action, "rescheduled");
  assert.equal(txRow("ev2").method, "onsite");
});

await ok("未設定（null）の既存TimeRex面談は、再送でMeetならオンラインになる", async () => {
  setup();
  await tx({ meetingUrl: undefined });
  txRow().method = null;   // 109適用済みで未設定
  await tx();
  assert.equal(txRow().method, "online");
});

await ok("手入力の面談を引き継ぐ（adopted_manual）とき、面談方法が未設定ならオンラインになる", async () => {
  setup();
  const iv = await manualInterview({ meetingUrl: "" });
  iv.method = null;        // 109適用済みの列（未設定）
  const r = await tx();
  assert.equal(r.action, "adopted_manual");
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).method, "online");
});

await ok("手入力の面談を引き継ぐとき、面談方法が設定済みなら変えない", async () => {
  setup();
  const iv = await manualInterview({ method: "phone" });
  const r = await tx();
  assert.equal(r.action, "adopted_manual");
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).method, "phone");
});

await ok("109未適用（method列が無い）でも、新規予約・再送・引き継ぎのWebhookは成功する", async () => {
  setup();
  db.noMethodColumn = true;
  const r1 = await tx();
  assert.equal(r1.action, "created", JSON.stringify(r1));
  assert.equal(txRow().method, undefined);
  assert.equal(txRow().meeting_url, MEET);
  const r2 = await tx({ scheduledAt: "2026-10-07T01:00:00Z" });
  assert.equal(r2.action, "resynced", JSON.stringify(r2));
  assert.equal(txRow().scheduled_at, "2026-10-07T01:00:00Z");
  setup();
  db.noMethodColumn = true;
  const iv = await manualInterview();
  const r3 = await tx({ eventId: "ev-a" });
  assert.equal(r3.action, "adopted_manual", JSON.stringify(r3));
  assert.equal(db.rows.gw_hr_interviews.find((i) => i.id === iv.id).timerex_event_id, "ev-a");
});

console.log("\n=== 面談を予定するときの面談担当（編集と同じ規則） ===\n");

await ok("別の会社の社員を面談担当にして予定しようとすると断る", async () => {
  setup();
  const r = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: "2026-10-05T05:00:00Z", interviewerId: "e9" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_interviewer");
  assert.equal(db.rows.gw_hr_interviews.filter((i) => i.tenant_id === "t1").length, 0, "面談は作られない");
  assert.equal(db.rows.gw_hr_applicants.find((a) => a.id === "a1").status, "todo", "応募者の状態も動かない");
});

await ok("存在しない社員を面談担当にして予定しようとすると断る", async () => {
  setup();
  const r = await schedule({ applicantId: "a1", kind: "casual", interviewerId: "no-such" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_interviewer");
});

await ok("同じ会社の社員なら予定できる", async () => {
  setup();
  const r = await schedule({ applicantId: "a1", kind: "casual", interviewerId: "e2" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.interview.interviewerId, "e2");
});

await ok("面談担当が空（未定）でも予定できる", async () => {
  setup();
  const r1 = await schedule({ applicantId: "a1", kind: "casual" });
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  const r2 = await schedule({ applicantId: "a1", kind: "ceo", interviewerId: "" });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.interview.interviewerId, null);
});

await ok("編集でも、存在しない社員は面談担当にできない", async () => {
  setup();
  const iv = await manualInterview();
  const r = await edit({ id: iv.id, interviewerId: "no-such" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_interviewer");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
