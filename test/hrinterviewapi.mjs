// 採用HR：面談・評価（api/hr/interviews/index.js・today.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 面談を予定すると、応募者の状態が「面談予定」へ進み、選考ステージも動く
//   2. 同じ種別の未実施の面談が既にあれば、二重登録を断る
//   3. 実施済みにすると、状態が「評価入力待ち」へ進む
//   4. 評価を保存すると、ランクから対応ステータスが機械的に決まる（承認はしない）
//   5. 今日の面談だけを、時刻順に返す
//   6. recruiterロールだけの人も使える。一般メンバーは使えない
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
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canRecruit: (c) => Boolean(c?.isAdmin || c?.isHr || (c?.roles || []).includes("recruiter")),
  },
});

const { default: interviews } = await import(atRoot("api/hr/interviews/index.js"));
const { default: today } = await import(atRoot("api/hr/interviews/today.js"));
const { default: evalReminderCron } = await import(atRoot("api/cron/hr-interviews.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const schedule = (body) => call(interviews, { method: "POST", url: "/api/hr/interviews", body });
const act = (body) => call(interviews, { method: "PATCH", url: "/api/hr/interviews", body });
const getToday = () => call(today, { method: "GET", url: "/api/hr/interviews/today" });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = RECRUITER;
  db.missing = null;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [{
      id: "a1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", source: "リファラル",
      stage: "applied", status: "todo", rank: null, decision: null, decision_due_on: null,
      recruiter_id: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z",
    }],
    gw_hr_interviews: [], gw_hr_timeline: [], gw_notifications: [], gw_employees: [
      { id: "e1", tenant_id: "t1", display_name: "面接 花子" },
    ],
  };
}
const runCron = () => call(evalReminderCron, { method: "GET", url: "/api/cron/hr-interviews" });
const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

console.log("\n=== 面談を予定する（POST /api/hr/interviews） ===\n");

await ok("予定すると、応募者の状態が「面談予定」へ進む", async () => {
  setup();
  const r = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z`, interviewerId: "e1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.interview.kind, "casual");
  const a = db.rows.gw_hr_applicants[0];
  assert.equal(a.status, "interview_scheduled");
  assert.equal(a.stage, "casual_interview");
});

await ok("選考タイムラインに残る", async () => {
  setup();
  await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  assert.equal(db.rows.gw_hr_timeline.length, 1);
  assert.equal(db.rows.gw_hr_timeline[0].event_key, "interview_scheduled");
});

await ok("監査ログに残る", async () => {
  setup();
  await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  assert.ok(logged.some((l) => l.action === "hr.interview_schedule"));
});

await ok("同じ種別の未実施の面談があれば、二重登録を断る", async () => {
  setup();
  await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  const r = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T06:00:00Z` });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_scheduled");
});

await ok("実施済みのものがあれば、次を予定できる", async () => {
  setup();
  const first = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  await act({ id: first.body.interview.id, action: "conduct" });
  const r = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T09:00:00Z` });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("種別が違えば、二重登録にならない（カジュアルと社長は別）", async () => {
  setup();
  await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  const r = await schedule({ applicantId: "a1", kind: "ceo", scheduledAt: `${jstToday()}T09:00:00Z` });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("応募者がいなければ404", async () => {
  setup();
  const r = await schedule({ applicantId: "not-exists", kind: "casual" });
  assert.equal(r.statusCode, 404);
});

console.log("\n=== 実施済みにする（conduct） ===\n");

await ok("実施済みにすると、状態が「評価入力待ち」へ進む", async () => {
  setup();
  const s = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  const r = await act({ id: s.body.interview.id, action: "conduct" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.interview.conductedAt);
  assert.equal(db.rows.gw_hr_applicants[0].status, "eval_pending");
});

console.log("\n=== 評価を保存する（evaluate） ===\n");

await ok("ランクから、対応ステータスが機械的に決まる", async () => {
  setup();
  const s = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  await act({ id: s.body.interview.id, action: "conduct" });
  const r = await act({
    id: s.body.interview.id, action: "evaluate",
    scores: { communication: "great", experience: "good" }, rank: "A",
    recommendReason: "即戦力です", nextDueOn: "2026-10-01",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "ceo_recommend_pending");
  const a = db.rows.gw_hr_applicants[0];
  assert.equal(a.rank, "A");
  assert.equal(a.status, "ceo_recommend_pending");
  assert.equal(a.decision_due_on, "2026-10-01");
});

await ok("Dランクは見送りへ進む。ただしdecisionは自動で確定しない", async () => {
  setup();
  const s = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  await act({ id: s.body.interview.id, action: "conduct" });
  await act({ id: s.body.interview.id, action: "evaluate", rank: "D" });
  const a = db.rows.gw_hr_applicants[0];
  assert.equal(a.status, "passed");
  assert.equal(a.decision, null, "ランクだけで採用判断を確定しない");
});

await ok("評価入力・ランクが、選考タイムラインに残る", async () => {
  setup();
  const s = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  await act({ id: s.body.interview.id, action: "conduct" });
  await act({ id: s.body.interview.id, action: "evaluate", rank: "B" });
  const keys = db.rows.gw_hr_timeline.map((t) => t.event_key);
  assert.ok(keys.includes("evaluated"));
  assert.ok(keys.includes("rank_B"));
});

await ok("ランクを選ばなければ断る", async () => {
  setup();
  const s = await schedule({ applicantId: "a1", kind: "casual", scheduledAt: `${jstToday()}T05:00:00Z` });
  const r = await act({ id: s.body.interview.id, action: "evaluate", scores: { communication: "good" } });
  assert.equal(r.statusCode, 400);
});

console.log("\n=== 今日の面談（GET /api/hr/interviews/today） ===\n");

await ok("今日ぶんだけ、時刻順に返す", async () => {
  setup();
  db.rows.gw_hr_interviews = [
    { id: "late", tenant_id: "t1", applicant_id: "a1", kind: "casual", interviewer_id: "e1",
      scheduled_at: `${jstToday()}T09:00:00Z`, conducted_at: null },
    { id: "early", tenant_id: "t1", applicant_id: "a1", kind: "ceo", interviewer_id: null,
      scheduled_at: `${jstToday()}T02:00:00Z`, conducted_at: null },
    { id: "far", tenant_id: "t1", applicant_id: "a1", kind: "casual", interviewer_id: null,
      scheduled_at: "2020-01-01T09:00:00Z", conducted_at: null },
  ];
  const r = await getToday();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.interviews.length, 2, "今日ぶんだけ（遠い日付は入らない）");
  assert.equal(r.body.interviews[0].id, "early", "時刻の早い順");
  assert.equal(r.body.interviews[0].name, "山田 太郎");
  assert.equal(r.body.interviews[0].jobTitle, "エンジニア");
  assert.equal(r.body.interviews[1].interviewerName, "面接 花子");
});

console.log("\n=== 面談結果の未入力通知（cron） ===\n");

await ok("実施から間もなければ、まだ知らせない", async () => {
  setup();
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    interviewer_id: "e1", conducted_at: new Date().toISOString(), rank: null }];
  const r = await runCron();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.notified, 0);
  assert.equal(db.rows.gw_notifications.length, 0);
});

await ok("2時間たっても未評価なら、面談担当へ知らせる", async () => {
  setup();
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    interviewer_id: "e1", conducted_at: new Date(Date.now() - 3 * 3600000).toISOString(), rank: null }];
  const r = await runCron();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.notified, 1);
  assert.equal(db.rows.gw_notifications[0].employee_id, "e1");
  assert.equal(db.rows.gw_notifications[0].kind, "hr");
  assert.match(db.rows.gw_notifications[0].title, /面談結果が未入力/);
});

await ok("評価済みなら、対象にならない", async () => {
  setup();
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    interviewer_id: "e1", conducted_at: new Date(Date.now() - 3 * 3600000).toISOString(), rank: "A" }];
  const r = await runCron();
  assert.equal(r.body.notified, 0);
});

await ok("同じ面談は、何度cronが回っても二重に通知しない", async () => {
  setup();
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    interviewer_id: "e1", conducted_at: new Date(Date.now() - 3 * 3600000).toISOString(), rank: null }];
  await runCron();
  const r = await runCron();
  assert.equal(r.body.notified, 0, "2回目は増えない");
  assert.equal(db.rows.gw_notifications.length, 1);
});

await ok("面談担当が未定なら、採用担当へ知らせる", async () => {
  setup();
  db.rows.gw_hr_applicants[0].recruiter_id = "emp-r1";
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    interviewer_id: null, conducted_at: new Date(Date.now() - 3 * 3600000).toISOString(), rank: null }];
  const r = await runCron();
  assert.equal(r.body.notified, 1);
  assert.equal(db.rows.gw_notifications[0].employee_id, "emp-r1");
});

console.log("\n=== 誰が触れるか ===\n");

await ok("一般メンバーは使えない", async () => {
  setup();
  who = MEMBER;
  const r = await schedule({ applicantId: "a1", kind: "casual" });
  assert.equal(r.statusCode, 403);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
