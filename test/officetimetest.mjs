// 勤務表の時間の計算（lib/office-time.js）。
//
// ■ 何を守るテストか
//
//   1. 時刻・休憩の読み方。曖昧なものは読まない（null）。休憩の「なし」は0、不明は null（補完しない）
//   2. 日別の実働 = 拘束 − 休憩。休憩が不明なら実働を出さない（blocking）。日跨ぎ・拘束の長すぎ
//   3. 月跨ぎ：月末日の勤務が翌日にかかるぶんは、月境界で分割して翌月へ
//   4. 丸め：15分・30分、切捨て・切上げ・四捨五入。日ごと／月合計で結果が変わる
//   5. 月間集計：不明な日は合計に入れず unresolved に挙げる。対象月外の日付は入れない
//   期待値は、規則から手で計算した数字（実装の出力を写していない）
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const T = await import(join(ROOT, "lib/office-time.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const H = (h, m = 0) => h * 60 + m;

console.log("— 時刻・休憩の読み方 —");

await ok("時刻：9:00・09:00・全角コロン・9時・9時30分", async () => {
  for (const s of ["9:00", "09:00", "9：00", "9時", " 9 : 00 ".replace(/ /g, "")]) assert.equal(T.parseClock(s), H(9), s);
  assert.equal(T.parseClock("9時30分"), H(9, 30));
  assert.equal(T.parseClock("17:45"), H(17, 45));
  assert.equal(T.parseClock(H(9)), H(9), "分の数値はそのまま");
});
await ok("24時間を超える表記は、終了時刻として読める（26:00 = 翌2:00）。48時以降は読まない", async () => {
  assert.equal(T.parseClock("24:00"), 1440);
  assert.equal(T.parseClock("26:00"), H(26));
  assert.equal(T.parseClock("48:00"), null);
  assert.equal(T.parseClock("26:00", { allowOver24: false }), null);
});
await ok("曖昧・不正は読まない（null）：9:5・9:60・空・文字", async () => {
  for (const s of ["9:5", "9:60", "", "  ", "abc", "9-00", "９時", null, undefined, "9:00-18:00"]) {
    assert.equal(T.parseClock(s), null, String(s));
  }
});
await ok("HH:MM と 時間（小数2桁）に戻す", async () => {
  assert.equal(T.formatClock(H(9, 5)), "09:05");
  assert.equal(T.formatClock(H(26)), "26:00");
  assert.equal(T.formatHours(9750), "162.5");
  assert.equal(T.formatHours(480), "8");
  assert.equal(T.formatHours(1), "0.02");
});
await ok("休憩：1:00・60・60分・1時間・1.5時間 → 分", async () => {
  for (const [s, want] of [["1:00", 60], ["60", 60], ["60分", 60], ["1時間", 60], ["1.5時間", 90], [45, 45], ["0:45", 45]]) {
    assert.deepEqual(T.parseBreak(s), { value: want }, String(s));
  }
});
await ok("休憩：「なし」「0」は 0（取っていない）。空・「-」・「不明」は null（不明。補完しない）", async () => {
  for (const s of ["なし", "無し", "0", 0]) assert.deepEqual(T.parseBreak(s), { value: 0 }, String(s));
  for (const s of ["", "-", "—", "不明", null, undefined]) assert.deepEqual(T.parseBreak(s), { value: null }, String(s));
});
await ok("休憩：読めない書き方は、値を入れずにエラーを返す", async () => {
  for (const s of ["1:75", "たくさん", "1.5"]) {
    const r = T.parseBreak(s);
    assert.equal(r.value, null, s);
    assert.ok(r.error, s);
  }
  assert.ok(T.parseBreak(-5).error);
});

console.log("— 日別の実働（拘束 − 休憩） —");

await ok("9:00〜18:00・休憩1:00 → 拘束9:00・実働8:00", async () => {
  const r = T.dayWork({ kind: "work", start: H(9), end: H(18), breakMin: 60 });
  assert.equal(r.gross, 540);
  assert.equal(r.worked, 480);
  assert.deepEqual(r.flags, []);
});
await ok("休憩が不明なら、実働を出さない（補完しない）。blocking の理由が付く", async () => {
  const r = T.dayWork({ kind: "work", start: H(9), end: H(18), breakMin: null });
  assert.equal(r.worked, null);
  assert.equal(r.gross, 540, "拘束は分かる");
  assert.ok(r.flags.some((f) => f.code === "break_unknown" && f.blocking));
});
await ok("休憩0（取っていない）は、そのまま拘束＝実働", async () => {
  assert.equal(T.dayWork({ kind: "work", start: H(9), end: H(13), breakMin: 0 }).worked, 240);
});
await ok("開始・終了が空なら、実働を出さない", async () => {
  for (const d of [{ start: null, end: H(18) }, { start: H(9), end: null }]) {
    const r = T.dayWork({ kind: "work", breakMin: 60, ...d });
    assert.equal(r.worked, null);
    assert.ok(r.flags.some((f) => f.code === "time_missing" && f.blocking));
  }
});
await ok("休憩が拘束より長い → blocking", async () => {
  const r = T.dayWork({ kind: "work", start: H(9), end: H(10), breakMin: 90 });
  assert.equal(r.worked, null);
  assert.ok(r.flags.some((f) => f.code === "break_over" && f.blocking));
});
await ok("日跨ぎ：22:00〜06:00 は、書かれていなくても翌日終了として計算し、人に確認してもらう", async () => {
  const r = T.dayWork({ kind: "work", start: H(22), end: H(6), breakMin: 60 });
  assert.equal(r.gross, 480);
  assert.equal(r.worked, 420);
  assert.equal(r.overnight, true);
  assert.ok(r.flags.some((f) => f.code === "overnight_assumed" && !f.blocking));
});
await ok("日跨ぎ：終了を 30:00 と明示していれば、確認の印は付けない", async () => {
  const r = T.dayWork({ kind: "work", start: H(22), end: H(30), breakMin: 60 });
  assert.equal(r.worked, 420);
  assert.deepEqual(r.flags, []);
});
await ok("拘束が20時間を超えたら、読み違いを疑って印を付ける（開始と終了が同じ時刻など）", async () => {
  const r = T.dayWork({ kind: "work", start: H(9), end: H(9), breakMin: 60 });
  assert.equal(r.gross, 1440);
  assert.ok(r.flags.some((f) => f.code === "span_long"));
});
await ok("休み（off）は実働0で、確認の印なし", async () => {
  const r = T.dayWork({ kind: "off", start: null, end: null, breakMin: null });
  assert.equal(r.worked, 0);
  assert.deepEqual(r.flags, []);
});

console.log("— 月跨ぎ：月境界で分割 —");

await ok("月末日 22:00〜翌6:00・休憩1:00 → 月内 1:00（休憩は開始側から差し引く）・翌月 6:00、合計は元の実働 7:00", async () => {
  const w = T.dayWork({ kind: "work", start: H(22), end: H(30), breakMin: 60 });
  const s = T.splitAtMonthEnd("2026-10-31", "2026-10", { start: H(22), endMin: w.endMin, breakMin: 60, worked: w.worked });
  assert.deepEqual(s, { inMonth: 60, spill: 360, flagged: true });
  assert.equal(s.inMonth + s.spill, w.worked);
});
await ok("休憩が月内の部分より長ければ、残りは翌月側から差し引く（合計は保つ）", async () => {
  const s = T.splitAtMonthEnd("2026-10-31", "2026-10", { start: H(22), endMin: H(30), breakMin: 180, worked: 300 });
  assert.deepEqual(s, { inMonth: 0, spill: 300, flagged: true });
});
await ok("月末日でない・翌日にかからない勤務は、分割しない", async () => {
  assert.deepEqual(T.splitAtMonthEnd("2026-10-30", "2026-10", { start: H(22), endMin: H(30), breakMin: 60, worked: 420 }),
    { inMonth: 420, spill: 0, flagged: false });
  assert.deepEqual(T.splitAtMonthEnd("2026-10-31", "2026-10", { start: H(9), endMin: H(18), breakMin: 60, worked: 480 }),
    { inMonth: 480, spill: 0, flagged: false });
});
await ok("2月の末日（うるう年・平年）で分割する", async () => {
  assert.equal(T.splitAtMonthEnd("2027-02-28", "2027-02", { start: H(22), endMin: H(26), breakMin: 0, worked: 240 }).flagged, true);
  assert.equal(T.splitAtMonthEnd("2028-02-28", "2028-02", { start: H(22), endMin: H(26), breakMin: 0, worked: 240 }).flagged, false, "2028年は29日が末日");
  assert.equal(T.splitAtMonthEnd("2028-02-29", "2028-02", { start: H(22), endMin: H(26), breakMin: 0, worked: 240 }).flagged, true);
});

console.log("— 丸め —");

await ok("15分・切捨て／切上げ／四捨五入", async () => {
  assert.equal(T.roundMinutes(7, 15, "floor"), 0);
  assert.equal(T.roundMinutes(7, 15, "ceil"), 15);
  assert.equal(T.roundMinutes(7, 15, "round"), 0);
  assert.equal(T.roundMinutes(8, 15, "round"), 15);
  assert.equal(T.roundMinutes(450, 15, "floor"), 450, "ちょうどは変わらない");
  assert.equal(T.roundMinutes(450, 15, "ceil"), 450);
});
await ok("30分：100分 → 切捨て90・切上げ120", async () => {
  assert.equal(T.roundMinutes(100, 30, "floor"), 90);
  assert.equal(T.roundMinutes(100, 30, "ceil"), 120);
});
await ok("単位が無ければ丸めない", async () => {
  assert.equal(T.roundMinutes(97, null, "floor"), 97);
  assert.equal(T.roundMinutes(97, 1, "floor"), 97);
});

console.log("— 月間集計 —");

const D = (day, s, e, b, extra = {}) => ({ workDate: `2026-10-${String(day).padStart(2, "0")}`, kind: "work", startMin: s, endMin: e, breakMin: b, ...extra });
const OFF = (day) => ({ workDate: `2026-10-${String(day).padStart(2, "0")}`, kind: "off", startMin: null, endMin: null, breakMin: null });

await ok("実働の合計。休みの日・勤務0の日は稼働日数に入らない", async () => {
  const r = T.aggregateMonth([D(1, H(9), H(18), 60), D(2, H(9), H(18), 60), OFF(3), OFF(4), D(5, H(9), H(9, 30), 0)], { month: "2026-10" });
  assert.equal(r.rawMinutes, 480 + 480 + 30);
  assert.equal(r.totalMinutes, 990);
  assert.equal(r.workDays, 3);
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.rounding, null, "契約条件が無ければ丸めない");
});
await ok("日ごとの丸めと、月合計の丸めで結果が変わる（7:50 が2日・30分単位・切捨て）", async () => {
  const days = [D(1, H(9), H(17, 50), 0), D(2, H(9), H(17, 50), 0)];      // 各 8:50 → 実働 530
  const byDay = T.aggregateMonth(days, { month: "2026-10", unit: 30, mode: "floor", scope: "day" });
  const byMonth = T.aggregateMonth(days, { month: "2026-10", unit: 30, mode: "floor", scope: "month" });
  assert.equal(byDay.rawMinutes, 1060);
  assert.equal(byDay.totalMinutes, 510 + 510, "530→510 を2日");
  assert.equal(byMonth.totalMinutes, 1050, "1060→1050");
  assert.deepEqual(byDay.rounding, { unit: 30, mode: "floor", scope: "day" });
});
await ok("休憩が不明な日は、合計に入れず unresolved に挙げる（補完しない）", async () => {
  const r = T.aggregateMonth([D(1, H(9), H(18), 60), D(2, H(9), H(18), null), D(3, H(9), H(18), 60)], { month: "2026-10" });
  assert.equal(r.totalMinutes, 960);
  assert.deepEqual(r.unresolved, ["2026-10-02"]);
  assert.ok(r.perDay[1].flags.some((f) => f.code === "break_unknown"));
});
await ok("開始・終了が空の日も unresolved", async () => {
  const r = T.aggregateMonth([D(1, null, null, 60)], { month: "2026-10" });
  assert.deepEqual(r.unresolved, ["2026-10-01"]);
  assert.equal(r.totalMinutes, 0);
});
await ok("対象月ではない日付は合計に入れず、unresolved（人が直す）", async () => {
  const r = T.aggregateMonth([D(1, H(9), H(18), 60), { workDate: "2026-11-01", kind: "work", startMin: H(9), endMin: H(18), breakMin: 60 }, { workDate: "abc", kind: "off" }], { month: "2026-10" });
  assert.equal(r.totalMinutes, 480);
  assert.deepEqual(r.unresolved, ["2026-11-01", "abc"]);
});
await ok("月末日の勤務が翌月にかかる：月内ぶんだけを合計し、翌月ぶんは spillMinutes に持つ", async () => {
  const r = T.aggregateMonth([D(30, H(9), H(18), 60), D(31, H(22), H(30), 60)], { month: "2026-10" });
  assert.equal(r.rawMinutes, 480 + 60);
  assert.equal(r.spillMinutes, 360);
  assert.ok(r.perDay[1].flags.some((f) => f.code === "month_split"));
});
await ok("前月の月末から入ってくるぶん（carry-in）を、この月に足す", async () => {
  const r = T.aggregateMonth([D(1, H(9), H(18), 60)], { month: "2026-10", carryInMinutes: 360 });
  assert.equal(r.rawMinutes, 840);
  assert.equal(r.totalMinutes, 840);
  assert.equal(r.carryInMinutes, 360);
  const r2 = T.aggregateMonth([D(1, H(9), H(18), 60)], { month: "2026-10", carryInMinutes: 355, unit: 15, mode: "floor", scope: "day" });
  assert.equal(r2.totalMinutes, 480 + 345, "carry-in も丸める");
});
await ok("日ごとの丸めでは、実働が丸め単位より短い日は 0 になる（切捨て）", async () => {
  const r = T.aggregateMonth([D(1, H(9), H(9, 10), 0)], { month: "2026-10", unit: 15, mode: "floor", scope: "day" });
  assert.equal(r.totalMinutes, 0);
  assert.equal(r.workDays, 1, "実働はある（丸める前）");
});
await ok("日が1件も無くても壊れない", async () => {
  const r = T.aggregateMonth([], { month: "2026-10" });
  assert.equal(r.totalMinutes, 0);
  assert.deepEqual(r.unresolved, []);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
