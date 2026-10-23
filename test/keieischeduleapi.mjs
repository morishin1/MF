// 経営「予定・日報確認」（GET /api/keiei?view=schedule・lib/keiei-schedule-read.js・lib/work-schedule.js）。
//
// ■ 何を守るテストか
//   1. 経営者（owner）だけ。人事・管理者・一般は 403
//   2. 自社だけ（他社の人・他社の予定は、社員IDが同じでも出ない）
//   3. 業務予定は source='self'・私用以外・件名あり・正しい時刻。私用・休暇・予約は件数に入れない
//   4. 休暇（source='leave'・複数日1行）は「休暇」。対象人数から外す
//   5. 未来の日を見られる。翌営業日は土日・祝日を飛ばす
//   6. 予定のメモ（body）は返さない
//   7. 読めなければ「取得できません」（未提出・未登録とは言わない。数は null）
//   8. 入社日・退職日を分母に反映（入社前・退職後は対象外）
//   9. 読み取りだけ（書き込みは1回もしない）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";
import * as FX from "./fixtures/keiei-schedule.mjs";

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
const WS = await import(atRoot("lib/work-schedule.js"));

const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.raw = b; r.body = JSON.parse(b); }; return r; };
const get = async (q) => { const r = res(); await keiei({ method: "GET", url: q, headers: {} }, r); return r; };
const ctxOf = (roles, extra = {}) => ({ tenantId: FX.TENANT, isAdmin: false, isHr: REAL_GW.isHrOf({ roles, apps: [] }), roles, apps: [], employee: { id: "e1" }, ...extra });
const OWNER = ctxOf(["owner"]);

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};
function setup() { mem.reset(); mem.state.missing = null; Object.assign(mem.rows, FX.scheduleRows()); who = OWNER; }
const person = (r, id) => r.body.people.find((p) => p.employeeId === id);
const URL0 = "/api/keiei?view=schedule";

console.log("\n=== 入口 ===\n");
await ok("経営者だけ。人事・管理者・一般は 403", async () => {
  setup();
  assert.equal((await get(URL0)).statusCode, 200);
  for (const c of [ctxOf(["hr"]), ctxOf([], { isAdmin: true }), ctxOf(["manager"]), ctxOf([])]) {
    who = c;
    assert.equal((await get(URL0)).statusCode, 403, JSON.stringify(c.roles));
    assert.equal((await get(`${URL0}&period=week&employeeId=e1`)).statusCode, 403);
  }
});

await ok("引数の検査：period・date・月は1人ずつ・他社の社員は 404", async () => {
  setup();
  assert.equal((await get(`${URL0}&period=year`)).statusCode, 400);
  assert.equal((await get(`${URL0}&date=2026-02-30`)).statusCode, 400);
  assert.equal((await get(`${URL0}&date=2030-01-01`)).statusCode, 400, "前後1年まで");
  assert.equal((await get(`${URL0}&period=month`)).statusCode, 400, "月は employeeId が要る");
  assert.equal((await get(`${URL0}&period=month&employeeId=x1`)).statusCode, 404, "他社の人は開けない");
  assert.equal((await get(`${URL0}&period=day&employeeId=e6`)).statusCode, 404, "退職済みは開けない");
});

console.log("\n=== 全員×日 ===\n");
await ok("名簿：在籍・退職予定でログインできる人だけ。他社・退職済み・ログインなしは出ない", async () => {
  setup();
  const r = await get(URL0);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.people.map((p) => p.employeeId).sort(), ["e1", "e2", "e3", "e4", "e5"]);
  assert.equal(r.body.date, FX.TODAY);
  assert.equal(r.body.period, "day");
  assert.deepEqual(r.body.unreadable, []);
  assert.equal(r.body.review, null, "経営の確認状態は Phase 2");
  assert.ok(!r.raw.includes("他社"), "他社の名前・予定を返さない");
  assert.ok(!r.body.events.some((e) => e.id.startsWith("ev-x")), "他社の予定（社員IDが同じでも）を返さない");
});

await ok("翌営業日は土日・祝日を飛ばす（10/9 金 → 10/13 火。10/12 はスポーツの日）", async () => {
  setup();
  const r = await get(URL0);
  assert.equal(r.body.nextBizDay, FX.NEXT);
  assert.equal(r.body.summary.next.date, FX.NEXT);
  assert.equal((await get(`${URL0}&date=2026-10-13`)).body.nextBizDay, "2026-10-14");
});

await ok("業務予定の件数：私用・予約・休暇・件名なし・時刻不正は数えない", async () => {
  setup();
  const r = await get(URL0);
  const n = person(r, "e1").days[FX.NEXT];
  assert.equal(n.count, 2);
  assert.equal(n.mark, "has");
  assert.equal(n.markLabel, "予定あり");
  const ids = r.body.events.filter((e) => e.employeeId === "e1" && e.dates.includes(FX.NEXT)).map((e) => e.id);
  assert.deepEqual(ids, ["ev-n1", "ev-n2"], "件数と詳細が一致");
  const f = person(r, "e2").days[FX.NEXT];
  assert.equal(f.count, 0, "私用だけ＝0件");
  assert.equal(f.mark, "none");
  assert.equal(f.markLabel, "未登録");
  assert.ok(!r.body.events.some((e) => ["ev-n3", "ev-n4", "ev-n6", "ev-n7", "ev-f1", "ev-y1"].includes(e.id)));
});

await ok("休暇（source=leave・複数日1行）は「休暇」。対象人数から外す", async () => {
  setup();
  const r = await get(URL0);
  const y = person(r, "e3").days[FX.NEXT];
  assert.equal(y.mark, "leave");
  assert.equal(y.markLabel, "休暇");
  assert.equal(y.target, false);
  assert.equal(y.count, 0, "休暇は業務予定の件数に入れない");
  // 2日目（10/14）も休暇（開始日だけで探していない）
  const w = await get(`${URL0}&period=week&date=${FX.NEXT}`);
  assert.equal(person(w, "e3").days["2026-10-14"].mark, "leave");
  assert.equal(person(w, "e3").days["2026-10-15"].mark, "none");
});

await ok("入社日・退職日を分母に反映（入社前・退職後は対象外）", async () => {
  setup();
  const r = await get(URL0);
  const i = person(r, "e4");
  assert.equal(i.days[FX.TODAY].mark, "off");
  assert.equal(i.days[FX.TODAY].reason, "入社前");
  assert.equal(i.days[FX.TODAY].nippo.state, "off");
  assert.equal(i.days[FX.TODAY].nippo.label, "対象外");
  assert.equal(i.days[FX.NEXT].target, true, "入社日から対象");
  const t = person(r, "e5");
  assert.equal(t.days[FX.TODAY].target, true);
  assert.equal(t.days[FX.NEXT].reason, "退職後");
  assert.equal(t.days[FX.NEXT].markLabel, "対象外");
  // 今日：中村・藤本・山内・退職予定 の4人（今福は入社前）。翌営業日：中村・藤本・今福 の3人（山内は休暇・退職予定は退職後）
  assert.deepEqual(r.body.summary.nippo, { date: FX.TODAY, target: 4, submitted: 3, missing: 1, future: false, bizDay: true });
  assert.deepEqual(r.body.summary.next, { date: FX.NEXT, target: 3, registered: 2, missing: 1 });
  assert.deepEqual(r.body.summary.attention, { people: 1, nippoMissing: 1, scheduleMissing: 1 });
});

await ok("日報：submitted_at があるときだけ提出（下書きは未提出）。要対応の人が上", async () => {
  setup();
  const r = await get(URL0);
  assert.equal(person(r, "e1").days[FX.TODAY].nippo.state, "submitted");
  assert.equal(person(r, "e1").days[FX.TODAY].nippo.nippoId, `n-u1-${FX.TODAY}`);
  assert.equal(person(r, "e2").days[FX.TODAY].nippo.state, "missing");
  assert.equal(person(r, "e2").days[FX.TODAY].nippo.label, "未提出");
  assert.equal(r.body.people[0].employeeId, "e2", "要対応（日報未提出・翌営業日未登録）が先頭");
  assert.deepEqual(r.body.people[0].attention, { nippoMissing: true, scheduleMissing: true, any: true });
});

await ok("時間割チェック（api/schedule/review.js の inspect。AI は呼ばない）：重なりを示す", async () => {
  setup();
  const r = await get(URL0);
  const c = person(r, "e1").days[FX.NEXT].check;
  assert.equal(c.overlaps, 1);
  assert.equal(c.verdict, "adjust");
  assert.ok(c.notes.some((s) => s.includes("重複")));
  assert.equal(person(r, "e2").days[FX.NEXT].check, null, "予定が無い日は出さない");
});

const SECRET_PART = "090-0000-0000";
await ok("予定のメモ（body）は返さない。予定の項目は決めたものだけ", async () => {
  setup();
  for (const q of [URL0, `${URL0}&period=week&date=${FX.NEXT}`, `${URL0}&period=month&employeeId=e1&date=${FX.NEXT}`, `${URL0}&employeeId=e1&date=${FX.NEXT}`]) {
    const r = await get(q);
    assert.equal(r.statusCode, 200, q);
    assert.ok(!r.raw.includes(SECRET_PART) && !r.raw.includes(FX.SECRET), `メモが出ている：${q}`);
    for (const e of r.body.events) {
      assert.deepEqual(Object.keys(e).sort(), ["allDay", "category", "dates", "employeeId", "endsAt", "id", "location", "startsAt", "title", "updatedAt"].sort());
    }
  }
});
await ok("未来の日を見られる（members と違って今日にそろえない）", async () => {
  setup();
  const r = await get(`${URL0}&date=2026-11-20`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.date, "2026-11-20");
  assert.equal(r.body.summary.nippo.future, true);
  assert.equal(r.body.summary.nippo.missing, 0, "未来の日報は未提出と数えない");
  assert.equal(person(r, "e1").days["2026-11-20"].nippo.state, "future");
  assert.equal(r.body.dueBy, FX.NEXT, "今日の翌営業日（これより先の未登録は期限前）");
  // 先の日の「翌営業日の予定」は、まだ期限前なので要対応にしない（件数は出す）
  assert.ok(r.body.summary.next.missing > 0);
  assert.equal(r.body.summary.attention.scheduleMissing, 0);
  assert.ok(r.body.people.every((p) => !p.attention.any));
});

console.log("\n=== 週・月・1人 ===\n");
await ok("全員×週：月〜日の7日。休日は対象外・祝日の印", async () => {
  setup();
  const r = await get(`${URL0}&period=week&date=${FX.NEXT}`);
  assert.equal(r.body.from, "2026-10-12");
  assert.equal(r.body.to, "2026-10-18");
  assert.equal(r.body.days.length, 7);
  assert.equal(r.body.days[0].holiday, true);
  assert.equal(r.body.days[0].bizDay, false);
  const f = person(r, "e2");
  assert.equal(f.days["2026-10-12"].mark, "off");
  assert.equal(f.days["2026-10-12"].reason, "休日");
  assert.equal(f.days["2026-10-13"].mark, "none");
});

await ok("メンバー別×月：1人だけ・月の全日。件数と予定が一致", async () => {
  setup();
  const r = await get(`${URL0}&period=month&employeeId=e1&date=${FX.TODAY}`);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.people.map((p) => p.employeeId), ["e1"]);
  assert.equal(r.body.from, "2026-10-01");
  assert.equal(r.body.to, "2026-10-31");
  assert.equal(r.body.days.length, 31);
  const p = person(r, "e1");
  for (const d of r.body.days) {
    const n = r.body.events.filter((e) => e.dates.includes(d.date)).length;
    assert.equal(p.days[d.date].count, n, d.date);
  }
  assert.equal(p.days["2026-10-07"].count, 1);
});

await ok("部署・名前で絞る（dep・q）", async () => {
  setup();
  assert.deepEqual((await get(`${URL0}&dep=${encodeURIComponent("開発")}`)).body.people.map((p) => p.employeeId), ["e2"]);
  assert.deepEqual((await get(`${URL0}&q=${encodeURIComponent("山内")}`)).body.people.map((p) => p.employeeId), ["e3"]);
  assert.deepEqual((await get(URL0)).body.departments, ["営業", "開発"]);
});

console.log("\n=== 読めないとき ===\n");
await ok("日報が読めない → 「取得できません」（未提出と言わない・数は null）", async () => {
  setup();
  mem.state.missing = "tc_nippo";
  try {
    const r = await get(URL0);
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.unreadable.includes("日報"));
    assert.equal(r.body.summary.nippo, null);
    assert.equal(r.body.summary.attention.nippoMissing, null);
    for (const p of r.body.people) {
      const n = p.days[FX.TODAY].nippo;
      assert.notEqual(n.state, "missing", p.name);
      assert.ok(n.label === "取得できません" || n.label === "対象外", `${p.name}:${n.label}`);
    }
  } finally { mem.state.missing = null; }
});

await ok("予定が読めない → 「取得できません」（未登録と言わない・数は null）", async () => {
  setup();
  mem.state.missing = "gw_calendar_events";
  try {
    const r = await get(URL0);
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.unreadable.includes("予定・休暇"));
    assert.equal(r.body.summary.next, null);
    assert.equal(r.body.events, null);
    for (const p of r.body.people) {
      const d = p.days[FX.NEXT];
      assert.notEqual(d.mark, "none");
      assert.ok(d.markLabel === "取得できません" || d.markLabel === "対象外", `${p.name}:${d.markLabel}`);
      assert.equal(p.attention.scheduleMissing, false);
    }
  } finally { mem.state.missing = null; }
});

await ok("名簿が読めない → 500（0人とは言わない）", async () => {
  setup();
  mem.state.missing = "gw_employees";
  try { assert.equal((await get(URL0)).statusCode, 500); } finally { mem.state.missing = null; }
});

await ok("読み取りだけ（書き込みなし）。給与・契約の表は読まない", async () => {
  setup();
  await get(URL0);
  await get(`${URL0}&period=week`);
  await get(`${URL0}&period=month&employeeId=e1`);
  assert.ok(!mem.state.log.some((l) => l.op !== "select"), "書き込みなし");
});

console.log("\n=== 業務予定の定義（lib/work-schedule.js） ===\n");
await ok("isBusinessEvent・overlapsDay", async () => {
  const base = { source: "self", category: "work", title: "x", all_day: false, starts_at: "2026-10-13T01:00:00Z", ends_at: "2026-10-13T02:00:00Z" };
  assert.equal(WS.isBusinessEvent(base), true);
  assert.equal(WS.isBusinessEvent({ ...base, source: "leave" }), false);
  assert.equal(WS.isBusinessEvent({ ...base, source: "booking" }), false);
  assert.equal(WS.isBusinessEvent({ ...base, category: "private" }), false);
  assert.equal(WS.isBusinessEvent({ ...base, title: " " }), false);
  assert.equal(WS.isBusinessEvent({ ...base, ends_at: base.starts_at }), false);
  assert.equal(WS.isBusinessEvent({ ...base, all_day: true, ends_at: base.starts_at }), true);
  // 日本時間 0:00 ちょうどに終わる予定は、次の日に掛からない
  const late = { ...base, starts_at: "2026-10-13T14:00:00Z", ends_at: "2026-10-13T15:00:00Z" };
  assert.equal(WS.overlapsDay(late, "2026-10-13"), true);
  assert.equal(WS.overlapsDay(late, "2026-10-14"), false);
  assert.deepEqual(WS.jstBounds("2026-10-13"), { fromIso: "2026-10-12T15:00:00Z", toIso: "2026-10-13T15:00:00Z" });
});

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
