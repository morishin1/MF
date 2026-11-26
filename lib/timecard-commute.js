import { json, dbSetupHint } from "./http.js";
import { clock } from "./timecard.js";
import { csvCell } from "./sales-enger-csv.js";

export const validMonth = (s) => typeof s === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(s);
export const validId = (s) => typeof s === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(s);

const problems = {
  commute_busy: [409, "同じ月を更新中です。少し待ってもう一度お試しください。"],
  commute_stale: [409, "表示後に勤怠か通勤費が変わりました。最新の内容を読み直してください。"],
  commute_locked: [409, "この月は締め済みです。修正はOfficeにご相談ください。"],
  commute_unreviewed: [409, "通勤費が未確認の方がいます。支給なしの方も確認してから締めてください。"],
  commute_attendance: [409, "未完了の打刻・修正申請・通勤日の不一致を確認してから締めてください。"],
  commute_dates: [400, "対象月に勤務が確定した日から、実際に通勤した日を選択してください。"],
  commute_input: [400, "支給方法と金額を確認してください。"],
  commute_month: [400, "当月または過去の月を選択してください。"],
  commute_advisor: [400, "在籍中の社労士を選択するか、共有なしにしてください。"],
  commute_employee: [404, "この月の対象者がいません。"],
};

// 新しい月締めで守られた日への打刻・修正も、利用者が分かる理由で返す。
export function commuteDbError(res, err) {
  const known = problems[err?.message];
  if (known) return json(res, known[0], { error: err.message, hint: known[1] });
  const hint = dbSetupHint(err, "db/193_timecard_commute.sql");
  return json(res, hint ? 503 : 500, { error: "commute_unavailable", hint: hint || "勤怠・通勤費の処理に失敗しました。再読み込みしてください。" });
}

export function claimValid(body, month) {
  if (!body || !["pass", "actual", "none"].includes(body.method)) return false;
  if (!Number.isSafeInteger(body.rate) || body.rate < 0 || body.rate > 2147483647) return false;
  if ((body.method === "none") !== (body.rate === 0)) return false;
  if (typeof body.route !== "string" || body.route.length > 500 || !/^[\da-f]{32}$/.test(body.version || "")) return false;
  if (!Array.isArray(body.dates) || body.dates.length > 31 || new Set(body.dates).size !== body.dates.length) return false;
  if (body.method !== "actual" && body.dates.length) return false;
  const last = new Date(month + "-01T00:00:00Z");
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return body.dates.every(d => typeof d === "string" && d.startsWith(month + "-")
    && /^\d{4}-\d{2}-(0[1-9]|[12]\d|3[01])$/.test(d) && Number(d.slice(8)) <= last.getUTCDate());
}

export function commuteCsv(month, rows) {
  const methods = { pass: "定期代", actual: "実費", none: "支給なし" };
  const lines = [["対象月", "社員番号", "氏名", "勤務日数", "実労働時間", "支給方法", "通勤日数", "確定通勤費（円）"]];
  for (const r of rows) {
    lines.push([month, r.code, r.name, r.workDays, clock(r.workMinutes), methods[r.method], r.commuteDays, r.amount]);
  }
  return "\uFEFF" + lines.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
