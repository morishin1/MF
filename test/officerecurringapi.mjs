// Office 定例業務マスター・Office 業務予定（db/125・lib/office-recurring.js・api/office-tasks/recurring.js・api/office-tasks/calendar.js・api/cron/office-recurring.js）。
//
// ■ 何を守るテストか
//   1. 繰り返し：毎月（日・末日・最終営業日・31日のない月）・毎年・毎週・1回だけ・土日祝の前後への移動・開始／終了日
//   2. 期限：予定日と同じ・n日後・毎月d日（前なら翌月）・月末
//   3. 自動生成：今日から先90日の無い回だけ作る。二重に作らない（同時に作っても・cron を2回回しても）。完了・今回なしの回は作り直さない
//   4. マスターを直す → 今日以降の未完了だけ作り直す（完了・過去は残す）／停止 → 今日以降の未完了を消す（マスターは消さない）
//   5. 担当者：名簿にいない人は付けられない。退職したら「担当者未設定」
//   6. カテゴリの権限：人事・労務＝人事、経理＝経理、営業事務＝経理か月末月初、全体ほか＝見るのは Office の業務のどれか・直すのは月末月初
//   7. 完了：完了日時・完了した人を残す。担当者本人は完了にできる。ほかのカテゴリの人はできない（404/403）
//   8. 期限超過：範囲より前の未完了で期限を過ぎたものを返す
//   9. Excel：月をまたいで出る文言は毎月、毎年のことばは毎年、ほかは単発（初めは除外）。同じ月の古いシートは使わない。同じ行は2回入れない
//   10. 個人の予定（gw_calendar_events）には書かない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002";
const TODAY = "2026-10-07";   // 水曜

const L = await import(atRoot("lib/office-recurring.js"));
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};
const M = (type, rule, extra = {}) => ({ id: "m", tenant_id: T1, title: "t", category: "finance", recurrence_type: type, recurrence_rule: rule, start_on: "2026-01-01", end_on: null, due_rule: { type: "same" }, is_active: true, ...extra });

console.log("\n=== 繰り返しの計算（lib） ===\n");

await ok("毎月：日・末日・31日の無い月は月末・最終営業日（の n 営業日前）", async () => {
  assert.deepEqual(L.occurrences(M("monthly", { day: 10 }), "2026-10-01", "2026-12-31"), ["2026-10-10", "2026-11-10", "2026-12-10"]);
  assert.deepEqual(L.occurrences(M("monthly", { day: 31 }), "2026-09-01", "2026-11-30"), ["2026-09-30", "2026-10-31", "2026-11-30"]);
  assert.deepEqual(L.occurrences(M("monthly", { type: "month_end" }), "2026-02-01", "2026-02-28"), ["2026-02-28"]);
  assert.deepEqual(L.occurrences(M("monthly", { type: "month_end_biz", n: 0 }), "2026-10-01", "2026-10-31"), ["2026-10-30"], "10/31 は土曜 → 30日（金）");
  assert.deepEqual(L.occurrences(M("monthly", { type: "month_end_biz", n: 1 }), "2026-10-01", "2026-10-31"), ["2026-10-29"]);
});

await ok("土日祝の移動：前の営業日／次の営業日（祝日表 lib/holidays.js）", async () => {
  assert.deepEqual(L.occurrences(M("monthly", { day: 10, shift: "prev" }), "2026-10-01", "2026-10-31"), ["2026-10-09"], "10/10 は土曜 → 9日（金）");
  assert.deepEqual(L.occurrences(M("monthly", { day: 10, shift: "next" }), "2026-10-01", "2026-10-31"), ["2026-10-13"], "10/10 土・11 日・12 スポーツの日 → 13日");
  assert.deepEqual(L.occurrences(M("monthly", { day: 1, shift: "prev" }), "2026-10-25", "2026-11-05"), ["2026-10-30"], "11/1 は日曜 → 前月の30日（範囲に入る）");
});

await ok("毎年・毎週・1回だけ・開始日と終了日", async () => {
  assert.deepEqual(L.occurrences(M("yearly", { month: 11, day: 10 }), "2026-01-01", "2027-12-31"), ["2026-11-10", "2027-11-10"]);
  assert.deepEqual(L.occurrences(M("yearly", { month: 2, type: "month_end" }), "2027-01-01", "2028-12-31"), ["2027-02-28", "2028-02-29"]);
  assert.deepEqual(L.occurrences(M("weekly", { dows: [1, 5] }), "2026-10-05", "2026-10-11"), ["2026-10-05", "2026-10-09"]);
  assert.deepEqual(L.occurrences(M("none", { date: "2026-10-20" }), "2026-10-01", "2026-10-31"), ["2026-10-20"]);
  assert.deepEqual(L.occurrences(M("monthly", { day: 5 }, { start_on: "2026-11-01", end_on: "2027-01-31" }), "2026-10-01", "2027-03-31"), ["2026-11-05", "2026-12-05", "2027-01-05"]);
});

await ok("期限：予定日と同じ・n日後・毎月d日（予定日より前なら翌月）・月末", async () => {
  assert.equal(L.dueOf(M("monthly", {}), "2026-10-05"), "2026-10-05");
  assert.equal(L.dueOf(M("monthly", {}, { due_rule: { type: "offset", days: 3 } }), "2026-10-05"), "2026-10-08");
  assert.equal(L.dueOf(M("monthly", {}, { due_rule: { type: "day", day: 8 } }), "2026-10-05"), "2026-10-08");
  assert.equal(L.dueOf(M("monthly", {}, { due_rule: { type: "day", day: 3 } }), "2026-10-05"), "2026-11-03");
  assert.equal(L.dueOf(M("monthly", {}, { due_rule: { type: "month_end" } }), "2026-02-05"), "2026-02-28");
});

await ok("生成の計画：無い回だけ。同じキーは1回", async () => {
  const have = new Set(["m|2026-10-10"]);
  const rows = L.planGeneration([M("monthly", { day: 10 })], have, { from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(rows.map((r) => r.event_date), ["2026-11-10", "2026-12-10"]);
  assert.equal(L.planGeneration([M("monthly", { day: 10 })], have, { from: "2026-10-01", to: "2026-12-31" }).length, 0, "2回目は作らない");
  assert.equal(L.planGeneration([M("monthly", { day: 10 }, { is_active: false })], new Set(), { from: "2026-10-01", to: "2026-12-31" }).length, 0, "停止は作らない");
});

await ok("表示のことば・入力の確かめ", async () => {
  assert.equal(L.describeRule("monthly", { day: 10, shift: "prev" }), "毎月 10日（土日祝は前の営業日）");
  assert.equal(L.describeRule("yearly", { month: 5, type: "month_end" }), "毎年 5月末日");
  const bad = L.validateMaster({ title: "", category: "x", recurrenceType: "monthly", recurrenceRule: { day: 40 } });
  assert.ok(bad.problems.length >= 3);
  const good = L.validateMaster({ title: "給与データ確認", category: "finance", recurrenceType: "monthly", recurrenceRule: { day: 8, shift: "prev", junk: 1 }, dueRule: { type: "day", day: 10 }, url: "https://example.jp/a" });
  assert.deepEqual(good.value.recurrence_rule, { shift: "prev", day: 8 }, "知らない項目は捨てる");
  assert.ok(L.validateMaster({ title: "x", category: "finance", recurrenceType: "monthly", recurrenceRule: { day: 1 }, url: "javascript:alert(1)" }).problems, "http(s) 以外の URL は断る");
});

await ok("カテゴリの権限", async () => {
  const hr = { hr: true, fin: false, app: false, admin: false }, fin = { hr: false, fin: true, app: true, admin: false }, mgr = { hr: false, fin: false, app: true, admin: false };
  assert.ok(L.canViewCategory(hr, "hr") && L.canViewCategory(hr, "labor") && !L.canViewCategory(hr, "finance") && !L.canViewCategory(hr, "sales_admin"));
  assert.ok(L.canViewCategory(hr, "all") && !L.canEditCategory(hr, "all"), "人事は全体を見られるが直せない");
  assert.ok(L.canEditCategory(fin, "finance") && L.canEditCategory(fin, "sales_admin") && L.canEditCategory(fin, "all") && !L.canViewCategory(fin, "hr"));
  assert.ok(!L.canViewCategory(mgr, "finance") && L.canEditCategory(mgr, "sales_admin") && L.canEditCategory(mgr, "ecnw"));
});

console.log("\n=== Excel 年間予定表の分類（lib） ===\n");

await ok("毎月（4か月以上）・毎年（ことば）・単発（除外）。古いシートは使わない", async () => {
  const cells = [];
  const sheets = [["202510月", 10], ["202511月", 11], ["202512月", 12], ["202601月", 1], ["202602月", 2]];
  for (const [s, m] of sheets) {
    cells.push({ sheet: s, header: `x年${m}月度`, row: 10, day: m === 11 ? 6 : 7, col: "Q", text: "・10日振込予約\n・通帳記帳（ドライブ格納）" });
  }
  cells.push({ sheet: "202511月", header: "", row: 20, day: 10, col: "O", text: "・年末調整アナウンス" });
  cells.push({ sheet: "202512月", header: "", row: 15, day: 12, col: "N", text: "・山田さん入社対応" });
  cells.push({ sheet: "10月", header: "2023年10月度", row: 12, day: 3, col: "Q", text: "古いシートの文言" });
  const out = L.classifyExcel(cells, { periodStart: "2025-09" });
  const by = (t) => out.rows.filter((r) => r.title === t);
  assert.equal(by("10日振込予約")[0].recurrenceType, "monthly");
  assert.deepEqual(by("10日振込予約")[0].recurrenceRule, { day: 7, shift: "prev" }, "多い日（7日）。日がずれるので前の営業日");
  assert.equal(by("10日振込予約")[0].category, "finance");
  assert.equal(by("10日振込予約")[0].include, true);
  assert.equal(by("年末調整アナウンス")[0].recurrenceType, "yearly");
  assert.deepEqual(by("年末調整アナウンス")[0].recurrenceRule, { month: 11, day: 10 });
  assert.equal(by("年末調整アナウンス")[0].category, "labor");
  const single = by("山田さん入社対応")[0];
  assert.equal(single.kind, "single");
  assert.equal(single.include, false, "単発は初めは除外");
  assert.equal(single.recurrenceRule.date, "2025-12-12", "期の始まり（2025-09）から年を決める");
  assert.equal(by("古いシートの文言").length, 0);
  assert.ok(out.sheets.find((s) => s.name === "10月" && !s.used));
  assert.ok(out.rows.every((r) => r.origin.length), "元の日付が付く");
});

console.log("\n=== API ===\n");

const mem = createMemDb({
  schema: {
    gw_office_recurring_tasks: {
      defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_key: null, is_active: true }),
      unique: [["tenant_id", "source_key"]],
    },
    gw_office_calendar_events: {
      defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_id: null, completed_at: null }),
      unique: [["recurring_task_id", "event_date"], ["tenant_id", "source_id"]],
      check: (r) => ((r.status === "done") !== Boolean(r.completed_at) ? "done needs completed_at" : null),
    },
  },
});
const logged = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-me" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
const REAL_TC = await import(atRoot("lib/timecard.js"));
mock.module(atRoot("lib/timecard.js"), { namedExports: { ...REAL_TC, jstDate: () => TODAY } });

const recApi = (await import(atRoot("api/office-tasks/recurring.js"))).default;
const calApi = (await import(atRoot("api/office-tasks/calendar.js"))).default;
const cronApi = (await import(atRoot("api/cron/office-recurring.js"))).default;
const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const call = async (api, req) => { const r = res(); await api({ headers: {}, ...req }, r); return r; };
const rec = (body) => call(recApi, { method: "POST", url: "/api/office-tasks/recurring", body });
const recList = () => call(recApi, { method: "GET", url: "/api/office-tasks/recurring" });
const cal = (q) => call(calApi, { method: "GET", url: `/api/office-tasks/calendar?${q}` });
const calAct = (body) => call(calApi, { method: "POST", url: "/api/office-tasks/calendar", body });

const ctxOf = ({ roles = [], apps = ["office"], isAdmin = false, emp = "e-me", tenantId = T1 } = {}) =>
  ({ tenantId, isAdmin, roles, apps, isHr: REAL_GW.isHrOf({ roles, apps }), employee: { id: emp, display_name: "自分 太郎" } });
const FIN = ctxOf({ roles: ["finance"] });
const HR = ctxOf({ roles: ["hr"], emp: "e-hr" });
const MGR = ctxOf({ roles: ["manager"] });
const NONE = ctxOf({ roles: [], apps: ["office"] });

function setup() {
  mem.reset(); logged.length = 0;
  mem.rows.gw_employees = [
    { id: "e-me", tenant_id: T1, display_name: "自分 太郎", status: "active" },
    { id: "e-hr", tenant_id: T1, display_name: "人事 花子", status: "active" },
    { id: "e-left", tenant_id: T1, display_name: "退職 一郎", status: "left" },
    { id: "e-other", tenant_id: T2, display_name: "他社", status: "active" },
  ];
  mem.rows.gw_office_recurring_tasks = [];
  mem.rows.gw_office_calendar_events = [];
  mem.rows.gw_calendar_events = [];
}
const events = () => mem.rows.gw_office_calendar_events;
const create = (over = {}) => rec({ action: "create", title: "10日振込予約", category: "finance", recurrenceType: "monthly", recurrenceRule: { day: 10, shift: "prev" }, assigneeEmployeeId: "e-me", ...over });

await ok("作ると、今日から先90日の予定ができる（毎月・土日祝は前）", async () => {
  setup(); who = FIN;
  const r = await create();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.made, 3);
  assert.deepEqual(events().map((e) => e.event_date).sort(), ["2026-10-09", "2026-11-10", "2026-12-10"]);
  assert.ok(events().every((e) => e.status === "pending" && e.assignee_employee_id === "e-me" && e.category === "finance"));
  assert.equal(r.body.master.nextDate, "2026-10-09");
  assert.equal(r.body.master.ruleText, "毎月 10日（土日祝は前の営業日）");
  assert.equal(mem.rows.gw_calendar_events.length, 0, "個人の予定には書かない");
});

await ok("二重に作らない：cron を2回・カレンダーを開いても同じ回は1件", async () => {
  setup(); who = FIN;
  await create();
  const c1 = await call(cronApi, { method: "GET", url: "/api/cron/office-recurring" });
  const c2 = await call(cronApi, { method: "GET", url: "/api/cron/office-recurring" });
  assert.equal(c1.body.made, 0); assert.equal(c2.body.made, 0);
  await cal("from=2026-09-28&to=2026-11-08");
  const keys = events().map((e) => `${e.recurring_task_id}|${e.event_date}`);
  assert.equal(new Set(keys).size, keys.length);
  // 先の月を開くと、その月の分もその場で作る（cron を待たない）
  const far = await cal("from=2027-02-22&to=2027-04-04");
  assert.equal(far.statusCode, 200);
  assert.deepEqual(far.body.events.map((e) => e.date), ["2027-03-10"]);
  await cal("from=2027-02-22&to=2027-04-04");
  assert.equal(events().filter((e) => e.event_date === "2027-03-10").length, 1);
});

await ok("cron：CRON_SECRET があれば、合わない呼び出しは 401", async () => {
  setup();
  process.env.CRON_SECRET = "s3cret";
  try {
    assert.equal((await call(cronApi, { method: "GET", url: "/", headers: {} })).statusCode, 401);
    assert.equal((await call(cronApi, { method: "GET", url: "/", headers: { authorization: "Bearer s3cret" } })).statusCode, 200);
  } finally { delete process.env.CRON_SECRET; }
});

await ok("完了：完了日時・完了した人を残す。完了・今回なしの回は作り直さない", async () => {
  setup(); who = FIN;
  await create();
  const ev = events().find((e) => e.event_date === "2026-10-09");
  const r = await calAct({ action: "complete", id: ev.id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.event.status, "done");
  assert.ok(ev.completed_at && ev.completed_by === "u-me" && ev.completed_by_name === "自分 太郎");
  const nov = events().find((e) => e.event_date === "2026-11-10");
  await calAct({ action: "skip", id: nov.id });
  await call(cronApi, { method: "GET", url: "/" });
  assert.equal(events().filter((e) => e.event_date === "2026-10-09").length, 1);
  assert.equal(events().find((e) => e.event_date === "2026-11-10").status, "skipped");
  const back = await calAct({ action: "reopen", id: ev.id });
  assert.equal(back.body.event.status, "pending");
  assert.equal(ev.completed_at, null);
});

await ok("直す：今日以降の未完了だけ作り直す（完了・過去は残す）／停止：今日以降の未完了を消す（マスターは残る）", async () => {
  setup(); who = FIN;
  const id = (await create()).body.master.id;
  mem.rows.gw_office_calendar_events.push({ id: "past", tenant_id: T1, recurring_task_id: id, title: "10日振込予約", category: "finance", event_date: "2026-09-10", due_on: "2026-09-10", status: "done", completed_at: "2026-09-10T01:00:00Z", source: "recurring" });
  const ev = events().find((e) => e.event_date === "2026-10-09");
  await calAct({ action: "complete", id: ev.id });
  const u = await rec({ action: "update", id, title: "10日振込予約（改）", category: "finance", recurrenceType: "monthly", recurrenceRule: { day: 10, shift: "prev" }, assigneeEmployeeId: "e-hr" });
  assert.equal(u.statusCode, 200, JSON.stringify(u.body));
  assert.equal(events().find((e) => e.id === "past").title, "10日振込予約", "過去は変えない");
  assert.equal(events().find((e) => e.id === ev.id).title, "10日振込予約", "完了は変えない");
  assert.equal(events().find((e) => e.event_date === "2026-11-10").title, "10日振込予約（改）");
  assert.equal(events().find((e) => e.event_date === "2026-11-10").assignee_employee_id, "e-hr");
  const off = await rec({ action: "set_active", id, active: false });
  assert.equal(off.body.master.active, false);
  assert.equal(off.body.master.nextDate, null);
  assert.deepEqual(events().map((e) => e.id).sort(), ["past", ev.id].sort(), "今日以降の未完了は消える。完了・過去は残る");
  assert.equal(mem.rows.gw_office_recurring_tasks.length, 1, "マスターは消さない");
  const on = await rec({ action: "set_active", id, active: true });
  assert.equal(on.body.made, 2, "再開すると作り直す（完了した10月は作らない）");
});

await ok("毎年：今日から先90日に入れば作る・一覧の次回予定日", async () => {
  setup(); who = HR;
  const r = await rec({ action: "create", title: "年末調整の案内", category: "labor", recurrenceType: "yearly", recurrenceRule: { month: 11, day: 1 }, dueRule: { type: "offset", days: 4 } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(events().map((e) => [e.event_date, e.due_on]), [["2026-11-01", "2026-11-05"]]);
  const h = await rec({ action: "create", title: "健康診断", category: "hr", recurrenceType: "yearly", recurrenceRule: { month: 5, day: 15 } });
  assert.equal(h.body.made, 0, "5月は90日の外");
  assert.equal(h.body.master.nextDate, "2027-05-15");
});

await ok("担当者：名簿にいない人は付けられない。退職したら「担当者未設定」", async () => {
  setup(); who = FIN;
  assert.equal((await create({ assigneeEmployeeId: "e-other" })).statusCode, 400, "他社の社員");
  const r = await create({ assigneeEmployeeId: "e-left" });
  assert.equal(r.body.master.assigneeMissing, true);
  const l = await recList();
  assert.equal(l.body.masters[0].assigneeMissing, true);
  const c = await cal("from=2026-09-28&to=2026-11-08");
  assert.ok(c.body.events.every((e) => e.assigneeMissing));
  assert.ok(!l.body.employees.some((p) => p.id === "e-left"), "担当に選べるのは在籍の人");
});

await ok("カテゴリの権限：見えない・直せない（API でも止める）", async () => {
  setup(); who = HR;
  await rec({ action: "create", title: "勤怠チェック", category: "labor", recurrenceType: "monthly", recurrenceRule: { day: 15 } });
  who = FIN;
  await create();
  // 人事は経理を見られない・直せない
  who = HR;
  const l = await recList();
  assert.deepEqual(l.body.masters.map((m) => m.category), ["labor"]);
  const finEv = events().find((e) => e.category === "finance");
  assert.equal((await calAct({ action: "complete", id: finEv.id })).statusCode, 404);
  assert.equal((await create()).statusCode, 403);
  const c = await cal("from=2026-09-28&to=2026-11-08");
  assert.ok(c.body.events.every((e) => e.category === "labor"));
  // 責任者（月末月初）は全体を作れるが人事・労務は作れない
  who = MGR;
  assert.equal((await rec({ action: "create", title: "棚卸", category: "all", recurrenceType: "yearly", recurrenceRule: { month: 3, day: 31 } })).statusCode, 200);
  assert.equal((await rec({ action: "create", title: "勤怠", category: "labor", recurrenceType: "monthly", recurrenceRule: { day: 1 } })).statusCode, 403);
  // 人事は全体を見られるが直せない
  who = HR;
  const all = await recList();
  assert.ok(all.body.masters.some((m) => m.category === "all" && m.canEdit === false));
  // Office の業務が何も無い人は 403
  who = NONE;
  assert.equal((await recList()).statusCode, 403);
  assert.equal((await cal("")).statusCode, 403);
  // 他社のマスターは触れない
  who = ctxOf({ roles: ["finance"], tenantId: T2 });
  const id = mem.rows.gw_office_recurring_tasks.find((m) => m.category === "finance").id;
  assert.equal((await rec({ action: "set_active", id, active: false })).statusCode, 404);
});

await ok("担当者本人は、ほかのカテゴリでも完了にできる（見えるとき）", async () => {
  setup(); who = MGR;
  await rec({ action: "create", title: "全体の作業", category: "all", recurrenceType: "monthly", recurrenceRule: { day: 20 }, assigneeEmployeeId: "e-hr" });
  const ev = events()[0];
  who = HR;   // 人事は「全体」を直せないが、担当者本人
  const r = await calAct({ action: "complete", id: ev.id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  who = ctxOf({ roles: ["hr"], emp: "e-me" });   // 担当でもなく、直せる権限も無い
  assert.equal((await calAct({ action: "reopen", id: ev.id })).statusCode, 403);
});

await ok("期限超過：範囲より前の未完了で期限を過ぎたもの。完了は出ない", async () => {
  setup(); who = FIN;
  mem.rows.gw_office_calendar_events.push(
    { id: "o1", tenant_id: T1, recurring_task_id: null, title: "請求書確認", category: "finance", event_date: "2026-09-20", due_on: "2026-09-25", status: "pending", source: "manual", assignee_employee_id: "e-me" },
    { id: "o2", tenant_id: T1, recurring_task_id: null, title: "済んだもの", category: "finance", event_date: "2026-09-21", due_on: "2026-09-21", status: "done", completed_at: "2026-09-21T00:00:00Z", source: "manual" },
    { id: "o3", tenant_id: T1, recurring_task_id: null, title: "期限は先", category: "finance", event_date: "2026-09-22", due_on: "2026-10-20", status: "pending", source: "manual" },
  );
  const c = await cal("from=2026-10-01&to=2026-10-31");
  assert.deepEqual(c.body.overdue.map((e) => e.id), ["o1"]);
  assert.equal(c.body.overdue[0].overdueDays, 12);
  assert.equal(c.body.today, TODAY);
  assert.equal((await cal("from=2026-01-01&to=2026-12-31")).statusCode, 400, "範囲は62日まで");
});

await ok("単発の予定を足す（直せるカテゴリだけ）", async () => {
  setup(); who = FIN;
  const r = await calAct({ action: "create", title: "臨時の振込", category: "finance", date: "2026-10-15", dueOn: "2026-10-16" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(events()[0].source, "manual");
  assert.equal((await calAct({ action: "create", title: "x", category: "hr", date: "2026-10-15" })).statusCode, 403);
  assert.equal((await calAct({ action: "create", title: "x", category: "finance", date: "2026-10-15", dueOn: "2026-10-01" })).statusCode, 400);
});

await ok("Excel 取り込み：一覧（まだ登録しない）→ 登録にした行だけ入れる → 2回目は登録済み", async () => {
  setup(); who = FIN;
  const cells = [];
  for (const [s, m] of [["202510月", 10], ["202511月", 11], ["202512月", 12], ["202601月", 1]]) {
    cells.push({ sheet: s, header: "", row: 10, day: 6, col: "Q", text: "・10日振込予約" });
    cells.push({ sheet: s, header: "", row: 11, day: 1, col: "N", text: "・新入社員対応" });
  }
  cells.push({ sheet: "202510月", header: "", row: 20, day: 20, col: "Q", text: "・臨時の支払い" });
  const p = await rec({ action: "import_preview", cells, periodStart: "2025-09" });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  assert.equal(mem.rows.gw_office_recurring_tasks.length, 0, "一覧を作っただけでは登録しない");
  const furi = p.body.rows.find((r) => r.title === "10日振込予約");
  const hr = p.body.rows.find((r) => r.title === "新入社員対応");
  const single = p.body.rows.find((r) => r.title === "臨時の支払い");
  assert.ok(furi.include && furi.canEdit);
  assert.ok(!hr.include && !hr.canEdit, "経理は人事の行を登録できない（初めから外す）");
  assert.ok(!single.include);
  single.include = true;
  const c = await rec({ action: "import_commit", rows: [furi, single] });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.masters, c.body.singles], [1, 1]);
  assert.equal(mem.rows.gw_office_recurring_tasks[0].source, "excel");
  assert.ok(events().some((e) => e.source === "excel" && e.event_date === "2025-10-20"));
  // 人事の行を無理に入れようとしても断る
  assert.equal((await rec({ action: "import_commit", rows: [{ ...hr, include: true }] })).statusCode, 400);
  // 2回目：登録済みになり、入れ直さない
  const p2 = await rec({ action: "import_preview", cells, periodStart: "2025-09" });
  assert.ok(p2.body.rows.find((r) => r.title === "10日振込予約").registered);
  const c2 = await rec({ action: "import_commit", rows: [{ ...furi, include: true }, { ...single, include: true }] });
  assert.equal(c2.body.skipped, 2);
  assert.equal(mem.rows.gw_office_recurring_tasks.length, 1);
});

await ok("表が無い（db/125 未適用）ときは 503 と SQL の名前", async () => {
  setup(); who = FIN;
  mem.state.missing = "gw_office_recurring_tasks";
  try {
    const r = await recList();
    assert.equal(r.statusCode, 503);
    assert.match(r.body.message, /125_office_recurring/);
    const c = await call(cronApi, { method: "GET", url: "/" });
    assert.equal(c.body.notReady, true, "cron は落とさない");
  } finally { mem.state.missing = null; }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
