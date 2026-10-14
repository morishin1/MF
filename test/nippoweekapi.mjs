// 日報・勤怠の「今週の提出・勤怠」（lib/nippo-week.js と GET /api/nippo/admin?view=week）。
//
// ■ 何を守るテストか
//   1. 1日の状態：正常／日報未提出／勤怠要確認／両方未完了／休日・対象外／今日（まだ）
//      ・土日・祝日・まだ来ていない日は数えない。今日の日報は、まだ書く時間があるので未提出に数えない
//      ・勤怠の要確認：承認待ちの修正・退勤の打刻なし（日が変わった）・営業日なのに打刻なし。休み（absent）は対象外
//      ・直近5週間に一度も打刻していない人は「勤怠を使っていない」として要確認にしない
//   2. KPI：日報提出率・日報未提出・勤怠要確認・要フォロー人数
//   3. 新しい表を使わない（読むのは tc_nippo・gw_time_entries・gw_time_fixes・gw_employees など既存のものだけ）。書き込まない
//   4. 勤怠は、経営者と勤怠を見られる人（canManageHr。/api/timecard と同じ）に返す。他社の打刻は混ざらない
//   5. 週の指定（どの曜日を渡しても、その週の月〜日）
//   6. 今日の提出：提出率（過去営業日）には入れないが、今日の提出として別に数える（行ごと・KPI）
//   7. 本番の中村さんの条件（active・user_id 一致・今日の日報あり・AI評価 completed）で、管理側が「未提出」にしない
//      （日次の一覧・未提出・AI評価・週の表のどれでも）。別の user_id／名簿の user_id が空 は未提出のまま
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001", T2 = "00000000-0000-4000-8000-000000000002";

const L = await import(atRoot("lib/nippo-week.js"));
const NK = await import(atRoot("test/fixtures/nippo-nakamura.mjs"));

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

await ok("今日の提出：提出率には入れず、行ごと・KPI に別に数える。今日を含まない週は null", async () => {
  const w = L.buildWeek({
    monday: "2026-10-05", today: "2026-10-07", staff,
    nippos: [{ user_id: "u1", work_date: "2026-10-05" }, { user_id: "u1", work_date: "2026-10-06" }, { user_id: "u1", work_date: "2026-10-07" },
             { user_id: "u2", work_date: "2026-10-07" }],
    entries: null,
  });
  const by = (n) => w.members.find((m) => m.name === n);
  assert.deepEqual(by("山田").today, { nippo: "ok", submitted: true });
  assert.deepEqual(by("佐藤").today, { nippo: "ok", submitted: true });
  assert.deepEqual(by("鈴木").today, { nippo: "today", submitted: false });
  assert.equal(by("山田").days[2].state, "ok", "今日のセルは正常（提出済み）");
  assert.deepEqual(w.kpi.today, { submitted: 2, expected: 3, holiday: false });
  assert.equal(w.kpi.expected, 6, "提出率の分母は今日より前の営業日だけ（変えない）");
  assert.equal(w.kpi.submitted, 2);
  assert.equal(by("山田").nippo.submitted, 2, "行の「日報 ○/○」も過去営業日だけ");
  const prev = L.buildWeek({ monday: "2026-09-28", today: "2026-10-07", staff, nippos: [], entries: null });
  assert.equal(prev.kpi.today, null);
  assert.ok(prev.members.every((m) => m.today === null));
  const hol = L.buildWeek({ monday: "2026-10-12", today: "2026-10-12", staff, nippos: [{ user_id: "u1", work_date: "2026-10-12" }], entries: null });
  assert.deepEqual(hol.kpi.today, { submitted: 1, expected: null, holiday: true }, "今日が祝日なら分母なし");
  assert.equal(hol.members.find((m) => m.name === "佐藤").today.nippo, "off");
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
let TODAY_JST = "2026-10-07";
mock.module(atRoot("lib/nippo.js"), { namedExports: { ...REAL_NIPPO, jstDate: () => TODAY_JST } });
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

await ok("経営者（管理者でも人事でもない）も勤怠を見る。中身は管理者と同じで、他社の打刻は混ざらない", async () => {
  setup(); who = ADMIN;
  const byAdmin = (await get("view=week&date=2026-10-08")).body;
  setup(); who = OWNER_ONLY;
  const r = await get("view=week&date=2026-10-08");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.attendance, true);
  assert.equal(r.body.attendanceNote, null);
  assert.equal(r.body.kpi.timeCheck, byAdmin.kpi.timeCheck);
  assert.ok(r.body.kpi.timeCheck > 0, "勤怠要確認を数える");
  assert.deepEqual(r.body.members.map((m) => m.days.map((c) => `${c.state}/${c.time}`)),
    byAdmin.members.map((m) => m.days.map((c) => `${c.state}/${c.time}`)), "管理者と同じ表");
  const y = r.body.members.find((m) => m.name === "山田");
  assert.deepEqual(y.days.slice(0, 3).map((c) => c.state), ["ok", "ok", "today"], "他社の行（退勤なし）は見ない");
  assert.ok(!mem.state.log.some((l) => l.op !== "select"), "書き込まない");
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

console.log("\n=== 本番の中村さんの条件（active・user_id 一致・今日の日報・AI評価 completed） ===\n");

function setupNakamura() {
  mem.reset();
  Object.assign(mem.rows, NK.nakamuraRows());
  TODAY_JST = NK.TODAY;
  return { ...ADMIN, tenantId: NK.TENANT };
}

await ok("日次：中村さんは提出済み。一覧・未提出・AI評価・日報カードの材料に出る", async () => {
  who = setupNakamura();
  try {
    const r = await get(`date=${NK.TODAY}`);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const m = r.body.members.find((x) => x.userId === NK.NAKAMURA.user_id);
    assert.ok(m, "名簿に出る");
    assert.equal(m.submitted, true, "「未提出」にならない");
    assert.ok(!r.body.notSubmitted.includes(NK.NAKAMURA.display_name), "未提出の一覧に出ない");
    const n = r.body.nippos.find((x) => x.id === NK.NIPPO_ID);
    assert.ok(n && n.user_id === NK.NAKAMURA.user_id, "今日の日報の一覧に出る（詳細カードの材料）");
    const e = r.body.evals.find((x) => x.nippoId === NK.NIPPO_ID);
    assert.equal(e?.status, "completed", "AI評価 completed が付く");
    assert.equal(e.totalScore, 72);
    assert.ok(r.body.replies.some((x) => x.nippo_id === NK.NIPPO_ID && x.kind === "ai"), "AIフィードバックも付く");
    assert.ok(!mem.state.log.some((l) => l.op !== "select"), "書き込まない");
  } finally { TODAY_JST = "2026-10-07"; }
});

await ok("日次：別の user_id で書いた人・名簿の user_id が空の人は未提出のまま（名前では寄せない）", async () => {
  who = setupNakamura();
  try {
    const r = await get(`date=${NK.TODAY}`);
    assert.equal(r.body.members.find((x) => x.name === "別アカウント 太郎").submitted, false, "日報の user_id が名簿と違う");
    assert.ok(r.body.notSubmitted.includes("別アカウント 太郎"));
    assert.ok(!r.body.members.some((x) => x.name === "ログインなし 花子"), "user_id が空の人は名簿（対象者）に出ない");
    assert.ok(r.body.nippos.some((x) => x.user_id === "u-second-account"), "その日報自体は今日の日報の一覧に出る（消えない）");
  } finally { TODAY_JST = "2026-10-07"; }
});

await ok("週：中村さんの今日のセルは提出済み。今日の提出に数える。提出率（過去営業日）は 3/3", async () => {
  who = setupNakamura();
  try {
    const r = await get(`view=week&date=${NK.TODAY}`);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const m = r.body.members.find((x) => x.userId === NK.NAKAMURA.user_id);
    assert.deepEqual(m.days.slice(0, 4).map((c) => c.nippo), ["ok", "ok", "ok", "ok"], "10/5〜10/8 すべて提出");
    assert.equal(m.days[3].state, "ok", "今日（10/8）のセルは提出済み");
    assert.deepEqual(m.today, { nippo: "ok", submitted: true });
    assert.deepEqual(m.nippo, { submitted: 3, expected: 3, missing: 0 });
    assert.deepEqual(r.body.kpi.today, { submitted: 1, expected: 2, holiday: false }, "今日の提出 1/2人（別アカウントの人はまだ）");
    const other = r.body.members.find((x) => x.name === "別アカウント 太郎");
    assert.deepEqual(other.today, { nippo: "today", submitted: false });
  } finally { TODAY_JST = "2026-10-07"; }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
