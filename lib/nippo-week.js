// 日報・勤怠の「今週の提出・勤怠状況」（admin-nippo.html の最上部）。純粋な関数（表は読まない）。
//
// ■ 材料（新しい表は作らない。既存のものだけ）
//   日報 … tc_nippo（user_id × work_date）。提出したかどうかだけを見る
//   勤怠 … gw_time_entries（employee_id × work_date。出勤・退勤・休み）と、承認待ちの修正 gw_time_fixes
//   人   … gw_employees（user_id と id をつなぐ。在籍・退職予定でログインできる人）
//   休日 … lib/holidays.js（土日・祝日・年末年始）
//
// ■ 1日の見方
//   日報   ok（出した）／missing（営業日なのに出ていない）／today（今日。まだ書く時間がある）／off（休日・まだ来ていない日）
//   勤怠   ok／check（要確認）／today（今日。勤務中を含む）／off（休日・休み・まだ来ていない日）／none（見られない・使っていない）
//          要確認になるのは：承認待ちの修正がある・退勤の打刻が無いまま日が変わった・営業日なのに打刻が無い
//          ただし直近5週間に一度も打刻していない人は「勤怠を使っていない」として要確認にしない（全員が毎日赤くなるのを防ぐ）
//   まとめ ok（正常）／nippo（日報未提出）／time（勤怠要確認）／both（両方未完了）／off（休日・対象外）／today（今日・まだ）
//
// ■ 数え方
//   日報提出率 … 今日より前の営業日について「出した日 ÷ 出すべき日」。今日の分は、まだ書く時間があるので数えない
//               （lib/follow.js の未提出の数え方と同じ考え方）
//   日報未提出 … 今日より前の営業日で、出ていない日の数（人×日）
//   勤怠要確認 … 要確認の日の数（人×日）
//   要フォロー … lib/follow.js が出す「見るべき人」の人数（相談・KPI未達・未提出2日・止まっている仕事など）

import { HOLIDAYS } from "./holidays.js";

export const DOW = ["日", "月", "火", "水", "木", "金", "土"];

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** その日を含む週の月曜日 */
export function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return addDays(date, -back);
}

/** 月〜日の7日。休日・今日・まだ来ていない日の印つき */
export function weekDays(monday, today) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const holiday = dow === 0 || dow === 6 || HOLIDAYS.has(date);
    return { date, dow: DOW[dow], holiday, today: date === today, future: date > today };
  });
}

/** 勤怠を使っているか（直近5週間に1回でも打刻があるか） */
export const USAGE_WINDOW_DAYS = 35;

/**
 * @param {object} p
 * @param {string} p.monday   週の月曜（YYYY-MM-DD）
 * @param {string} p.today    今日（日本時間）
 * @param {{user_id:string, id:string, display_name:string, department?:string}[]} p.staff
 * @param {{user_id:string, work_date:string}[]} p.nippos  この週の日報
 * @param {{employee_id:string, work_date:string, clock_in?:string, clock_out?:string, status?:string}[]|null} p.entries
 *        この週の打刻。null なら勤怠は見られない（権限なし・表が無い）
 * @param {{employee_id:string, work_date:string}[]} p.fixes   承認待ちの修正（この週の日）
 * @param {Set<string>|null} p.usedTimecard  直近5週間に打刻がある employee_id
 * @param {number|null} p.followUps  要フォローの人数（null なら出さない）
 */
export function buildWeek({ monday, today, staff, nippos, entries, fixes = [], usedTimecard = null, followUps = null }) {
  const days = weekDays(monday, today);
  const attendance = Array.isArray(entries);
  const wrote = new Set((nippos || []).map((n) => `${n.user_id}|${n.work_date}`));
  const entryOf = new Map((entries || []).map((e) => [`${e.employee_id}|${e.work_date}`, e]));
  const fixOf = new Set((fixes || []).map((f) => `${f.employee_id}|${f.work_date}`));

  let expected = 0, submitted = 0, missing = 0, timeCheck = 0;
  const members = (staff || []).map((e) => {
    const usesTime = attendance && (!usedTimecard || usedTimecard.has(e.id));
    let mMissing = 0, mCheck = 0, mWrote = 0, mExpected = 0;
    const cells = days.map((d) => {
      const has = wrote.has(`${e.user_id}|${d.date}`);
      // ---- 日報
      let nippo;
      if (has) nippo = "ok";
      else if (d.future || d.holiday) nippo = "off";
      else if (d.today) nippo = "today";
      else nippo = "missing";
      if (!d.holiday && !d.future && !d.today) {
        mExpected++;
        if (has) mWrote++; else mMissing++;
      }
      // ---- 勤怠
      let time = "none", timeWhy = attendance ? "この人は勤怠の打刻を使っていません（直近5週間に打刻なし）" : "勤怠は見られません";
      if (usesTime) {
        const t = entryOf.get(`${e.id}|${d.date}`);
        const pendingFix = fixOf.has(`${e.id}|${d.date}`);
        if (pendingFix) { time = "check"; timeWhy = "打刻の修正が承認待ちです"; }
        else if (d.future) { time = "off"; timeWhy = "まだ来ていない日です"; }
        else if (t?.status === "absent") { time = "off"; timeWhy = "休み"; }
        else if (t && t.clock_in && !t.clock_out) {
          if (d.today) { time = "today"; timeWhy = "勤務中"; }
          else { time = "check"; timeWhy = "退勤の打刻がありません"; }
        } else if (t && t.clock_in) { time = "ok"; timeWhy = "出勤・退勤の打刻あり"; }
        else if (d.holiday) { time = "off"; timeWhy = "休日"; }
        else if (d.today) { time = "today"; timeWhy = "今日はまだ打刻がありません"; }
        else { time = "check"; timeWhy = "打刻がありません"; }
        if (time === "check") mCheck++;
      }
      const nippoBad = nippo === "missing", timeBad = time === "check";
      const state = nippoBad && timeBad ? "both" : nippoBad ? "nippo" : timeBad ? "time"
        : (nippo === "ok" || time === "ok") ? "ok"
        : (nippo === "today" || time === "today") ? "today" : "off";
      return { date: d.date, state, nippo, time, timeWhy };
    });
    expected += mExpected; submitted += mWrote; missing += mMissing; timeCheck += mCheck;
    return {
      userId: e.user_id, employeeId: e.id, name: e.display_name, department: e.department || null,
      days: cells,
      nippo: { submitted: mWrote, expected: mExpected, missing: mMissing },
      time: { check: mCheck, uses: Boolean(usesTime) },
      issues: mMissing + mCheck,
    };
  });

  // 要対応の多い人を先に。同じなら名簿の順（名前）
  members.sort((a, b) => b.issues - a.issues || String(a.name).localeCompare(String(b.name), "ja"));

  return {
    from: days[0].date, to: days[6].date, today, days, attendance, members,
    kpi: {
      rate: expected ? Math.round((submitted / expected) * 100) : null,
      submitted, expected, missing,
      timeCheck: attendance ? timeCheck : null,
      followUps,
    },
  };
}

/** 週の範囲（打刻の使用の有無を見る期間も） */
export function weekRange(monday) {
  return { from: monday, to: addDays(monday, 6), usageFrom: addDays(monday, -USAGE_WINDOW_DAYS) };
}

export { addDays };
