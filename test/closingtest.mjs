import assert from "node:assert/strict";
import * as C from "../lib/closing.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };

console.log("— 月の範囲 —");
ok("年をまたぐ", () => {
  assert.deepEqual(C.monthRange("2026-12"), { from: "2026-12-01", to: "2027-01-01" });
  assert.equal(C.prevMonth("2026-01"), "2025-12");
  assert.equal(C.prevMonth("2026-05"), "2026-04");
  assert.equal(C.monthRange("2026-5"), null);
});

console.log("— 休暇の日数 —");
const R = C.monthRange("2026-04");
ok("月の中に収まっていれば、申請の日数をそのまま使う", () => {
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-04-10", ends_on: "2026-04-12", days: 3 }, R), 3);
});
ok("半休を壊さない", () => {
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-04-10", ends_on: "2026-04-10", days: 0.5 }, R), 0.5);
});
ok("月をまたぐと、その月にかかる分だけ数える", () => {
  // 3/30〜4/2 の4日。4月にかかるのは2日
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-03-30", ends_on: "2026-04-02", days: 4 }, R), 2);
  // 4/29〜5/2 の4日。4月にかかるのは2日
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-04-29", ends_on: "2026-05-02", days: 4 }, R), 2);
});
ok("その月にかからないものは0", () => {
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-05-01", ends_on: "2026-05-02", days: 2 }, R), 0);
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-03-01", ends_on: "2026-03-02", days: 2 }, R), 0);
});
ok("days が無くても、日付から数える", () => {
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-04-10", ends_on: "2026-04-12" }, R), 3);
});
ok("壊れた値で落ちない", () => {
  assert.equal(C.leaveDaysInMonth({}, R), 0);
  assert.equal(C.leaveDaysInMonth({ starts_on: "2026-04-10" }, R), 1);
});

console.log("— 締められるか —");
const row = (name, pending = {}) => ({
  employee: { name },
  pending: { leave: 0, ringi: 0, expense: 0, timefix: 0, ...pending },
});
ok("未承認が無ければ締められる", () => {
  const r = C.canClose([row("A"), row("B")]);
  assert.equal(r.ok, true);
  assert.equal(r.blockers.length, 0);
});
ok("未承認があれば締められない", () => {
  const r = C.canClose([row("A", { expense: 2 }), row("B")]);
  assert.equal(r.ok, false);
  assert.equal(r.blockers[0].name, "A");
  assert.equal(r.blockers[0].what, "経費精算");
  assert.equal(r.blockers[0].count, 2);
});
ok("止めている理由を全部挙げる（1つ直して終わりにさせない）", () => {
  const r = C.canClose([row("A", { leave: 1, expense: 2 }), row("B", { timefix: 1 })]);
  assert.equal(r.blockers.length, 3);
});
ok("空でも落ちない", () => {
  assert.equal(C.canClose(null).ok, true);
  assert.equal(C.canClose([]).ok, true);
});

console.log("— CSV —");
const full = {
  employee: { email: "taro@gw.8grp.co.jp", name: "今福 太郎", department: "制作部" },
  work: { days: 20, workMinutes: 9600, breakMinutes: 1200, nightMinutes: 30, holidayMinutes: 0 },
  leave: { paid: 2, other: 0.5 },
  expense: { total: 12800, count: 3 },
  pending: { leave: 0, ringi: 0, expense: 0, timefix: 0 },
};
ok("列の数がヘッダと合う", () => {
  assert.equal(C.csvRow("2026-04", full, true).length, C.CSV_HEADER.length);
});
ok("実労働は 時:分 と 分 の両方を出す（給与ソフトによって要る形が違う）", () => {
  const r = C.csvRow("2026-04", full, true);
  assert.equal(r[5], "160:00");
  assert.equal(r[6], 9600);
});
ok("締め状況が入る", () => {
  assert.equal(C.csvRow("2026-04", full, true).at(-1), "締め済");
  assert.equal(C.csvRow("2026-04", full, false).at(-1), "未締め");
});
ok("カンマを含む名前を壊さない", () => {
  assert.equal(C.csvCell("株式会社エイト, 制作部"), '"株式会社エイト, 制作部"');
  assert.equal(C.csvCell('引用"符'), '"引用""符"');
  assert.equal(C.csvCell("ふつう"), "ふつう");
  assert.equal(C.csvCell(null), "");
});

console.log("— 時刻の表示 —");
ok("clock", () => {
  assert.equal(C.clock(9600), "160:00");
  assert.equal(C.clock(90), "1:30");
  assert.equal(C.clock(0), "0:00");
  assert.equal(C.clock(-5), "0:00");
});

console.log(`\n${n} 件 すべて通りました`);
