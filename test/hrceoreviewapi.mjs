// 採用HR Stage 4：CEO REVIEW（api/hr/ceo-review.js・面談実施の分岐・採用判断の権限）を、
// 偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 応募者全件ではなく、社長推薦以降の人だけを3ブロックに振り分けて返す
//   2. 社長面談を実施すると「評価入力待ち」ではなく「社長判断待ち」へ進む
//      （カジュアル面談とは違う。5項目評価はしない）
//   3. 採用判断（内定・保留・見送り）は社長・管理者だけ。Dランクの早期見送りは
//      recruiterでもできる（同じdecision列でも、区別する）
//   4. CEO REVIEWの一覧そのものも、社長・管理者だけが見られる
//   5. 推薦理由・良かった点・気になる点がカードに出る
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
const OWNER = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], employee: { id: "emp-o1", display_name: "社長" } };
let who = OWNER;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canRecruit: (c) => Boolean(c?.isAdmin || c?.isHr || (c?.roles || []).includes("recruiter")),
    canDecideHire: (c) => Boolean(c?.isAdmin || (c?.roles || []).includes("owner")),
  },
});

const { default: ceoReview } = await import(atRoot("api/hr/ceo-review.js"));
const { default: applicantDetail } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: interviews } = await import(atRoot("api/hr/interviews/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getCeoReview = () => call(ceoReview, { method: "GET", url: "/api/hr/ceo-review" });
const patchApplicant = (body) => call(applicantDetail, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const act = (body) => call(interviews, { method: "PATCH", url: "/api/hr/interviews", body });
const schedule = (body) => call(interviews, { method: "POST", url: "/api/hr/interviews", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

function setup() {
  who = OWNER;
  db.missing = null;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [], gw_hr_interviews: [], gw_hr_timeline: [], gw_notifications: [],
    gw_employees: [{ id: "emp-o1", tenant_id: "t1", user_id: "u-o1", display_name: "社長", status: "active" }],
    memberships: [{ tenant_id: "t1", user_id: "u-o1", role: "admin" }],
    gw_role_grants: [],
  };
}

console.log("\n=== CEO REVIEWの一覧（GET /api/hr/ceo-review） ===\n");

await ok("応募者全件ではなく、社長推薦以降だけを返す", async () => {
  setup();
  db.rows.gw_hr_applicants = [
    { id: "a1", tenant_id: "t1", name: "応募したて", stage: "applied", status: "todo", rank: null, decision: null },
    { id: "a2", tenant_id: "t1", name: "推薦された", stage: "ceo_recommend", status: "ceo_interview_pending", rank: "A", decision: null,
      recommend_note: "営業経験が強い" },
  ];
  const r = await getCeoReview();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const all = [...r.body.todayMeetings, ...r.body.recommended, ...r.body.decisionPending];
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "推薦された");
  assert.equal(all[0].recommendNote, "営業経験が強い");
});

await ok("今日面談予定の人は「今日会う人」へ", async () => {
  setup();
  db.rows.gw_hr_applicants = [
    { id: "a1", tenant_id: "t1", name: "本日面談", stage: "ceo_interview", status: "interview_scheduled", rank: "A", decision: null },
  ];
  db.rows.gw_hr_interviews = [
    { id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "ceo",
      scheduled_at: `${jstToday()}T05:00:00Z`, conducted_at: null, rank: null },
  ];
  const r = await getCeoReview();
  assert.equal(r.body.todayMeetings.length, 1);
  assert.equal(r.body.todayMeetings[0].name, "本日面談");
  assert.equal(r.body.recommended.length, 0);
});

await ok("推薦されただけで、まだ社長面談を設定していない人は「社長に会ってほしい人」へ", async () => {
  setup();
  db.rows.gw_hr_applicants = [
    { id: "a1", tenant_id: "t1", name: "推薦待ち", stage: "ceo_recommend", status: "ceo_interview_pending", rank: "A", decision: null },
  ];
  const r = await getCeoReview();
  assert.equal(r.body.recommended.length, 1);
  assert.equal(r.body.todayMeetings.length, 0);
});

await ok("社長面談が済んだ人は「社長判断待ち」へ", async () => {
  setup();
  db.rows.gw_hr_applicants = [
    { id: "a1", tenant_id: "t1", name: "判断待ち", stage: "ceo_interview", status: "ceo_decision_pending", rank: "A", decision: null },
  ];
  const r = await getCeoReview();
  assert.equal(r.body.decisionPending.length, 1);
  assert.equal(r.body.decisionPending[0].name, "判断待ち");
});

await ok("良かった点・気になる点は、評価済みの面談から出す", async () => {
  setup();
  db.rows.gw_hr_applicants = [
    { id: "a1", tenant_id: "t1", name: "山田 太郎", stage: "ceo_recommend", status: "ceo_interview_pending", rank: "A", decision: null },
  ];
  db.rows.gw_hr_interviews = [
    { id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual", rank: "A",
      recommend_reason: "行動力が高い", notes: "報酬条件のみ確認したい" },
  ];
  const r = await getCeoReview();
  assert.equal(r.body.recommended[0].goodPoints, "行動力が高い");
  assert.equal(r.body.recommended[0].concerns, "報酬条件のみ確認したい");
});

await ok("recruiterはCEO REVIEWの一覧を見られない", async () => {
  setup();
  who = RECRUITER;
  const r = await getCeoReview();
  assert.equal(r.statusCode, 403);
});

console.log("\n=== 社長面談を実施すると、評価待ちではなく判断待ちへ ===\n");

await ok("kind: ceo は、5項目評価をせず社長判断待ちへ", async () => {
  setup();
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "ceo_interview",
    status: "interview_scheduled", rank: "A", decision: null }];
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "ceo",
    scheduled_at: `${jstToday()}T05:00:00Z`, conducted_at: null }];
  who = OWNER;
  const r = await act({ id: "iv1", action: "conduct" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "ceo_decision_pending");
  assert.equal(db.rows.gw_hr_applicants[0].status, "ceo_decision_pending");
});

await ok("kind: casual は、これまでどおり評価待ちへ（Stage 3を壊していない）", async () => {
  setup();
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "casual_interview",
    status: "interview_scheduled", rank: null, decision: null }];
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    scheduled_at: `${jstToday()}T05:00:00Z`, conducted_at: null }];
  const r = await act({ id: "iv1", action: "conduct" });
  assert.equal(r.body.status, "eval_pending");
});

console.log("\n=== 採用判断の権限 ===\n");

await ok("Dランクの早期見送りは、recruiterでもできる（社長判断待ちではないため）", async () => {
  setup();
  who = RECRUITER;
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "casual_interview",
    status: "passed", rank: "D", decision: null }];
  const r = await patchApplicant({ id: "a1", decision: "rejected" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_applicants[0].decision, "rejected");
});

await ok("社長判断待ちからの内定・保留・見送りは、recruiterはできない", async () => {
  setup();
  who = RECRUITER;
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "ceo_interview",
    status: "ceo_decision_pending", rank: "A", decision: null }];
  const r = await patchApplicant({ id: "a1", decision: "hired", stage: "offer", status: "offer_draft_pending" });
  assert.equal(r.statusCode, 403);
  assert.equal(db.rows.gw_hr_applicants[0].decision, null, "書き換わっていない");
});

await ok("社長・管理者は、社長判断待ちから内定にできる。stageもステータスも進む", async () => {
  setup();
  who = OWNER;
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "ceo_interview",
    status: "ceo_decision_pending", rank: "A", decision: null }];
  const r = await patchApplicant({ id: "a1", decision: "hired", stage: "offer", status: "offer_draft_pending", decisionNote: "即採用" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a = db.rows.gw_hr_applicants[0];
  assert.equal(a.decision, "hired");
  assert.equal(a.stage, "offer");
  assert.equal(a.status, "offer_draft_pending", "Stage 5（合格通知作成待ち）へ渡る");
  const keys = db.rows.gw_hr_timeline.map((t) => t.event_key);
  assert.ok(keys.includes("stage_offer"));
  assert.ok(keys.includes("decision_hired"));
});

await ok("保留は、理由・次に確認すること・再判断期限を残す", async () => {
  setup();
  who = OWNER;
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "ceo_interview",
    status: "ceo_decision_pending", rank: "B", decision: null }];
  const r = await patchApplicant({
    id: "a1", decision: "hold", holdReason: "報酬条件を確認したい",
    holdNextStep: "人事に給与レンジを確認", decisionDueOn: "2026-10-05",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a = db.rows.gw_hr_applicants[0];
  assert.equal(a.hold_reason, "報酬条件を確認したい");
  assert.equal(a.hold_next_step, "人事に給与レンジを確認");
  assert.equal(a.decision_due_on, "2026-10-05");
  assert.equal(a.status, "ceo_decision_pending", "保留は判断待ちのまま（自動で終わらせない）");
});

await ok("見送りは、decision=rejectedとタイムラインが残る", async () => {
  setup();
  who = OWNER;
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田", stage: "ceo_interview",
    status: "ceo_decision_pending", rank: "C", decision: null }];
  const r = await patchApplicant({ id: "a1", decision: "rejected" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_applicants[0].decision, "rejected");
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "decision_rejected"));
});

console.log("\n=== 通知（社長・管理者へ。通知は増やしすぎない） ===\n");

await ok("社長推薦されたら、社長・管理者へ知らせる", async () => {
  setup();
  who = RECRUITER;
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田 太郎", stage: "casual_interview",
    status: "eval_pending", rank: "A", decision: null }];
  await patchApplicant({ id: "a1", stage: "ceo_recommend", status: "ceo_interview_pending", recommendNote: "推薦します" });
  assert.equal(db.rows.gw_notifications.length, 1);
  assert.equal(db.rows.gw_notifications[0].employee_id, "emp-o1");
  assert.equal(db.rows.gw_notifications[0].kind, "hr");
  assert.match(db.rows.gw_notifications[0].title, /社長推薦/);
});

await ok("社長面談を設定したら、社長・管理者へ知らせる", async () => {
  setup();
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田 太郎", stage: "ceo_recommend",
    status: "ceo_interview_pending", rank: "A", decision: null }];
  await schedule({ applicantId: "a1", kind: "ceo", scheduledAt: "2026-09-26T05:00:00Z" });
  assert.equal(db.rows.gw_notifications.length, 1);
  assert.equal(db.rows.gw_notifications[0].employee_id, "emp-o1");
  assert.match(db.rows.gw_notifications[0].title, /社長面談/);
});

await ok("カジュアル面談を設定しても、社長へは知らせない", async () => {
  setup();
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田 太郎", stage: "applied",
    status: "todo", rank: null, decision: null }];
  await schedule({ applicantId: "a1", kind: "casual", scheduledAt: "2026-09-26T05:00:00Z" });
  assert.equal(db.rows.gw_notifications.length, 0);
});

await ok("社長面談が終わったら、採用判断をしてくださいと知らせる", async () => {
  setup();
  db.rows.gw_hr_applicants = [{ id: "a1", tenant_id: "t1", name: "山田 太郎", stage: "ceo_interview",
    status: "interview_scheduled", rank: "A", decision: null }];
  db.rows.gw_hr_interviews = [{ id: "iv1", tenant_id: "t1", applicant_id: "a1", kind: "ceo",
    scheduled_at: "2026-09-26T05:00:00Z", conducted_at: null }];
  await act({ id: "iv1", action: "conduct" });
  assert.equal(db.rows.gw_notifications.length, 1);
  assert.match(db.rows.gw_notifications[0].title, /採用判断/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
