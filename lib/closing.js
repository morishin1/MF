// 月次締めの計算。
//
// ■ 何のための仕組みか
//   勤怠・休暇・経費は入口が別々にある。それでよい。
//   困るのは月初で、「この人の分は全部そろったか」を3画面で照合していた。
//   締めるときだけ、1か所に集める。
//
// ■ 集計は保存しない
//   締めたときに数え直せばよく、写しを持つと、
//   元データを直したときに食い違う。画面は常に元データを数える。
//
// ■ 未承認が残っていたら締められない
//   締めたあとに経費の申請が出てくると、給与を計算し直すことになる。
//   締める側が「見落とし」を防ぐのではなく、
//   仕組みが「見落とせない」ようにする。

const JST = 9 * 3600000;

export const isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s || ""));

/** その月の初日と、翌月の初日 */
export function monthRange(month) {
  if (!isMonth(month)) return null;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: `${month}-01`, to: next };
}

/** 日本時間での YYYY-MM */
export const jstMonth = (t = Date.now()) =>
  new Date((t instanceof Date ? t.getTime() : t) + JST).toISOString().slice(0, 7);

/** ひとつ前の月。締めるのはたいてい前月なので、既定値に使う */
export function prevMonth(month) {
  if (!isMonth(month)) return null;
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * 休暇の日数を、その月にかかる分だけ数える。
 *
 * 月をまたぐ休暇（3/30〜4/2）は、月ごとに割る。
 * 申請の days をそのまま足すと、両方の月に全部が乗って二重になる。
 *
 * 半休は days に 0.5 が入る。またいでいないときは days をそのまま使い、
 * またいでいるときだけ日数で割り直す（半休が月をまたぐことはない）。
 */
export function leaveDaysInMonth(req, range) {
  const from = String(req.starts_on || "");
  const to = String(req.ends_on || from);
  if (!from) return 0;

  const s = from > range.from ? from : range.from;
  const e = to < range.to ? to : lastDayBefore(range.to);
  if (s > e) return 0;

  const whole = spanDays(from, to);
  const inside = spanDays(s, e);
  if (whole <= 0) return 0;
  // またいでいなければ、申請の日数をそのまま信じる（半休を壊さない）
  if (inside === whole) return Number(req.days ?? whole) || whole;
  // またいでいるときは、日数の比で割る
  return Math.round((Number(req.days ?? whole) || whole) * (inside / whole) * 10) / 10;
}

const spanDays = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

function lastDayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 締められるか。
 *
 * @param {Array} rows 社員ごとの行（下の shapeRow が作ったもの）
 * @returns {{ok:boolean, blockers:Array}} 止めている理由
 */
export function canClose(rows) {
  const blockers = [];
  for (const r of rows || []) {
    if (r.pending.leave) {
      blockers.push({ name: r.employee.name, what: "休暇の申請", count: r.pending.leave });
    }
    if (r.pending.ringi) {
      blockers.push({ name: r.employee.name, what: "稟議", count: r.pending.ringi });
    }
    if (r.pending.expense) {
      blockers.push({ name: r.employee.name, what: "経費精算", count: r.pending.expense });
    }
    if (r.pending.timefix) {
      blockers.push({ name: r.employee.name, what: "打刻の修正", count: r.pending.timefix });
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/** 分 → 「8:30」。給与へ渡す数字は、小数にすると読み違える */
export function clock(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * CSV の列。
 *
 * ■ 給与へ渡すためのもの
 *   割増は入れない。実労働までしか出さないのは、タイムカードと同じ理由
 *   （法定内・法定外・深夜・休日の割増は、就業規則と賃金規定で決まる）。
 *
 * ■ 未承認の件数も入れる
 *   締めたあとに出てきたものが無いかを、渡した先でも確かめられるように。
 */
export const CSV_HEADER = [
  // 社員番号は mf に無い。名前だけで突き合わせると同姓同名で崩れるので、
  // 一意になるメールアドレスを鍵にする
  "月", "メールアドレス", "氏名", "部署",
  "出勤日数", "実労働(時:分)", "実労働(分)", "休憩(分)",
  "深夜(分)", "休日(分)",
  "有給(日)", "その他休暇(日)",
  "経費(円)", "経費件数",
  "未承認(休暇)", "未承認(稟議)", "未承認(経費)", "未承認(打刻)",
  "締め状況",
];

export function csvRow(month, r, closed) {
  return [
    month,
    r.employee.email || "",
    r.employee.name || "",
    r.employee.department || "",
    r.work.days,
    clock(r.work.workMinutes),
    r.work.workMinutes,
    r.work.breakMinutes,
    r.work.nightMinutes ?? 0,
    r.work.holidayMinutes ?? 0,
    r.leave.paid,
    r.leave.other,
    r.expense.total,
    r.expense.count,
    r.pending.leave,
    r.pending.ringi,
    r.pending.expense,
    r.pending.timefix,
    closed ? "締め済" : "未締め",
  ];
}

/** CSV の1マス。カンマ・改行・引用符が入っていたら囲む */
export const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
