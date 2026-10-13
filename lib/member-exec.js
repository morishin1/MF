// 経営「メンバー実行状況」（/keiei → 人・組織 → メンバー実行状況）。純粋な関数（表は読まない）。
//
// ■ 何をするか
//   新しい日報・タスクの仕組みは作らない。既存の判定をそのまま使い、メンバーごとに1行にまとめる。
//     今日の3つ・明日の3つ … lib/focus.js の focusRows / boardRow（全員のタスク admin-tasks.html と同じ）
//     要フォロー          … lib/follow.js の findFollowUps（日報・勤怠 admin-nippo.html の「今日の要フォロー」と同じ）
//     日報の提出          … tc_nippo にその日の行があるか（日報・勤怠の「提出」と同じ）
//     期限超過            … lib/task-view.js の isOverdue（全員のタスクの一覧と同じ）
//     今週の提出          … lib/nippo-week.js の buildWeek（日報・勤怠の「今週の提出・勤怠」と同じ）
//
// ■ 状態は3つ（見る → 気付く → フォローする）
//   要対応 danger … 要フォロー（相談あり・止まっている仕事・3日連続KPI未達・日報未提出2日）／前の営業日の日報が未提出／
//                   期限超過2件以上／過去の日を見ていて日報が無い
//   注意   warn   … 今日の日報がまだ／期限超過1件／今日の3つに手が付いていない・未登録／明日の3つが未登録・未確定／
//                   やりかけの放置・行動量の低下
//   良好   good   … どれにも当たらない
//
// ■ 読めなかった材料
//   読めなかったもの（null）は「問題なし」にしない。その欄は null のまま返し、画面は「読めませんでした」と出す。

const LEVEL_ORDER = { danger: 0, warn: 1, good: 2 };
export const LEVEL_LABEL = { danger: "要対応", warn: "注意", good: "良好" };
// 要フォローの理由のうち、要対応にするもの（ほかは注意）
const DANGER_KINDS = new Set(["consult", "blocker", "kpi_miss", "not_submitted"]);

/**
 * @param {object} p
 * @param {string} p.date        対象日
 * @param {boolean} p.isToday    対象日が今日か（今日なら日報はまだ書ける）
 * @param {string|null} p.prevWorkday  前の営業日（日報の未提出を要対応にする日）
 * @param {Array}  p.roster      [{id, user_id, display_name, department}]
 * @param {Map|null} p.focus     employeeId → focusRows の行（null＝読めなかった）
 * @param {Map|null} p.follow    userId → findFollowUps の行（null＝読めなかった）
 * @param {Set|null} p.submittedToday   その日に日報がある userId
 * @param {Set|null} p.submittedPrev    前の営業日に日報がある userId
 * @param {Map|null} p.overdue   employeeId → 期限超過のタスク[]（null＝読めなかった）
 * @param {Map|null} p.week      userId → buildWeek の member（null＝読めなかった）
 */
export function buildMemberExec({ date, isToday, prevWorkday, roster = [], focus, follow, submittedToday, submittedPrev, overdue, week }) {
  const members = roster.map((e) => {
    const f = focus ? focus.get(e.id) || null : null;
    const fu = follow ? follow.get(e.user_id) || { reasons: [] } : null;
    const od = overdue ? overdue.get(e.id) || [] : null;
    const submitted = submittedToday ? submittedToday.has(e.user_id) : null;
    const prevSubmitted = submittedPrev && prevWorkday ? submittedPrev.has(e.user_id) : null;
    const wk = week ? week.get(e.user_id) || null : null;

    const reasons = [];
    const add = (level, key, label) => reasons.push({ level, key, label });
    // 要フォロー（日報・勤怠と同じ理由・同じ文言）
    for (const r of fu?.reasons || []) add(DANGER_KINDS.has(r.kind) ? "danger" : "warn", r.kind, r.label + (r.detail && r.kind !== "not_submitted" ? `：${r.detail}` : ""));
    // 日報
    if (submitted === false) add(isToday ? "warn" : "danger", "nippo_today", isToday ? "今日の日報がまだ" : "日報未提出");
    if (prevSubmitted === false && !(fu?.reasons || []).some((r) => r.kind === "not_submitted")) add("danger", "nippo_prev", "前の営業日の日報が未提出");
    // 期限超過
    if (od && od.length >= 2) add("danger", "overdue", `期限超過 ${od.length}件`);
    else if (od && od.length === 1) add("warn", "overdue", "期限超過 1件");
    // 今日の3つ・明日の3つ（全員のタスクと同じ判定）
    if (f) {
      if (f.today.count === 0) add("warn", "focus_none", "今日の3つが未登録");
      else if (f.today.done === 0) add("warn", "focus_zero", "今日の3つに手が付いていない");
      if (!f.tomorrow.count) add("warn", "tomorrow_none", "明日の3つが未登録");
      else if (!f.tomorrow.confirmed) add("warn", "tomorrow_open", `明日の3つが${f.tomorrow.label}`);
    }
    const level = reasons.some((r) => r.level === "danger") ? "danger" : reasons.length ? "warn" : "good";
    reasons.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

    return {
      employeeId: e.id, userId: e.user_id, name: e.display_name, department: e.department || null,
      status: level, statusLabel: LEVEL_LABEL[level], reasons,
      nippo: { submitted, prevSubmitted },
      today: f ? { total: f.today.count, done: f.today.done, label: f.today.label, allDone: f.today.allDone } : null,
      tomorrow: f ? { count: f.tomorrow.count, state: f.tomorrow.state, label: f.tomorrow.label, confirmed: f.tomorrow.confirmed } : null,
      overdue: od ? od.length : null,
      follow: fu ? fu.reasons.map((r) => ({ kind: r.kind, label: r.label, detail: r.detail || "" })) : null,
      consultOrBlocker: fu ? fu.reasons.some((r) => r.kind === "consult" || r.kind === "blocker") : null,
      week: wk ? { submitted: wk.nippo.submitted, expected: wk.nippo.expected, missing: wk.nippo.missing } : null,
    };
  });

  members.sort(compareMembers);
  return { date, members, summary: summarize(members, { focus, follow, submittedToday, overdue }) };
}

const rate = (m) => (m.today && m.today.total ? m.today.done / m.today.total : -1);
/** 要対応 → 注意 → 良好。同じ状態なら：期限超過が多い → 日報未提出 → 今日の完了率が低い → 明日の3つ未登録 → 名前 */
export function compareMembers(a, b) {
  return (LEVEL_ORDER[a.status] - LEVEL_ORDER[b.status])
    || ((b.overdue || 0) - (a.overdue || 0))
    || ((a.nippo.submitted === false ? 0 : 1) - (b.nippo.submitted === false ? 0 : 1))
    || (rate(a) - rate(b))
    || ((a.tomorrow && !a.tomorrow.count ? 0 : 1) - (b.tomorrow && !b.tomorrow.count ? 0 : 1))
    || String(a.name).localeCompare(String(b.name), "ja");
}

/** 上部の数。読めなかった材料の数は null（0 とは言わない） */
export function summarize(members, { focus, follow, submittedToday, overdue }) {
  const n = (pred) => members.filter(pred).length;
  return {
    people: members.length,
    nippoSubmitted: submittedToday ? n((m) => m.nippo.submitted) : null,
    focusDone: focus ? n((m) => m.today?.allDone) : null,
    followRequired: n((m) => m.status === "danger"),
    overdue: overdue ? members.reduce((s, m) => s + (m.overdue || 0), 0) : null,
    tomorrowMissing: focus ? n((m) => m.tomorrow && !m.tomorrow.count) : null,
    consultOrBlocker: follow ? n((m) => m.consultOrBlocker) : null,
  };
}

/** 今日の要フォロー（最大5人）。要対応の人を、並びの順に */
export function topFollow(members, max = 5) {
  return members.filter((m) => m.status === "danger").slice(0, max)
    .map((m) => ({ employeeId: m.employeeId, name: m.name, reasons: m.reasons.filter((r) => r.level === "danger").map((r) => r.label).concat(
      m.today ? [`今日 ${m.today.done}/${m.today.total}`] : []) }));
}
