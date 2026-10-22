// 日報コーチ：次勤務日の数値目標・完了/品質条件・見積と実所要の整理（純粋関数。DB・AI・送信なし）。
//
// 引継ぎ資料（mf-coach/local-only/goal-review.mjs、合成27テスト）をリポジトリへ移したもの。
// 仕様：docs/behavior-coach.md「定量目標と時間」。
//   ・数量は本人が登録した値（member_registered）か本人の仮案（member_provisional）だけを保持する。新しい数量は作らない
//   ・根拠が無ければ quantity=null（0 と未確認を区別する）。行動量 / 成果物 / 事業成果を分ける
//   ・予定時間と実所要は、同じ定義・完了済み・品質/難易度が比較可能・重複なしのときだけ差を出す。カレンダー枠は実所要ではない
//   ・payload は productionReady:false / semanticEvidenceVerified:false / sendEnabled:false を必ず持つ
//
// 移植時の変更：metricType・deliverable が記録に無いとき（GW の日報・タスクには種類の欄が無い）、
// 推測で埋めずに null として「不足」に入れる。元の27テストの入力では動作は変わらない。
import { digest } from "./behavior-coach.js";

const requireValue = (v, c) => { if (!v) throw Error(c); };
const nonnegative = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const text = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 800;
export const METRIC_TYPES = ["activity", "output", "outcome"];

export function verifyGoalReview(payload) {
  const { reviewHash, ...body } = payload; return reviewHash === digest(body);
}

export function buildGoalReview(input) {
  input = structuredClone(input);
  requireValue(input && text(input.memberId) && text(input.sourceRevision), "invalid_scope");
  requireValue(Array.isArray(input.evidence), "invalid_evidence");
  const evidence = new Map();
  for (const e of input.evidence) {
    requireValue(e && text(e.id) && !evidence.has(e.id) && e.memberId === input.memberId && text(e.revision) && Number.isFinite(Date.parse(e.checkedAt)) && ["plan", "member_report", "verified_result", "context"].includes(e.kind), "invalid_evidence");
    evidence.set(e.id, e);
  }
  const refs = (ids, kind) => Array.isArray(ids) && ids.length > 0 && ids.every((id) => evidence.has(id) && (!kind || kind.includes(evidence.get(id).kind)));
  const missing = [], questions = [];
  if (input.active !== true) missing.push("在籍・稼働状況");
  if (input.scopeConfirmed !== true) missing.push("契約上の業務範囲");
  if (!input.nextWorkday) missing.push("次勤務日");
  else requireValue(/^\d{4}-\d{2}-\d{2}$/.test(input.nextWorkday) && new Date(input.nextWorkday).toISOString().slice(0, 10) === input.nextWorkday, "invalid_date");
  const goal = input.goal;
  requireValue(goal && text(goal.task) && (goal.deliverable == null || text(goal.deliverable)) && (goal.metricType == null || METRIC_TYPES.includes(goal.metricType)), "invalid_goal");
  requireValue(refs(goal.refs), "unknown_goal_reference");
  if (goal.metricType == null) missing.push("指標の種類（行動量・成果物・事業成果）");
  if (goal.deliverable == null) missing.push("完成させる成果物");
  let quantity = null, quantityStatus = "unset";
  if (goal.quantity != null) {
    requireValue(nonnegative(goal.quantity) && text(goal.unit) && ["member_registered", "member_provisional"].includes(goal.quantityOrigin) && refs(goal.quantityRefs, ["plan", "member_report"]), "unsupported_quantity");
    quantity = goal.quantity; quantityStatus = goal.quantityOrigin === "member_registered" ? "registered_not_replaced" : "provisional_not_agreed";
  }
  if (quantity === null) { missing.push("件数の根拠"); questions.push("確保できる勤務時間・同種作業の実績・残件を確認し、実行可能な件数を調整してください。"); }
  const completion = goal.completionCriteria ?? null, quality = goal.qualityCriteria ?? null;
  requireValue(completion === null || text(completion), "invalid_completion"); requireValue(quality === null || text(quality), "invalid_quality");
  if (!completion) missing.push("完了条件"); if (!quality) missing.push("品質条件");
  if (!completion || !quality) questions.push("何をもって完了とし、どの品質条件を満たすか確認してください。");
  let timing = { status: "unconfirmed", plannedMinutes: null, actualMinutes: null, differenceMinutes: null };
  if (input.timing) {
    const t = input.timing;
    requireValue(t.plannedMinutes == null || nonnegative(t.plannedMinutes), "invalid_planned_minutes");
    requireValue(t.actualMinutes == null || nonnegative(t.actualMinutes), "invalid_actual_minutes");
    requireValue(refs(t.refs), "unknown_time_reference");
    requireValue(["calendar_slot", "member_estimate"].includes(t.plannedOrigin), "invalid_time_origin");
    if (t.actualMinutes != null) requireValue(t.actualOrigin === "member_report" || t.actualOrigin === "verified_result", "invalid_actual_origin");
    if (t.actualMinutes != null) requireValue(refs(t.actualRefs, [t.actualOrigin]), "actual_not_evidence");
    const comparable = t.plannedOrigin === "member_estimate" && t.actualMinutes != null && t.plannedMinutes != null && t.complete === true && t.sameDefinition === true && t.qualityComparable === true && t.difficultyComparable === true && t.overlapping === false;
    timing = { status: comparable ? "comparable_difference_not_performance_rating" : "unconfirmed", plannedMinutes: t.plannedMinutes ?? null, actualMinutes: t.actualMinutes ?? null, differenceMinutes: comparable ? t.actualMinutes - t.plannedMinutes : null, plannedOrigin: t.plannedOrigin, actualOrigin: t.actualOrigin ?? null, refs: t.refs, actualRefs: t.actualRefs ?? [], conditions: { complete: t.complete ?? null, sameDefinition: t.sameDefinition ?? null, qualityComparable: t.qualityComparable ?? null, difficultyComparable: t.difficultyComparable ?? null, overlapping: t.overlapping ?? null }, breakdown: t.breakdown ?? null };
    if (t.breakdown) { for (const [k, v] of Object.entries(t.breakdown)) { requireValue(["research", "execution", "checking", "waiting", "interruptions"].includes(k) && (v === null || nonnegative(v)), "invalid_breakdown"); } }
    // No sum: waiting, interruption and active time may overlap or be estimates.
    if (!comparable) questions.push("予定枠と実所要は別です。完了件数・実所要と、待ちや割込の有無を必要な範囲で確認してください。");
  } else missing.push("本人確認済みの予定時間・実所要");
  const improvement = input.improvement ?? null;
  if (improvement) requireValue(text(improvement.text) && refs(improvement.refs), "ungrounded_improvement");
  // Deliberately never infer agreement, classification, throughput or a target quantity.
  const payload = { schemaVersion: 1, validationLevel: "synthetic_structural_only", semanticEvidenceVerified: false, productionReady: false, memberId: input.memberId, sourceRevision: input.sourceRevision, nextWorkday: input.nextWorkday ?? null,
    goal: { task: goal.task, deliverable: goal.deliverable ?? null, metricType: goal.metricType ?? null, quantity, unit: goal.unit ?? null, quantityStatus, quantityOrigin: goal.quantityOrigin ?? null, quantityRefs: goal.quantityRefs ?? [], completionCriteria: completion, qualityCriteria: quality, refs: goal.refs },
    timing, missing, questions: [...new Set(questions)].slice(0, 3), improvement, agreement: "not_established",
    evidence: input.evidence, recipientStatus: "unverified", sendEnabled: false, approvalRequired: true,
    excluded: input.active === false, warning: "代表レビュー用。数値は本人登録/仮案の整理であり、新規ノルマ・人事評価ではありません。" };
  return { ...payload, reviewHash: digest(payload) };
}

const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * GW の記録（readCoachSources の facts）から、目標レビューを作る。
 *   ・前勤務日の日報の行（work_items）：朝に本人が書いた target/unit/done_when を「本人登録の計画」、
 *     夜の result/actual/undone_reason を「本人報告」として扱う。独立確認はしない
 *   ・次勤務日の重要タスク（gw_tasks の focus_date）：本人が決めた done_condition を完了条件にする
 *   ・どちらにも「指標の種類」「品質条件」「実所要」の欄は無いので null のまま不足に出す
 * 1件でも検証に落ちた行は、その行だけ「unusable」として理由を残し、他の行は続ける（全体を止めない）。
 * @returns {{goals:object[], results:object[], skipped:{ref:string,error:string}[]}}
 */
export function goalReviewsFromSources(sources, { scopeConfirmed = false, checkedAt, limit = 3 } = {}) {
  const goals = [], results = [], skipped = [];
  if (!sources || !Array.isArray(sources.facts)) return { goals, results, skipped };
  const memberId = sources.employeeId;
  const report = sources.facts.find((f) => f.id === "report:" + sources.reportDate);
  const nippoRev = report?.value?.updatedAt || report?.value?.submittedAt || null;
  const evidenceBase = [];
  if (report?.value?.submittedAt && nippoRev) {
    evidenceBase.push({ id: "report:" + sources.reportDate, memberId, revision: String(nippoRev), checkedAt, kind: "member_report" });
    evidenceBase.push({ id: "plan:" + sources.reportDate, memberId, revision: String(nippoRev), checkedAt, kind: "plan" });
  }
  const sourceRevision = String(sources.sourceHash || "unknown");
  const base = { memberId, sourceRevision, active: sources.active === true ? true : sources.active === false ? false : null, scopeConfirmed, nextWorkday: sources.nextDate || null };
  const items = Array.isArray(report?.value?.workItems) ? report.value.workItems : [];
  for (const w of items.slice(0, limit)) {
    const task = clip(w?.task, 200);
    if (!task || !evidenceBase.length) continue;
    const quantity = num(w.target), unit = clip(w.unit, 10);
    const input = { ...base, evidence: evidenceBase,
      goal: { task, deliverable: null, metricType: null, refs: ["plan:" + sources.reportDate],
        ...(quantity != null && unit ? { quantity, unit, quantityOrigin: "member_registered", quantityRefs: ["plan:" + sources.reportDate] } : {}),
        completionCriteria: clip(w.done_when, 500) || null, qualityCriteria: null } };
    try {
      goals.push({ source: "previous_workday_report", ref: "report:" + sources.reportDate, review: buildGoalReview(input) });
      results.push({ task, ref: "report:" + sources.reportDate, reported: true,
        done: w.done === true || (!!clip(w.result, 500) && !clip(w.undone_reason, 500)),
        actual: num(w.actual), actualOrigin: num(w.actual) == null ? null : "member_report",
        target: quantity, unit: unit || null, unitMissing: quantity != null && !unit,
        undoneReasonGiven: !!clip(w.undone_reason, 500) });
    } catch (e) { skipped.push({ ref: "report:" + sources.reportDate, error: e.message }); }
  }
  for (const f of sources.facts.filter((x) => x.id.startsWith("focus:")).slice(0, limit)) {
    const v = f.value || {};
    const title = clip(v.title, 200);
    if (!title || !v.updated_at) continue;
    const ev = { id: f.id, memberId, revision: String(v.updated_at), checkedAt, kind: "plan" };
    try {
      goals.push({ source: "next_workday_focus_task", ref: f.id, review: buildGoalReview({ ...base, evidence: [ev],
        goal: { task: title, deliverable: null, metricType: null, refs: [f.id], completionCriteria: clip(v.done_condition, 500) || null, qualityCriteria: null } }) });
    } catch (e) { skipped.push({ ref: f.id, error: e.message }); }
  }
  return { goals, results, skipped };
}
