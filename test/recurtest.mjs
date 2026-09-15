// 繰り返しタスクの日付と、依頼 → 受諾 → 完了。
//
// ■ なぜここを固めるのか
//
//   出る日がずれても、誰も気づかない。
//   「第3営業日」が1日ずれて出ても、出た日にやる人はやってしまう。
//   月次の締めや支払がそれだと、ずれたまま運用される。
//
//   旧タスク管理（8grp.co.jp/8/zimu/task/）と同じ日付が出ることを見る。
//   違う日に出ると、移したあとに「前と違う」が起きる。
import assert from "node:assert/strict";
import {
  occurrenceDates, cleanRecur, recurLabel, pendingOccurrences,
  flowState, needsAccept, canComplete, HORIZON_MONTHS,
} from "../lib/task-flow.js";
import { isBizDay, bizDaysOfMonth, domDate, HOLIDAYS, COVERED_TO } from "../lib/holidays.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("— 営業日 —");

ok("土日は営業日ではない", () => {
  assert.equal(isBizDay(new Date("2026-09-19T00:00:00Z")), false, "土");
  assert.equal(isBizDay(new Date("2026-09-20T00:00:00Z")), false, "日");
  assert.equal(isBizDay(new Date("2026-09-18T00:00:00Z")), true, "金");
});

ok("祝日は営業日ではない", () => {
  // 2026-09-21 敬老の日 / 09-22 国民の休日 / 09-23 秋分の日
  assert.equal(isBizDay(new Date("2026-09-21T00:00:00Z")), false);
  assert.equal(isBizDay(new Date("2026-09-23T00:00:00Z")), false);
  assert.equal(isBizDay(new Date("2026-09-24T00:00:00Z")), true, "木は営業日");
});

ok("年末年始も休み", () => {
  for (const d of ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01"]) {
    assert.equal(isBizDay(new Date(`${d}T00:00:00Z`)), false, d);
  }
});

// 祝日表は手で足す。足し忘れると、第n営業日が静かにずれる。
// 先細りしたらここで落ちて教える（黙って間違えるよりよい）
ok("祝日表が、まだ先まで埋まっている", () => {
  const ahead = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  assert.ok(COVERED_TO >= ahead,
    `祝日表が ${COVERED_TO} までしかありません。`
    + `lib/holidays.js に翌年ぶんを足して、COVERED_TO を伸ばしてください`);
});

console.log("\n— 繰り返しの日付 —");

ok("毎月n日（そのまま）", () => {
  const d = occurrenceDates({ type: "dom", n: 25, adj: "" }, "2026-09", "2026-11");
  assert.deepEqual(d, ["2026-09-25", "2026-10-25", "2026-11-25"]);
});

ok("毎月n日（休みなら前の営業日）", () => {
  // 2026-10-25 は日曜 → 前営業日の 10-23（金）へ
  const d = occurrenceDates({ type: "dom", n: 25, adj: "prev" }, "2026-10", "2026-10");
  assert.deepEqual(d, ["2026-10-23"]);
});

ok("毎月n日（休みなら次の営業日）", () => {
  const d = occurrenceDates({ type: "dom", n: 25, adj: "next" }, "2026-10", "2026-10");
  assert.deepEqual(d, ["2026-10-26"]);
});

ok("月末より大きい日は、その月の末日に寄せる", () => {
  // 31日にしても、2月は28日（2026年）
  const d = occurrenceDates({ type: "dom", n: 31, adj: "" }, "2027-02", "2027-02");
  assert.deepEqual(d, ["2027-02-28"]);
});

ok("第n営業日（祝日を数えない）", () => {
  // 2026-09: 1(火) 2 3 4 が営業日、5-6 土日、7(月) 8 9 10 11、12-13 土日、
  //          14 15 16 17 18、19-20 土日、21-23 祝日、24 25、26-27 土日、28 29 30
  const biz = bizDaysOfMonth("2026-09").map((d) => d.toISOString().slice(0, 10));
  assert.equal(biz[0], "2026-09-01", "第1営業日");
  assert.equal(biz[2], "2026-09-03", "第3営業日");
  const d = occurrenceDates({ type: "biz", n: 3 }, "2026-09", "2026-09");
  assert.deepEqual(d, ["2026-09-03"]);
});

ok("第n営業日は、祝日の翌月でもずれない", () => {
  // 2027-01: 1(金)・2(土) は休み、4(月) が第1営業日
  const d = occurrenceDates({ type: "biz", n: 1 }, "2027-01", "2027-01");
  assert.deepEqual(d, ["2027-01-04"]);
});

ok("第n営業日が足りない月は、最後の営業日に寄せる", () => {
  // 黙って1件も作らないほうが困る
  const d = occurrenceDates({ type: "biz", n: 23 }, "2026-09", "2026-09");
  const biz = bizDaysOfMonth("2026-09");
  assert.deepEqual(d, [biz[biz.length - 1].toISOString().slice(0, 10)]);
});

ok("毎週", () => {
  // 2026-09 の月曜
  const d = occurrenceDates({ type: "weekly", weekday: 1 }, "2026-09", "2026-09");
  assert.deepEqual(d, ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
});

ok("毎日（平日のみ）は、土日祝を飛ばす", () => {
  const d = occurrenceDates({ type: "daily", daily: "wd" }, "2026-09", "2026-09");
  assert.ok(!d.includes("2026-09-19"), "土が入っている");
  assert.ok(!d.includes("2026-09-21"), "祝日が入っている");
  assert.ok(d.includes("2026-09-18"));
});

ok("毎日（全部）は、休みも入れる", () => {
  const d = occurrenceDates({ type: "daily", daily: "all" }, "2026-09", "2026-09");
  assert.equal(d.length, 30);
});

ok("月をまたいで並ぶ", () => {
  const d = occurrenceDates({ type: "dom", n: 1, adj: "" }, "2026-11", "2027-02");
  assert.deepEqual(d, ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
});

console.log("\n— 先まで作りすぎない —");

ok("作るのは当月と翌月だけ", () => {
  // 12か月ぶん先に作ると、月1件の繰り返しでも一覧に12件並んで、
  // 片付けても減らない＝終わらない、という見え方になる
  assert.equal(HORIZON_MONTHS, 2);
  const out = pendingOccurrences(
    { id: "t1", recur: { type: "dom", n: 15, adj: "" } },
    { today: "2026-09-14", have: new Set() });
  assert.deepEqual(out.map((o) => o.date), ["2026-09-15", "2026-10-15"]);
});

ok("過ぎた日は作らない", () => {
  const out = pendingOccurrences(
    { id: "t1", recur: { type: "dom", n: 1, adj: "" } },
    { today: "2026-09-14", have: new Set() });
  assert.ok(!out.some((o) => o.date === "2026-09-01"), "過去日を作っています");
});

ok("もう作ってある回は、作らない", () => {
  const have = new Set(["t1|2026-09-15"]);
  const out = pendingOccurrences(
    { id: "t1", recur: { type: "dom", n: 15, adj: "" } },
    { today: "2026-09-14", have });
  assert.deepEqual(out.map((o) => o.date), ["2026-10-15"]);
});

ok("鍵は template_id|日付", () => {
  const out = pendingOccurrences(
    { id: "abc", recur: { type: "dom", n: 15, adj: "" } },
    { today: "2026-09-14", have: new Set() });
  assert.equal(out[0].key, "abc|2026-09-15");
});

console.log("\n— 決まりの形を、先に確かめる —");

ok("種類が無ければ受け付けない", () => {
  assert.equal(cleanRecur(null).ok, false);
  assert.equal(cleanRecur({}).ok, false);
  assert.equal(cleanRecur({ type: "yearly" }).ok, false);
});

ok("日にちの範囲を見る", () => {
  assert.equal(cleanRecur({ type: "dom", n: 0 }).ok, false);
  assert.equal(cleanRecur({ type: "dom", n: 32 }).ok, false);
  assert.equal(cleanRecur({ type: "dom", n: 25 }).ok, true);
});

ok("曜日の範囲を見る", () => {
  assert.equal(cleanRecur({ type: "weekly", weekday: 7 }).ok, false);
  assert.equal(cleanRecur({ type: "weekly", weekday: 0 }).ok, true);
});

ok("余計な鍵は落とす", () => {
  // 画面から来たものをそのまま jsonb に入れると、
  // あとで「なぜこの列があるのか」が誰にも分からなくなる
  const r = cleanRecur({ type: "dom", n: 25, adj: "prev", hack: 1 });
  assert.deepEqual(r.recur, { type: "dom", n: 25, adj: "prev" });
});

ok("人が読める1行になる", () => {
  assert.equal(recurLabel({ type: "biz", n: 3 }), "毎月 第3営業日");
  assert.equal(recurLabel({ type: "dom", n: 25, adj: "prev" }), "毎月 25日（休みなら前営業日）");
  assert.equal(recurLabel({ type: "weekly", weekday: 1 }), "毎週 月曜");
  assert.equal(recurLabel({ type: "daily", daily: "wd" }), "毎日（平日）");
  assert.equal(recurLabel(null), "");
});

console.log("\n— 依頼 → 受諾 → 完了 —");

ok("人から頼まれて、まだ受けていなければ「未確認の依頼」", () => {
  const t = { status: "todo", requestedByOther: true, accepted_at: null };
  assert.equal(flowState(t).key, "waiting");
  assert.equal(needsAccept(t), true);
});

ok("受ければ、目立たせない", () => {
  const t = { status: "todo", requestedByOther: true, accepted_at: "2026-09-14T00:00:00Z" };
  assert.equal(flowState(t).key, "doing");
  assert.equal(needsAccept(t), false);
});

ok("自分で立てたものは、受諾を求めない", () => {
  // 自分が自分に頼んだものまで未確認にすると、
  // 一覧の大半が「未確認」で埋まって、本当の依頼が埋もれる
  const t = { status: "todo", requestedByOther: false, accepted_at: null };
  assert.equal(flowState(t).key, "own");
  assert.equal(needsAccept(t), false);
});

ok("終わったものは、未確認にしない", () => {
  const t = { status: "done", requestedByOther: true, accepted_at: null };
  assert.equal(flowState(t).key, "done");
  assert.equal(needsAccept(t), false);
});

ok("頼まれた仕事は、結果を書かないと完了にできない", () => {
  const t = { requestedByOther: true };
  assert.equal(canComplete(t, "").ok, false);
  assert.equal(canComplete(t, "   ").ok, false);
  assert.ok(/1行/.test(canComplete(t, "").why));
  assert.equal(canComplete(t, "請求書を送付しました").ok, true);
});

ok("自分のメモは、結果なしで完了できる", () => {
  // ここまで書かせると、面倒で完了を押さなくなる。
  // 押されなくなった時点で、一覧が信用できなくなる
  assert.equal(canComplete({ requestedByOther: false }, "").ok, true);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
