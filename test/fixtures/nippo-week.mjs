// 日報・勤怠の週（admin-nippo.html の最上部）の画面確認用の材料。lib/nippo-week.js の buildWeek をそのまま通す。
// 実在の人ではない。今日 2026-10-07（水）、週は 10/5（月）〜10/11（日）。10/12 は祝日（次週）
import { buildWeek, mondayOf } from "../../lib/nippo-week.js";

export const TODAY = "2026-10-07";
export const staff = [
  { id: "e1", user_id: "u1", display_name: "山田 太郎", department: "営業" },
  { id: "e2", user_id: "u2", display_name: "佐藤 花子", department: "開発" },
  { id: "e3", user_id: "u3", display_name: "鈴木 一郎", department: "開発" },
  { id: "e4", user_id: "u4", display_name: "高橋 美咲", department: "管理" },
];
export const nippos = [
  { user_id: "u1", work_date: "2026-10-05" }, { user_id: "u1", work_date: "2026-10-06" }, { user_id: "u1", work_date: "2026-10-07" },
  { user_id: "u2", work_date: "2026-10-05" },
  { user_id: "u3", work_date: "2026-10-06" },
  { user_id: "u4", work_date: "2026-10-05" }, { user_id: "u4", work_date: "2026-10-06" },
];
const t = (d, inH, outH) => ({ work_date: d, clock_in: `${d}T0${inH}:00:00Z`, clock_out: outH ? `${d}T${outH}:00:00Z` : null, status: outH ? "closed" : "open" });
export const entries = [
  { employee_id: "e1", ...t("2026-10-05", 0, "09") }, { employee_id: "e1", ...t("2026-10-06", 0, "09") }, { employee_id: "e1", ...t("2026-10-07", 0, null) },
  { employee_id: "e2", ...t("2026-10-05", 0, "09") }, { employee_id: "e2", ...t("2026-10-06", 0, null) },
  { employee_id: "e3", ...t("2026-10-05", 0, "09") },
  // e4 は勤怠の打刻を使っていない
];
export const fixes = [{ employee_id: "e3", work_date: "2026-10-06" }];

export function weekBody(date = TODAY, { attendance = true } = {}) {
  return {
    ...buildWeek({
      monday: mondayOf(date), today: TODAY, staff, nippos,
      entries: attendance ? entries : null, fixes: attendance ? fixes : [],
      usedTimecard: attendance ? new Set(["e1", "e2", "e3"]) : null,
      followUps: mondayOf(date) <= TODAY ? 1 : null,
    }),
    attendanceNote: attendance ? null : "勤怠は、勤怠管理を見られる人にだけ出ます",
  };
}
