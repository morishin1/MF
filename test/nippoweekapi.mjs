// 日報・勤怠の「今週の提出・勤怠」（lib/nippo-week.js と GET /api/nippo/admin?view=week）。
//
// ■ 何を守るテストか
//   1. 1日の状態：正常／日報未提出／勤怠要確認／両方未完了／休日・対象外／今日（まだ）
//      ・土日・祝日・まだ来ていない日は数えない。今日の日報は、まだ書く時間があるので未提出に数えない
//      ・勤怠の要確認：承認待ちの修正・退勤の打刻なし（日が変わった）・営業日なのに打刻なし。休み（absent）は対象外
//      ・直近5週間に一度も打刻していない人は「勤怠を使っていない」として要確認にしない
//   2. KPI：日報提出率・日報未提出・勤怠要確認・要フォロー人数
//   3. 新しい表を使わない（読むのは tc_nippo・gw_time_entries・gw_time_fixes・gw_employees など既存のものだけ）。書き込まない
//   4. 勤怠は、勤怠を見られる人（canManageHr。/api/timecard と同じ）にだけ返す。他社の打刻は混ざらない
//   5. 週の指定（どの曜日を渡しても、その週の月〜日）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002";

const L = await import(atRoot("lib/nippo-week.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== 週の組み立て（lib） ===\n");

const staff = [
  { id: "e1", user_id: "u1", display_name: "山田" },
  { id: "e2", user_id: "u2", display_name: "佐藤" },
  { id: "e3", user_id: "u3", display_name: "鈴木" },
];
const at = (d, out = true) => ({ work_date: d, clock_in: `${d}T00:00:00Z`, clock_out: out ? `${d}T09:00:00Z` : null, status: out ? "closed" : "open" });

await ok("週は月〜日。土日・祝日・今日・まだ来ていない日の印", async () => {
  const days = L.weekDays(L.mondayOf("2026-10-14"), "2026-10-14");
  assert.equal(days[0].date, "2026-10-12");
  assert.equal(days[0].holiday, true, "10/12 はスポーツの日");
  assert.deepEqual(days.map((d) => d.dow), ["月", "火", "水", "木", "金", "土", "日"]);
  assert.equal(days[2].today, true);
  assert.equal(days[3].future, true);
  assert.equal(days[5].holiday && days[6].holiday, true);
  assert.equal(L.mondayOf("2026-10-11"), "2026-10-05", "日曜はその週の月曜へ");
});

await ok("1日の状態：正常・日報未提出・勤怠要確認・両方未完了・休日・今日（まだ）", async () => {
  const w = L.buildWeek({
    monday: "2026-10-05", today: "2026-10-07", staff,
    nippos: [{ user_id: "u1", work_date: "2026-10-05" }, { user_id: "u1", work_date: "2026-10-06" },
             { user_id: "u2", work_date: "2026-10-05" }, { user_id: "u3", work_date: "2026-10-06" }],
    entries: [
      { employee_id: "e1", ...at("2026-10-05") }, { employee_id: "e1", ...at("2026-10-06") }, { employee_id: "e1", ...at("2026-10-07", false) },
      { employee_id: "e2", ...at("2026-10-05") }, { employee_id: "e2", ...at("2026-10-06", false) },
      { employee_id: "e3", ...at("2026-10-05") },
    ],
    fixes: [{ employee_id: "e3", work_date: "2026-10-06" }],
    usedTimecard: new Set(["e1", "e2", "e3"]), followUps: 1,
  });
  const by = (n) => w.members.find((m) => m.name === n);
  const st = (n) => by(n).days.map((c) => c.state).join(",");
  assert.equal(st("山田"), "ok,ok,today,off,off,off,off", "今日は勤務中＝まだ（要確認にしない）");
  assert.equal(st("佐藤"), "ok,both,today,off,off,off,off", "日報なし＋退勤の打刻なし（日が変わった）＝両方");
  assert.equal(st("鈴木"), "nippo,time,today,off,off,off,off", "打刻はあるが日報なし／日報はあるが修正の承認待ち");
  assert.equal(by("佐藤").days[1].timeWhy, "退勤の打刻がありません");
  assert.equal(by("鈴木").days[1].timeWhy, "打刻の修正が承認待ちです");
  assert.equal(w.kpi.expected, 6, "今日より前の営業日 2日 × 3人");
  assert.equal(w.kpi.submitted, 4);
  assert.equal(w.kpi.rate, 67);
  assert.equal(w.kpi.missing, 2);
  assert.equal(w.kpi.timeCheck, 2);
  assert.equal(w.kpi.followUps, 1);
  assert.deepEqual(w.members.map((m) => m.name).slice(0, 2).sort(), ["佐藤", "鈴木"], "要対応の多い人が先");
  assert.equal(by("山田").issues, 0);
});

await ok("打刻なし：営業日は要確認。ただし勤怠を使っていない人・休み（absent）・休日は対象外", async () => {
  const w = L.buildWeek({
    monday: "2026-10-05", today: "2026-10-11", staff,
    nippos: [],
    entries: [{ employee_id: "e1", work_date: "2026-10-06", status: "absent" }, { employee_id: "e1", ...at("2026-10-10") }],
    usedTimecard: new Set(["e1", "e2"]),
  });
  const by = (n) => w.members.find((m) => m.name === n);
  assert.deepEqual(by("山田").days.map((c) => c.time), ["check", "off", "check", "check", "check", "ok", "off"], "休み・休日は対象外。土曜の出勤は打刻あり");
  assert.equal(by("佐藤").days[0].time, "check", "打刻を使っている人の打刻なしは要確認");
  assert.equal(by("鈴木").days[0].time, "none", "直近5週間に打刻が無い人は、勤怠を使っていない");
  assert.equal(by("鈴木").time.uses, false);
  assert.equal(by("鈴木").days[0].state, "nippo", "日報だけ未提出");
});

await ok("勤怠を見られないとき：勤怠は none、KPI は null。日報だけで状態を出す", async () => {
  const w = L.buildWeek({ monday: "2026-10-05", today: "2026-10-07", staff, nippos: [{ user_id: "u1", work_date: "2026-10-05" }], entries: null });
  assert.equal(w.attendance, false);
  assert.equal(w.kpi.timeCheck, null);
  assert.ok(w.members.every((m) => m.days.every((c) => c.time === "none")));
  assert.equal(w.members.find((m) => m.name === "山田").days[0].state, "ok");
  assert.equal(w.members.find((m) => m.name === "山田").days[1].state, "nippo");
});

await ok("まだ来ていない週：数える日が無い（提出率は null）。休日の提出は正常として出す", async () => {
  const w = L.buildWeek({ monday: "2026-10-12", today: "2026-10-07", staff, nippos: [], entries: [] });
  assert.equal(w.kpi.rate, null);
  assert.equal(w.kpi.expected, 0);
  assert.ok(w.members.every((m) => m.days.every((c) => c.state === "off")));
  const h = L.buildWeek({ monday: "2026-10-05", today: "2026-10-12", staff: staff.slice(0, 1), nippos: [{ user_id: "u1", work_date: "2026-10-10" }], entries: null });
  assert.equal(h.members[0].days[5].state, "ok");
  assert.equal(h.members[0].nippo.expected, 5, "土曜に書いても、出すべき日は増えない");
});

console.log("\n=== GET /api/nippo/admin?view=week ===\n");

const mem = createMemDb();
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-owner" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
const REAL_NIPPO = await import(atRoot("lib/nippo.js"));
mock.module(atRoot("lib/nippo.js"), { namedExports: { ...REAL_NIPPO, jstDate: () => "2026-10-07" } });
const { default: api } = await import(atRoot("api/nippo/admin.js"));
const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const get = async (q) => { const r = res(); await api({ method: "GET", url: `/api/nippo/admin?${q}`, headers: {} }, r); return r; };

const ADMIN = { tenantId: T1, isAdmin: true, isHr: false, roles: [], employee: { id: "e1" } };
const OWNER_ONLY = { tenantId: T1, isAdmin: false, isHr: false, roles: ["owner"], employee: { id: "e1" } };
const MEMBER = { tenantId: T1, isAdmin: false, isHr: false, roles: [], employee: { id: "e1" } };

function setup() {
  mem.reset();
  mem.rows.gw_employees = [
    { id: "e1", tenant_id: T1, user_id: "u1", display_name: "山田", department: "営業", status: "active" },
    { id: "e2", tenant_id: T1, user_id: "u2", display_name: "佐藤", department: "開発", status: "leaving" },
    { id: "e9", tenant_id: T1, user_id: null, display_name: "ログインなし", status: "active" },
    { id: "e8", tenant_id: T1, user_id: "u8", display_name: "退職済み", status: "left" },
    { id: "b1", tenant_id: T2, user_id: "ub", display_name: "他社", status: "active" },
  ];
  mem.rows.tc_nippo = [{ user_id: "u1", work_date: "2026-10-05" }, { user_id: "u1", work_date: "2026-10-06" }, { user_id: "ub", work_date: "2026-10-05" }];
  mem.rows.gw_time_entries = [
    { tenant_id: T1, employee_id: "e1", ...at("2026-10-05") }, { tenant_id: T1, employee_id: "e1", ...at("2026-10-06") },
    { tenant_id: T1, employee_id: "e2", ...at("2026-10-05", false) },
    { tenant_id: T2, employee_id: "e1", ...at("2026-10-06", false) },       // 他社（同じ id でも混ざらない）
  ];
  mem.rows.gw_time_fixes = [];
  mem.rows.gw_daily_kpis = [];
  mem.rows.gw_blockers = [];
  mem.rows.gw_action_items = [];
}

await ok("管理者：週の表と勤怠。在籍・退職予定でログインできる人だけ。他社の打刻は混ざらない", async () => {
  setup(); who = ADMIN;
  const r = await get("view=week&date=2026-10-08");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.from, "2026-10-05");
  assert.equal(r.body.to, "2026-10-11");
  assert.equal(r.body.attendance, true);
  assert.deepEqual(r.body.members.map((m) => m.name).sort(), ["佐藤", "山田"]);
  const y = r.body.members.find((m) => m.name === "山田");
  assert.deepEqual(y.days.slice(0, 3).map((c) => c.state), ["ok", "ok", "today"], "他社の行（退勤なし）は見ない");
  const s = r.body.members.find((m) => m.name === "佐藤");
  assert.equal(s.days[0].state, "both");
  assert.equal(r.body.kpi.followUps, 1, "佐藤は日報未提出2日");
  assert.ok(!mem.state.log.some((l) => l.op !== "select"), "書き込まない");
});

await ok("勤怠を見られない人（経営者だけ・管理者でも人事でもない）：日報だけ。勤怠は返さない", async () => {
  setup(); who = OWNER_ONLY;
  const r = await get("view=week");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.attendance, false);
  assert.equal(r.body.kpi.timeCheck, null);
  assert.match(r.body.attendanceNote, /勤怠管理を見られる人/);
  assert.ok(r.body.members.every((m) => m.days.every((c) => c.time === "none" && !/打刻/.test(c.timeWhy))), "打刻の中身を返さない");
});

await ok("見られない人は 403（日次と同じ入口）", async () => {
  setup(); who = MEMBER;
  assert.equal((await get("view=week")).statusCode, 403);
});

await ok("打刻の表が読めないとき：勤怠は「読めません」で、日報の表は出す", async () => {
  setup(); who = ADMIN;
  mem.state.missing = "gw_time_entries";
  try {
    const r = await get("view=week");
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.attendance, false);
    assert.match(r.body.attendanceNote, /読めませんでした/);
  } finally { mem.state.missing = null; }
});

await ok("日次の応答は変わらない（view を付けなければ従来どおり）", async () => {
  setup(); who = ADMIN;
  mem.rows.tc_settings = [];
  mem.rows.gw_nippo_ai_evals = [];
  const r = await get("date=2026-10-07");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.date, "2026-10-07");
  assert.ok(Array.isArray(r.body.trend) && Array.isArray(r.body.followUps));
  assert.equal(r.body.from, undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
