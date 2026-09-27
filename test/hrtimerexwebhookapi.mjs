// 採用HR Phase 4A：/api/hr/timerex/webhook（実装完了後）を、実際に近い形の
// payload（個人情報を匿名化したfixture）と偽のSupabaseで通す。
//
// ■ 何を守るテストか（TimeRex Webhook parser 最終実装指示）
//
//   1. event_confirmed → gw_hr_interviewsが作られ、Google Meet URLも保存される
//   2. applicant_idが直接含まれる場合は最優先で使う
//   3. applicant_idが無ければ、guest_emailの完全一致（status=schedulingかつ1名のみ）
//   4. email 0件・2件以上は自動反映しない
//   5. 同じevent_idの再送では複製しない（冪等）
//   6. 認証ヘッダーが不正・無しなら401。未設定なら503
//   7. 壊れたbodyでも例外を投げない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const copy = (r) => (r ? { ...r } : null);
const match = (g) => (x) => g.every(([op, k, v]) =>
  op === "eq" ? x[k] === v : (Array.isArray(v) ? v.includes(x[k]) : x[k] === v));

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter(match(f));
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter(match(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});

process.env.TIMEREX_WEBHOOK_SECRET = "test-secret-value-long-enough";

const { default: webhook } = await import(atRoot("api/hr/timerex/webhook.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const AUTH = { "x-hr-timerex-secret": "test-secret-value-long-enough" };
const call = (body, headers = AUTH) => {
  const r = res();
  return webhook({ method: "POST", headers, body }, r).then(() => r);
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "テスト 太郎", email: "test@example.jp", status: "scheduling", stage: "applied" },
    ],
    gw_hr_interviews: [], gw_hr_timeline: [],
  };
}

// 個人情報を匿名化した、実際に確認できたpayload構造そのままのfixture
const confirmedFixture = (over = {}) => ({
  webhook_type: "event_confirmed",
  event: {
    id: "ev_abc123",
    start_datetime: "2026-10-01T05:00:00Z",
    local_start_datetime: "2026-10-01T14:00:00+09:00",
    google_meet_meeting: { join_url: "https://meet.google.com/xyz-abcd-efg" },
    form: [
      { field_type: "guest_name", value: "テスト 太郎" },
      { field_type: "guest_email", value: "test@example.jp" },
      { field_type: "company_name", value: "" },
      { field_type: "guest_comment", value: "" },
    ],
    is_changed: false, old_event_id: null, new_event_id: null,
    ...over,
  },
});

console.log("\n=== 予約確定（event_confirmed） ===\n");

await ok("guest_emailの一致で応募者を特定し、面談が作られる", async () => {
  setup();
  const r = await call(confirmedFixture());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, "created");
  assert.equal(db.rows.gw_hr_interviews.length, 1);
  const iv = db.rows.gw_hr_interviews[0];
  assert.equal(iv.applicant_id, "a1");
  assert.equal(iv.scheduled_at, "2026-10-01T05:00:00Z");
  assert.equal(iv.meeting_url, "https://meet.google.com/xyz-abcd-efg");
  assert.equal(iv.timerex_event_id, "ev_abc123");
  assert.equal(db.rows.gw_hr_applicants[0].status, "interview_scheduled");
});

await ok("applicant_idが直接含まれる場合は、それを最優先で使う", async () => {
  setup();
  db.rows.gw_hr_applicants.push({ id: "a2", tenant_id: "t1", name: "別人", email: "test@example.jp", status: "scheduling" });
  // emailは複数一致する状態だが、applicant_idが直接あるので照合しない
  const body = confirmedFixture();
  body.applicant_id = "a2";
  const r = await call(body);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_interviews[0].applicant_id, "a2");
});

console.log("\n=== 応募者識別（guest_email） ===\n");

await ok("一致0件はapplicant_not_found（404）。DBは変わらない", async () => {
  setup();
  const body = confirmedFixture();
  body.event.form = body.event.form.map((f) => f.field_type === "guest_email" ? { ...f, value: "nobody@example.jp" } : f);
  const r = await call(body);
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "applicant_not_found");
  assert.equal(db.rows.gw_hr_interviews.length, 0);
});

await ok("一致2件以上はambiguous_applicant（409）。DBは変わらない", async () => {
  setup();
  db.rows.gw_hr_applicants.push({ id: "a2", tenant_id: "t1", name: "同姓同名", email: "test@example.jp", status: "scheduling" });
  const r = await call(confirmedFixture());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "ambiguous_applicant");
  assert.equal(db.rows.gw_hr_interviews.length, 0);
});

await ok("status=schedulingでない応募者とは自動で紐付けない", async () => {
  setup();
  db.rows.gw_hr_applicants[0].status = "todo"; // まだTimeRex URLを送っていない状態
  const r = await call(confirmedFixture());
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "applicant_not_found");
});

console.log("\n=== 冪等性（同一event_idの再送） ===\n");

await ok("同じevent_idのWebhookが複数回来ても、複製せず200を返す", async () => {
  setup();
  const r1 = await call(confirmedFixture());
  assert.equal(r1.statusCode, 200);
  const r2 = await call(confirmedFixture());
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(db.rows.gw_hr_interviews.length, 1, "複製しない");
});

console.log("\n=== 認証 ===\n");

await ok("不正なSecretは401", async () => {
  setup();
  const r = await call(confirmedFixture(), { "x-hr-timerex-secret": "wrong" });
  assert.equal(r.statusCode, 401);
  assert.equal(db.rows.gw_hr_interviews.length, 0);
});

await ok("Secretヘッダーが無ければ401", async () => {
  setup();
  const r = await call(confirmedFixture(), {});
  assert.equal(r.statusCode, 401);
});

await ok("TIMEREX_WEBHOOK_SECRET自体が未設定なら503（常に拒否）", async () => {
  setup();
  const saved = process.env.TIMEREX_WEBHOOK_SECRET;
  delete process.env.TIMEREX_WEBHOOK_SECRET;
  try {
    const r = await call(confirmedFixture());
    assert.equal(r.statusCode, 503);
  } finally {
    process.env.TIMEREX_WEBHOOK_SECRET = saved;
  }
});

console.log("\n=== 壊れたbody ===\n");

await ok("bodyが空でも例外を投げず400", async () => {
  setup();
  const r = await call({});
  assert.equal(r.statusCode, 400);
});

await ok("webhook_typeが無ければ400", async () => {
  setup();
  const r = await call({ event: { id: "x" } });
  assert.equal(r.statusCode, 400);
});

await ok("未確認のwebhook_type（キャンセル等）は推測せず400で受理しない", async () => {
  setup();
  const r = await call({ webhook_type: "event_cancelled", event: { id: "ev1" } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "unsupported_webhook_type");
  assert.equal(db.rows.gw_hr_interviews.length, 0);
});

await ok("event.idが無ければ400", async () => {
  setup();
  const r = await call({ webhook_type: "event_confirmed", event: {} });
  assert.equal(r.statusCode, 400);
});

console.log("\n=== その他 ===\n");

await ok("GETは405", async () => {
  const r = res();
  await webhook({ method: "GET", headers: AUTH }, r);
  assert.equal(r.statusCode, 405);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
