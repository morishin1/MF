// 日報コーチ：勤務日・名簿・朝の定時確認・外部呼び出し・Slack preflight・送信アダプタ（既定OFF）。
//
// 合成データだけ（実在の名前・ID・トークンなし）。時計は注入（実行環境のタイムゾーンに依存しない）。
// Slack は偽物だけ（本物は呼ばない）。SQL の RPC は、下の fakeRpc が db/148 と同じ規則をメモリ上で真似る
// （実 PostgreSQL での確認は test/sql/148_behavior_coach.sql・148_concurrency.sh）。
import test from "node:test";
import assert from "node:assert/strict";
import { createMemDb } from "./_memdb.mjs";
import { digest } from "../lib/behavior-coach.js";
import { previousWorkday, nextWorkday, workdayStatus, rosterScope, leaveOn } from "../lib/behavior-coach-days.js";
import { runCoachCheck, classifyPerson, buildTeamAdvice, assertTeamSafe, buildOwnerReport, summarize, outboxTarget, STATUS_LABEL } from "../lib/behavior-coach-morning.js";
import { createCoachHandler, parseCheckRequest, jstToday } from "../lib/behavior-coach-api.js";
import { slackPreflight, deliveryBlock, deliverOutbox, deliverReview, slackConfigHash, coachDeliveryEnv } from "../lib/behavior-coach-delivery.js";

// 2026-10-22（木）08:00 JST
const NOW = new Date("2026-10-21T23:00:00Z");
const clock = () => NOW;
const T = "aaaa0000-0000-4000-8000-000000000001", T2 = "aaaa0000-0000-4000-8000-000000000002";
const uid = (n) => `bbbb0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eid = (n) => `cccc0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = uid(99);
const WEEK = [1, 2, 3, 4, 5];
const KEY = "k".repeat(40);
const ENV = { NIPPO_COACH_ROUTINE_KEY: KEY, NIPPO_COACH_TENANT_ID: T };

function emp(n, extra = {}) {
  return { id: eid(n), tenant_id: T, user_id: uid(n), display_name: `合成メンバー${n}`, status: "active", employment_type: "正社員", joined_on: "2025-04-01", left_on: null, updated_at: "2026-10-01T00:00:00Z", email: `m${n}@example.invalid`, ...extra };
}
const nippo = (n, date, extra = {}) => ({ id: `dddd0000-0000-4000-8000-${String(n).padStart(6, "0")}${date.replaceAll("-", "").slice(2)}`, user_id: uid(n), work_date: date,
  submitted_at: date + "T09:30:00Z", updated_at: date + "T09:30:00Z", top_priority: "合成の最優先", tomorrow_plan: "合成の計画（本文は確認結果に写さない）",
  work_items: [{ task: "合成の確認作業", target: 3, unit: "件", done_when: "確認結果を記録", result: "完了", done: true, actual: 3 }], ...extra });

function fixture() {
  const mem = createMemDb();
  const R = mem.rows;
  R.gw_coach_config = [{ tenant_id: T, enabled: true, ai_enabled: false, delivery_enabled: false, morning_enabled: true, owner_user_id: OWNER,
    slack_team_id: null, slack_bot_user_id: null, team_channel_id: null, owner_slack_user_id: null, owner_dm_channel_id: null, slack_preflight: null }];
  R.gw_employees = [
    emp(1),                                                               // 順調
    emp(2, { employment_type: "アルバイト" }),                             // 火木勤務・前勤務日の提出なし → 要確認
    emp(3, { employment_type: "業務委託" }),                               // 勤務曜日あり・提出なし → 契約範囲未確認 → 未確認
    emp(4),                                                               // 勤務曜日なし・提出なし → 未確認
    emp(5, { status: "left", left_on: "2026-09-30" }),                    // 対象外
    emp(6, { status: null }),                                             // 在籍状態不明 → 未確認
    emp(7),                                                               // 前日休暇 → 2日前の日報で順調
    emp(8),                                                               // 期限超過タスク → 要対応
    emp(9, { joined_on: "2026-11-01", status: "invited" }),               // 入社前 → 対象外
    emp(10),                                                              // 別テナントにも同じ user → 未確認
    emp(11),                                                              // 未完了の理由なし・計画なし → 要確認
    emp(12, { status: "leaving", left_on: "2026-10-10" }),                // 退職日を過ぎた leaving → 対象外
    { ...emp(99), employment_type: "役員", display_name: "合成代表" },     // 代表（勤務曜日なし）
    { id: eid(110), tenant_id: T2, user_id: uid(10), display_name: "他社の行", status: "active" },
  ];
  R.gw_reminder_prefs = [1, 3, 6, 7, 8, 10, 11].map((n) => ({ employee_id: eid(n), tenant_id: T, workdays: WEEK, updated_at: "2026-09-01T00:00:00Z" }))
    .concat([{ employee_id: eid(2), tenant_id: T, workdays: [2, 4], updated_at: "2026-09-01T00:00:00Z" }]);
  R.gw_requests = [{ id: "eeee0000-0000-4000-8000-000000000001", tenant_id: T, employee_id: eid(7), kind: "leave", leave_type: "paid", starts_on: "2026-10-21", ends_on: "2026-10-21", status: "approved", updated_at: "2026-10-01T00:00:00Z", body: "私的な理由（読まない）" }];
  R.gw_contracts = [];
  R.tc_nippo = [nippo(1, "2026-10-21"), nippo(7, "2026-10-20"), nippo(8, "2026-10-21"), nippo(10, "2026-10-21"),
    nippo(11, "2026-10-21", { tomorrow_plan: null, work_items: [{ task: "合成の資料作成", result: "", undone_reason: "" }] }),
    nippo(2, "2026-10-20", { submitted_at: null })];     // 朝の入力だけ
  R.gw_tasks = [
    { id: "ffff0000-0000-4000-8000-000000000001", tenant_id: T, assignee_id: eid(8), title: "合成の期限切れ", status: "doing", due_on: "2026-10-15", priority: "normal", updated_at: "2026-10-15T00:00:00Z" },
    { id: "ffff0000-0000-4000-8000-000000000002", tenant_id: T, assignee_id: eid(1), title: "合成の重要タスク", status: "todo", focus_date: "2026-10-22", focus_rank: 1, done_condition: null, due_on: null, updated_at: "2026-10-21T10:00:00Z" },
  ];
  R.gw_calendar_events = [
    { id: "abab0000-0000-4000-8000-000000000001", tenant_id: T, employee_id: eid(8), title: "合成の打合せ", body: "本文（読まない）", category: "work", source: "self", starts_at: "2026-10-22T10:00:00+09:00", ends_at: "2026-10-22T11:00:00+09:00", all_day: false, updated_at: "2026-10-20T00:00:00Z" },
    { id: "abab0000-0000-4000-8000-000000000002", tenant_id: T, employee_id: eid(11), title: "私用", body: "x", category: "private", source: "self", starts_at: "2026-10-22T10:00:00+09:00", ends_at: "2026-10-22T11:00:00+09:00", all_day: false, updated_at: "2026-10-20T00:00:00Z" },
    { id: "abab0000-0000-4000-8000-000000000003", tenant_id: T, employee_id: eid(11), title: "休暇", body: "x", category: "work", source: "leave", starts_at: "2026-10-22T00:00:00+09:00", ends_at: "2026-10-22T00:00:00+09:00", all_day: true, updated_at: "2026-10-20T00:00:00Z" },
  ];
  R.gw_coach_checks = []; R.gw_coach_reviews = []; R.gw_coach_outbox = []; R.gw_coach_runs = []; R.gw_coach_recipients = [];
  const sb = mem.admin();
  const calls = [];
  const selects = [];
  const origFrom = sb.from.bind(sb);
  sb.from = (name) => { const q = origFrom(name); const s = q.select.bind(q); q.select = (c, o) => { selects.push([name, c]); return s(c, o); }; return q; };
  sb.rpc = async (name, args) => { calls.push(name); return { data: fakeRpc(R, name, args), error: null }; };
  return { mem, R, sb, calls, selects };
}

const nowIso = () => new Date().toISOString();
// db/148 の RPC を、同じ規則でメモリ上に（判定に関わるところだけ）
function fakeRpc(R, name, a) {
  const cfg = R.gw_coach_config.find((c) => c.tenant_id === a.p_tenant_id);
  if (name === "gw_coach_run_begin") {
    if (!cfg?.enabled || !cfg?.morning_enabled) return { run: "disabled" };
    const r = R.gw_coach_runs.find((x) => x.tenant_id === a.p_tenant_id && x.check_date === a.p_check_date && x.mode === a.p_mode);
    if (!r) { R.gw_coach_runs.push({ tenant_id: a.p_tenant_id, check_date: a.p_check_date, mode: a.p_mode, idempotency_key: a.p_key, state: "running", lease_token: a.p_token, attempts: 1, result: null }); return { run: "started" }; }
    if (r.state === "done" && r.idempotency_key === a.p_key) return { run: "replay", result: r.result };
    if (r.state === "running") return { run: "busy" };
    Object.assign(r, { idempotency_key: a.p_key, state: "running", lease_token: a.p_token, attempts: r.attempts + 1, result: null });
    return { run: "started" };
  }
  if (name === "gw_coach_run_finish") {
    const r = R.gw_coach_runs.find((x) => x.tenant_id === a.p_tenant_id && x.check_date === a.p_check_date && x.mode === a.p_mode && x.lease_token === a.p_token && x.state === "running");
    if (!r) return false; Object.assign(r, { state: a.p_ok ? "done" : "failed", result: a.p_result }); return true;
  }
  if (name === "gw_coach_record_check") {
    if (!cfg?.enabled || !cfg?.morning_enabled) return { check: "disabled" };
    if (!R.gw_employees.some((e) => e.id === a.p_employee_id && e.tenant_id === a.p_tenant_id)) throw new Error("tenant mismatch");
    let reviewId = null, review = null;
    if (a.p_review) {
      assert.equal(a.p_review.epoch, (a.p_mode === "provisional" ? "provisional:" : "final:") + a.p_report_date);
      assert.equal(a.p_review.draft.epoch, a.p_review.epoch);
      let r = R.gw_coach_reviews.find((x) => x.tenant_id === a.p_tenant_id && x.employee_id === a.p_employee_id && x.report_date === a.p_report_date);
      if (!r) {
        r = { id: `9999${String(R.gw_coach_reviews.length).padStart(4, "0")}-0000-4000-8000-000000000000`, tenant_id: a.p_tenant_id, employee_id: a.p_employee_id, report_date: a.p_report_date,
          source_revision: 1, generation: 1, evaluation_epoch: a.p_review.epoch, state: a.p_review.state, draft: a.p_review.draft, approval: null, delivery_state: "none",
          source_metadata: { kind: "morning", morning_hash: a.p_source_hash } };
        R.gw_coach_reviews.push(r); review = "written";
      } else if (r.source_metadata?.morning_hash !== a.p_source_hash && !(r.evaluation_epoch.startsWith("final:") && a.p_review.epoch.startsWith("provisional:"))) {
        Object.assign(r, { source_revision: r.source_revision + 1, generation: r.generation + 1, evaluation_epoch: a.p_review.epoch, approval: null,
          draft: a.p_review.draft, state: a.p_review.state, source_metadata: { kind: "morning", morning_hash: a.p_source_hash } });
        review = "written";
      } else review = "unchanged";
      reviewId = r.id;
    }
    const c = R.gw_coach_checks.find((x) => x.tenant_id === a.p_tenant_id && x.check_date === a.p_check_date && x.mode === a.p_mode && x.employee_id === a.p_employee_id);
    const row = { tenant_id: a.p_tenant_id, employee_id: a.p_employee_id, check_date: a.p_check_date, mode: a.p_mode, status: a.p_status, report_date: a.p_report_date,
      next_workday: a.p_next_workday, source_hash: a.p_source_hash, detail: a.p_detail, review_id: reviewId };
    let check;
    if (!c) { R.gw_coach_checks.push({ ...row, revision: 1, checked_at: nowIso() }); check = "created"; }
    else if (c.source_hash !== a.p_source_hash) { Object.assign(c, row, { review_id: reviewId || c.review_id, revision: c.revision + 1, checked_at: nowIso() }); check = "changed"; }
    else { c.checked_at = nowIso(); check = "unchanged"; }
    return { check, review, review_id: reviewId };
  }
  if (name === "gw_coach_outbox_upsert") {
    if (!cfg?.enabled || !cfg?.morning_enabled) return { outbox: "disabled" };
    let o = R.gw_coach_outbox.find((x) => x.tenant_id === a.p_tenant_id && x.kind === a.p_kind && x.check_date === a.p_check_date && x.mode === a.p_mode);
    const state = a.p_target ? "draft" : "blocked";
    if (!o) { o = { id: `8888${String(R.gw_coach_outbox.length).padStart(4, "0")}-0000-4000-8000-000000000000`, tenant_id: a.p_tenant_id, kind: a.p_kind, check_date: a.p_check_date, mode: a.p_mode, generation: 1, state, body: a.p_body, body_hash: a.p_body_hash, target: a.p_target, target_hash: a.p_target_hash, approval: null }; R.gw_coach_outbox.push(o); return { outbox: "created", id: o.id }; }
    if (["delivery_attempted", "delivery_unknown", "sent"].includes(o.state)) return { outbox: "locked", id: o.id };
    if (o.body_hash === a.p_body_hash && o.target_hash === a.p_target_hash) return { outbox: "unchanged", id: o.id };
    Object.assign(o, { generation: o.generation + 1, body: a.p_body, body_hash: a.p_body_hash, target: a.p_target, target_hash: a.p_target_hash, approval: null, state });
    return { outbox: "changed", id: o.id };
  }
  const o = R.gw_coach_outbox.find((x) => x.id === a.p_id);
  const ocfg = o && R.gw_coach_config.find((c) => c.tenant_id === o.tenant_id);
  if (name === "gw_coach_outbox_approve") {
    if (!o || o.generation !== a.p_generation || o.state !== "draft" || !o.target || a.p_approval.body_hash !== o.body_hash || a.p_approval.target_hash !== o.target_hash || ocfg.owner_user_id !== a.p_approval.actor_user_id) return false;
    Object.assign(o, { approval: a.p_approval, state: "approved" }); return true;
  }
  if (name === "gw_coach_outbox_attempt") {
    if (!o || o.generation !== a.p_generation || o.state !== "approved" || !ocfg.delivery_enabled || o.approval.body_hash !== o.body_hash) return false;
    Object.assign(o, { state: "delivery_attempted", delivery_token: a.p_token }); return true;
  }
  if (name === "gw_coach_outbox_complete") {
    if (!o || o.delivery_token !== a.p_token || o.state !== "delivery_attempted") return false;
    Object.assign(o, { state: a.p_sent ? "sent" : "delivery_unknown", receipt: { sent: a.p_sent, message_id: a.p_message_id } }); return true;
  }
  const r = R.gw_coach_reviews.find((x) => x.id === a.p_id);
  const rcfg = r && R.gw_coach_config.find((c) => c.tenant_id === r.tenant_id);
  if (name === "gw_coach_approve") {
    if (!r || r.generation !== a.p_generation || r.state !== "owner_review" || a.p_approval.draft_hash !== r.draft.id || rcfg.owner_user_id !== a.p_approval.actor_user_id) return false;
    Object.assign(r, { approval: a.p_approval, state: "approved" }); return true;
  }
  if (name === "gw_coach_attempt") {
    if (!r || r.generation !== a.p_generation || r.state !== "approved" || !rcfg.delivery_enabled || ["attempted", "unknown"].includes(r.delivery_state)) return false;
    Object.assign(r, { state: "delivery_attempted", delivery_state: "attempted", delivery_token: a.p_claim_token }); return true;
  }
  if (name === "gw_coach_complete_attempt") {
    if (!r || r.delivery_token !== a.p_claim_token || r.delivery_state !== "attempted") return false;
    Object.assign(r, { delivery_state: a.p_sent ? "sent" : "unknown", state: a.p_sent ? "sent" : "delivery_unknown" }); return true;
  }
  throw new Error("unexpected rpc " + name);
}

const byEmp = (result) => new Map(result.persons.map((p) => [p.employeeId, p]));
const run = (f, opts = {}) => runCoachCheck(f.sb, { tenantId: T, checkDate: "2026-10-22", mode: "morning", config: f.R.gw_coach_config[0], now: clock, ...opts });

// ---------------- 勤務日 ----------------
test("previous/next work day uses personal weekdays, company holidays and approved leave; never assumes Mon–Fri", () => {
  assert.deepEqual(previousWorkday("2026-11-04", { workdays: WEEK }), { date: "2026-11-02", reason: "workday" }); // 11/3 祝日
  assert.equal(previousWorkday("2026-10-22", { workdays: null }).date, null);
  assert.equal(previousWorkday("2026-10-22", { workdays: null }).reason, "workdays_unknown");
  assert.equal(previousWorkday("2026-10-22", { workdays: [] }).reason, "workdays_unknown");
  assert.equal(previousWorkday("2026-10-22", { workdays: WEEK, leaves: [{ starts_on: "2026-10-21", ends_on: "2026-10-21", status: "approved", leave_type: "paid" }] }).date, "2026-10-20");
  assert.equal(previousWorkday("2026-10-22", { workdays: WEEK, leaves: [{ starts_on: "2026-10-21", ends_on: "2026-10-21", status: "pending", leave_type: "paid" }] }).reason, "leave_pending");
  assert.equal(previousWorkday("2026-10-22", { workdays: WEEK, leaves: [{ starts_on: "2026-10-21", ends_on: "2026-10-21", status: "approved", leave_type: "am" }] }).date, "2026-10-21");
  assert.equal(previousWorkday("2026-10-22", { workdays: [2, 4] }).date, "2026-10-20");
  assert.equal(nextWorkday("2026-10-30", { workdays: WEEK }).date, "2026-11-02");
  assert.equal(nextWorkday("2026-11-02", { workdays: WEEK }).date, "2026-11-04");
  assert.equal(nextWorkday("2026-10-22", { workdays: WEEK, leftOn: "2026-10-22" }).date, null);
  assert.equal(previousWorkday("2026-10-22", { workdays: WEEK, joinedOn: "2026-10-22" }).reason, "before_join");
  // 提出済みの日報がある日は、曜日設定外・休日でも勤務日（本人の記録を優先）
  assert.equal(workdayStatus("2026-10-24", { workdays: WEEK, submittedDates: new Set(["2026-10-24"]) }).work, true);
  assert.equal(leaveOn("2026-10-21", [{ starts_on: "2026-10-20", ends_on: "2026-10-22", status: "approved", leave_type: "paid" }]), "approved");
});

test("roster scope: left/leaving-past/joined-later excluded only when confirmed; unknown status is unconfirmed", () => {
  assert.equal(rosterScope(emp(1), "2026-10-22").scope, "in");
  assert.equal(rosterScope(emp(1, { status: "left" }), "2026-10-22").scope, "out");
  assert.equal(rosterScope(emp(1, { status: "leaving", left_on: "2026-10-21" }), "2026-10-22").scope, "out");
  assert.equal(rosterScope(emp(1, { status: "leaving", left_on: "2026-10-22" }), "2026-10-22").scope, "in");
  assert.equal(rosterScope(emp(1, { joined_on: "2026-10-23" }), "2026-10-22").scope, "out");
  assert.equal(rosterScope(emp(1, { status: null }), "2026-10-22").scope, "unknown");
  assert.equal(rosterScope(emp(1, { status: "invited" }), "2026-10-22").scope, "unknown");
  assert.equal(rosterScope(emp(1, { user_id: null }), "2026-10-22").reason, "no_login_mapping");
});

// ---------------- 朝の確認 ----------------
test("morning check classifies every roster member; counts reconcile; non-submission is never a violation", async () => {
  const f = fixture();
  const r = await run(f);
  const p = byEmp(r);
  const st = (n) => p.get(eid(n)).status;
  assert.equal(st(1), "ok");
  assert.equal(st(2), "check"); assert.ok(p.get(eid(2)).reasons.some((x) => x.code === "report_not_submitted"));
  assert.ok(p.get(eid(2)).reasons.some((x) => x.code === "morning_only"));
  assert.equal(p.get(eid(2)).reportDate, "2026-10-20");
  assert.equal(st(3), "unconfirmed"); assert.ok(p.get(eid(3)).reasons.some((x) => x.code === "submission_scope_unknown"));
  assert.equal(st(4), "unconfirmed"); assert.ok(p.get(eid(4)).reasons.some((x) => x.code === "workdays_unknown"));
  assert.equal(st(5), "excluded");
  assert.equal(st(6), "unconfirmed");
  assert.equal(st(7), "ok"); assert.equal(p.get(eid(7)).reportDate, "2026-10-20");
  assert.equal(st(8), "action");
  assert.equal(st(9), "excluded");
  assert.equal(st(10), "unconfirmed"); assert.ok(p.get(eid(10)).reasons.some((x) => x.code === "ambiguous_report_owner"));
  assert.equal(st(11), "check");
  assert.ok(["no_plan_for_next_workday", "undone_without_reason"].every((c) => p.get(eid(11)).reasons.some((x) => x.code === c)));
  assert.equal(st(12), "excluded");
  assert.equal(r.summary.total, 13);
  assert.equal(r.summary.checked + r.summary.unconfirmed + r.summary.excluded, r.summary.total);
  assert.equal(r.summary.consistent, true);
  assert.ok(!JSON.stringify(r).includes("違反"));
  assert.equal(f.R.gw_coach_checks.length, 13);
  assert.ok(!f.R.gw_coach_checks.some((c) => c.employee_id === eid(110)), "other tenant row never checked");
  assert.equal(r.productionReady, false); assert.equal(r.sendEnabled, false); assert.equal(r.deliveryEnabled, false);
});

test("evidence is metadata only: no report/schedule/leave body copied; schedule title/body never selected", async () => {
  const f = fixture();
  await run(f);
  const stored = JSON.stringify(f.R.gw_coach_checks);
  assert.ok(!stored.includes("合成の計画"), "tomorrow_plan text not copied");
  assert.ok(!stored.includes("本文") && !stored.includes("私的な理由"));
  const ev = f.selects.filter(([t]) => t === "gw_calendar_events").map(([, c]) => c);
  assert.ok(ev.length && ev.every((c) => !/\bbody\b/.test(c)));
  const bulk = ev[0];
  assert.ok(!/title/.test(bulk), "bulk morning read does not read titles");
  const leave = f.selects.filter(([t]) => t === "gw_requests").map(([, c]) => c);
  assert.ok(leave.every((c) => !/body|title/.test(c)));
  const one = f.R.gw_coach_checks.find((c) => c.employee_id === eid(1));
  const ref = one.detail.refs.find((x) => x.id === "report:2026-10-21");
  assert.equal(ref.source, "tc_nippo"); assert.ok(ref.submittedAt && ref.updatedAt && ref.version);
  assert.ok(one.detail.checkedAt);
});

test("private and leave-mirror events are not counted as a plan", async () => {
  const f = fixture();
  const r = await run(f);
  assert.ok(byEmp(r).get(eid(11)).reasons.some((x) => x.code === "no_plan_for_next_workday"));
  assert.ok(!byEmp(r).get(eid(11)).refs.some((x) => x.id.startsWith("schedule:")));
});

test("same source versions → no new candidates; a source change re-reviews and drops old approval", async () => {
  const f = fixture();
  const first = await run(f);
  assert.ok(first.reviewsWritten >= 3);
  const rv = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(1));
  rv.approval = { actor_user_id: OWNER }; rv.state = "approved";
  const gens = f.R.gw_coach_reviews.map((x) => x.generation);
  const second = await run(f);
  assert.equal(second.created, 0); assert.equal(second.changed, 0); assert.equal(second.unchanged, 13);
  assert.equal(second.reviewsWritten, 0);
  assert.deepEqual(f.R.gw_coach_reviews.map((x) => x.generation), gens);
  assert.equal(rv.state, "approved");
  // 本人が日報を直した
  const n = f.R.tc_nippo.find((x) => x.user_id === uid(1) && x.work_date === "2026-10-21");
  n.updated_at = "2026-10-21T12:00:00Z"; n.work_items = [{ task: "合成の確認作業", target: 4, unit: "件", done_when: "確認結果を記録", result: "完了", done: true }];
  const third = await run(f);
  assert.equal(third.changed, 1); assert.equal(third.reviewsWritten, 1);
  assert.equal(rv.generation, 2); assert.equal(rv.approval, null); assert.notEqual(rv.state, "approved");
});

test("draft: rules only, ≤3 points with one change, grounded refs, registered quantity kept, flags off", async () => {
  const f = fixture();
  await run(f);
  const r11 = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(11));
  assert.equal(r11.draft.model, "rules-only");
  assert.ok(r11.draft.points.length <= 3);
  assert.equal(r11.draft.points.filter((x) => x.kind === "change").length, 1);
  assert.equal(r11.state, "owner_review");
  assert.equal(r11.draft.needsContact, true);
  assert.equal(r11.draft.productionReady, false); assert.equal(r11.draft.semanticEvidenceVerified, false); assert.equal(r11.draft.sendEnabled, false);
  const ids = new Set(r11.draft.sources.map((s) => s.id));
  assert.ok(r11.draft.points.every((p) => p.refs.every((id) => ids.has(id))));
  assert.equal(r11.draft.routeIssue, "recipient_unverified");
  const r1 = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(1));
  assert.equal(r1.state, "no_action", "順調 + no change → no individual message");
  const g = r1.draft.goals.find((x) => x.source === "previous_workday_report").review;
  assert.equal(g.goal.quantity, 3); assert.equal(g.goal.quantityStatus, "registered_not_replaced");
  assert.equal(g.goal.metricType, null); assert.ok(g.missing.includes("指標の種類（行動量・成果物・事業成果）"));
  assert.equal(g.timing.actualMinutes, null); assert.equal(g.timing.differenceMinutes, null);
  assert.equal(g.productionReady, false);
  const focus = r1.draft.goals.find((x) => x.source === "next_workday_focus_task");
  assert.ok(focus && focus.review.goal.completionCriteria === null);
  assert.deepEqual(r1.draft.results[0].actualOrigin, "member_report");
  const r8 = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(8));
  assert.ok(r8.draft.points.find((x) => x.kind === "change").text.includes("期限"));
});

test("quantity without unit or evidence stays null (no number invented)", async () => {
  const f = fixture();
  f.R.tc_nippo.find((x) => x.user_id === uid(1)).work_items = [{ task: "合成の作業", target: 5, unit: "", done: true, result: "済" }];
  await run(f);
  const g = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(1)).draft.goals[0].review;
  assert.equal(g.goal.quantity, null); assert.ok(g.missing.includes("件数の根拠"));
});

test("unreadable source → unconfirmed (not empty, not violation); roster unreadable aborts", async () => {
  const f = fixture();
  f.mem.state.missing = "gw_requests";
  const r = await run(f);
  const p = byEmp(r);
  assert.equal(p.get(eid(1)).status, "unconfirmed");
  assert.ok(p.get(eid(1)).reasons.some((x) => x.code === "source_unavailable"));
  assert.equal(p.get(eid(5)).status, "excluded");
  assert.equal(r.summary.consistent, true);
  const g = fixture(); g.mem.state.missing = "gw_employees";
  await assert.rejects(() => run(g), /roster_unreadable/);
});

test("provisional (17:30): today's report before deadline is unconfirmed; review epoch provisional", async () => {
  const f = fixture();
  f.R.tc_nippo.push(nippo(7, "2026-10-22"));
  const r = await run(f, { mode: "provisional", now: () => new Date("2026-10-22T08:30:00Z") });
  const p = byEmp(r);
  assert.equal(p.get(eid(1)).status, "unconfirmed"); assert.ok(p.get(eid(1)).reasons.some((x) => x.code === "before_deadline"));
  assert.equal(p.get(eid(7)).reportDate, "2026-10-22");
  const rv = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(7) && x.report_date === "2026-10-22");
  assert.equal(rv.evaluation_epoch, "provisional:2026-10-22");
  assert.ok(!f.R.gw_coach_outbox.some((o) => o.kind === "team_advice"), "no team advice in provisional");
});

test("weekly (Monday): counts confirmed work days vs submitted, unknown days separate, no reviews", async () => {
  const f = fixture();
  const r = await run(f, { checkDate: "2026-10-26", mode: "weekly", now: () => new Date("2026-10-25T23:00:00Z") });
  const p = byEmp(r);
  assert.deepEqual(p.get(eid(1)).weekly, { workdays: 5, submitted: 1, missing: 4, unknown: 0 });
  assert.equal(p.get(eid(1)).status, "check");
  assert.equal(p.get(eid(4)).status, "unconfirmed");
  assert.equal(f.R.gw_coach_reviews.length, 0);
});

test("dry run reads only: no checks, reviews, outbox or RPC", async () => {
  const f = fixture();
  const r = await run(f, { dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(r.persons.length, 13);
  assert.equal(f.calls.length, 0);
  assert.equal(f.R.gw_coach_checks.length + f.R.gw_coach_reviews.length + f.R.gw_coach_outbox.length, 0);
});

test("outbox: owner report blocked without configured DM; team advice only for shared patterns and person-free", async () => {
  const f = fixture();
  f.R.tc_nippo.push(nippo(3, "2026-10-21", { tomorrow_plan: null }));
  f.R.gw_employees.find((e) => e.id === eid(3)).employment_type = "正社員";
  await run(f);
  const owner = f.R.gw_coach_outbox.find((o) => o.kind === "owner_report");
  assert.equal(owner.state, "blocked"); assert.equal(owner.target, null);
  assert.ok(owner.body.includes("合成メンバー8")); assert.ok(!owner.body.includes("合成の計画"));
  const team = f.R.gw_coach_outbox.find((o) => o.kind === "team_advice");
  assert.ok(team, "two members without plan → team tip");
  assert.ok(!/合成メンバー|[0-9]/.test(team.body));
  assert.throws(() => assertTeamSafe("合成メンバー1さんへ", ["合成メンバー1"]), /team_text_unsafe/);
  assert.throws(() => assertTeamSafe("3件未提出"), /team_text_unsafe/);
  assert.equal(buildTeamAdvice([{ status: "check", reasons: ["no_plan_for_next_workday"] }]), null, "single person pattern never goes to channel");
});

test("outbox target only from config (owner DM requires verified DM id)", () => {
  assert.equal(outboxTarget("owner_report", { slack_team_id: "TW", owner_slack_user_id: "UO" }), null);
  assert.deepEqual(outboxTarget("owner_report", { slack_team_id: "TW", owner_slack_user_id: "UO", owner_dm_channel_id: "DO" }), { kind: "owner_dm", teamId: "TW", userId: "UO", channelId: "DO" });
  assert.equal(outboxTarget("team_advice", { team_channel_id: "CX" }), null);
});

// ---------------- 外部呼び出し（P の定時タスク） ----------------
function handler(f, { env = ENV, user = OWNER, slackClient = null, fetchImpl = async () => { throw new Error("network must not be used"); } } = {}) {
  return createCoachHandler({ requireUser: async () => (user ? { id: user } : null), gwContext: async () => ({ tenantId: T, isAdmin: true, roles: ["owner"] }),
    getAdmin: () => f.sb, askJson: async () => { throw new Error("no AI"); }, readJson: async (req) => req.body, now: clock, env, fetchImpl, slackClient });
}
async function call(h, { method = "POST", headers = {}, body = {}, url = "/api/nippo/coach" } = {}) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = JSON.parse(v); } };
  await h({ method, headers, body, url }, res);
  return res;
}
const routine = (body) => ({ headers: { "x-nippo-coach-key": KEY }, body: { action: "morning", idempotencyKey: "p-0800-2026-10-22", ...body } });

test("routine auth: disabled without env, wrong key 401, tenant from env only, config gate", async () => {
  const f = fixture();
  assert.equal((await call(handler(f, { env: {} }), routine())).body.error, "routine_disabled");
  assert.equal((await call(handler(f, { env: { ...ENV, NIPPO_COACH_ROUTINE_KEY: "short" } }), routine())).statusCode, 503);
  const bad = await call(handler(f), { headers: { "x-nippo-coach-key": "x".repeat(40) }, body: { action: "morning", idempotencyKey: "p-0800-2026-10-22" } });
  assert.equal(bad.statusCode, 401); assert.equal(bad.body.retryable, false);
  f.R.gw_coach_config[0].morning_enabled = false;
  const off = await call(handler(f), routine());
  assert.equal(off.body.error, "coach_disabled"); assert.equal(f.R.gw_coach_checks.length, 0);
  f.R.gw_coach_config[0].morning_enabled = true;
  const other = await call(handler(f), routine({ tenantId: T2 }));
  assert.equal(other.statusCode, 200);
  assert.ok(f.R.gw_coach_checks.every((c) => c.tenant_id === T));
  assert.equal((await call(handler(f), { ...routine(), method: "GET" })).statusCode, 405);
});

test("routine input validation: future/old date, bad mode, missing idempotency key", async () => {
  const f = fixture(); const h = handler(f);
  for (const body of [{ date: "2026-10-23" }, { date: "2026-10-01" }, { mode: "hourly" }, { idempotencyKey: "" }, { dryRun: "yes" }, { action: "approve" }, { date: "2026-02-30" }]) {
    const r = await call(h, routine(body));
    assert.equal(r.statusCode, 400, JSON.stringify(body)); assert.equal(r.body.retryable, false);
  }
  assert.equal(parseCheckRequest({}, NOW).date, "2026-10-22");
  assert.equal(jstToday(new Date("2026-10-21T14:59:59Z")), "2026-10-21");
  assert.equal(jstToday(new Date("2026-10-21T15:00:00Z")), "2026-10-22");
});

test("routine run: per-person output, replay with same key, busy while another run holds the lease", async () => {
  const f = fixture(); const h = handler(f);
  const r = await call(h, routine());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.persons.length, 13);
  const one = r.body.persons.find((x) => x.employeeId === eid(2));
  assert.equal(one.statusLabel, "要確認"); assert.ok(one.reasons[0].label);
  assert.ok(["created", "changed", "unchanged"].includes(one.check));
  assert.equal(r.body.summary.consistent, true); assert.equal(r.body.replay, false);
  const writes = f.calls.length;
  const again = await call(h, routine());
  assert.equal(again.body.replay, true); assert.equal(f.calls.length, writes + 1, "replay only touches the lease");
  f.R.gw_coach_runs[0].state = "running";
  const busy = await call(h, routine({ idempotencyKey: "p-0800-retry-0002" }));
  assert.equal(busy.statusCode, 409); assert.equal(busy.body.error, "run_in_progress"); assert.equal(busy.body.retryable, true);
  f.R.gw_coach_runs[0].state = "done";
  const rerun = await call(h, routine({ idempotencyKey: "p-0800-retry-0003" }));
  assert.equal(rerun.body.unchanged, 13); assert.equal(rerun.body.reviewsWritten, 0);
});

test("routine partial failure is reported retryable and leaves lease failed", async () => {
  const f = fixture(); const h = handler(f);
  const orig = f.sb.rpc; let n = 0;
  f.sb.rpc = async (name, args) => { if (name === "gw_coach_record_check" && ++n === 3) return { data: null, error: { message: "boom" } }; return orig(name, args); };
  const r = await call(h, routine());
  assert.equal(r.statusCode, 503); assert.equal(r.body.retryable, true); assert.equal(r.body.partial, true);
  assert.equal(f.R.gw_coach_runs[0].state, "failed");
  f.sb.rpc = orig;
  const retry = await call(h, routine());
  assert.equal(retry.statusCode, 200); assert.equal(retry.body.unchanged, 2);
});

test("routine dry run needs no idempotency key and writes nothing", async () => {
  const f = fixture();
  const r = await call(handler(f), { headers: { "x-nippo-coach-key": KEY }, body: { action: "morning", dryRun: true } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.dryRun, true);
  assert.equal(f.calls.length, 0);
});

test("owner screen view + outbox approval bound to body/target/generation; delivery stays off", async () => {
  const f = fixture();
  Object.assign(f.R.gw_coach_config[0], { slack_team_id: "TSYN", owner_slack_user_id: "USYN", owner_dm_channel_id: "DSYN" });
  const h = handler(f);
  await call(h, routine());
  const v = await call(h, { method: "GET", url: "/api/nippo/coach?view=checks&date=2026-10-22&mode=morning" });
  assert.equal(v.statusCode, 200);
  assert.equal(v.body.checks.length, 13); assert.equal(v.body.summary.consistent, true);
  assert.equal(v.body.deliveryEnabled, false); assert.equal(v.body.settings.deliveryBlockedBy, "coach_delivery_disabled");
  assert.ok(v.body.checks.find((c) => c.employee_id === eid(2)).name === "合成メンバー2");
  const o = f.R.gw_coach_outbox.find((x) => x.kind === "owner_report");
  assert.equal(o.state, "draft");
  const stale = await call(h, { body: { action: "approve_outbox", id: o.id, bodyHash: "x", targetHash: o.target_hash, generation: 1 } });
  assert.equal(stale.statusCode, 409);
  const ok = await call(h, { body: { action: "approve_outbox", id: o.id, bodyHash: o.body_hash, targetHash: o.target_hash, generation: o.generation } });
  assert.equal(ok.body.approved, true);
  const send = await call(h, { body: { action: "deliver", kind: "outbox", id: o.id } });
  assert.deepEqual(send.body, { status: "blocked", error: "coach_delivery_disabled" });
  assert.equal(o.state, "approved");
  const nonOwner = await call(handler(f, { user: uid(1) }), { method: "GET", url: "/api/nippo/coach?view=checks" });
  assert.equal(nonOwner.statusCode, 403);
});

// ---------------- Slack preflight / 送信 ----------------
const SLACK_CFG = { enabled: true, delivery_enabled: true, owner_user_id: OWNER, slack_team_id: "TSYN", slack_bot_user_id: "BSYN", team_channel_id: "CSYN", owner_slack_user_id: "USYN", owner_dm_channel_id: "DSYN" };
function fakeSlack(over = {}) {
  const calls = [];
  const base = {
    authTest: async () => ({ ok: true, team_id: "TSYN", user_id: "BSYN" }),
    conversationsInfo: async (c) => c === "CSYN" ? { ok: true, channel: { id: "CSYN", is_member: true, is_archived: false, is_im: false } }
      : c === "DSYN" ? { ok: true, channel: { id: "DSYN", is_im: true, user: "USYN" } } : { ok: false, error: "channel_not_found" },
    usersInfo: async (u) => ({ ok: true, user: { id: u, team_id: "TSYN", deleted: false, is_bot: false, profile: { email: "m99@example.invalid" } } }),
    ...over,
  };
  return Object.assign(Object.fromEntries(Object.entries(base).map(([k, fn]) => [k, (...a) => { calls.push(k); return fn(...a); }])), { calls });
}

test("preflight (read-only, mocked Slack): all checks pass only when workspace, bot, channel, owner and DM match", async () => {
  const ok = await slackPreflight({ config: SLACK_CFG, client: fakeSlack(), ownerEmail: "M99@example.invalid", now: clock });
  assert.equal(ok.ok, true); assert.equal(ok.configHash, slackConfigHash(SLACK_CFG));
  const cases = [
    [{ authTest: async () => ({ ok: true, team_id: "TOTHER", user_id: "BSYN" }) }, "workspace"],
    [{ authTest: async () => ({ ok: true, team_id: "TSYN", user_id: "BOTHER" }) }, "bot_identity"],
    [{ conversationsInfo: async (c) => c === "CSYN" ? { ok: true, channel: { id: "CSYN", is_member: false } } : { ok: true, channel: { id: "DSYN", is_im: true, user: "USYN" } } }, "daily_channel_member"],
    [{ conversationsInfo: async (c) => c === "CSYN" ? { ok: true, channel: { id: "CSYN", is_member: true } } : { ok: true, channel: { id: "DSYN", is_im: true, user: "UOTHER" } } }, "owner_dm"],
    [{ conversationsInfo: async (c) => c === "CSYN" ? { ok: true, channel: { id: "CSYN", is_member: true } } : { ok: true, channel: { id: "DSYN", is_im: false, is_mpim: true } } }, "owner_dm"],
    [{ usersInfo: async () => ({ ok: true, user: { id: "USYN", team_id: "TSYN", profile: { email: "someone@example.invalid" } } }) }, "owner_gw_mapping"],
    [{ usersInfo: async () => ({ ok: true, user: { id: "USYN", team_id: "TOTHER", profile: { email: "m99@example.invalid" } } }) }, "owner_user"],
    [{ authTest: async () => { throw new Error("timeout"); } }, "workspace"],
  ];
  for (const [over, name] of cases) {
    const r = await slackPreflight({ config: SLACK_CFG, client: fakeSlack(over), ownerEmail: "m99@example.invalid", now: clock });
    assert.equal(r.ok, false, name); assert.equal(r.checks.find((c) => c.name === name).ok, false, name);
  }
  const missing = await slackPreflight({ config: { ...SLACK_CFG, owner_dm_channel_id: null }, client: fakeSlack(), ownerEmail: "m99@example.invalid", now: clock });
  assert.equal(missing.ok, false); assert.match(missing.checks[0].code, /owner_dm_channel_id/);
});

test("delivery gates: DB flag, env flag, token, team, preflight and preflight freshness", () => {
  const denv = coachDeliveryEnv({ NIPPO_COACH_SEND_ENABLED: "1", NIPPO_COACH_SLACK_BOT_TOKEN: "test-token-not-real", NIPPO_COACH_SLACK_TEAM_ID: "TSYN" });
  const pf = { ok: true, configHash: slackConfigHash(SLACK_CFG) };
  assert.equal(deliveryBlock({ ...SLACK_CFG, delivery_enabled: false, slack_preflight: pf }, denv), "coach_delivery_disabled");
  assert.equal(deliveryBlock({ ...SLACK_CFG, slack_preflight: pf }, coachDeliveryEnv({})), "coach_send_env_off");
  assert.equal(deliveryBlock({ ...SLACK_CFG, slack_preflight: pf }, { ...denv, token: null }), "coach_slack_not_configured");
  assert.equal(deliveryBlock({ ...SLACK_CFG, slack_preflight: pf }, { ...denv, teamId: "TOTHER" }), "slack_team_mismatch");
  assert.equal(deliveryBlock({ ...SLACK_CFG, slack_preflight: null }, denv), "slack_preflight_required");
  assert.equal(deliveryBlock({ ...SLACK_CFG, slack_preflight: { ...pf, ok: false } }, denv), "slack_preflight_required");
  assert.equal(deliveryBlock({ ...SLACK_CFG, team_channel_id: "CNEW", slack_preflight: pf }, denv), "slack_preflight_required");
  assert.equal(deliveryBlock({ ...SLACK_CFG, slack_preflight: pf }, denv), null);
  assert.equal(coachDeliveryEnv({}).sendEnabled, false);
});

async function approvedOwnerReport() {
  const f = fixture();
  const cfg = Object.assign(f.R.gw_coach_config[0], SLACK_CFG, { morning_enabled: true });
  cfg.slack_preflight = { ok: true, configHash: slackConfigHash(cfg) };
  await run(f);
  const o = f.R.gw_coach_outbox.find((x) => x.kind === "owner_report");
  assert.equal(fakeRpc(f.R, "gw_coach_outbox_approve", { p_id: o.id, p_generation: o.generation, p_approval: { actor_user_id: OWNER, body_hash: o.body_hash, target_hash: o.target_hash, generation: o.generation } }), true);
  const denv = coachDeliveryEnv({ NIPPO_COACH_SEND_ENABLED: "1", NIPPO_COACH_SLACK_BOT_TOKEN: "test-token-not-real", NIPPO_COACH_SLACK_TEAM_ID: "TSYN" });
  return { f, cfg, o, denv };
}

test("outbox delivery (mock fetch): attempt persisted first, sent once, never twice", async () => {
  const { f, cfg, o, denv } = await approvedOwnerReport();
  const posts = [];
  const fetchImpl = async (url, init) => { assert.equal(o.state, "delivery_attempted", "attempt recorded before network"); posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, ts: "1.0" }) }; };
  assert.deepEqual(await deliverOutbox(f.sb, o, { config: cfg, denv, fetchImpl }), { status: "sent" });
  assert.equal(posts.length, 1); assert.equal(posts[0].channel, "DSYN"); assert.equal(posts[0].mrkdwn, false);
  assert.equal(o.state, "sent");
  await assert.rejects(() => deliverOutbox(f.sb, o, { config: cfg, denv, fetchImpl }), /not_approved/);
  assert.equal(posts.length, 1);
});

test("timeout → delivery_unknown, no automatic resend; changed body/recipient after approval refused", async () => {
  const { f, cfg, o, denv } = await approvedOwnerReport();
  let n = 0;
  const r = await deliverOutbox(f.sb, o, { config: cfg, denv, fetchImpl: async () => { n++; throw new Error("TimeoutError"); } });
  assert.deepEqual(r, { status: "delivery_unknown" }); assert.equal(o.state, "delivery_unknown"); assert.equal(n, 1);
  const again = await approvedOwnerReport();
  again.o.body += "（改変）";
  await assert.rejects(() => deliverOutbox(again.f.sb, again.o, { config: again.cfg, denv, fetchImpl: async () => assert.fail("must not send") }), /draft_changed/);
  const moved = await approvedOwnerReport();
  moved.cfg.owner_dm_channel_id = "DOTHER";
  moved.cfg.slack_preflight = { ok: true, configHash: slackConfigHash(moved.cfg) };
  await assert.rejects(() => deliverOutbox(moved.f.sb, moved.o, { config: moved.cfg, denv, fetchImpl: async () => assert.fail("must not send") }), /recipient_changed/);
});

test("member advice delivery requires owner approval of exact text + verified 3-member route; otherwise nothing is sent", async () => {
  const f = fixture();
  const cfg = Object.assign(f.R.gw_coach_config[0], SLACK_CFG);
  cfg.slack_preflight = { ok: true, configHash: slackConfigHash(cfg) };
  f.R.gw_coach_recipients.push({ tenant_id: T, employee_id: eid(11), team_id: "TSYN", sender_id: "BSYN", owner_slack_id: "USYN", member_slack_id: "UM11", conversation_id: "GSYN", members: ["BSYN", "USYN", "UM11"], mapping_version: "v1", verified_at: "2026-10-01" });
  await run(f);
  const rv = f.R.gw_coach_reviews.find((x) => x.employee_id === eid(11));
  assert.ok(rv.draft.targetHash);
  const denv = coachDeliveryEnv({ NIPPO_COACH_SEND_ENABLED: "1", NIPPO_COACH_SLACK_BOT_TOKEN: "test-token-not-real", NIPPO_COACH_SLACK_TEAM_ID: "TSYN" });
  const never = async () => assert.fail("must not send");
  await assert.rejects(() => deliverReview(f.sb, rv, { config: cfg, denv, fetchImpl: never }), /not_approved/);
  const h = handler(f);
  const ap = await call(h, { body: { action: "approve", id: rv.id, draftId: rv.draft.id, text: rv.draft.text, targetHash: rv.draft.targetHash } });
  assert.equal(ap.body.approved, true); assert.equal(ap.body.deliveryEnabled, false);
  const posts = [];
  const r = await deliverReview(f.sb, rv, { config: cfg, denv, fetchImpl: async (u, i) => { posts.push(JSON.parse(i.body)); return { ok: true, json: async () => ({ ok: true, ts: "2.0" }) }; } });
  assert.deepEqual(r, { status: "sent" }); assert.equal(posts[0].channel, "GSYN"); assert.equal(posts[0].text, rv.draft.text);
});

test("owner report never contains report bodies; summary helper reconciles", () => {
  const people = [{ status: "ok", reasons: [], name: "合成A" }, { status: "unconfirmed", reasons: ["workdays_unknown"], name: "合成B" }, { status: "excluded", reasons: ["left_confirmed"], name: "合成C" }];
  const s = summarize(people);
  assert.deepEqual([s.total, s.checked, s.unconfirmed, s.excluded, s.consistent], [3, 1, 1, 1, true]);
  const body = buildOwnerReport(s, people, { checkDate: "2026-10-22", mode: "morning" });
  assert.ok(body.includes("未確認：合成B（勤務曜日が未設定）"));
  assert.ok(body.includes("本人の問題ではありません"));
  assert.equal(STATUS_LABEL.unconfirmed, "未確認");
});

test("classifyPerson is deterministic and independent of process timezone", () => {
  const f = fixture();
  const inputs = { employees: f.R.gw_employees, mapping: f.R.gw_employees, prefs: f.R.gw_reminder_prefs, leaves: [], contracts: [], nippos: f.R.tc_nippo, focus: [], events: [], tasks: [] };
  const a = classifyPerson(emp(1), inputs, { checkDate: "2026-10-22", mode: "morning" });
  const b = classifyPerson(emp(1), inputs, { checkDate: "2026-10-22", mode: "morning" });
  assert.equal(a.bulkHash, b.bulkHash);
  assert.equal(a.reportDate, "2026-10-21"); assert.equal(a.nextWorkday, "2026-10-22");
  assert.equal(digest({ x: 1 }), digest({ x: 1 }));
});

test("every team tip template passes the person-free guard", () => {
  const codes = ["no_plan_for_next_workday", "undone_without_reason", "overdue_tasks"];
  const people = [0, 1].map(() => ({ status: "check", reasons: codes }));
  const body = buildTeamAdvice(people);
  assert.equal(assertTeamSafe(body, ["合成メンバー1"]), body);
  assert.equal(body.split("\n").filter((l) => l.startsWith("・")).length, 3);
});

test("preflight action stores the read-only result; failure keeps delivery blocked", async () => {
  const f = fixture();
  Object.assign(f.R.gw_coach_config[0], SLACK_CFG);
  f.R.gw_employees.find((e) => e.id === eid(99)).email = "m99@example.invalid";
  const env = { ...ENV, NIPPO_COACH_SEND_ENABLED: "1", NIPPO_COACH_SLACK_BOT_TOKEN: "test-token-not-real", NIPPO_COACH_SLACK_TEAM_ID: "TSYN" };
  const bad = fakeSlack({ authTest: async () => ({ ok: true, team_id: "TSYN", user_id: "BOTHER" }) });
  const r1 = await call(handler(f, { env, slackClient: bad }), { body: { action: "preflight" } });
  assert.equal(r1.body.preflight.ok, false);
  assert.equal(deliveryBlock(f.R.gw_coach_config[0], coachDeliveryEnv(env)), "slack_preflight_required");
  const good = fakeSlack();
  const r2 = await call(handler(f, { env, slackClient: good }), { body: { action: "preflight" } });
  assert.equal(r2.body.preflight.ok, true);
  assert.ok(good.calls.every((m) => ["authTest", "conversationsInfo", "usersInfo"].includes(m)), "read-only Slack methods only");
  assert.equal(deliveryBlock(f.R.gw_coach_config[0], coachDeliveryEnv(env)), null);
  f.R.gw_coach_config[0].owner_dm_channel_id = "DNEW";
  assert.equal(deliveryBlock(f.R.gw_coach_config[0], coachDeliveryEnv(env)), "slack_preflight_required", "setting change voids preflight");
});
