// 営業分析の期間（本日・昨日・今週・先週・今月・先月・任意期間）を、決まった「いま」で確かめる。
//
// ■ 何を守るテストか
//   1. 日本時間（JST）の暦日で区切る。UTC の日付で切らない（朝9時前の扱いがずれない）
//   2. 週は月曜はじまり（lib/nippo.js weekStart と同じ。新しい定義を増やさない）
//   3. 今週・今月は今日まで。先週・先月はまるごと。年をまたいでも正しい
//   4. 任意期間は YYYY-MM-DD で、開始日 ≤ 終了日、長すぎないこと
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { resolvePeriod, PERIOD_KEYS, DEFAULT_PERIOD, MAX_CUSTOM_DAYS } = await import(join(ROOT, "lib/sales-period.js"));
const { weekStart } = await import(join(ROOT, "lib/nippo.js"));

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };
const at = (iso) => new Date(iso);
const range = (key, now, custom) => {
  const p = resolvePeriod(key, custom, now);
  return p.error ? p.error : `${p.from}..${p.to}`;
};

// 2026-10-07 は水曜日
const WED = at("2026-10-07T10:00:00+09:00");
ok("本日・昨日", () => {
  assert.equal(range("today", WED), "2026-10-07..2026-10-07");
  assert.equal(range("yesterday", WED), "2026-10-06..2026-10-06");
});
ok("今週は月曜〜今日、先週は前の月曜〜日曜（月曜はじまり）", () => {
  assert.equal(range("this_week", WED), "2026-10-05..2026-10-07");
  assert.equal(range("last_week", WED), "2026-09-28..2026-10-04");
  assert.equal(weekStart("2026-10-07"), "2026-10-05", "既存の週の定義（lib/nippo.js）と同じ");
});
ok("今月は1日〜今日、先月はまるごと", () => {
  assert.equal(range("this_month", WED), "2026-10-01..2026-10-07");
  assert.equal(range("last_month", WED), "2026-09-01..2026-09-30");
});
ok("日本時間で区切る：UTC では日曜でも、日本時間で月曜0時半なら今週は月曜から", () => {
  const monEarly = at("2026-10-04T15:30:00Z");   // = 2026-10-05（月）0:30 JST
  assert.equal(range("today", monEarly), "2026-10-05..2026-10-05");
  assert.equal(range("this_week", monEarly), "2026-10-05..2026-10-05");
  assert.equal(range("last_week", monEarly), "2026-09-28..2026-10-04");
});
ok("日曜日の今週は、その週の月曜から日曜まで", () => {
  assert.equal(range("this_week", at("2026-10-11T20:00:00+09:00")), "2026-10-05..2026-10-11");
});
ok("年をまたぐ：1月の先月は前年12月、1月1日の昨日は前年12月31日", () => {
  assert.equal(range("last_month", at("2026-01-15T09:00:00+09:00")), "2025-12-01..2025-12-31");
  assert.equal(range("yesterday", at("2026-01-01T08:00:00+09:00")), "2025-12-31..2025-12-31");
  assert.equal(range("last_month", at("2024-03-10T09:00:00+09:00")), "2024-02-01..2024-02-29", "うるう年");
});
ok("時刻の境目：from の 0:00 JST 以上、to の翌日 0:00 JST 未満（UTC の ISO）", () => {
  const p = resolvePeriod("yesterday", {}, WED);
  assert.equal(p.sinceIso, "2026-10-05T15:00:00.000Z");
  assert.equal(p.untilIso, "2026-10-06T15:00:00.000Z");
  assert.equal(p.days, 1);
});
ok("任意期間：両端を含む。開始日が後・形が違う・存在しない日・長すぎるは弾く", () => {
  assert.equal(range("custom", WED, { from: "2026-09-01", to: "2026-09-30" }), "2026-09-01..2026-09-30");
  assert.equal(resolvePeriod("custom", { from: "2026-09-01", to: "2026-09-30" }, WED).days, 30);
  assert.equal(range("custom", WED, { from: "2026-09-30", to: "2026-09-01" }), "bad_range");
  assert.equal(range("custom", WED, { from: "2026/09/01", to: "2026-09-30" }), "bad_range");
  assert.equal(range("custom", WED, { from: "2026-02-30", to: "2026-03-01" }), "bad_range");
  assert.equal(range("custom", WED, {}), "bad_range");
  assert.equal(range("custom", WED, { from: "2024-01-01", to: "2026-01-01" }), "range_too_long");
  assert.ok(MAX_CUSTOM_DAYS >= 366, "1年分は指定できる");
});
ok("既定は今週。知らない期間は弾く", () => {
  assert.equal(DEFAULT_PERIOD, "this_week");
  assert.equal(resolvePeriod("", {}, WED).key, "this_week");
  assert.equal(range("foo", WED), "bad_period");
  assert.deepEqual(PERIOD_KEYS, ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "custom"]);
});

console.log(`\n${n} 件 すべて通りました`);
