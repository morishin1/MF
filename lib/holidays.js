// 営業日。土日と、日本の祝日・年末年始を除いた日。
//
// ■ なぜ表を持つのか
//
//   これまでこのリポジトリは祝日を見ていなかった（「表を持つ手間に見合わない」）。
//   繰り返しタスクに「第3営業日」が入ると、そうはいかなくなる。
//   月次の締めや支払は第n営業日で決まっていて、祝日を数えないと
//   1日ずれた日に「今日やること」が出る。出た日にやらない人はいないので、
//   ずれたまま運用されてしまう。
//
// ■ 手で書く
//
//   祝日APIを叩くと、その日に外が落ちていると営業日が計算できなくなる。
//   年に1回、2行足すほうが確実。下のテスト（test/recurtest.mjs）が、
//   表が先細りしたときに落ちて教える。
//
// ■ 旧タスク管理（8/zimu/task/）と同じ表
//
//   ずれると、移したあとに「前と違う日に出る」が起きる。
//   向こうの HOLIDAYS をそのまま持ってきてある。

/** 日本の祝日・会社休日（YYYY-MM-DD）。年末年始も休みとして入れてある */
export const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23",
  "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22",
  "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2026-12-29", "2026-12-30", "2026-12-31",
  // 2027
  "2027-01-01", "2027-01-02", "2027-01-11", "2027-02-11", "2027-02-23",
  "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04",
  "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23",
  "2027-10-11", "2027-11-03", "2027-11-23",
  "2027-12-29", "2027-12-30", "2027-12-31",
]);

/** 表がどこまで埋まっているか。テストがここを見て、先細りしたら落ちる */
export const COVERED_TO = "2027-12-31";

/** YYYY-MM-DD にする。UTC で組み立てているので、どの時間帯で動かしても同じ日になる */
export const dateStr = (d) => d.toISOString().slice(0, 10);

/** その日は営業日か（土日と祝日を除く） */
export function isBizDay(d) {
  const g = d.getUTCDay();
  if (g === 0 || g === 6) return false;
  return !HOLIDAYS.has(dateStr(d));
}

/** YYYY-MM の日数 */
export function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** YYYY-MM の営業日を、1日から順に並べる */
export function bizDaysOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const out = [];
  for (let dd = 1; dd <= daysInMonth(ym); dd++) {
    const d = new Date(Date.UTC(y, m - 1, dd));
    if (isBizDay(d)) out.push(d);
  }
  return out;
}

/**
 * 毎月n日。休みに当たったときの寄せ方を決める。
 *   ""     … そのまま（休みでもその日）
 *   "prev" … 前の営業日へ（支払・締めはこちらが多い）
 *   "next" … 次の営業日へ
 */
export function domDate(ym, n, adj) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, Math.min(n, daysInMonth(ym))));
  if (adj === "prev") while (!isBizDay(d)) d.setUTCDate(d.getUTCDate() - 1);
  else if (adj === "next") while (!isBizDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  return dateStr(d);
}

/** YYYY-MM に n か月足す */
export function ymAdd(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}
