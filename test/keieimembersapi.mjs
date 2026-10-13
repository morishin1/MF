// 経営「メンバー実行状況」（GET /api/keiei?view=members・lib/member-exec.js・lib/member-exec-read.js・lib/follow-read.js）。
//
// ■ 何を守るテストか
//   1. 経営者（owner）だけ。人事・管理者・一般は 403（ほかの経営の画面と同じ入口）
//   2. 名簿は日報・勤怠と同じ：在籍・退職予定でログインできる人。退職済み・ログインなし・招待中・他社は出ない
//   3. 日報の提出／未提出、今日の3つ 0/3〜3/3、期限超過（完了・テンプレート・他社は数えない）、明日の3つ未登録・未確定、相談・ブロッカー
//   4. 状態（要対応・注意・良好）と並び（要対応 → 注意 → 良好。同じなら期限超過の多い順）
//   5. 読み取りだけ（書き込みは1回もしない）。給与・契約の表は読まない
//   6. 読めなかった元データは 0 や「良好」にしない（null と unreadable）
//   7. 1人の詳細（ドロワー）：今日の日報・今日の3つ・止まっているもの・明日の3つ・今週
//   8. 既存の判定と同じ：全員のタスク（api/tasks/board.js）の行・日報・勤怠の要フォロー（findFollowUps）と食い違わない
//   9. 「相談事項」（consult_note）も相談ありになる（lib/follow.js）。ホームの要約（hub の memberExec）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";
import * as FX from "./fixtures/member-exec.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const realNow = Date.now;
Date.now = () => Date.parse(FX.NOW_ISO);

const mem = createMemDb();
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-owner" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
const { default: keiei } = await import(atRoot("api/keiei/index.js"));
const { default: board } = await import(atRoot("api/tasks/board.js"));
const F = await import(atRoot("lib/follow.js"));
const M = await import(atRoot("lib/member-exec.js"));

const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const get = async (q, h = keiei) => { const r = res(); await h({ method: "GET", url: q, headers: {} }, r); return r; };
const ctxOf = (roles, extra = {}) => ({ tenantId: FX.TENANT, isAdmin: false, isHr: REAL_GW.isHrOf({ roles, apps: [] }), roles, apps: [], employee: { id: "e1" }, ...extra });
const OWNER = ctxOf(["owner"]);

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};
function setup() { mem.reset(); mem.state.missing = null; Object.assign(mem.rows, FX.memberExecRows()); who = OWNER; }
const byName = (r, n) => r.body.members.find((m) => m.name.startsWith(n));

console.log("\n=== 入口 ===\n");
await ok("経営者だけ。人事・管理者・一般は 403", async () => {
  setup();
  assert.equal((await get("/api/keiei?view=members")).statusCode, 200);
  for (const c of [ctxOf(["hr"]), ctxOf([], { isAdmin: true }), ctxOf(["manager"]), ctxOf([])]) {
    who = c;
    assert.equal((await get("/api/keiei?view=members")).statusCode, 403, JSON.stringify(c.roles));
  }
});

console.log("\n=== 一覧 ===\n");
await ok("名簿：在籍・退職予定でログインできる人だけ。退職済み・ログインなし・招待中・他社は出ない", async () => {
  setup();
  const r = await get("/api/keiei?view=members");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.members.map((m) => m.name).sort(), ["中村 テスト", "今福 テスト", "山内 テスト", "藤本 テスト"].sort());
  assert.equal(r.body.date, FX.TODAY);
  assert.equal(r.body.isToday, true);
  assert.deepEqual(r.body.unreadable, []);
});

await ok("日報・今日の3つ・期限超過・明日の3つ・相談・ブロッカー", async () => {
  setup();
  const r = await get("/api/keiei?view=members");
  const n = byName(r, "中村"), f = byName(r, "藤本"), y = byName(r, "山内"), i = byName(r, "今福");
  assert.deepEqual([n.nippo.submitted, f.nippo.submitted, y.nippo.submitted, i.nippo.submitted], [true, false, true, true]);
  assert.deepEqual([n.today.done, f.today.done, y.today.done, i.today.done], [3, 1, 2, 3]);
  assert.ok(n.today.allDone && !f.today.allDone);
  assert.deepEqual([n.overdue, f.overdue, y.overdue, i.overdue], [0, 2, 1, 0], "完了・テンプレート・他社は数えない");
  assert.deepEqual([n.tomorrow.confirmed, f.tomorrow.count, y.tomorrow.confirmed, i.tomorrow.confirmed], [true, 0, false, true]);
  assert.ok(f.follow.some((x) => x.kind === "not_submitted"), "日報未提出2日");
  assert.ok(i.follow.some((x) => x.kind === "consult" && x.detail.includes("値引き")), "相談事項（consult_note）も相談あり");
  assert.ok(i.follow.some((x) => x.kind === "blocker"), "5日止まっている仕事");
  assert.equal(i.consultOrBlocker, true);
});

await ok("状態と並び：要対応（期限超過の多い順）→ 注意 → 良好", async () => {
  setup();
  const r = await get("/api/keiei?view=members");
  assert.deepEqual(r.body.members.map((m) => `${m.name.split(" ")[0]}:${m.status}`), ["藤本:danger", "今福:danger", "山内:warn", "中村:good"]);
  const y = byName(r, "山内");
  assert.ok(y.reasons.some((x) => x.key === "overdue" && x.level === "warn"), "期限超過1件は注意");
  assert.ok(y.reasons.some((x) => x.key === "tomorrow_open"), "明日の3つが未確定");
  const f = byName(r, "藤本");
  assert.ok(f.reasons.some((x) => x.key === "overdue" && x.level === "danger"), "期限超過2件は要対応");
  assert.ok(f.reasons.some((x) => x.key === "tomorrow_none"));
  assert.deepEqual(byName(r, "中村").reasons, []);
});

await ok("上部の数・今日の要フォロー（最大5人）", async () => {
  setup();
  const r = await get("/api/keiei?view=members");
  assert.deepEqual(r.body.summary, { people: 4, nippoSubmitted: 3, focusDone: 2, followRequired: 2, overdue: 3, tomorrowMissing: 1, consultOrBlocker: 1 });
  assert.deepEqual(r.body.follow.map((x) => x.name), ["藤本 テスト", "今福 テスト"]);
  assert.ok(r.body.follow[0].reasons.some((x) => x.includes("期限超過 2件")));
  assert.deepEqual(r.body.departments, ["営業", "開発"]);
});

await ok("読み取りだけ。給与・契約の表は読まない", async () => {
  setup();
  await get("/api/keiei?view=members");
  await get("/api/keiei?view=members&employeeId=e2");
  assert.ok(!mem.state.log.some((l) => l.op !== "select"), "書き込みなし");
  const read = new Set(mem.state.log.map((l) => l.table));
  for (const t of ["gw_contracts", "gw_compensations", "gw_hr_pay", "gw_time_entries"]) assert.ok(!read.has(t), `${t} を読まない`);
});

await ok("読めなかった元データは 0 や「良好」にしない（null・unreadable）", async () => {
  setup();
  mem.state.missing = "gw_tasks";
  try {
    const r = await get("/api/keiei?view=members");
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.unreadable.includes("今日・明日の3つ") && r.body.unreadable.includes("期限超過"));
    assert.equal(r.body.summary.focusDone, null);
    assert.equal(r.body.summary.overdue, null);
    assert.equal(r.body.summary.tomorrowMissing, null);
    assert.ok(r.body.members.every((m) => m.overdue === null && m.today === null));
  } finally { mem.state.missing = null; }
  mem.state.missing = "tc_nippo";
  try {
    const r = await get("/api/keiei?view=members");
    assert.equal(r.body.summary.nippoSubmitted, null);
    assert.ok(r.body.members.every((m) => m.nippo.submitted === null), "未提出とは言わない");
  } finally { mem.state.missing = null; }
});

await ok("過去の日を見る（date）：その日の日報が無ければ要対応。未来の日は今日にそろえる", async () => {
  setup();
  const r = await get(`/api/keiei?view=members&date=${FX.PREV}`);
  assert.equal(r.body.date, FX.PREV);
  assert.equal(r.body.isToday, false);
  const f = byName(r, "藤本");
  assert.ok(f.reasons.some((x) => x.key === "nippo_today" && x.level === "danger" && x.label === "日報未提出"));
  assert.equal((await get("/api/keiei?view=members&date=2099-01-01")).body.date, FX.TODAY);
});

console.log("\n=== 1人の詳細 ===\n");
await ok("今日の日報・今日の3つ・止まっているもの・明日の3つ・今週", async () => {
  setup();
  const r = await get("/api/keiei?view=members&employeeId=e4");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body.detail;
  assert.equal(d.member.name, "今福 テスト");
  assert.equal(d.nippo.submitted, true);
  assert.equal(d.nippo.consult, "見積の値引き幅を相談したい");
  assert.equal(d.nippoId, "n-u4-2026-10-15");
  assert.equal(d.today.length, 3);
  assert.ok(d.today.every((t) => t.done && t.purpose && t.doneCondition && t.kpi));
  assert.deepEqual(d.stuck.blockers.map((b) => b.title), ["先方の決裁待ち"]);
  assert.equal(d.tomorrow.confirmed, true);
  assert.equal(d.tomorrow.complete, true);
  assert.equal(d.week.nippo.expected, 2, "火・水の2営業日（10/12 月はスポーツの日。祝日は数えない）");
  assert.equal(d.week.nippo.submitted, 2);
  const f = (await get("/api/keiei?view=members&employeeId=e2")).body.detail;
  assert.equal(f.nippo.submitted, false);
  assert.deepEqual(f.stuck.overdue.map((t) => t.title).sort(), ["請求書の再発行", "見積の修正"].sort());
  assert.deepEqual(f.stuck.carried.map((t) => t.carryCount), [2]);
  assert.equal(f.stuck.noCondition.length, 1, "完了条件が未入力");
  assert.equal(f.tomorrow.count, 0);
  const n = (await get("/api/keiei?view=members&employeeId=e1")).body.detail;
  assert.deepEqual(n.nippo.replies, { admin: 1, ai: 0 });
  assert.equal((await get("/api/keiei?view=members&employeeId=e5")).statusCode, 404, "退職済みは開けない");
  assert.equal((await get("/api/keiei?view=members&employeeId=x1")).statusCode, 404, "他社は開けない");
});

console.log("\n=== 既存の判定と同じ ===\n");
await ok("全員のタスク（api/tasks/board.js）と、今日の3つ・明日の3つの数が同じ", async () => {
  setup();
  const mine = (await get("/api/keiei?view=members")).body.members;
  who = { ...OWNER, isHr: true };
  const b = await get(`/api/tasks/board?date=${FX.TODAY}`, board);
  assert.equal(b.statusCode, 200, JSON.stringify(b.body));
  for (const m of mine) {
    const row = b.body.rows.find((x) => x.employeeId === m.employeeId);
    assert.deepEqual([m.today.done, m.today.total, m.tomorrow.count, m.tomorrow.confirmed], [row.today.done, row.today.count, row.tomorrow.count, row.tomorrow.confirmed], m.name);
  }
  assert.ok(b.body.rows.every((r) => !("_today" in r)), "全員のタスクの応答は変えない");
});

await ok("要フォローは findFollowUps と同じ（相談事項 consult_note も拾う）", async () => {
  const out = F.findFollowUps({ date: FX.TODAY, staff: [{ user_id: "u9", display_name: "x" }],
    nippos: [{ user_id: "u9", work_date: FX.TODAY, consult_note: "相談です", issues: [], no_issues: true }], kpis: [] });
  assert.ok(out[0].reasons.some((r) => r.kind === "consult" && r.detail === "相談です"));
  const old = F.findFollowUps({ date: FX.TODAY, staff: [{ user_id: "u9", display_name: "x" }],
    nippos: [{ user_id: "u9", work_date: FX.TODAY, issues: [{ issue: "困った", consulted: "上長" }], no_issues: false }], kpis: [] });
  assert.equal(old[0].reasons.find((r) => r.kind === "consult").detail, "困った", "036 より前の形も今までどおり");
});

await ok("ホーム（hub）に要約：要フォロー・日報未提出・明日の3つ未登録", async () => {
  setup();
  const r = await get("/api/keiei?view=hub");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual(r.body.memberExec, { followRequired: 2, nippoMissing: 1, tomorrowMissing: 1 });
});

await ok("並び（compareMembers）：同じ状態なら 期限超過 → 日報未提出 → 完了率 → 明日の3つ未登録", async () => {
  const mk = (name, o) => ({ name, status: "warn", overdue: 0, nippo: { submitted: true }, today: { done: 1, total: 3 }, tomorrow: { count: 3 }, ...o });
  const rows = [mk("A"), mk("B", { tomorrow: { count: 0 } }), mk("C", { today: { done: 0, total: 3 } }), mk("D", { nippo: { submitted: false } }), mk("E", { overdue: 1 })];
  assert.deepEqual(rows.sort(M.compareMembers).map((r) => r.name), ["E", "D", "C", "B", "A"]);
});

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
