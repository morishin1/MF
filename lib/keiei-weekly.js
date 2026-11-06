// KEIEI「日報まとめ」週次レビュー。日報・週次振り返りの正本を読み取り専用で集約する。
// API の owner ゲートを通した後だけ呼ぶこと。tc_* には tenant_id が無いので、
// 先にテナント所属の社員の user_id を確定し、その ID の行だけを読む。
import { readIn } from "./pg-read.js";
import { rosterOf } from "./member-exec-read.js";
import { evaluationItems, isDone, isSubmittedNippo, weeklyFilled } from "./nippo.js";

const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const clean = (x, max = 1000) => typeof x === "string" ? x.trim().slice(0, max) : "";
const arr = (x) => Array.isArray(x) ? x : [];
const countQuestions = (w) => ["q1", "q2", "q3", "q4"].filter((k) => clean(w?.[k])).length;
const reviewForUi = (w) => w ? {
  q1: clean(w.q1, 4000), q2: clean(w.q2, 4000),
  q3: clean(w.q3, 4000), q4: clean(w.q4, 4000),
  updatedAt: w.updated_at || null,
  // 管理者が本人に提出した確定評価だけを、公開済み評価として扱う。
  publishedScore: w.submitted_at && Number.isFinite(w.eval_total) ? w.eval_total : null,
  publishedComment: w.submitted_at ? clean(w.eval_comment, 2000) : "",
} : null;

const rateOf = (a, b) => b ? Math.round(100 * a / b) : null;

export function summarizeKeieiWeekly({ roster, nippos, reviews, weekStart, today }) {
  const previousStart = addDays(weekStart, -7);
  const weekEnd = addDays(weekStart, 6);
  const byUser = new Map();
  for (const n of nippos) {
    if (!byUser.has(n.user_id)) byUser.set(n.user_id, []);
    byUser.get(n.user_id).push(n);
  }
  const reviewMap = new Map(reviews.map((w) => [w.user_id + ":" + w.week_start, w]));
  const members = roster.map((e) => {
    const all = byUser.get(e.user_id) || [];
    const daily = all.filter((n) => n.work_date >= weekStart && n.work_date <= weekEnd && n.work_date <= today && isSubmittedNippo(n))
      .sort((a, b) => a.work_date.localeCompare(b.work_date));
    const prevDaily = all.filter((n) => n.work_date >= previousStart && n.work_date < weekStart && isSubmittedNippo(n));
    const raw = reviewMap.get(e.user_id + ":" + weekStart) || null;
    const prevRaw = reviewMap.get(e.user_id + ":" + previousStart) || null;
    const qCount = countQuestions(raw);
    const reviewStatus = !weeklyFilled(raw) ? "missing" : qCount < 4 ? "partial" : "filled";

    const kgiRecorded = daily.filter((n) => n.kgi_achieved === true || n.kgi_achieved === false);
    const achieved = kgiRecorded.filter((n) => n.kgi_achieved === true).length;
    const prevKgi = prevDaily.filter((n) => n.kgi_achieved === true || n.kgi_achieved === false);
    const prevAchieved = prevKgi.filter((n) => n.kgi_achieved === true).length;
    const actions = daily.flatMap((n) => evaluationItems({ ...n, work_items: arr(n.work_items) })
      .map((w) => ({ date: n.work_date, ...w })));
    const kgiDays = daily.filter((n) => n.kgi_achieved !== null || n.kgi_target != null || n.kgi_actual != null)
      .map((n) => ({
        date: n.work_date, goal: clean(n.goal_today, 200),
        target: n.kgi_target, actual: n.kgi_actual, achieved: n.kgi_achieved,
      }));
    const results = actions.filter(isDone).map((w) => ({
      date: w.date, task: clean(w.task, 500), result: clean(w.result, 500) || "完了（本人申告）",
    })).slice(0, 20);
    const unfinished = actions.filter((w) => !isDone(w) && clean(w.undone_reason)).map((w) => ({
      date: w.date, task: clean(w.task, 500), reason: clean(w.undone_reason, 500),
    })).slice(0, 10);
    const consultations = daily.filter((n) => clean(n.consult_note)).map((n) => ({
      date: n.work_date, text: clean(n.consult_note, 1000),
    })).slice(0, 10);
    const improvements = daily.filter((n) => clean(n.improved_note)).map((n) => ({
      date: n.work_date, text: clean(n.improved_note, 500),
    })).slice(0, 10);

    const topics = [];
    if (reviewStatus === "missing") topics.push("週次の振り返りが未記入です。本人の勤務予定と入力状況を確認");
    else if (reviewStatus === "partial") topics.push("振り返りが一部未記入です。空欄の内容を確認");
    if (prevRaw && clean(prevRaw.q3)) topics.push("先週決めた「やめる・続ける・試す」は、今週どこまで実行できたか");
    if (kgiRecorded.length && achieved < kgiRecorded.length)
      topics.push("KGI未達 " + (kgiRecorded.length - achieved) + "日：原因と次週に変える行動は何か");
    if (consultations.length) topics.push("相談・困りごとへの支援内容、担当者、期限を決める");
    if (unfinished.length) topics.push("未完了の仕事について、継続・中止・期限を判断");
    topics.push(clean(raw?.q4) ? "来週のKGI・KPIと実行内容を確認" : "来週のKGI・KPIを数値と行動で具体化する");

    return {
      employeeId: e.id, name: e.display_name || "氏名未設定", department: e.department || "所属未設定",
      reviewStatus, answered: qCount, review: reviewForUi(raw),
      previousReview: reviewForUi(prevRaw),
      submittedDays: new Set(daily.map((n) => n.work_date)).size,
      previousSubmittedDays: new Set(prevDaily.map((n) => n.work_date)).size,
      kgiAchieved: achieved, kgiRecorded: kgiRecorded.length, kgiRate: rateOf(achieved, kgiRecorded.length),
      previousKgiRate: rateOf(prevAchieved, prevKgi.length),
      resultsCount: actions.filter(isDone).length, results, kgiDays,
      unfinished, consultations, improvements,
      topics,
      // 達成率は記録されたKGI日のみ。未記録を未達と推測しない。
      needsDiscussion: reviewStatus !== "filled" || (kgiRecorded.length > 0 && achieved < kgiRecorded.length)
        || consultations.length > 0 || unfinished.length > 0,
    };
  }).sort((a, b) => a.department.localeCompare(b.department, "ja") || a.name.localeCompare(b.name, "ja"));

  const recorded = members.reduce((a, m) => a + m.kgiRecorded, 0);
  const achieved = members.reduce((a, m) => a + m.kgiAchieved, 0);
  return {
    weekStart, weekEnd, previousStart, today,
    summary: {
      total: members.length,
      written: members.filter((m) => m.reviewStatus !== "missing").length,
      complete: members.filter((m) => m.reviewStatus === "filled").length,
      notWritten: members.filter((m) => m.reviewStatus === "missing").length,
      submittedDays: members.reduce((a, m) => a + m.submittedDays, 0),
      kgiAchieved: achieved, kgiRecorded: recorded, kgiRate: rateOf(achieved, recorded),
      discuss: members.filter((m) => m.needsDiscussion).length,
    },
    departments: [...new Set(members.map((m) => m.department))].sort((a, b) => a.localeCompare(b, "ja")),
    members,
    note: "日報提出数は実際の提出日数です。曜日別の勤務予定が異なるため一律の提出率は計算しません。KGI達成率は数値・達成判定が記録された日のみが分母です。",
  };
}

export async function readKeieiWeekly(sb, { tenantId, weekStart, today }) {
  const roster = await rosterOf(sb, tenantId);
  if (roster === null) return { error: "roster_unreadable" };
  if (!roster.length) return summarizeKeieiWeekly({ roster: [], nippos: [], reviews: [], weekStart, today });
  const ids = roster.map((e) => e.user_id);
  const previousStart = addDays(weekStart, -7);
  const weekEnd = addDays(weekStart, 6);
  const [nippos, reviews] = await Promise.all([
    readIn((part) => sb.from("tc_nippo")
      .select("id,user_id,work_date,submitted_at,goal_today,kgi_target,kgi_actual,kgi_achieved,work_items,consult_note,improved_note")
      .in("user_id", part).gte("work_date", previousStart).lte("work_date", weekEnd)
      .order("work_date").order("id"), ids),
    readIn((part) => sb.from("tc_weekly_review")
      .select("id,user_id,week_start,q1,q2,q3,q4,updated_at,eval_total,eval_comment,submitted_at")
      .in("user_id", part).in("week_start", [previousStart, weekStart])
      .order("week_start").order("id"), ids),
  ]);
  if (nippos === null || reviews === null) return { error: "source_unreadable" };
  return summarizeKeieiWeekly({ roster, nippos, reviews, weekStart, today });
}
