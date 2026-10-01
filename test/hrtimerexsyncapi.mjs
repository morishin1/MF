// 採用HR Phase 4A：TimeRex Webhookの「正規化イベント→DB反映」層（lib/hr-timerex.js）を、
// 偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   ここではTimeRexの実payload構造は扱わない（まだ確認できていないため）。
//   「すでに正規化された1件のTimeRexイベント」を受け取ったときの、
//   DB反映・冪等性・応募者状態遷移・手動運用との共存だけを確かめる。
//
//   1. 予約確定でgw_hr_interviewsが作られ、応募者がinterview_scheduledへ進む
//   2. 同じevent_idの再送では重複作成せず、冪等に上書きする
//   3. event_idが変わる日程変更では、旧IDの行を新IDへ引き継ぐ（複製しない）
//   4. キャンセルでは物理削除せず、応募者はscheduling（日程調整のやり直し）へ戻す
//   5. 応募者が見つからなければ何も書き込まずエラーにする（メール等では照合しない）
//   6. 他テナントの同じevent_idと衝突しない
//   7. 既存の手動設定ずみ面談があれば、複製せずそれを引き継ぐ
//   8. 壊れた入力（必須項目欠落・不明なtype）はエラーとして扱う
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

function table(name) {
  const f = [];
  let order = null, lim = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      if (op === "is") return v === null ? r[k] == null : r[k] != null;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : a[order] > b[order] ? -1 : 0));
    if (lim) out = out.slice(0, lim);
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(col, opts) { order = col; return q; },
    limit(n) { lim = n; return q; },
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
        const hit = (db.rows[name] || []).filter((x) => g.every(([op, k, v]) => x[k] === v));
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

const { applyTimerexEvent } = await import(atRoot("lib/hr-timerex.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "山田 太郎", status: "todo", stage: "applied" },
      { id: "a2", tenant_id: "t2", name: "他社の応募者", status: "todo", stage: "applied" },
    ],
    gw_hr_interviews: [], gw_hr_timeline: [],
  };
}

const booked = (over = {}) => ({
  type: "booked", kind: "casual", eventId: "ev1", applicantId: "a1",
  scheduledAt: "2026-10-01T05:00:00Z", meetingUrl: "https://meet.example.com/x", ...over,
});

console.log("\n=== 予約確定（booked） ===\n");

await ok("gw_hr_interviewsが作られ、応募者がinterview_scheduledへ進む", async () => {
  setup();
  const r = await applyTimerexEvent(booked());
  assert.equal(r.action, "created", JSON.stringify(r));
  assert.equal(db.rows.gw_hr_interviews.length, 1);
  const iv = db.rows.gw_hr_interviews[0];
  assert.equal(iv.tenant_id, "t1");
  assert.equal(iv.kind, "casual");
  assert.equal(iv.scheduled_at, "2026-10-01T05:00:00Z");
  assert.equal(iv.meeting_url, "https://meet.example.com/x");
  assert.equal(iv.timerex_event_id, "ev1");
  assert.ok(iv.timerex_synced_at);
  const a = db.rows.gw_hr_applicants.find((x) => x.id === "a1");
  assert.equal(a.status, "interview_scheduled");
  assert.equal(a.stage, "casual_interview");
});

await ok("選考タイムライン・監査ログに残る", async () => {
  setup();
  await applyTimerexEvent(booked());
  assert.equal(db.rows.gw_hr_timeline.length, 1);
  assert.equal(db.rows.gw_hr_timeline[0].event_key, "interview_scheduled");
  assert.ok(logged.some((l) => l.action === "hr.timerex_interview_sync"));
});

await ok("応募者が見つからなければ、何も書き込まずエラーにする", async () => {
  setup();
  const r = await applyTimerexEvent(booked({ applicantId: "not-exists" }));
  assert.equal(r.error, "applicant_not_found");
  assert.equal(db.rows.gw_hr_interviews.length, 0);
});

console.log("\n=== 冪等性（同じevent_idの再送） ===\n");

await ok("同じevent_idの再送では、複製せず上書きする", async () => {
  setup();
  await applyTimerexEvent(booked());
  const r = await applyTimerexEvent(booked({ scheduledAt: "2026-10-01T06:00:00Z" }));
  assert.equal(r.action, "resynced");
  assert.equal(db.rows.gw_hr_interviews.length, 1, "複製しない");
  assert.equal(db.rows.gw_hr_interviews[0].scheduled_at, "2026-10-01T06:00:00Z");
});

console.log("\n=== 日程変更（rescheduled。event_idが変わる場合） ===\n");

await ok("旧event_idの行を、新event_idへ引き継ぐ（複製しない）", async () => {
  setup();
  await applyTimerexEvent(booked());
  const r = await applyTimerexEvent({
    type: "rescheduled", kind: "casual", eventId: "ev2", previousEventId: "ev1", applicantId: "a1",
    scheduledAt: "2026-10-02T05:00:00Z", meetingUrl: "https://meet.example.com/x",
  });
  assert.equal(r.action, "rescheduled", JSON.stringify(r));
  assert.equal(db.rows.gw_hr_interviews.length, 1, "複製しない");
  assert.equal(db.rows.gw_hr_interviews[0].timerex_event_id, "ev2");
  assert.equal(db.rows.gw_hr_interviews[0].scheduled_at, "2026-10-02T05:00:00Z");
});

console.log("\n=== キャンセル ===\n");

await ok("面談を物理削除せず、canceled_atを立てる", async () => {
  setup();
  await applyTimerexEvent(booked());
  const r = await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "ev1", applicantId: "a1" });
  assert.equal(r.action, "canceled", JSON.stringify(r));
  assert.equal(db.rows.gw_hr_interviews.length, 1, "物理削除しない");
  assert.ok(db.rows.gw_hr_interviews[0].canceled_at);
});

await ok("応募者はscheduling（日程調整のやり直し）へ戻る", async () => {
  setup();
  await applyTimerexEvent(booked());
  await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "ev1", applicantId: "a1" });
  assert.equal(db.rows.gw_hr_applicants.find((x) => x.id === "a1").status, "scheduling");
});

await ok("キャンセルのタイムライン・監査ログが残る", async () => {
  setup();
  await applyTimerexEvent(booked());
  await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "ev1", applicantId: "a1" });
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "interview_canceled"));
  assert.ok(logged.some((l) => l.action === "hr.timerex_interview_cancel"));
});

await ok("対象の面談が見つからなければエラー（存在しないevent_id）", async () => {
  setup();
  const r = await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "not-exists", applicantId: "a1" });
  assert.equal(r.error, "interview_not_found");
});

await ok("すでにキャンセル済みなら、もう一度は何もしない", async () => {
  setup();
  await applyTimerexEvent(booked());
  await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "ev1", applicantId: "a1" });
  const r = await applyTimerexEvent({ type: "canceled", kind: "casual", eventId: "ev1", applicantId: "a1" });
  assert.equal(r.action, "already_canceled");
});

console.log("\n=== 他テナントとの分離 ===\n");

await ok("同じevent_idでも、テナントが違えば別々に扱う（衝突しない）", async () => {
  setup();
  await applyTimerexEvent(booked({ applicantId: "a1", eventId: "ev-shared" }));
  const r = await applyTimerexEvent({
    type: "booked", kind: "casual", eventId: "ev-shared", applicantId: "a2",
    scheduledAt: "2026-10-01T05:00:00Z",
  });
  assert.equal(r.action, "created", "t2の新規予約として作られる（t1のresyncにならない）");
  assert.equal(db.rows.gw_hr_interviews.length, 2);
  assert.equal(db.rows.gw_hr_interviews.filter((i) => i.tenant_id === "t1").length, 1);
  assert.equal(db.rows.gw_hr_interviews.filter((i) => i.tenant_id === "t2").length, 1);
});

console.log("\n=== 既存の手動設定との共存（README「応募者一覧・ドロワーUI改善」指示書 §9） ===\n");

await ok("手動設定ずみの面談があれば、複製せずそれをTimeRex連携として引き継ぐ", async () => {
  setup();
  db.rows.gw_hr_interviews.push({
    id: "manual1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    scheduled_at: "2026-09-28T05:00:00Z", meeting_url: null,
    conducted_at: null, canceled_at: null, timerex_event_id: null,
    created_at: "2026-09-20T00:00:00Z",
  });
  const r = await applyTimerexEvent(booked());
  assert.equal(r.action, "adopted_manual", JSON.stringify(r));
  assert.equal(db.rows.gw_hr_interviews.length, 1, "複製しない");
  assert.equal(db.rows.gw_hr_interviews[0].id, "manual1");
  assert.equal(db.rows.gw_hr_interviews[0].timerex_event_id, "ev1");
  assert.equal(db.rows.gw_hr_interviews[0].scheduled_at, "2026-10-01T05:00:00Z");
});

await ok("実施済み・キャンセル済みの古い面談は引き継ぎ対象にしない（新規作成する）", async () => {
  setup();
  db.rows.gw_hr_interviews.push({
    id: "done1", tenant_id: "t1", applicant_id: "a1", kind: "casual",
    scheduled_at: "2026-09-20T05:00:00Z", conducted_at: "2026-09-20T06:00:00Z",
    canceled_at: null, timerex_event_id: null, created_at: "2026-09-19T00:00:00Z",
  });
  const r = await applyTimerexEvent(booked());
  assert.equal(r.action, "created");
  assert.equal(db.rows.gw_hr_interviews.length, 2);
});

console.log("\n=== 壊れた入力 ===\n");

await ok("applicant_idが無ければ断る", async () => {
  const r = await applyTimerexEvent({ type: "booked", kind: "casual", eventId: "ev1", scheduledAt: "2026-10-01T05:00:00Z" });
  assert.equal(r.error, "missing_applicant_id");
});

await ok("event_idが無ければ断る", async () => {
  const r = await applyTimerexEvent({ type: "booked", kind: "casual", applicantId: "a1", scheduledAt: "2026-10-01T05:00:00Z" });
  assert.equal(r.error, "missing_event_id");
});

await ok("予約確定なのにscheduledAtが無ければ断る", async () => {
  setup();
  const r = await applyTimerexEvent({ type: "booked", kind: "casual", eventId: "ev1", applicantId: "a1" });
  assert.equal(r.error, "missing_scheduled_at");
});

await ok("不明なtypeは断る", async () => {
  setup();
  const r = await applyTimerexEvent({ type: "unknown_type", kind: "casual", eventId: "ev1", applicantId: "a1" });
  assert.equal(r.error, "unknown_event_type");
});

await ok("イベントそのものが無ければ断る（例外を投げない）", async () => {
  const r = await applyTimerexEvent(null);
  assert.equal(r.error, "invalid_event");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
