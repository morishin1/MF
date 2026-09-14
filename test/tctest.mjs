import assert from "node:assert/strict";
import * as T from "../lib/timecard.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };

console.log("— 日付・月 —");
ok("jstDate は日本時間で切る", () => {
  // UTC 2026-09-07 16:00 は日本では 翌8日 01:00
  assert.equal(T.jstDate("2026-09-07T16:00:00Z"), "2026-09-08");
  assert.equal(T.jstDate("2026-09-07T14:59:00Z"), "2026-09-07");
});
ok("jstTime", () => {
  assert.equal(T.jstTime("2026-09-07T00:00:00Z"), "09:00");
  assert.equal(T.jstTime(null), null);
});
ok("monthRange は年をまたぐ", () => {
  assert.deepEqual(T.monthRange("2026-12"), { from: "2026-12-01", to: "2027-01-01" });
  assert.deepEqual(T.monthRange("2026-09"), { from: "2026-09-01", to: "2026-10-01" });
  assert.equal(T.monthRange("2026-9"), null);
});

console.log("— 休憩 —");
ok("normalizeBreaks は読めないものを捨てる（例外を投げない）", () => {
  const r = T.normalizeBreaks([
    { start: "2026-09-07T03:00:00Z", end: "2026-09-07T04:00:00Z" },
    { start: "これは時刻ではない" },
    { end: "2026-09-07T05:00:00Z" },
    null,
    { start: "2026-09-07T06:00:00Z", end: null },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[1].end, null);
});
ok("normalizeBreaks は12件で打ち切る", () => {
  const many = Array.from({ length: 30 }, () => ({ start: "2026-09-07T03:00:00Z" }));
  assert.equal(T.normalizeBreaks(many).length, 12);
});
ok("onBreak", () => {
  assert.equal(T.onBreak({ breaks: [{ start: "x", end: null }] }), true);
  assert.equal(T.onBreak({ breaks: [{ start: "x", end: "y" }] }), false);
  assert.equal(T.onBreak({}), false);
});
ok("breakMinutes は終わっていない休憩を今まで数える", () => {
  const now = new Date("2026-09-07T04:30:00Z");
  assert.equal(T.breakMinutes({ breaks: [{ start: "2026-09-07T04:00:00Z", end: null }] }, now), 30);
  assert.equal(T.breakMinutes({ breaks: [
    { start: "2026-09-07T03:00:00Z", end: "2026-09-07T03:20:00Z" },
    { start: "2026-09-07T04:00:00Z", end: "2026-09-07T04:10:00Z" },
  ] }, now), 30);
});

console.log("— 1日 —");
const day = {
  work_date: "2026-09-07",
  status: "closed",
  clock_in: "2026-09-07T00:00:00Z",   // 09:00
  clock_out: "2026-09-07T09:00:00Z",  // 18:00
  breaks: [{ start: "2026-09-07T03:00:00Z", end: "2026-09-07T04:00:00Z" }],
};
ok("実労働＝拘束−休憩", () => {
  const t = T.dayTotals(day);
  assert.equal(t.stayMinutes, 540);
  assert.equal(t.breakMinutes, 60);
  assert.equal(t.workMinutes, 480);
  assert.equal(t.open, false);
});
ok("出勤中は「いま」まで数える", () => {
  const t = T.dayTotals({ status: "open", clock_in: "2026-09-07T00:00:00Z", clock_out: null, breaks: [] },
    new Date("2026-09-07T02:00:00Z"));
  assert.equal(t.workMinutes, 120);
  assert.equal(t.open, true);
});
ok("休憩が拘束を超えても負にならない", () => {
  const t = T.dayTotals({
    status: "closed", clock_in: "2026-09-07T00:00:00Z", clock_out: "2026-09-07T01:00:00Z",
    breaks: [{ start: "2026-09-07T00:00:00Z", end: "2026-09-07T05:00:00Z" }],
  });
  assert.equal(t.workMinutes, 0);
});
ok("夜勤（日をまたぐ）", () => {
  const t = T.dayTotals({
    status: "closed", clock_in: "2026-09-07T13:00:00Z", clock_out: "2026-09-07T22:00:00Z", breaks: [],
  });
  assert.equal(t.workMinutes, 540);
});
ok("打っていない日は0", () => {
  assert.equal(T.dayTotals({ status: "absent" }).workMinutes, 0);
  assert.equal(T.dayTotals(null).stayMinutes, 0);
});

console.log("— 表示 —");
ok("hhmm", () => {
  assert.equal(T.hhmm(480), "8時間");
  assert.equal(T.hhmm(510), "8時間30分");
  assert.equal(T.hhmm(45), "45分");
  assert.equal(T.hhmm(-5), "0分");
});
ok("clock", () => {
  assert.equal(T.clock(510), "8:30");
  assert.equal(T.clock(5), "0:05");
  assert.equal(T.clock(0), "0:00");
});

console.log("— 所定労働時間 —");
ok("よくある書き方", () => {
  assert.equal(T.scheduledMinutes("9:00〜18:00"), 540);
  assert.equal(T.scheduledMinutes("9:00〜18:00（休憩60分）"), 480);
  assert.equal(T.scheduledMinutes("9:00〜18:00 休憩1時間"), 480);
  assert.equal(T.scheduledMinutes("１０：００〜１９：００"), 540);
  assert.equal(T.scheduledMinutes("10:00-19:00"), 540);
});
ok("夜勤", () => {
  assert.equal(T.scheduledMinutes("22:00〜7:00"), 540);
});
ok("読めなければ null（勝手に決めない）", () => {
  assert.equal(T.scheduledMinutes("シフト制"), null);
  assert.equal(T.scheduledMinutes(""), null);
  assert.equal(T.scheduledMinutes(null), null);
});

console.log("— 月 —");
const month = [
  day,
  { ...day, clock_out: "2026-09-07T10:00:00Z" },  // 実労働 9h
  { status: "absent", clock_in: null, clock_out: null, breaks: [] },
];
ok("欠勤は日数に数えない", () => {
  const m = T.monthTotals(month, {});
  assert.equal(m.days, 2);
  assert.equal(m.workMinutes, 480 + 540);
  assert.equal(m.overMinutes, null);
});
ok("所定があれば超過を出す", () => {
  const m = T.monthTotals(month, { scheduled: 480 });
  assert.equal(m.overMinutes, 60);
});
ok("空でも落ちない", () => {
  assert.deepEqual(T.monthTotals(null, {}).days, 0);
});

console.log("— 妥当性 —");
ok("退勤が出勤より前", () => {
  assert.match(T.validateEntry({ clockIn: "2026-09-07T09:00:00Z", clockOut: "2026-09-07T01:00:00Z" }) || "",
    /退勤が出勤より前/);
});
ok("退勤だけは入れられない", () => {
  assert.match(T.validateEntry({ clockOut: "2026-09-07T09:00:00Z" }) || "", /退勤だけ/);
});
ok("20時間超は日付の間違いを疑う", () => {
  assert.match(T.validateEntry({ clockIn: "2026-09-07T00:00:00Z", clockOut: "2026-09-08T02:00:00Z" }) || "",
    /20時間/);
});
ok("勤務の外の休憩", () => {
  assert.match(T.validateEntry({
    clockIn: "2026-09-07T00:00:00Z", clockOut: "2026-09-07T09:00:00Z",
    breaks: [{ start: "2026-09-06T23:00:00Z", end: "2026-09-06T23:30:00Z" }],
  }) || "", /出勤より前/);
  assert.match(T.validateEntry({
    clockIn: "2026-09-07T00:00:00Z", clockOut: "2026-09-07T09:00:00Z",
    breaks: [{ start: "2026-09-07T08:00:00Z", end: "2026-09-07T10:00:00Z" }],
  }) || "", /退勤より後/);
});
ok("休憩が拘束を超える", () => {
  assert.match(T.validateEntry({
    clockIn: "2026-09-07T00:00:00Z", clockOut: "2026-09-07T01:00:00Z",
    breaks: [{ start: "2026-09-07T00:00:00Z", end: "2026-09-07T01:00:00Z" },
             { start: "2026-09-07T00:10:00Z", end: "2026-09-07T00:50:00Z" }],
  }) || "", /休憩の合計/);
});
ok("正しいものは null", () => {
  assert.equal(T.validateEntry({
    clockIn: "2026-09-07T00:00:00Z", clockOut: "2026-09-07T09:00:00Z",
    breaks: [{ start: "2026-09-07T03:00:00Z", end: "2026-09-07T04:00:00Z" }],
  }), null);
  assert.equal(T.validateEntry({}), null);   // 欠勤（何も打っていない）
});

console.log("— CSV —");
ok("列の数がヘッダと合う", () => {
  const r = T.csvRow({ ...day, note: "客先直行", edited_at: "2026-09-08T00:00:00Z", edit_reason: "打刻漏れ" },
    { display_name: "山田 太郎", department: "営業" });
  assert.equal(r.length, T.CSV_HEADER.length);
  assert.deepEqual(r.slice(0, 7), ["2026-09-07", "山田 太郎", "営業", "09:00", "18:00", "1:00", "8:00"]);
  assert.equal(r[7], "退勤済");
  assert.equal(r[9], "打刻漏れ");
});
ok("欠勤の行", () => {
  const r = T.csvRow({ work_date: "2026-09-09", status: "absent", clock_in: null, clock_out: null, breaks: [] }, {});
  assert.equal(r[7], "欠勤・休暇");
  assert.equal(r[6], "0:00");
});

console.log(`\n${n} 件 すべて通りました`);
